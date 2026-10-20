// Robinhood Chain swap setup (R4), embedded (Privy) wallets only: MetaMask won't 7702-delegate to
// Kernel. The session key is made and sealed in the core enclave; this route turns it into the
// payloads the main key signs, checks the signatures, and queues them for the ops relayer.
import { buildSwapSetup, chains, ENTRY_POINT_V07, entryPointNonceAbi, KERNEL_V33_IMPLEMENTATION, network, revokePolicyUserOp, userOpFromJson, userOpHash, swapSetupFromJson, swapSetupTypedData, TESTNET_DEPLOYMENT, TESTNET_SWAP, toJsonSafe, type SwapSetup } from "@proviso/chain";
import { swapKeys } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { createPublicClient, getAddress, hashMessage, http, isAddressEqual, recoverAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { verifyAuthorization } from "viem/utils";
import { z } from "zod";
import { authedProcedure, router } from "../trpc";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/) as unknown as z.ZodType<Hex>;
const CONTRACTS = { swapAdapter: TESTNET_DEPLOYMENT.swapAdapter!, swapKeyPolicy: TESTNET_DEPLOYMENT.swapKeyPolicy! };
const typedData = (s: SwapSetup) => swapSetupTypedData(s, CONTRACTS);

export const swapKeyRouter = router({
  status: authedProcedure.query(async ({ ctx }) => {
    const [k] = await ctx.db
      .select({ keyAddr: swapKeys.keyAddr, expiresAt: swapKeys.expiresAt, registeredAt: swapKeys.registeredAt, revokedAt: swapKeys.revokedAt, setup: swapKeys.setup })
      .from(swapKeys)
      .where(eq(swapKeys.address, ctx.auth.address));
    if (!k || k.revokedAt) return { state: "none" as const };
    if (k.registeredAt) return { state: "ready" as const, sessionKey: k.keyAddr, expiresAt: k.expiresAt };
    const signed = !!(k.setup as { signatures?: unknown } | null)?.signatures;
    return { state: signed ? ("relaying" as const) : ("unsigned" as const), sessionKey: k.keyAddr, expiresAt: k.expiresAt };
  }),

  // Asks the enclave for a fresh session key, then builds everything the main key signs.
  prepare: authedProcedure.mutation(async ({ ctx }) => {
    if (network() !== "testnet") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Robinhood Chain swaps run on testnet only for now." });
    const chain = chains.testnet;
    const owner = ctx.auth.address;
    // One live setup per account: no silent re-keying (and no re-funded session keys) once ready.
    const [prev] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (prev && !prev.revokedAt && prev.registeredAt && prev.expiresAt > new Date())
      throw new TRPCError({ code: "CONFLICT", message: "Swaps are already set up for this wallet." });
    // An unsigned key from the last 10 minutes is reused (a second click, a dropped response), so
    // repeated clicks never mint a stream of enclave keys.
    let row = prev && !prev.registeredAt && !prev.revokedAt && Date.now() - prev.createdAt.getTime() < 10 * 60_000 ? prev : undefined;
    if (!row) {
      const since = new Date(Date.now() - 1000);
      await ctx.db.execute(sql`select pgmq.send('agent', ${JSON.stringify({ owner, kind: "swap" })}::jsonb)`);
      for (let i = 0; i < 20 && !(row && row.createdAt >= since); i++) {
        await new Promise((r) => setTimeout(r, 500));
        [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
      }
      if (!row || row.createdAt < since) throw new TRPCError({ code: "TIMEOUT", message: "The enclave didn't answer; try again." });
    }

    const setup = await buildSwapSetup(createPublicClient({ chain, transport: http(process.env.RHC_RPC_URL) }) as never, {
      chainId: chain.id,
      account: getAddress(owner),
      sessionKey: row.keyAddr as Address,
      expiresAt: BigInt(Math.floor(row.expiresAt.getTime() / 1000)),
      ...CONTRACTS,
      markets: TESTNET_SWAP.markets,
      caps: TESTNET_SWAP.caps,
    });
    await ctx.db.update(swapKeys).set({ setup: toJsonSafe(setup) }).where(eq(swapKeys.address, owner));
    return { setup, typedData: typedData(setup) };
  }),

  // Checks every signature against the main key, then queues the setup for the ops relayer.
  register: authedProcedure
    .input(
      z.object({
        authorization: z.object({ address: hex, chainId: z.number(), nonce: z.number(), r: hex, s: hex, yParity: z.number() }).optional(),
        userOp: hex.optional(),
        adapter: z.array(hex).max(8),
        policy: hex,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owner = ctx.auth.address;
      const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
      if (!row?.setup || row.registeredAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Start the swap setup again." });
      const setup = swapSetupFromJson(row.setup as Record<string, unknown>);
      const account = getAddress(owner);
      const bad = (what: string) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: `The ${what} signature isn't from your wallet.` });
      };
      const td = typedData(setup);
      if (input.adapter.length !== td.adapter.length) bad("adapter policy");
      for (const [i, t] of td.adapter.entries())
        if (!isAddressEqual(await recoverTypedDataAddress({ ...t, signature: input.adapter[i]! } as never), account)) bad("adapter policy");
      if (!isAddressEqual(await recoverTypedDataAddress({ ...td.policy, signature: input.policy } as never), account)) bad("swap-key policy");
      // Only what prepare asked for is accepted; the delegation must point at Kernel v3.3 on this chain.
      const want = setup.install?.authorization;
      if (!want && input.authorization) bad("delegation");
      if (!setup.install && input.userOp) bad("account setup");
      if (setup.install) {
        if (!input.userOp || !isAddressEqual(await recoverAddress({ hash: hashMessage({ raw: setup.install.userOpHash }), signature: input.userOp }), account)) bad("account setup");
        if (want) {
          const a = input.authorization;
          if (!a || !isAddressEqual(a.address, KERNEL_V33_IMPLEMENTATION) || !isAddressEqual(want.address, KERNEL_V33_IMPLEMENTATION) || a.chainId !== chains.testnet.id || a.chainId !== want.chainId || a.nonce !== want.nonce)
            bad("delegation");
          if (!(await verifyAuthorization({ address: account, authorization: { ...a!, address: a!.address as Address } }))) bad("delegation");
        }
      }
      const signatures = { authorization: want ? input.authorization : undefined, userOp: setup.install ? input.userOp : undefined, adapter: input.adapter, policy: input.policy };
      await ctx.db.transaction(async (tx) => {
        await tx.update(swapKeys).set({ setup: { ...(row.setup as object), signatures } }).where(eq(swapKeys.address, owner));
        await tx.execute(sql`select pgmq.send('swap_setup', ${JSON.stringify({ address: owner })}::jsonb)`);
      });
      return { queued: true };
    }),

  // Revoke: one zero-fee UserOp that uninstalls SwapKeyPolicy. The key stops working in core at
  // once (revoked_at); ops relays the on-chain uninstall. Bought tokens stay in the wallet.
  prepareRevoke: authedProcedure.mutation(async ({ ctx }) => {
    const owner = ctx.auth.address;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (!row?.registeredAt || row.revokedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no active swap key to revoke." });
    const chain = chains.testnet;
    const pub = createPublicClient({ chain, transport: http(process.env.RHC_RPC_URL) });
    const account = getAddress(owner);
    const nonce = (await pub.readContract({ address: ENTRY_POINT_V07, abi: entryPointNonceAbi, functionName: "getNonce", args: [account, 0n] })) as bigint;
    const userOp = revokePolicyUserOp({ account, swapKeyPolicy: CONTRACTS.swapKeyPolicy, nonce });
    const revoke = { userOp, userOpHash: userOpHash(userOp, chain.id) };
    await ctx.db.update(swapKeys).set({ setup: { ...(row.setup as object), revoke: toJsonSafe(revoke) } }).where(eq(swapKeys.address, owner));
    return revoke;
  }),

  revoke: authedProcedure.input(z.object({ signature: hex })).mutation(async ({ ctx, input }) => {
    const owner = ctx.auth.address;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    const r = (row?.setup as { revoke?: { userOp: Record<string, unknown>; userOpHash: Hex } } | null)?.revoke;
    if (!row?.registeredAt || row.revokedAt || !r) throw new TRPCError({ code: "BAD_REQUEST", message: "Start the revoke again." });
    const op = userOpFromJson(r.userOp);
    if (userOpHash(op, chains.testnet.id) !== r.userOpHash || !isAddressEqual(await recoverAddress({ hash: hashMessage({ raw: r.userOpHash }), signature: input.signature }), getAddress(owner)))
      throw new TRPCError({ code: "BAD_REQUEST", message: "The revoke signature isn't from your wallet." });
    await ctx.db.transaction(async (tx) => {
      await tx.update(swapKeys).set({ revokedAt: new Date(), setup: { ...(row.setup as object), revoke: { ...r, signature: input.signature } } }).where(eq(swapKeys.address, owner));
      await tx.execute(sql`select pgmq.send('swap_setup', ${JSON.stringify({ address: owner, revoke: true })}::jsonb)`);
    });
    return { revoked: true };
  }),
});
