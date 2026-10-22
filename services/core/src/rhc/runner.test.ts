import { describe, expect, test } from "bun:test";
import { buildSwapKeyPolicy, TESTNET_SWAP, toJsonSafe } from "@proviso/chain";
import { activity, feedWanted, fires, follows, orders, swapKeys, theses, users } from "@proviso/db";
import { Spec } from "@proviso/dsl";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { spec as mkSpec, priceAbove } from "../evaluator/testkit";
import { insertThesis, OWNER, setup } from "../runtime/fixture";
import type { sendSwap, SwapJob } from "./executor";
import { SessionKeyManager } from "./policy";
import { handleSwapKeyRequest, SwapRunner, type SwapExit } from "./runner";

const M = TESTNET_SWAP.markets[0]!;
const FOLLOWER = "0x00000000000000000000000000000000000000bb";
const buy = { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 10 }, maxSlipPct: 1 } as const;
// Buys at $400 per TSLA, stop -5%, take +10%.
const SPEC = Spec.parse({ ...mkSpec(priceAbove("BTC", 1)), entry: { ...mkSpec(priceAbove("BTC", 1)).entry, then: [buy] }, exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" } });
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;

const transfer = (token: Address, to: Address, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: M.key.currency0, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

const SWAP_WALLET = "0x00000000000000000000000000000000000000dd";
async function world(o: { follower?: boolean; registered?: boolean; allowlist?: boolean | "api"; swapWallet?: boolean; followerExitWaitMs?: number } = {}) {
  const { db, pub } = await setup();
  await insertThesis(db, pub, 1n, { state: "fired" });
  const [fire] = await db.insert(fires).values({ thesisId: 1n, firedAt: new Date(), refMark: "100" }).returning({ id: fires.id });
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const manager = new SessionKeyManager(sealKey);
  const register = async (owner: string, account = owner) => {
    const sessionKey = await handleSwapKeyRequest(db, manager, owner, { chainId: 46630, days: 30, account });
    const policy = buildSwapKeyPolicy({
      account: account as Address, sessionKey, adapter: "0x00000000000000000000000000000000000000cc",
      caps: [{ token: TESTNET_SWAP.usdg, maxPerTx: 100n * E6, maxPerDay: 200n * E6 }], pools: [M.key],
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400), nonce: 1n,
    });
    if (o.registered !== false)
      await db.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: toJsonSafe(policy), policySig: "0x01" }).where(eq(swapKeys.address, owner));
    return sessionKey;
  };
  const sessions = { caller: await register(OWNER, o.swapWallet ? SWAP_WALLET : OWNER) } as Record<string, string>;
  if (o.follower) {
    await db.insert(users).values({ address: FOLLOWER, limits: { maxUsd: 1000, maxLev: 3 } });
    sessions.follower = await register(FOLLOWER);
    await db.insert(follows).values({
      follower: FOLLOWER, caller: OWNER, active: true, sizeRule: { kind: "fixed", usd: 4 }, limits: { maxUsd: 1000, maxLev: 3 },
      sealedAllowlist:
        o.allowlist === false ? null
        // The object follow.create used to store (rows written before the P-M1 fix are still in this shape).
        : o.allowlist === "api" ? { coins: ["TSLA"], sides: ["long", "short"], maxUsd: 5, maxLev: 1 }
        : [{ coin: "TSLA", side: "both", maxUsd: 5, maxLev: 1 }],
    });
  }
  const calls: { account: string; amountIn?: bigint; tokenIn: string; usd: number }[] = [];
  const exits: SwapExit[] = [];
  let staleOnce = false;
  let nonceErrors = 0;
  let nonceMessage = "Nonce provided for the transaction is lower than the current nonce of the account.";
  // Swaps in flight per session wallet (sent, receipt not yet awaited): the runner keeps it <= 1.
  const inflight = new Map<string, number>();
  let maxInflight = 0;
  // A fake chain: buys fill at $400 / TSLA, sells at the current price.
  let price = 400;
  const slowFor = new Map<string, number>();
  const send = (async (_d: unknown, job: SwapJob) => {
    const account = job.policy.account;
    const delay = slowFor.get(account.toLowerCase());
    if (delay) await Bun.sleep(delay);
    calls.push({ account: account.toLowerCase(), amountIn: job.amountIn, tokenIn: job.action.tokenIn, usd: job.action.size.usd });
    if (staleOnce) return (staleOnce = false), { plan: { ok: false, reason: "stale_oracle" } };
    if (nonceErrors > 0 && nonceErrors--) throw new Error(nonceMessage);
    const n = (inflight.get(account) ?? 0) + 1;
    inflight.set(account, n);
    maxInflight = Math.max(maxInflight, n);
    const isBuy = job.action.tokenIn === "USDG";
    const amountIn = job.amountIn ?? BigInt(Math.round(job.action.size.usd * 1e6));
    const out = isBuy ? (amountIn * E18 * 10n ** 0n) / (BigInt(price) * E6) : (amountIn * BigInt(price) * E6) / E18;
    const hash = `0x${(calls.length).toString(16).padStart(64, "0")}` as Hex;
    receipts.set(hash, [transfer(isBuy ? TESTNET_SWAP.tsla : TESTNET_SWAP.usdg, account, out)]);
    owners.set(hash, account);
    return { plan: { ok: true, key: M.key, zeroForOne: isBuy, tokenIn: TESTNET_SWAP.usdg, amountIn, minOut: 1n, expectedOut: out }, hash };
  }) as unknown as typeof sendSwap;
  const receipts = new Map<Hex, unknown[]>();
  const owners = new Map<Hex, string>();
  const sleeps: number[] = [];
  const runner = new SwapRunner({
    db, sealKey, swapKeyPolicy: OWNER, poolManager: OWNER, markets: TESTNET_SWAP.markets,
    publicClient: {
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        await Bun.sleep(5);
        const a = owners.get(hash)!;
        inflight.set(a, inflight.get(a)! - 1);
        return { status: "success", logs: receipts.get(hash) ?? [] };
      },
    } as unknown as PublicClient,
    walletFor: (pk) => ({ account: privateKeyToAccount(pk) }) as unknown as WalletClient,
    sleep: async (ms) => void sleeps.push(ms),
    onExit: (e) => void exits.push(e),
    send,
    followerExitWaitMs: o.followerExitWaitMs,
  });
  return {
    db, pub, fireId: fire!.id, sessions, calls, exits, sleeps, runner, sealKey, send,
    setPrice: (p: number) => (price = p),
    stale: () => (staleOnce = true),
    nonceErrors: (n: number, message?: string) => ((nonceErrors = n), message && (nonceMessage = message)),
    slow: (account: string, ms: number) => slowFor.set(account.toLowerCase(), ms),
    maxInflight: () => maxInflight,
    fire: () => runner.run({ owner: OWNER, thesisId: 1n, fireId: fire!.id, actions: [buy], spec: SPEC }),
  };
}

