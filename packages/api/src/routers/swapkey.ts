// Robinhood Chain swap setup (R4), embedded (Privy) wallets only: MetaMask won't 7702-delegate to
// Kernel. The session key is made and sealed in the core enclave; this route turns it into the
// payloads the main key signs, checks the signatures, and queues them for the ops relayer.
import { buildSwapSetup, swapWalletProofMessage, chainConfig, deployment, ENTRY_POINT_V07, entryPointNonceAbi, KERNEL_V33_IMPLEMENTATION, network, revokePolicyUserOp, swapConfig, userOpFromJson, userOpHash, swapSetupFromJson, swapSetupTypedData, toJsonSafe, type SwapSetup } from "@proviso/chain";
import { swapKeys } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { createPublicClient, getAddress, hashMessage, http, isAddressEqual, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { verifyAuthorization } from "viem/utils";
import { z } from "zod";
import { authedProcedure, limitedProcedure, router } from "../trpc";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/) as unknown as z.ZodType<Hex>;
// Read per call: on mainnet deployment() throws until the contracts are deployed.
const contracts = () => {
  const d = deployment();
  return { swapAdapter: d.swapAdapter!, swapKeyPolicy: d.swapKeyPolicy! };
};
const typedData = (s: SwapSetup) => swapSetupTypedData(s, contracts());

