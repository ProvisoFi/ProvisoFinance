// swap_setup queue: relays a user's signed Robinhood Chain swap setup (R4). In order, each step
// skipped when already done on-chain: one type-4 handleOps tx that 7702-delegates the embedded
// wallet to Kernel v3.3 and installs SwapKeyPolicy (the UserOp pays no gas), the adapter policies,
// the swap-key policy, gas for the session key, and on testnet a tUSDG drip. Setups are refused up
// front (no tx sent) past the setup pool or the owner's share of it, past 2 session-key fundings per
// owner a day, when the swap wallet holds under SETUP_MIN_USDG, or when a key of it was funded under
// 7 days ago (revoked or not: core mints a fresh key per setup, so a re-setup would need new gas),
// or on mainnet when the swap wallet hasn't been funded for SPONSOR_MIN_AGE_S (budget.ts fundedAge).
// A refusal is kept on the row (setup.failed) so the browser can offer to send the same txs itself
// (swapKey.register selfPaid). Revokes are never refused.
import {
  adapterPolicyFromJson,
  ENTRY_POINT_V07,
  entryPointNonceAbi,
  KERNEL_V33_IMPLEMENTATION,
  kernelAbi,
  kernelDelegationCode,
  MODULE_TYPE_EXECUTOR,
  provisoSwapAdapterAbi,
  revokePolicyUserOp,
  SESSION_GAS,
  swapKeyPolicyAbi,
  swapKeyPolicyFromJson,
  swapKeyPolicyHash,
  userOpFromJson,
} from "@proviso/chain";
import { activity, swapKeys, type Db } from "@proviso/db";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { verifyAuthorization } from "viem/utils";
import { erc20Abi, formatUnits, getAddress, isAddressEqual, parseAbi, type Abi, type Address, type Hex, type SignedAuthorization } from "viem";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import type { QueueMessage } from "../queue";
import { dayCounter, rateLimits, txCost, type Budget, type FundedAge } from "./budget";
import { revertName, send, type Clients } from "./chain";

/** `revoke`: relay the signed uninstall of SwapKeyPolicy (swapKey.revoke already set revoked_at). */
export type SwapSetupMsg = { address: string; revoke?: boolean };
/** What swapKey.register adds to swap_keys.setup. */
export type SetupSignatures = {
  authorization?: SignedAuthorization;
  userOp?: Hex;
  adapter: Hex[];
  policy: Hex;
};

const MAX_ATTEMPTS = 3;
const BUDGET = "relayer_budget"; // the setup pool, this owner's share of it, or the reserve said no (budget.ts)
const SETUPS_PER_DAY = 2; // session-key fundings per owner per UTC day
const SETUP_LIMIT = `at most ${SETUPS_PER_DAY} sponsored swap setups a day per account; try again tomorrow`;
const REGAS_MS = 7 * 86_400_000; // one session-key funding per swap wallet per 7 days, revokes included
const RECENT_GAS = "this swap wallet's session key was funded in the last 7 days; try again after 7 days";
const mintAbi = parseAbi(["function mint(address to, uint256 value)"]);

/**
 * `budget`: the "setup" pool. Setups ask it first; revokes only record their spend (exits are never gated).
 * `usdg` + `minUsdg`: a setup is relayed only for a swap wallet holding at least `minUsdg`, so sybils pay something.
 * `funding`: the funded-age rule, applied to the swap wallet (mainnet).
 */
