// Robinhood Chain swap setup (R4), embedded (Privy) wallets only: MetaMask won't 7702-delegate to
// Kernel. The session key is made and sealed in the core enclave; this route turns it into the
// payloads the main key signs, checks the signatures, and queues them for the ops relayer. When the
// relayer won't sponsor it, the browser sends the same txs from the user's wallet (register selfPaid),
// and the setup is recorded only once all of it is live on-chain.
import { activity, swapKeys } from "@proviso/db";
import { buildSwapSetup, swapSetupProgress, swapWalletProofMessage, chainConfig, deployment, ENTRY_POINT_V07, entryPointNonceAbi, kernelAbi, KERNEL_V33_IMPLEMENTATION, legacySwapKeyPolicies, MODULE_TYPE_EXECUTOR, network, revokePolicyUserOp, swapConfig, userOpFromJson, userOpHash, swapSetupFromJson, swapSetupTypedData, toJsonSafe, type SwapSetup } from "@proviso/chain";
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
const rhc = () => createPublicClient({ chain: chainConfig().chain, transport: http(process.env.RHC_RPC_URL) });
/** Retired SwapKeyPolicy modules still installed on `account` (L-4); [] on any read error (plain EOA). */
const installedLegacy = async (account: Address): Promise<Address[]> => {
  const pub = rhc();
  const on = await Promise.all(legacySwapKeyPolicies().map((m) =>
    pub.readContract({ address: account, abi: kernelAbi, functionName: "isModuleInstalled", args: [MODULE_TYPE_EXECUTOR, m, "0x"] }).catch(() => false)));
  return legacySwapKeyPolicies().filter((_, i) => on[i] === true);
};

