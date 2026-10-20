import { describe, expect, test } from "bun:test";
import { buildSwapKeyPolicy, TESTNET_SWAP, toJsonSafe } from "@proviso/chain";
import { activity, feedWanted, fires, orders, swapKeys } from "@proviso/db";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicClient, WalletClient } from "viem";
import { insertThesis, OWNER, setup } from "../runtime/fixture";
import type { sendSwap } from "./executor";
import { SessionKeyManager } from "./policy";
import { handleSwapKeyRequest, SwapRunner } from "./runner";

const action = { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 2 }, maxSlipPct: 1 } as const;
const okPlan = { ok: true, key: TESTNET_SWAP.markets[0]!.key, zeroForOne: true, tokenIn: TESTNET_SWAP.usdg, amountIn: 2_000_000n, minOut: 1n, expectedOut: 2n } as const;

async function world(registered = true) {
  const { db, pub } = await setup();
  await insertThesis(db, pub, 1n, { state: "fired" });
  const [fire] = await db.insert(fires).values({ thesisId: 1n, firedAt: new Date(), refMark: "100" }).returning({ id: fires.id });
  const sealKey = crypto.getRandomValues(new Uint8Array(32));
  const manager = new SessionKeyManager(sealKey);
  const sessionKey = await handleSwapKeyRequest(db, manager, OWNER, { chainId: 46630, days: 30 });
  if (registered) {
    const policy = buildSwapKeyPolicy({
      account: OWNER, sessionKey, adapter: OWNER.replace("aa", "bb") as `0x${string}`,
      caps: [{ token: TESTNET_SWAP.usdg, maxPerTx: 10n, maxPerDay: 20n }], pools: [TESTNET_SWAP.markets[0]!.key],
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400), nonce: 1n,
    });
    await db.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: toJsonSafe(policy), policySig: "0x01" });
  }
  const wallets: string[] = [];
  const sleeps: number[] = [];
  const runner = (send: typeof sendSwap) =>
    new SwapRunner({
      db, sealKey, swapKeyPolicy: OWNER, poolManager: OWNER, markets: TESTNET_SWAP.markets,
      publicClient: { waitForTransactionReceipt: async () => ({ status: "success" }) } as unknown as PublicClient,
      walletFor: (pk) => (wallets.push(privateKeyToAccount(pk).address.toLowerCase()), {} as WalletClient),
      sleep: async (ms) => void sleeps.push(ms),
      send,
    });
  return { db, fireId: fire!.id, sessionKey, wallets, sleeps, runner };
}

describe("swap runner", () => {
  test("a stale oracle is retried once after asking for the feed; the fill is recorded", async () => {
    const w = await world();
    let calls = 0;
    const send = (async () => (++calls === 1 ? { plan: { ok: false, reason: "stale_oracle" } } : { plan: okPlan, hash: "0xabc" })) as unknown as typeof sendSwap;
    await w.runner(send).run({ owner: OWNER, thesisId: 1n, fireId: w.fireId, actions: [action] });
    expect(calls).toBe(2);
    expect(w.sleeps).toEqual([8000]);
    expect(w.wallets).toEqual([w.sessionKey]); // signs with the unsealed session key
    expect((await w.db.select().from(feedWanted)).map((r) => r.feed)).toEqual([TESTNET_SWAP.markets[0]!.oracle.toLowerCase()]);
    expect(await w.db.select().from(orders)).toMatchObject([{ venue: "rhc", status: "filled", size: "2000000", filledSize: "2000000", venueOrderId: "0xabc", coin: "TSLA" }]);
    expect(await w.db.select().from(activity)).toMatchObject([{ kind: "swap_done", payload: { thesisId: "1", usd: 2, tokenOut: "TSLA", tx: "0xabc" } }]);
  });

  test("a refusal is recorded once, without a second try for other reasons", async () => {
    const w = await world();
    let calls = 0;
    const send = (async () => (calls++, { plan: { ok: false, reason: "over_day_cap", detail: "5 > 4" } })) as unknown as typeof sendSwap;
    await w.runner(send).run({ owner: OWNER, thesisId: 1n, fireId: w.fireId, actions: [action] });
    expect(calls).toBe(1);
    expect(await w.db.select().from(orders)).toMatchObject([{ status: "rejected", error: "over_day_cap: 5 > 4" }]);
    expect(await w.db.select().from(activity)).toMatchObject([{ kind: "swap_refused", payload: { reason: "over_day_cap" } }]);
  });

  test("no registered swap key: the owner is told to set swaps up, nothing is sent", async () => {
    const w = await world(false);
    let calls = 0;
    await w.runner((async () => (calls++, { plan: okPlan })) as unknown as typeof sendSwap).run({ owner: OWNER, thesisId: 1n, fireId: w.fireId, actions: [action] });
    expect(calls).toBe(0);
    expect(await w.db.select().from(activity)).toMatchObject([{ kind: "needs_swap_setup" }]);
    expect(await w.db.select().from(orders)).toEqual([]);
  });
});