export const swapKeyRouter = router({
  status: authedProcedure.query(async ({ ctx }) => {
    const [k] = await ctx.db
      .select({ account: swapKeys.account, keyAddr: swapKeys.keyAddr, expiresAt: swapKeys.expiresAt, registeredAt: swapKeys.registeredAt, revokedAt: swapKeys.revokedAt, setup: swapKeys.setup })
      .from(swapKeys)
      .where(eq(swapKeys.address, ctx.auth.address));
    if (!k || k.revokedAt) return { state: "none" as const };
    if (k.registeredAt) return { state: "ready" as const, account: k.account, sessionKey: k.keyAddr, expiresAt: k.expiresAt };
    const signed = !!(k.setup as { signatures?: unknown } | null)?.signatures;
    return { state: signed ? ("relaying" as const) : ("unsigned" as const), account: k.account, sessionKey: k.keyAddr, expiresAt: k.expiresAt };
  }),

  // Asks the enclave for a fresh session key, then builds everything the main key signs. Never
  // holds the request open: while the enclave is still making the key it answers
  // { pending: true } at once and the browser asks again (some browsers drop slow responses).
  // `account`: the swap wallet (the account's embedded wallet); default the sign-in wallet itself.
  // Control of it is proven at register (every signature must come from it).
  // A swap wallet other than the sign-in wallet must prove control (`proof`: its signature over
  // swapWalletProofMessage) before anything is bound to it.
  prepare: limitedProcedure("swapPrepare").input(z.object({ account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), proof: hex.optional() }).optional()).mutation(async ({ ctx, input }): Promise<{ pending: true } | { pending: false; setup: SwapSetup; typedData: ReturnType<typeof typedData> }> => {
    if (network() === "local") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Robinhood Chain swaps need CHAIN_NETWORK testnet or mainnet." });
    const chain = chainConfig().chain;
    const owner = ctx.auth.address;
    const account = (input?.account ?? owner).toLowerCase();
    if (account !== owner) {
      const ok = !!input?.proof && isAddressEqual(await recoverMessageAddress({ message: swapWalletProofMessage(account, owner), signature: input.proof }), getAddress(account));
      if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "The swap wallet didn't prove it belongs to this account." });
    }
    // One live setup per account: no silent re-keying (and no re-funded session keys) once ready.
    const [prev] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (prev && !prev.revokedAt && prev.registeredAt && prev.expiresAt > new Date())
      throw new TRPCError({ code: "CONFLICT", message: "Swaps are already set up for this account." });
    // A swap wallet serves one account at a time (revoked keys don't count). Control of it is
    // proven above, so another account's unregistered row on it is this same person's stale
    // attempt (e.g. an earlier email login) and is dropped; a registered one blocks.
    const [other] = await ctx.db.select().from(swapKeys).where(and(eq(swapKeys.account, account), ne(swapKeys.address, owner), isNull(swapKeys.revokedAt)));
    if (other?.registeredAt) throw new TRPCError({ code: "CONFLICT", message: "That swap wallet already serves another Proviso account; revoke it there first." });
    if (other) await ctx.db.delete(swapKeys).where(and(eq(swapKeys.address, other.address), isNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt)));
    // An unsigned key for this swap wallet from the last 10 minutes is reused (a second click, a
    // dropped response), so repeated clicks never mint a stream of enclave keys.
    const row = prev && prev.account === account && !prev.registeredAt && !prev.revokedAt && Date.now() - prev.createdAt.getTime() < 10 * 60_000 ? prev : undefined;
    if (!row) {
      // One request in flight per owner: repeated polls don't queue more keys.
      const queued = await ctx.db.execute(sql`select 1 from pgmq.q_agent where message->>'owner' = ${owner} and message->>'kind' = 'swap' limit 1`);
      if (!(queued as unknown as unknown[]).length) await ctx.db.execute(sql`select pgmq.send('agent', ${JSON.stringify({ owner, kind: "swap", account })}::jsonb)`);
      return { pending: true };
    }

    const setup = await buildSwapSetup(createPublicClient({ chain, transport: http(process.env.RHC_RPC_URL) }) as never, {
      chainId: chain.id,
      account: getAddress(account),
      sessionKey: row.keyAddr as Address,
      expiresAt: BigInt(Math.floor(row.expiresAt.getTime() / 1000)),
      ...contracts(),
      markets: swapConfig().markets,
      caps: swapConfig().caps,
    });
    await ctx.db.update(swapKeys).set({ setup: toJsonSafe(setup) }).where(eq(swapKeys.address, owner));
    return { pending: false, setup, typedData: typedData(setup) };
  }),

  // Checks every signature against the main key, then queues the setup for the ops relayer.
  register: limitedProcedure("swapRegister")
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
      const account = getAddress(row.account); // the swap wallet signs everything
      const bad = (what: string) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: `The ${what} signature isn't from your swap wallet.` });
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
          if (!a || !isAddressEqual(a.address, KERNEL_V33_IMPLEMENTATION) || !isAddressEqual(want.address, KERNEL_V33_IMPLEMENTATION) || a.chainId !== chainConfig().chain.id || a.chainId !== want.chainId || a.nonce !== want.nonce)
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
  prepareRevoke: limitedProcedure("swapPrepare").mutation(async ({ ctx }) => {
    const owner = ctx.auth.address;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (!row?.registeredAt || row.revokedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no active swap key to revoke." });
    const chain = chainConfig().chain;
    const pub = createPublicClient({ chain, transport: http(process.env.RHC_RPC_URL) });
    const account = getAddress(row.account);
    const nonce = (await pub.readContract({ address: ENTRY_POINT_V07, abi: entryPointNonceAbi, functionName: "getNonce", args: [account, 0n] })) as bigint;
    const userOp = revokePolicyUserOp({ account, swapKeyPolicy: contracts().swapKeyPolicy, nonce });
    const revoke = { userOp, userOpHash: userOpHash(userOp, chain.id) };
    await ctx.db.update(swapKeys).set({ setup: { ...(row.setup as object), revoke: toJsonSafe(revoke) } }).where(eq(swapKeys.address, owner));
    return revoke;
  }),

  revoke: limitedProcedure("swapRevoke").input(z.object({ signature: hex })).mutation(async ({ ctx, input }) => {
    const owner = ctx.auth.address;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    const r = (row?.setup as { revoke?: { userOp: Record<string, unknown>; userOpHash: Hex } } | null)?.revoke;
    if (!row?.registeredAt || row.revokedAt || !r) throw new TRPCError({ code: "BAD_REQUEST", message: "Start the revoke again." });
    const op = userOpFromJson(r.userOp);
    if (userOpHash(op, chainConfig().chain.id) !== r.userOpHash || !isAddressEqual(await recoverAddress({ hash: hashMessage({ raw: r.userOpHash }), signature: input.signature }), getAddress(row.account)))
      throw new TRPCError({ code: "BAD_REQUEST", message: "The revoke signature isn't from your swap wallet." });
    await ctx.db.transaction(async (tx) => {
      await tx.update(swapKeys).set({ revokedAt: new Date(), setup: { ...(row.setup as object), revoke: { ...r, signature: input.signature } } }).where(eq(swapKeys.address, owner));
      await tx.execute(sql`select pgmq.send('swap_setup', ${JSON.stringify({ address: owner, revoke: true })}::jsonb)`);
    });
    return { revoked: true };
  }),
});
