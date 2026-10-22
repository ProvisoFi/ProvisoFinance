import { beforeEach, describe, expect, test } from "bun:test";
import { epochs, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { MAINNET_SWAP } from "@proviso/chain";
import type { Address, Hex } from "viem";
import { alerter, callerShareWatch, feedWatch, LOG_RANGE, opsWatch, sessionMinutes } from "./alerts";
import type { Clients } from "./chain";

const CS = "0x00000000000000000000000000000000000000c5" as Address;
const USDG = "0x00000000000000000000000000000000000000d6" as Address;
const CALLER = "0x00000000000000000000000000000000000000bb" as Address;
const ROOT = `0x${"11".repeat(32)}` as Hex;
const U = 1_000_000n; // 1 USDG
const T0 = 1_800_000_000; // block 0's timestamp; block n is n seconds later

type Sent = { title: string; body: string }[];
const sink = () => {
  const sent: Sent = [];
  return { sent, alert: alerter(async (m) => void sent.push(m), "0xAB") };
};

describe("alerter", () => {
  test("a condition alerts once, then once on recovery; events always send", async () => {
    const { sent, alert } = sink();
    await alert.condition("x", "bad");
    await alert.condition("x", "still bad");
    await alert.condition("x", null);
    await alert.condition("x", null);
    await alert.event("e", "1");
    await alert.event("e", "2");
    expect(sent.map((s) => s.title)).toEqual(["x", "x: recovered", "e", "e"]);
  });

  test("a failed send leaves the condition unsent, so the next tick retries", async () => {
    let fail = true;
    const sent: string[] = [];
    const alert = alerter(async (m) => (fail ? Promise.reject(new Error("down")) : void sent.push(m.title)), "0xab");
    await expect(alert.condition("x", "bad")).rejects.toThrow();
    fail = false;
    await alert.condition("x", "bad");
    expect(sent).toEqual(["x"]);
  });
});

describe("sessionMinutes (NYSE regular session in New York time)", () => {
  test("summer (EDT) and winter (EST) opens, close, weekend", () => {
    expect(sessionMinutes(new Date("2026-10-21T13:29:00Z"))).toBeNull();
    expect(sessionMinutes(new Date("2026-10-21T13:30:00Z"))).toBe(0);
    expect(sessionMinutes(new Date("2026-10-21T19:59:00Z"))).toBe(389);
    expect(sessionMinutes(new Date("2026-10-21T20:00:00Z"))).toBeNull();
    expect(sessionMinutes(new Date("2026-10-24T15:00:00Z"))).toBeNull(); // Saturday
    expect(sessionMinutes(new Date("2026-12-02T13:30:00Z"))).toBeNull();
    expect(sessionMinutes(new Date("2026-12-02T14:30:00Z"))).toBe(0);
  });
});

describe("CallerShare watch", () => {
  let db: Db;
  let logs: { eventName: string; blockNumber: bigint; transactionHash: Hex; args: Record<string, unknown> }[];
  let ranges: [bigint, bigint][];
  let latest: bigint;
  let onchain: Record<string, [Hex, bigint, bigint]>;
  let balance: bigint;
  let nowS: number;
  const c = {
    public: {
      getBlockNumber: async () => latest,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([fromBlock, toBlock]);
        return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber }),
      readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) =>
        functionName === "balanceOf" ? balance : (onchain[String(args[0])] ?? [`0x${"00".repeat(32)}`, 0n, 0n]),
    },
  } as unknown as Clients;
  const claim = (block: bigint, amount: bigint, epoch = 202643n) => ({ eventName: "Claimed", blockNumber: block, transactionHash: "0x01" as Hex, args: { epoch, caller: CALLER, amount } });
  const watch = (alert: ReturnType<typeof alerter>) =>
    callerShareWatch(db, c, { callerShare: CS, usdg: USDG, alert, claimMax: 100n * U, dayMax: 500n * U, fromBlock: 10n, now: () => nowS * 1000 });

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(epochs).values({ epoch: 202643n, root: ROOT, totalUsdg: (2000n * U).toString() });
    onchain = { "202643": [ROOT, 2000n * U, 0n] };
    balance = 2000n * U;
    logs = [];
    ranges = [];
    latest = 10n + 3n * LOG_RANGE;
    nowS = T0 + Number(latest);
  });

  test("a single claim above the threshold alerts; one below doesn't", async () => {
    const { sent, alert } = sink();
    logs = [claim(20n, 50n * U), claim(30n, 150n * U)];
    await watch(alert).tick();
    expect(sent.map((s) => s.title)).toEqual(["Large CallerShare claim"]);
    expect(sent[0]!.body).toContain("150 USDG");
  });

  test("24 h total: alerts once over the limit, recovers when the window slides past", async () => {
    const { sent, alert } = sink();
    const w = watch(alert);
    logs = [20n, 21n, 22n, 23n, 24n, 25n].map((b) => claim(b, 90n * U)); // 540 USDG
    await w.tick();
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["CallerShare 24 h claims"]);
    nowS += 86_400;
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["CallerShare 24 h claims", "CallerShare 24 h claims: recovered"]);
  });

  test("a claim on an epoch ops never posted, or with another root, alerts once per epoch", async () => {
    const { sent, alert } = sink();
    onchain["7"] = [`0x${"22".repeat(32)}`, 10n * U, 0n];
    onchain["202643"] = [`0x${"33".repeat(32)}`, 2000n * U, 0n];
    logs = [claim(20n, U, 7n), claim(21n, U, 7n), claim(22n, U)];
    await watch(alert).tick();
    expect(sent.map((s) => s.title)).toEqual(["CallerShare epoch 7 root", "CallerShare epoch 202643 root"]);
    expect(sent[0]!.body).toContain("no such epoch");
  });

  test("an EpochPosted with a root ops didn't compute alerts; ops' own doesn't", async () => {
    const { sent, alert } = sink();
    logs = [
      { eventName: "EpochPosted", blockNumber: 20n, transactionHash: "0x01", args: { epoch: 202643n, merkleRoot: ROOT, totalUsdg: 2000n * U } },
      { eventName: "EpochPosted", blockNumber: 21n, transactionHash: "0x02", args: { epoch: 9n, merkleRoot: ROOT, totalUsdg: 1n } },
    ];
    await watch(alert).tick();
    expect(sent.map((s) => s.title)).toEqual(["CallerShare epoch 9 root"]);
  });

  test("balance below what posted epochs still owe alerts, and recovers", async () => {
    const { sent, alert } = sink();
    const w = watch(alert);
    onchain["202643"] = [ROOT, 2000n * U, 500n * U];
    balance = 1499n * U;
    await w.tick();
    balance = 1500n * U;
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["CallerShare underfunded", "CallerShare underfunded: recovered"]);
  });

  test("scans in small ranges from a persisted cursor; a restart resumes without re-alerting and keeps the 24 h history", async () => {
    const first = sink();
    logs = [claim(20n, 300n * U)];
    await watch(first.alert).tick();
    expect(ranges[0]).toEqual([10n, 10n + LOG_RANGE - 1n]);
    expect(ranges.every(([a, b]) => b - a < LOG_RANGE)).toBe(true);
    expect(ranges.at(-1)![1]).toBe(latest);
    const [row] = await db.select().from(opsWatch);
    expect((row!.value as { block: string }).block).toBe(String(latest + 1n));

    // Restart (fresh watcher, fresh alert state); a new 250 USDG claim lands.
    ranges = [];
    latest += 100n;
    logs.push(claim(latest - 1n, 250n * U));
    const second = sink();
    await watch(second.alert).tick();
    expect(ranges).toEqual([[latest - 99n, latest]]);
    expect(second.sent.map((s) => s.title)).toEqual(["Large CallerShare claim", "CallerShare 24 h claims"]); // 300 + 250 > 500
  });
});

