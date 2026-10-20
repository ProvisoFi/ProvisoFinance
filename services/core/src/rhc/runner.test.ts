import { describe, expect, test } from "bun:test";
import { buildSwapKeyPolicy, TESTNET_SWAP, toJsonSafe } from "@proviso/chain";
import { activity, feedWanted, fires, follows, orders, swapKeys, users } from "@proviso/db";
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

async function world(o: { follower?: boolean; registered?: boolean } = {}) {
  const { db, pub } = await setup();
  await insertThesis(db, pub, 1n, { state: "fired" });
  const [fire] = await db.insert(fires).values({ thesisId: 1n, firedAt: new Date(), refMark: "100" }).returning({ id: fires.id });
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const manager = new SessionKeyManager(sealKey);
  const register = async (account: string) => {
    const sessionKey = await handleSwapKeyRequest(db, manager, account, { chainId: 46630, days: 30 });
    const policy = buildSwapKeyPolicy({
      account: account as Address, sessionKey, adapter: "0x00000000000000000000000000000000000000cc",
      caps: [{ token: TESTNET_SWAP.usdg, maxPerTx: 100n * E6, maxPerDay: 200n * E6 }], pools: [M.key],
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400), nonce: 1n,
    });
    if (o.registered !== false)
      await db.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: toJsonSafe(policy), policySig: "0x01" }).where(eq(swapKeys.address, account));
    return sessionKey;
  };
  const sessions = { caller: await register(OWNER) } as Record<string, string>;
  if (o.follower) {
    await db.insert(users).values({ address: FOLLOWER, limits: { maxUsd: 1000, maxLev: 3 } });
    sessions.follower = await register(FOLLOWER);
    await db.insert(follows).values({
      follower: FOLLOWER, caller: OWNER, active: true, sizeRule: { kind: "fixed", usd: 4 }, limits: { maxUsd: 1000, maxLev: 3 },
      sealedAllowlist: [{ coin: "TSLA", side: "both", maxUsd: 5, maxLev: 1 }],
    });
  }
  const calls: { account: string; amountIn?: bigint; tokenIn: string; usd: number }[] = [];
  const exits: SwapExit[] = [];
  let staleOnce = false;
  // A fake chain: buys fill at $400 / TSLA, sells at the current price.
  let price = 400;
  const send = (async (_d: unknown, job: SwapJob) => {
    const account = job.policy.account;
    calls.push({ account: account.toLowerCase(), amountIn: job.amountIn, tokenIn: job.action.tokenIn, usd: job.action.size.usd });
    if (staleOnce) return (staleOnce = false), { plan: { ok: false, reason: "stale_oracle" } };
    const isBuy = job.action.tokenIn === "USDG";
    const amountIn = job.amountIn ?? BigInt(Math.round(job.action.size.usd * 1e6));
    const out = isBuy ? (amountIn * E18 * 10n ** 0n) / (BigInt(price) * E6) : (amountIn * BigInt(price) * E6) / E18;
    const hash = `0x${(calls.length).toString(16).padStart(64, "0")}` as Hex;
    receipts.set(hash, [transfer(isBuy ? TESTNET_SWAP.tsla : TESTNET_SWAP.usdg, account, out)]);
    return { plan: { ok: true, key: M.key, zeroForOne: isBuy, tokenIn: TESTNET_SWAP.usdg, amountIn, minOut: 1n, expectedOut: out }, hash };
  }) as unknown as typeof sendSwap;
  const receipts = new Map<Hex, unknown[]>();
  const sleeps: number[] = [];
  const runner = new SwapRunner({
    db, sealKey, swapKeyPolicy: OWNER, poolManager: OWNER, markets: TESTNET_SWAP.markets,
    publicClient: { waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", logs: receipts.get(hash) ?? [] }) } as unknown as PublicClient,
    walletFor: (pk) => ({ account: privateKeyToAccount(pk) }) as unknown as WalletClient,
    sleep: async (ms) => void sleeps.push(ms),
    onExit: (e) => void exits.push(e),
    send,
  });
  return {
    db, fireId: fire!.id, sessions, calls, exits, sleeps, runner, sealKey, send,
    setPrice: (p: number) => (price = p),
    stale: () => (staleOnce = true),
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
    expect(w.sleeps).toEqual([8000]);
    expect((await w.db.select().from(feedWanted)).map((r) => r.feed)).toEqual([M.oracle.toLowerCase()]);
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

  test("no registered swap key: the owner is told to set swaps up, nothing is sent", async () => {
    const w = await world({ registered: false });
    await w.fire();
    expect(w.calls).toEqual([]);
    expect((await w.db.select().from(activity)).map((a) => a.kind)).toEqual(["needs_swap_setup"]);
  });
});