export const swapSetupHandler = (
  db: Db,
  c: Clients,
  d: {
    swapAdapter: Address; swapKeyPolicy: Address; testnetUsdg?: Address; budget?: Budget; usdg?: Address; minUsdg?: bigint; funding?: FundedAge;
    /** Retired SwapKeyPolicy deployments a revoke may also uninstall (legacySwapKeyPolicies()). */
    legacyPolicies?: readonly Address[];
  },
  log = console.error,
) => {
  const unfunded = `fund your swap wallet with at least ${formatUnits(d.minUsdg ?? 0n, 6)} USDG first`;
  const day = dayCounter(db);
  const gasKey = (account: Address) => `session_gas:${account.toLowerCase()}`;
  const installed = async (account: Address, module: Address = d.swapKeyPolicy) =>
    (await c.public.getCode({ address: account }))?.toLowerCase() === kernelDelegationCode &&
    ((await c.public.readContract({ address: account, abi: kernelAbi, functionName: "isModuleInstalled", args: [MODULE_TYPE_EXECUTOR, module, "0x"] })) as boolean);
  const charge = (wei: bigint, who: string) => d.budget?.spend(wei, who).catch((e) => log(`ops: relayer spend not recorded: ${e instanceof Error ? e.message : e}`));
  const handleOps = async (who: string, op: ReturnType<typeof userOpFromJson>, authorizationList?: SignedAuthorization[]) => {
    const hash = await c.wallet.writeContract({
      address: ENTRY_POINT_V07,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[toPackedUserOperation(op)], c.account.address],
      authorizationList,
      account: c.account,
      chain: c.public.chain,
    } as never);
    const r = await c.public.waitForTransactionReceipt({ hash });
    await charge(txCost(r), who);
    if (r.status !== "success") throw new Error(`handleOps ${hash} reverted`);
  };
  /** send(), with what it cost counted against the setup pool for `who`. */
  const paidSend = async (who: string, call: Parameters<typeof send>[1]) => {
    const { receipt } = await send(c, call);
    await charge(txCost(receipt), who);
  };

  /**
   * Relays the signed uninstalls (the current SwapKeyPolicy and/or retired ones, L-4); for a full revoke
   * the key already stopped working in core when revoked_at was set. Never budget-gated.
   */
  async function revoke(row: typeof swapKeys.$inferSelect | undefined, meta?: QueueMessage<SwapSetupMsg>) {
    type Op = { userOp: Record<string, unknown>; module: Address };
    const r = (row?.setup as { revoke?: { legacyOnly?: boolean; ops?: Op[]; signatures?: Hex[] } } | null)?.revoke;
    if (!row || !r?.ops?.length || r.signatures?.length !== r.ops.length || (!r.legacyOnly && !row.revokedAt)) return;
    const owner = row.address;
    const account = getAddress(row.account); // the swap wallet; notifications go to the owner
    const allowed = [d.swapKeyPolicy, ...(d.legacyPolicies ?? [])];
    try {
      for (const [i, o] of r.ops.entries()) {
        const module = getAddress(o.module);
        if (!allowed.some((a) => isAddressEqual(a, module))) throw new Error("bad_revoke");
        const op = { ...userOpFromJson(o.userOp), signature: r.signatures![i]! };
        // The ops were signed with consecutive EntryPoint nonces: one below the account's nonce was relayed
        // on an earlier attempt; one above it means an earlier op was skipped, so the user starts again.
        const next = (await c.public.readContract({ address: ENTRY_POINT_V07, abi: entryPointNonceAbi, functionName: "getNonce", args: [account, 0n] } as never)) as bigint;
        if (op.nonce < next) continue;
        if (!(await installed(account, module))) continue; // already gone (by hand); only the last op may be
        if (op.nonce > next) throw new Error("stale_revoke");
        // Only ever sponsor an uninstall of a SwapKeyPolicy module from this account.
        if (!isAddressEqual(op.sender, account) || op.callData.toLowerCase() !== revokePolicyUserOp({ account, swapKeyPolicy: module, nonce: op.nonce }).callData.toLowerCase())
          throw new Error("bad_revoke");
        await handleOps(owner, op);
        if (await installed(account, module)) throw new Error("revoke_failed");
      }
      await db.insert(activity).values({ address: owner, kind: r.legacyOnly ? "swaps_legacy_removed" : "swaps_revoked", payload: { sessionKey: row.keyAddr } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((meta?.readCt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw e;
      const reason = ["bad_revoke", "revoke_failed", "stale_revoke"].includes(msg) ? msg : "relay_error";
      log(`ops: swap revoke for ${owner} failed (${reason}): ${msg.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`);
      // Its own kind: the key is off in core, but the on-chain policy stays live until it expires.
      await db.insert(activity).values({ address: owner, kind: "swaps_revoke_failed", payload: { reason, sessionKey: row.keyAddr } });
    }
  }

  return async (m: SwapSetupMsg, meta?: QueueMessage<SwapSetupMsg>) => {
    const owner = m.address.toLowerCase();
    const [row] = await db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    if (m.revoke) return revoke(row, meta);
    const setup = row?.setup as (Record<string, any> & { signatures?: SetupSignatures }) | null | undefined;
    if (!row || row.revokedAt || row.registeredAt || !setup?.signatures) return; // nothing (left) to do
    const sig = setup.signatures;
    const account = getAddress(row.account); // the swap wallet; notifications go to the owner
    const read = (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
      c.public.readContract({ address, abi, functionName, args } as never) as Promise<any>;
    const countKey = `relayer_setup_n:${owner}`; // under the setup pool's prefix, so budget.ts prunes past days
    // Refusals that won't change on retry: recorded on the first attempt, before any tx.
    const refusals = [BUDGET, SETUP_LIMIT, unfunded, RECENT_GAS, ...(d.funding ? [d.funding.young] : [])];
    try {
      const policy = swapKeyPolicyFromJson(setup.policy);
      // First, so the wallet's clock starts even when another rule refuses this attempt.
      const age = await d.funding?.check([account]);
      if (d.budget && !(await d.budget.allowed(owner))) throw new Error(BUDGET);
      if ((await day.get(countKey)) >= SETUPS_PER_DAY) throw new Error(SETUP_LIMIT);
      if (d.usdg && d.minUsdg && ((await read(d.usdg, erc20Abi, "balanceOf", [account])) as bigint) < d.minUsdg) throw new Error(unfunded);
      if (age && age !== "funded") throw new Error(age === "young" ? d.funding!.young : unfunded);
      // Skipped when this key is already funded (a retried setup after a partial run).
      const needsGas = (await c.public.getBalance({ address: policy.sessionKey })) < SESSION_GAS / 3n;
      // Kept through revokes, so one funded wallet can't be cycled across accounts. Refusing here
      // (rather than skipping the gas) never leaves a live key without gas.
      if (needsGas && (await db.select().from(rateLimits).where(and(eq(rateLimits.key, gasKey(account)), gt(rateLimits.windowStart, new Date(Date.now() - REGAS_MS))))).length)
        throw new Error(RECENT_GAS);
      if (setup.install) {
        const delegated = (await c.public.getCode({ address: account }))?.toLowerCase() === kernelDelegationCode;
        if (!(await installed(account))) {
          if (!sig.userOp || (!delegated && !sig.authorization)) throw new Error("missing_install_signature");
          // Re-check at relay time: the relayer only ever sponsors a delegation to Kernel v3.3 here.
          const a = sig.authorization;
          if (!delegated && !(isAddressEqual(a!.address, KERNEL_V33_IMPLEMENTATION) && a!.chainId === c.public.chain?.id && (await verifyAuthorization({ address: account, authorization: a! }))))
            throw new Error("bad_authorization");
          await handleOps(owner, { ...userOpFromJson(setup.install.userOp), signature: sig.userOp }, delegated ? undefined : [a!]);
          if (!(await installed(account))) throw new Error("install_failed"); // the UserOp ran but installModule reverted inside it
        }
      }
      for (const [i, j] of (setup.adapterPolicies as Record<string, unknown>[]).entries()) {
        const ap = adapterPolicyFromJson(j);
        const last = (await read(d.swapAdapter, provisoSwapAdapterAbi as Abi, "lastPolicyNonce", [account])) as bigint;
        if (last < ap.nonce) await paidSend(owner, { address: d.swapAdapter, abi: provisoSwapAdapterAbi as Abi, functionName: "setPolicy", args: [ap, sig.adapter[i]] });
      }
      if ((await read(d.swapKeyPolicy, swapKeyPolicyAbi as Abi, "activePolicy", [account])) !== swapKeyPolicyHash(policy))
        await paidSend(owner, { address: d.swapKeyPolicy, abi: swapKeyPolicyAbi as Abi, functionName: "setPolicy", args: [policy, sig.policy] });

      if (needsGas) {
        const r = await c.public.waitForTransactionReceipt({
          hash: await c.wallet.sendTransaction({ to: policy.sessionKey, value: SESSION_GAS, account: c.account, chain: c.public.chain }),
        });
        await charge(txCost(r) + SESSION_GAS, owner);
        await day.add(countKey, 1);
        await db.delete(rateLimits).where(and(eq(rateLimits.key, gasKey(account)), lt(rateLimits.windowStart, new Date(Date.now() - REGAS_MS))));
        await db.insert(rateLimits).values({ key: gasKey(account), windowStart: new Date(), hits: 1 });
      }
      if (d.testnetUsdg && ((await read(d.testnetUsdg, erc20Abi, "balanceOf", [account])) as bigint) < 10n * 10n ** 6n)
        await paidSend(owner, { address: d.testnetUsdg, abi: mintAbi, functionName: "mint", args: [account, 100n * 10n ** 6n] });

      await db.transaction(async (tx) => {
        await tx.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: setup.policy, policySig: sig.policy }).where(eq(swapKeys.address, owner));
        await tx.insert(activity).values({ address: owner, kind: "swaps_ready", payload: { sessionKey: policy.sessionKey } });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Bad signatures and inner reverts won't heal on retry; RPC hiccups might. Give up after a few.
      if (!refusals.includes(msg) && (meta?.readCt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw e;
      // Users see a closed code or a refusal only; logs get the message without URLs (RPC endpoints can carry keys).
      const known = ["missing_install_signature", "bad_authorization", "install_failed", ...refusals];
      const reason = revertName(e) ?? (known.includes(msg) ? msg : "relay_error");
      log(`ops: swap setup for ${owner} failed (${reason}): ${msg.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`);
      await db.insert(activity).values({ address: owner, kind: "swap_setup_failed", payload: { reason } });
      await db.update(swapKeys).set({ setup: { ...setup, failed: reason } }).where(and(eq(swapKeys.address, owner), isNull(swapKeys.registeredAt)));
    }
  };
};