/** Robinhood Chain swap session key for the signed-in caller: set up, register, revoke. */
export const swapKeyRouter = router({
  /** The caller's swap-key state (none, unsigned, relaying, failed, ready) and whether a retired policy module is still installed (`legacy`). */
  status: authedProcedure.query(async ({ ctx }) => {
    const [k] = await ctx.db
      .select({ account: swapKeys.account, keyAddr: swapKeys.keyAddr, expiresAt: swapKeys.expiresAt, registeredAt: swapKeys.registeredAt, revokedAt: swapKeys.revokedAt, setup: swapKeys.setup })
      .from(swapKeys)
      .where(eq(swapKeys.address, ctx.auth.address));
    // An older swap permission (retired SwapKeyPolicy) still installed on the wallet: the app offers to remove it.
    const legacy = k && legacySwapKeyPolicies().length ? (await installedLegacy(getAddress(k.account))).length > 0 : false;
    if (!k || k.revokedAt) return { state: "none" as const, legacy };
    if (k.registeredAt) return { state: "ready" as const, account: k.account, sessionKey: k.keyAddr, expiresAt: k.expiresAt, legacy };
    const s = k.setup as { signatures?: unknown; failed?: string } | null;
    // failed: the relayer refused or gave up (ops swaps.ts); the browser can send the setup itself.
    if (s?.signatures && s.failed) return { state: "failed" as const, reason: s.failed, account: k.account, sessionKey: k.keyAddr, expiresAt: k.expiresAt };
    return { state: s?.signatures ? ("relaying" as const) : ("unsigned" as const), account: k.account, sessionKey: k.keyAddr, expiresAt: k.expiresAt };
  }),

  /**
   * Asks the enclave for a fresh session key, then builds everything the main key signs. Never
   * holds the request open: while the enclave is still making the key it answers
   * { pending: true } at once and the browser asks again (some browsers drop slow responses).
   * `account`: the swap wallet (the account's embedded wallet); default the sign-in wallet itself.
   * Control of it is proven at register (every signature must come from it).
   * A swap wallet other than the sign-in wallet must prove control (`proof`: its signature over
   * swapWalletProofMessage) before anything is bound to it.
   */
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

    const setup = await buildSwapSetup(rhc() as never, {
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

  /**
   * Checks every signature against the main key, then queues the setup for the ops relayer.
   * selfPaid: the user's wallet already sent the setup txs; it is recorded only when the delegation,
   * SwapKeyPolicy, every policy at its nonce and the session key's gas are all live on-chain.
   */
  register: limitedProcedure("swapRegister")
    .input(
      z.object({
        authorization: z.object({ address: hex, chainId: z.number(), nonce: z.number(), r: hex, s: hex, yParity: z.number() }).optional(),
        userOp: hex.optional(),
        adapter: z.array(hex).max(8),
        policy: hex,
        selfPaid: z.boolean().optional(),
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
        if (want && !input.selfPaid) {
          // A self-sent delegation is signed at the sender's next nonce; it is checked on-chain below instead.
          const a = input.authorization;
          if (!a || !isAddressEqual(a.address, KERNEL_V33_IMPLEMENTATION) || !isAddressEqual(want.address, KERNEL_V33_IMPLEMENTATION) || a.chainId !== chainConfig().chain.id || a.chainId !== want.chainId || a.nonce !== want.nonce)
            bad("delegation");
          if (!(await verifyAuthorization({ address: account, authorization: { ...a!, address: a!.address as Address } }))) bad("delegation");
        }
      }
      if (input.selfPaid) {
        const c = contracts();
        const p = await swapSetupProgress(rhc() as never, setup, { account, ...c });
        if (!p.complete) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The setup isn't fully on-chain yet (account upgrade, policies and session-key gas). Finish sending it, then try again." });
        await ctx.db.transaction(async (tx) => {
          await tx.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: (row.setup as { policy: unknown }).policy, policySig: input.policy }).where(eq(swapKeys.address, owner));
          await tx.insert(activity).values({ address: owner, kind: "swaps_ready", payload: { sessionKey: setup.policy.sessionKey, selfPaid: true } });
        });
        return { queued: false };
      }
      const signatures = { authorization: want ? input.authorization : undefined, userOp: setup.install ? input.userOp : undefined, adapter: input.adapter, policy: input.policy };
      await ctx.db.transaction(async (tx) => {
        await tx.update(swapKeys).set({ setup: { ...(row.setup as object), signatures, failed: undefined } }).where(eq(swapKeys.address, owner));
        await tx.execute(sql`select pgmq.send('swap_setup', ${JSON.stringify({ address: owner })}::jsonb)`);
      });
      return { queued: true };
    }),

  /**
   * Revoke: zero-fee UserOps, one per SwapKeyPolicy module installed on the swap wallet (the current
   * one, plus retired ones left from an earlier setup, L-4). The key stops working in core at once
   * (revoked_at); ops relays the on-chain uninstalls. Bought tokens stay in the wallet.
   * `legacyOnly`: remove only the retired modules and keep the current setup.
   */
  prepareRevoke: limitedProcedure("swapPrepare").input(z.object({ legacyOnly: z.boolean().optional() }).optional()).mutation(async ({ ctx, input }) => {
    const owner = ctx.auth.address;
    const legacyOnly = !!input?.legacyOnly;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (!row || (!legacyOnly && (!row.registeredAt || row.revokedAt))) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no active swap key to revoke." });
    const chain = chainConfig().chain;
    const account = getAddress(row.account);
    // Retired modules first, the current one last: ops skips a module that is already gone, and only a
    // skipped last op leaves no gap in the EntryPoint nonce sequence the others were signed with.
    const modules = [...(await installedLegacy(account)), ...(legacyOnly ? [] : [contracts().swapKeyPolicy])];
    if (!modules.length) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no older swap permission on this wallet." });
    const nonce = (await rhc().readContract({ address: ENTRY_POINT_V07, abi: entryPointNonceAbi, functionName: "getNonce", args: [account, 0n] })) as bigint;
    const ops = modules.map((module, i) => {
      const userOp = revokePolicyUserOp({ account, swapKeyPolicy: module, nonce: nonce + BigInt(i) });
      return { userOp, userOpHash: userOpHash(userOp, chain.id), module };
    });
    const revoke = { legacyOnly, ops };
    await ctx.db.update(swapKeys).set({ setup: { ...(row.setup as object), revoke: toJsonSafe(revoke) } }).where(eq(swapKeys.address, owner));
    return revoke;
  }),

  /**
   * Checks one swap-wallet signature per op from prepareRevoke, marks the key revoked (unless `legacyOnly`)
   * and queues the uninstalls for the ops relayer.
   */
  revoke: limitedProcedure("swapRevoke").input(z.object({ signatures: z.array(hex).min(1).max(8) })).mutation(async ({ ctx, input }) => {
    const owner = ctx.auth.address;
    const [row] = await ctx.db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    const r = (row?.setup as { revoke?: { legacyOnly?: boolean; ops?: { userOp: Record<string, unknown>; userOpHash: Hex; module: Address }[] } } | null)?.revoke;
    if (!row || !r?.ops?.length || (!r.legacyOnly && (!row.registeredAt || row.revokedAt))) throw new TRPCError({ code: "BAD_REQUEST", message: "Start the revoke again." });
    if (input.signatures.length !== r.ops.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Sign every step of the revoke." });
    for (const [i, o] of r.ops.entries()) {
      const ok = userOpHash(userOpFromJson(o.userOp), chainConfig().chain.id) === o.userOpHash &&
        isAddressEqual(await recoverAddress({ hash: hashMessage({ raw: o.userOpHash }), signature: input.signatures[i]! }), getAddress(row.account));
      if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: "The revoke signature isn't from your swap wallet." });
    }
    await ctx.db.transaction(async (tx) => {
      const revoke = { ...r, signatures: input.signatures };
      await tx.update(swapKeys).set({ ...(r.legacyOnly ? {} : { revokedAt: new Date() }), setup: { ...(row.setup as object), revoke } }).where(eq(swapKeys.address, owner));
      await tx.execute(sql`select pgmq.send('swap_setup', ${JSON.stringify({ address: owner, revoke: true })}::jsonb)`);
    });
    return { revoked: true };
  }),
});