describe("feed watch", () => {
  const m = MAINNET_SWAP.markets[0]!; // TSLA/USDG, stock is currency0
  const OPEN = Date.parse("2026-10-21T13:30:00Z") / 1000; // a Wednesday
  let answer: bigint;
  let updatedAt: number;
  let paused: boolean;
  let poolUsd: number;
  let nowS: number;
  const c = {
    public: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "latestRoundData") return [1n, answer, 0n, BigInt(updatedAt), 1n];
        if (functionName === "oraclePaused") return paused;
        // PoolManager.extsload slot0: sqrtPriceX96 for poolUsd USDG (6 dec) per TSLA (18 dec)
        return `0x${BigInt(Math.round(Math.sqrt(poolUsd / 1e12) * 2 ** 96)).toString(16).padStart(64, "0")}`;
      },
    },
  } as unknown as Clients;
  const watch = (alert: ReturnType<typeof alerter>) => feedWatch(c, { alert, maxAgeS: 10_800, poolManager: "0x00000000000000000000000000000000000000ee", markets: [m], now: () => nowS * 1000 });

  beforeEach(() => {
    answer = 400n * 10n ** 8n;
    poolUsd = 400;
    paused = false;
    updatedAt = OPEN - 17 * 3600; // last update the evening before
    nowS = OPEN + 60;
  });

  test("healthy feed in session: no alerts", async () => {
    const { sent, alert } = sink();
    await watch(alert).tick();
    expect(sent).toEqual([]);
  });

  test("staleness counts from the open, alerts once, recovers on an update", async () => {
    const { sent, alert } = sink();
    const w = watch(alert);
    nowS = OPEN + 3 * 3600; // exactly 3 h since the open
    await w.tick();
    expect(sent).toEqual([]);
    nowS += 60;
    await w.tick();
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["TSLA feed stale"]);
    updatedAt = nowS - 10;
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["TSLA feed stale", "TSLA feed stale: recovered"]);
  });

  test("outside the session neither staleness nor the pool gap alerts", async () => {
    const { sent, alert } = sink();
    nowS = Date.parse("2026-10-24T15:00:00Z") / 1000; // Saturday
    poolUsd = 450;
    await watch(alert).tick();
    expect(sent).toEqual([]);
  });

  test("answer <= 0 and oraclePaused alert any time", async () => {
    const { sent, alert } = sink();
    nowS = Date.parse("2026-10-24T15:00:00Z") / 1000;
    answer = 0n;
    paused = true;
    await watch(alert).tick();
    expect(sent.map((s) => s.title)).toEqual(["TSLA feed answer", "TSLA oracle paused"]);
  });

  test("pool more than 2% off the feed alerts in session; 1.9% doesn't", async () => {
    const { sent, alert } = sink();
    const w = watch(alert);
    poolUsd = 407.6;
    await w.tick();
    expect(sent).toEqual([]);
    poolUsd = 409;
    await w.tick();
    expect(sent.map((s) => s.title)).toEqual(["TSLA pool vs feed"]);
  });
});

describe("watch loops", () => {
  test("a market that can't be read is logged per tick; the loop stops on abort", async () => {
    const logs: string[] = [];
    const c = { public: { readContract: async () => Promise.reject(new Error("rpc down")) } } as unknown as Clients;
    const w = feedWatch(c, { alert: sink().alert, maxAgeS: 10_800, poolManager: "0x00000000000000000000000000000000000000ee", markets: [MAINNET_SWAP.markets[0]!], log: (m) => logs.push(m) });
    const ac = new AbortController();
    const done = w.run(ac.signal);
    while (!logs.length) await Bun.sleep(1);
    ac.abort();
    await done;
    expect(logs).toEqual(["ops: feed watch TSLA/USDG failed: rpc down"]);
  });
});
