import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "@proviso/db";
import type { SpecInput } from "@proviso/dsl";
import { as, setEnv, stubFetch, testDb } from "./api.testkit";
import { checkDryRun, coinsOf, dryRun, dryRunNow, dryRunSpec, hourly, stats, takerFeeBps, type Hourly } from "./dryrun";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1);
const DIP_AT = 40 * 24; // hour index of the one-hour 4% dip

/** 60 days of flat 100,000 BTC with a single 4% dip that snaps back above +5% the next hour. */
const closes = Array.from({ length: 60 * 24 }, (_, i) => (i === DIP_AT ? 96_000 : i > DIP_AT ? 101_000 : 100_000));
const rows: Hourly[] = closes.map((c, i) => ({ t: T0 + (i + 1) * HOUR, close: c, high: c, low: c, volumeUsd: 50_000_000, funding: 0.0000125 }));

const dip = (over: Partial<SpecInput> = {}): SpecInput => ({
  v: 1,
  entry: {
    when: { change: { coin: "BTC", op: "<=", value: -3, window: "24h" } },
    then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 2, size: { usd: 1000 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -3 }, take: { pct: 5 }, ref: "trigger_mark" },
  limits: { maxUsd: 1000, maxLev: 2 },
  mode: "live",
  fire: "once",
  expires: "7d",
  ...over,
});

const market = Promise.resolve([
  { coin: "BTC", maxLeverage: 40, volume24hUsd: 2e9, mark: 100_000 },
  { coin: "xyz:JIO", maxLeverage: 3, volume24hUsd: 5e6, mark: 400 },
]) as never;

test("Dry Run runs any rule as paper, re-armed daily, over the whole window", () => {
  const s = dryRunSpec(dip());
  expect(s).toMatchObject({ mode: "paper", fire: "repeat", cooldown: "24h", expires: "30d" });
  expect(coinsOf(s)).toEqual(["BTC"]);
  expect(takerFeeBps("BTC")).toBe(9.5);
  expect(takerFeeBps("xyz:GOLD")).toBeCloseTo(5.9, 9);
});

test("the replay fires on the dip, closes at the take, and charges fees on both fills", () => {
  const r = dryRun(dryRunSpec(dip()), new Map([["BTC", rows]]));
  expect(r.fires).toBe(1);
  expect(r.trades).toBe(1);
  expect(r.lastFires[0]).toMatchObject({ coin: "BTC", mark: 96_000 });
  expect(r.returnPct).toBeGreaterThan(0);
  expect(r.feesUsd).toBeGreaterThan(0);
  expect(r.winRate).toBe(1);
  expect(r.curve).toHaveLength(1);
  expect(r.days).toBe(59);
  // Same data, same answer.
  expect(dryRun(dryRunSpec(dip()), new Map([["BTC", rows]]))).toEqual(r);
  expect(() => dryRun(dryRunSpec(dip()), new Map([["BTC", rows.slice(0, 10)]]))).toThrow("Not enough history");
});

test("now: the last month plus the live mark says whether the rule would fire", () => {
  const flat = rows.slice(0, DIP_AT);
  expect(dryRunNow(dryRunSpec(dip()), new Map([["BTC", flat]]), [{ coin: "BTC", mark: 96_000, volume24hUsd: 2e9 }], flat.at(-1)!.t + 60_000).state).toBe("would_fire");
  expect(dryRunNow(dryRunSpec(dip()), new Map([["BTC", flat]]), [{ coin: "BTC", mark: 100_100, volume24hUsd: 2e9 }], flat.at(-1)!.t + 60_000).state).toBe("waiting");
});

test("market stats: last close, 24h move, 7-day range", () => {
  const s = stats(rows.slice(0, DIP_AT + 1));
  expect(s).toMatchObject({ mark: 96_000, weekHigh: 100_000, weekLow: 96_000, days: 40 });
  expect(s.change24hPct).toBeCloseTo(-4, 9);
  expect(stats([])).toMatchObject({ mark: null, weekHigh: null, change24hPct: null });
});