import { eq } from "drizzle-orm";

describe("swap runner", () => {
  test("Fair Copy: the allow-listed follower swaps first at its own size, then the caller; amounts come from the receipt", async () => {
    const w = await world({ follower: true });
    await w.fire();
    expect(w.calls.map((c) => [c.account, c.usd])).toEqual([[FOLLOWER, 4], [OWNER, 10]]);
    const rows = await w.db.select().from(orders);
    expect(rows.map((r) => [r.role, r.wave, r.side, r.status, r.size, r.filledSize])).toEqual([
      ["follower", 1, "buy", "filled", "4000000", String(E18 / 100n)],
      ["caller", 2, "buy", "filled", "10000000", String(E18 / 40n)],
    ]);
    expect(Number(rows[1]!.avgPx)).toBeCloseTo(400);
    expect(w.runner.openIdeas()).toEqual([1n]);
    expect((await w.db.select().from(activity)).map((a) => a.kind)).toEqual(["swap_done", "swap_done", "swap_entered"]);
  });

  test("take-profit: holdings are sold back (follower first), the exit is reported with the caller's P&L", async () => {
    const w = await world({ follower: true });
    await w.fire();
    w.setPrice(445);
    w.runner.onPrice("TSLA", 445); // above the +10% take at 440
    await w.runner.idle();
    const sells = w.calls.slice(2);
    expect(sells.map((c) => [c.account, c.tokenIn, c.amountIn])).toEqual([[FOLLOWER, "TSLA", E18 / 100n], [OWNER, "TSLA", E18 / 40n]]);
    expect(w.exits).toHaveLength(1);
    expect(w.exits[0]).toMatchObject({ thesisId: 1n, reason: "take" });
    expect(w.exits[0]!.pnl).toBeCloseTo(1.125); // 0.025 TSLA bought for $10, sold at $445
    expect(w.runner.openIdeas()).toEqual([]);
    expect((await w.db.select().from(orders)).filter((o) => o.side === "sell").every((o) => o.reduceOnly && o.status === "filled")).toBe(true);
  });

  test("an idea the Hyperliquid executor holds is not exited by the swap runner on its own", async () => {
    const w = await world();
    (w.runner as unknown as { d: { hlOwns: () => boolean } }).d.hlOwns = () => true;
    await w.fire();
    w.runner.onPrice("TSLA", 300);
    await w.runner.idle();
    expect(w.calls).toHaveLength(1);
    await w.runner.close(1n, "stop"); // the executor's exit sells it, without a second report
    expect(w.calls).toHaveLength(2);
    expect(w.exits).toEqual([]);
  });

  test("a stale oracle is retried once after asking for the feed", async () => {
    const w = await world();
    w.stale();
    await w.fire();
    expect(w.calls).toHaveLength(2);
    expect(w.sleeps).toEqual([12000]);
    expect((await w.db.select().from(feedWanted)).map((r) => r.feed)).toEqual([M.oracle.toLowerCase()]);
  });

  test("two ideas of one owner firing in one tick: their swaps on the one session key never overlap", async () => {
    const w = await world();
    await insertThesis(w.db, w.pub, 2n, { state: "fired" });
    const [f2] = await w.db.insert(fires).values({ thesisId: 2n, firedAt: new Date(), refMark: "100" }).returning({ id: fires.id });
    await Promise.all([w.fire(), w.runner.run({ owner: OWNER, thesisId: 2n, fireId: f2!.id, actions: [buy], spec: SPEC })]);
    expect(w.maxInflight()).toBe(1);
    expect((await w.db.select().from(orders)).map((r) => r.status)).toEqual(["filled", "filled"]);
    expect(w.runner.openIdeas().sort()).toEqual([1n, 2n]);
  });

  test("a lost nonce race is retried exactly once (re-planned); a second loss is recorded as nonce_conflict", async () => {
    const w = await world();
    w.nonceErrors(1);
    await w.fire();
    expect(w.calls).toHaveLength(2);
    expect((await w.db.select().from(orders)).map((r) => r.status)).toEqual(["filled"]);

    const v = await world();
    v.nonceErrors(5);
    await v.fire();
    expect(v.calls).toHaveLength(2);
    const [o] = await v.db.select().from(orders);
    expect([o!.status, o!.error?.split(":")[0]]).toEqual(["rejected", "nonce_conflict"]);
  });

  test("L-2: \"replacement transaction underpriced\" is not re-sent at a new nonce (the pending tx may still land)", async () => {
    const w = await world();
    w.nonceErrors(1, "replacement transaction underpriced");
    await w.fire();
    expect(w.calls).toHaveLength(1);
    const [o] = await w.db.select().from(orders);
    expect([o!.status, o!.error?.split(":")[0]]).toEqual(["rejected", "nonce_conflict"]);
  });

  test("after a restart the open position is rebuilt from orders, and a stop request sells it", async () => {
    const w = await world();
    await w.fire();
    const fresh = new SwapRunner({ ...(w.runner as unknown as { d: ConstructorParameters<typeof SwapRunner>[0] }).d });
    expect(await fresh.restore(() => SPEC)).toEqual([1n]);
    expect(await fresh.stop(1n)).toBe(true);
    expect(w.calls.at(-1)).toMatchObject({ account: OWNER, tokenIn: "TSLA", amountIn: E18 / 40n });
    expect(w.exits.at(-1)).toMatchObject({ reason: "stopped" });
    expect(await fresh.restore(() => SPEC)).toEqual([]); // sold: nothing left to rebuild
  });

  test("a repeat idea stays live after firing; a restart still rebuilds its position and the stop sells it (TU-01)", async () => {
    const w = await world();
    await w.fire();
    await w.db.update(theses).set({ state: "live" }).where(eq(theses.id, 1n));
    const fresh = new SwapRunner({ ...(w.runner as unknown as { d: ConstructorParameters<typeof SwapRunner>[0] }).d });
    expect(await fresh.restore(() => ({ ...SPEC, fire: "repeat" }))).toEqual([1n]);
    fresh.onPrice("TSLA", 300); // stop
    await fresh.idle();
    expect(w.calls.at(-1)).toMatchObject({ account: OWNER, tokenIn: "TSLA" });
    expect(w.exits.at(-1)).toMatchObject({ reason: "stop" });
    expect(await fresh.restore(() => SPEC)).toEqual([]);
  });

  test("P-M1: a follow stored in the API's object shape still auto-copies (no tap-to-confirm)", async () => {
    const w = await world({ follower: true, allowlist: "api" });
    await w.fire();
    expect(w.calls.map((c) => c.account)).toEqual([FOLLOWER, OWNER]); // follower wave first, automatically
    expect((await w.db.select().from(activity).where(eq(activity.address, FOLLOWER))).map((a) => a.kind)).not.toContain("copy_confirm_required");
  });

  test("L-1: Stop pressed while a late copy is going in waits for it, then sells everything (no silent no-op)", async () => {
    const w = await world({ follower: true, allowlist: false });
    await w.fire();
    const [follow] = await w.db.select().from(follows);
    w.slow(FOLLOWER, 300);
    const copying = w.runner.confirm({ address: FOLLOWER, follow: follow!, fireId: w.fireId });
    await Bun.sleep(20); // the late copy now holds the idea
    expect(await w.runner.stop(1n)).toBe(true);
    expect(await copying).toBe("placed");
    expect(w.calls.filter((c) => c.tokenIn === "TSLA").map((c) => c.account).sort()).toEqual([FOLLOWER, OWNER].sort());
    expect(w.runner.holds(1n)).toBe(false);
    expect(w.exits).toMatchObject([{ reason: "stopped" }]);
  });

  test("two quick presses of the same confirm buy once, even when the second waited behind the first", async () => {
    const w = await world({ follower: true, allowlist: false });
    await w.fire();
    const [follow] = await w.db.select().from(follows);
    w.slow(FOLLOWER, 100);
    const press = () => w.runner.confirm({ address: FOLLOWER, follow: follow!, fireId: w.fireId });
    const results = await Promise.all([press(), press()]);
    expect(results.sort()).toEqual(["placed", "refused"]);
    expect(w.calls.filter((c) => c.account === FOLLOWER)).toHaveLength(1);
  });

  test("Stop pressed during an entry waits for it, then sells (it is no longer dropped)", async () => {
    const w = await world();
    w.slow(OWNER, 200);
    const firing = w.fire();
    await Bun.sleep(20); // the caller's buy is in flight
    expect(w.runner.holds(1n)).toBe(true); // registered for the whole entry
    expect(await w.runner.stop(1n)).toBe(true);
    await firing;
    expect(w.calls.map((c) => c.tokenIn)).toEqual(["USDG", "TSLA"]); // bought, then sold
    expect(w.runner.holds(1n)).toBe(false);
    expect(w.exits).toMatchObject([{ reason: "stopped" }]);
  });

  test("an entry that buys nothing leaves nothing registered", async () => {
    const w = await world();
    w.nonceErrors(5); // every send fails
    await w.fire();
    expect(w.runner.holds(1n)).toBe(false);
  });

  test("L-1: a follower whose buy is stuck can't hold the caller's entry beyond the wait; its holding still counts", async () => {
    const w = await world({ follower: true, followerExitWaitMs: 50 });
    w.slow(FOLLOWER, 400);
    const t0 = Date.now();
    let callerBoughtAt = 0;
    const firing = w.fire();
    while (!callerBoughtAt) {
      if (w.calls.some((c) => c.account === OWNER && c.tokenIn === "USDG")) callerBoughtAt = Date.now() - t0;
      await Bun.sleep(5);
    }
    expect(callerBoughtAt).toBeLessThan(300);
    await firing;
    expect(w.runner.holds(1n)).toBe(true);
    w.runner.onPrice("TSLA", 300); // stop: the late follower holding is sold too
    await w.runner.idle();
    expect(w.calls.filter((c) => c.tokenIn === "TSLA").map((c) => c.account).sort()).toEqual([FOLLOWER, OWNER].sort());
  });

  test("L-1: a follower whose sell is stuck can't hold the caller's stop-loss beyond the wait", async () => {
    const w = await world({ follower: true, followerExitWaitMs: 50 });
    await w.fire();
    w.slow(FOLLOWER, 400);
    const t0 = Date.now();
    let callerSoldAt = 0;
    const exitDone = (async () => { w.runner.onPrice("TSLA", 300); await w.runner.idle(); })();
    while (!callerSoldAt) {
      if (w.calls.some((c) => c.account === OWNER && c.tokenIn === "TSLA")) callerSoldAt = Date.now() - t0;
      await Bun.sleep(5);
    }
    expect(callerSoldAt).toBeLessThan(300); // sold before the stuck follower finished
    await exitDone;
    expect(w.exits).toMatchObject([{ reason: "stop" }]);
  });

  test("a follower without an allow-list gets a one-tap confirm; pressing it buys their share, which exits with the caller", async () => {
    const w = await world({ follower: true, allowlist: false });
    await w.fire();
    expect(w.calls.map((c) => c.account)).toEqual([OWNER]); // no auto copy
    const asked = (await w.db.select().from(activity).where(eq(activity.address, FOLLOWER))).find((a) => a.kind === "copy_confirm_required");
    expect(asked?.payload).toMatchObject({ coin: "TSLA", side: "buy", notionalUsd: 4, caller: OWNER, venue: "rhc", fireId: w.fireId });
    const [follow] = await w.db.select().from(follows);
    expect(w.runner.holds(1n)).toBe(true);
    expect(await w.runner.confirm({ address: FOLLOWER, follow: follow!, fireId: w.fireId })).toBe("placed");
    expect(w.calls.at(-1)).toMatchObject({ account: FOLLOWER, usd: 4 });
    expect(await w.runner.confirm({ address: FOLLOWER, follow: follow!, fireId: w.fireId })).toBe("refused"); // once
    w.runner.onPrice("TSLA", 300); // stop
    await w.runner.idle();
    expect(w.calls.slice(-2).map((c) => [c.account, c.tokenIn])).toEqual([[FOLLOWER, "TSLA"], [OWNER, "TSLA"]]);
    expect(w.exits).toMatchObject([{ reason: "stop" }]);
  });

  test("one account, two wallets: the swap wallet trades, the account gets the activity; restore finds it by swap wallet", async () => {
    const w = await world({ swapWallet: true });
    await w.fire();
    expect(w.calls.map((c) => c.account)).toEqual([SWAP_WALLET]);
    expect((await w.db.select().from(orders)).map((r) => r.account)).toEqual([SWAP_WALLET]);
    expect((await w.db.select().from(activity)).map((a) => [a.address, a.kind])).toEqual([[OWNER, "swap_done"], [OWNER, "swap_entered"]]);
    const fresh = new SwapRunner({ ...(w.runner as unknown as { d: ConstructorParameters<typeof SwapRunner>[0] }).d });
    expect(await fresh.restore(() => SPEC)).toEqual([1n]);
    expect(await fresh.stop(1n)).toBe(true);
    expect(w.calls.at(-1)).toMatchObject({ account: SWAP_WALLET, tokenIn: "TSLA" });
  });

  test("no registered swap key: the owner is told to set swaps up, nothing is sent", async () => {
    const w = await world({ registered: false });
    await w.fire();
    expect(w.calls).toEqual([]);
    expect((await w.db.select().from(activity)).map((a) => a.kind)).toEqual(["needs_swap_setup"]);
  });

  test("P-M4: keyless follows made before the real follower can't squat its slot", async () => {
    const w = await world({ follower: true });
    const [mine] = await w.db.select().from(follows).where(eq(follows.follower, FOLLOWER));
    await w.db.delete(follows).where(eq(follows.follower, FOLLOWER));
    const crowd = Array.from({ length: 1100 }, (_, i) => "0x" + (0x10000 + i).toString(16).padStart(40, "0"));
    await w.db.insert(users).values(crowd.map((address) => ({ address })));
    for (let i = 0; i < crowd.length; i += 500)
      await w.db.insert(follows).values(crowd.slice(i, i + 500).map((follower) => ({ follower, caller: OWNER, sizeRule: { kind: "fixed", usd: 1 }, limits: { maxUsd: 1, maxLev: 1 } })));
    await w.db.insert(follows).values({ ...mine!, id: undefined, createdAt: new Date() }); // the newest follow of all
    await w.fire();
    expect(w.calls.map((c) => c.account)).toEqual([FOLLOWER, OWNER]);
    expect((await w.db.select().from(activity)).filter((a) => a.kind === "needs_swap_setup")).toHaveLength(0);
  }, 60_000);
});