test("Dry Run caps leverage at 5x, pre-IPO at 2x", async () => {
  expect(await checkDryRun(dryRunSpec(dip()), market)).toEqual([]);
  const over = (coin: string, lev: number) =>
    dryRunSpec(dip({ entry: { ...dip().entry, then: [{ venue: "hl", action: "open", coin, side: "long", lev, size: { usd: 100 } }] }, limits: { maxUsd: 1000, maxLev: 10 } }));
  expect((await checkDryRun(over("BTC", 8), market)).map((e) => e.code)).toContain("lev_over_limit");
  expect((await checkDryRun(over("xyz:JIO", 3), market)).map((e) => e.code)).toContain("lev_over_limit");
});

test("history: candles become closes known at the end of their hour, with the funding then in force; cached", async () => {
  const calls: string[] = [];
  const info = {
    post: async (b: { type: string }) => {
      calls.push(b.type);
      if (b.type === "candleSnapshot") return [{ t: T0, c: "10", v: "2", h: "11", l: "9" }, { t: T0 + HOUR, c: "12", v: "1", h: "12", l: "10" }];
      return [{ time: T0 + HOUR / 2, fundingRate: "0.00001" }, { time: T0 + HOUR + 1, fundingRate: "0.00002" }];
    },
  } as never;
  const h = await hourly("TEST-HIST", info, 2, T0 + 3 * HOUR);
  expect(h).toEqual([
    { t: T0 + HOUR, close: 10, high: 11, low: 9, volumeUsd: 20, funding: 0.00001 },
    { t: T0 + 2 * HOUR, close: 12, high: 12, low: 10, volumeUsd: 12, funding: 0.00002 },
  ]);
  expect(await hourly("TEST-HIST", info, 2, T0 + 3 * HOUR + 60_000)).toBe(h);
  expect(calls).toEqual(["candleSnapshot", "fundingHistory"]);
});

let db: Db;
let restoreFetch: () => void;
let restoreEnv: () => void;
beforeAll(async () => {
  restoreEnv = setEnv({ HL_NETWORK: "mainnet", HL_DEXES: "" });
  const candles = closes.map((c, i) => ({ t: Date.now() - (closes.length - i) * HOUR, c: String(c), v: "500", h: String(c), l: String(c) }));
  restoreFetch = stubFetch({
    hosts: {
      "api.hyperliquid.xyz": (_u, b) =>
        b.type === "candleSnapshot" ? candles
        : b.type === "fundingHistory" ? []
        : b.type === "perpDexs" ? [null]
        : b.type === "metaAndAssetCtxs" ? [{ universe: [{ name: "BTC", maxLeverage: 40, szDecimals: 5 }] }, [{ markPx: "101000", prevDayPx: "100000", funding: "0.0000125", dayNtlVlm: "2000000000", oraclePx: "101000", openInterest: "1" }]]
        : null,
    },
  });
  db = await testDb();
});
afterAll(() => {
  restoreFetch();
  restoreEnv();
});

test("signed out: try replays the rule; bad rules come back as BAD_REQUEST; draft input is checked", async () => {
  const anon = appRouterAnon();
  const r = await anon.dryRun.try({ spec: dip() });
  expect(r.result.fires).toBe(1);
  expect(r.rule).toContain("BTC");
  await expect(anon.dryRun.try({ spec: { v: 1 } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(anon.dryRun.try({ spec: dip({ entry: { ...dip().entry, then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 9, size: { usd: 100 } }] }, limits: { maxUsd: 1000, maxLev: 10 } }) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(anon.dryRun.draft({ text: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await anon.dryRun.now({ spec: dip() })).state).toBe("waiting");
  expect((await anon.dryRun.market({ coin: "BTC" })).mark).toBe(101_000);
});

const appRouterAnon = () => as(db, null);
