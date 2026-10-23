import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { arenaEntries, reveals, stampRequests, stamps, theses, orders, fires, users, type Db } from "@proviso/db";
import type { Spec } from "@proviso/dsl";
import type { InfoClient } from "@proviso/hl";
import { eq } from "drizzle-orm";
import { addr, as, sent, setEnv, stubFetch, testDb } from "./api.testkit";
import { arenaAccount, arenaClock, arenaModels, arenaSpec, seasonFromId, seasonOf, seedAiEntrants } from "./arena";

const ARENA_MODELS = [
  { id: "lab-a/model-1", name: "Alpha-AI" },
  { id: "lab-b/model-2", name: "Beta-AI" },
  { id: "lab-c/model-3", name: "Gamma-AI" },
];
import { revealedRule } from "./routers/arena";

const MONDAY = new Date("2026-10-19T06:00:00Z"); // season 2026-W43 opens 2026-10-19
const ME = addr(0xa1);
let db: Db;
let restoreFetch: () => void;
let restoreEnv: () => void;

const btc = (over: Partial<Spec> = {}): Spec => ({
  v: 1,
  entry: {
    when: { price: { coin: "BTC", op: ">", value: 100_000 } },
    then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 10, size: { usd: 5000 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -4 }, take: { pct: 8 }, ref: "trigger_mark" },
  limits: { maxUsd: 5000, maxLev: 10 },
  mode: "live",
  fire: "repeat",
  cooldown: "1h",
  expires: "7d",
  ...over,
});

const ctx = { markPx: "100000", prevDayPx: "98000", funding: "0.0000125", dayNtlVlm: "900000000", oraclePx: "100000", openInterest: "1" };
const info = {
  metaAndAssetCtxs: async (dex?: string) =>
    dex ? [{ universe: [{ name: "xyz:NVDA", maxLeverage: 20, szDecimals: 2 }] }, [{ ...ctx, markPx: "200" }]] : [{ universe: [{ name: "BTC", maxLeverage: 40, szDecimals: 5 }] }, [ctx]],
  perpDexs: async () => [null, { name: "xyz", fullName: "XYZ", deployer: "0x1" }],
} as unknown as InfoClient;

beforeAll(async () => {
  restoreFetch = stubFetch({});
  restoreEnv = setEnv({ CHAIN_NETWORK: "testnet", HL_DEXES: "xyz" });
  db = await testDb();
  await db.insert(users).values({ address: ME });
});
afterAll(() => {
  restoreFetch();
  restoreEnv();
});
afterEach(() => {
  arenaClock.now = () => new Date();
});

test("seasons are ISO weeks from Monday 00:00 UTC; entries close after Tuesday, calls expire by Saturday", () => {
  const s = seasonOf(new Date("2026-10-23T12:00:00Z"));
  expect(s.id).toBe("2026-W43");
  expect(s.start.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  expect(s.entryCloses.toISOString()).toBe("2026-10-21T00:00:00.000Z");
  expect(s.expiryCap.toISOString()).toBe("2026-10-24T00:00:00.000Z");
  expect(s.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  expect(seasonFromId("2026-W43")?.start.toISOString()).toBe(s.start.toISOString());
  expect(seasonOf(new Date("2026-01-01T00:00:00Z")).id).toBe("2026-W01");
  expect(seasonFromId("2026-W99")).toBeNull();
  expect(seasonFromId("nope")).toBeNull();
});

test("AI rules are held to Arena terms: paper, Arena markets only, $1,000 at most 3x, 48h max hold", () => {
  const s = arenaSpec(
    btc({ entry: { ...btc().entry, then: [...btc().entry.then, { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 10 }, maxSlipPct: 1 }] } }),
    40,
  );
  expect(s.mode).toBe("paper");
  expect(s.entry.then).toEqual([{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 3, size: { usd: 1000 } }]);
  expect(s.exit.maxHold).toBe("48h");
  expect(s).toMatchObject({ expires: "40h", fire: "once", limits: { maxUsd: 1000, maxLev: 3 } });
  expect(() => arenaSpec(btc({ entry: { ...btc().entry, then: [{ venue: "hl", action: "open", coin: "DOGE", side: "long", lev: 2, size: { usd: 10 } }] } }), 40)).toThrow("no Arena perp action");
});

test("AI entrants: each model writes from the same brief, seals from its own wallet as paper; re-runs don't duplicate", async () => {
  const briefs: string[] = [];
  const write = async (text: string, model: unknown) => {
    briefs.push(text);
    if (model === ARENA_MODELS[1].id) throw new Error("model timed out");
    return { spec: btc(), rendering: "", ambiguities: [], unsupported: [] };
  };
  const key = new Uint8Array(32).fill(7);
  const o = { seed: "test-seed", enclaveKey: async () => key, now: MONDAY, info, write: write as never, models: ARENA_MODELS };
  const r = await seedAiEntrants(db, o);
  expect(r.season).toBe("2026-W43");
  expect(r.entered).toHaveLength(ARENA_MODELS.length - 1);
  expect(r.failed).toEqual([{ model: ARENA_MODELS[1].id, error: "model timed out" }]);
  expect(briefs.every((b) => b.includes("BTC: mark 100000, 24h +2.04%"))).toBe(true);
  const first = arenaAccount("test-seed", ARENA_MODELS[0].id).address.toLowerCase();
  const [req] = await db.select().from(stampRequests).where(eq(stampRequests.owner, first));
  expect((req!.stamp as { mode: string }).mode).toBe("paper");
  expect((await db.select().from(users).where(eq(users.address, first)))[0]!.displayName).toBe("Alpha-AI");
  expect((await sent(db, "stamp")).length).toBe(ARENA_MODELS.length - 1);
  // A second run retries only the failed model.
  const again = await seedAiEntrants(db, { ...o, write: (async () => ({ spec: btc(), rendering: "", ambiguities: [], unsupported: [] })) as never });
  expect(again.entered).toEqual([ARENA_MODELS[1].id]);
  expect((await db.select().from(arenaEntries)).length).toBe(ARENA_MODELS.length);
  expect((await seedAiEntrants(db, { ...o, now: new Date("2026-10-22T00:00:00Z") })).skipped).toBe("entry window closed");
});

test("humans enter a paper call sealed this week; the board scores stamped P&L, shows revealed rules, and ignores late stamps", async () => {
  arenaClock.now = () => MONDAY;
  const base = { owner: ME, encSpec: new Uint8Array([1]), entryHash: "0x1", exitHash: "0x2", signedAt: MONDAY, stampedAt: MONDAY, sealTx: "0xtx" };
  await db.insert(theses).values([
    { ...base, id: 31n, mode: "paper", state: "fired", expiresAt: new Date("2026-10-22T00:00:00Z") },
    { ...base, id: 32n, mode: "live", state: "live", expiresAt: new Date("2026-10-22T00:00:00Z") },
    { ...base, id: 33n, mode: "paper", state: "alert", expiresAt: new Date("2026-10-30T00:00:00Z") },
  ]);
  await expect(as(db, ME).arena.enter({ thesisId: "32" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Arena entries are paper calls." });
  await expect(as(db, ME).arena.enter({ thesisId: "33" })).rejects.toMatchObject({ code: "BAD_REQUEST" }); // expires too late
  await expect(as(db, addr(0xb2)).arena.enter({ thesisId: "31" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await as(db, ME).arena.enter({ thesisId: "31" })).toEqual({ season: "2026-W43" });
  await expect(as(db, ME).arena.enter({ thesisId: "31" })).rejects.toMatchObject({ code: "CONFLICT" });
  arenaClock.now = () => new Date("2026-10-21T01:00:00Z");
  await expect(as(db, ME).arena.enter({ thesisId: "31" })).rejects.toMatchObject({ code: "BAD_REQUEST" }); // closed

  // Fired, filled $1,000 of BTC on paper, closed with +$50 stamped in time and +$999 stamped after the season.
  const [f] = await db.insert(fires).values({ thesisId: 31n, firedAt: MONDAY, refMark: "100000" }).returning();
  await db.insert(orders).values({ fireId: f!.id, thesisId: 31n, account: ME, role: "caller", wave: 0, venue: "paper", coin: "BTC", side: "long", size: "0.01", filledSize: "0.01", avgPx: "100000", status: "filled" });
  await db.update(theses).set({ state: "closed" }).where(eq(theses.id, 31n));
  await db.insert(stamps).values([
    { leaf: "0x" + "a".repeat(64), thesisId: 31n, seq: 1, kind: "PNL", data: { pnlUsd: 50 }, hourStart: MONDAY, createdAt: MONDAY },
    { leaf: "0x" + "b".repeat(64), thesisId: 31n, seq: 2, kind: "PNL", data: { pnlUsd: 999 }, hourStart: MONDAY, createdAt: new Date("2026-10-27T00:00:00Z") },
  ] as never);
  const entry = JSON.stringify({ v: 1, entry: btc().entry, mode: "paper" });
  await db.insert(reveals).values({ thesisId: 31n, part: "entry", kind: "FIRED", dueAt: MONDAY, revealedAt: MONDAY, canonical: entry });
  arenaClock.now = () => new Date("2026-10-27T00:00:00Z"); // after the season
  const board = await as(db, null).arena.season({ season: "2026-W43" });
  const mine = board.entries.find((e) => e.address === ME)!;
  expect(mine).toMatchObject({ ai: false, status: "closed", thesisId: "31" });
  expect(mine.returnPct).toBeCloseTo(5, 9); // $50 on $1,000; the late $999 doesn't count
  expect(mine.rule).toBe("When BTC mark price is above $100,000: open a 10× long on BTC for $5,000 on Hyperliquid.");
  expect(board.live).toBe(false);
  expect(board.entries.filter((e) => e.ai)).toHaveLength(ARENA_MODELS.length);
  expect(board.entries.find((e) => e.ai)?.status).toBe("sealing"); // stamp requests not relayed in tests
  expect(revealedRule("{not json")).toBeNull();
});

test("the lineup comes from ARENA_MODELS on the deployment; bad entries are dropped", () => {
  expect(arenaModels({ ARENA_MODELS: JSON.stringify([...ARENA_MODELS, { id: "x", name: "has space" }, { name: "NoId-AI" }]) })).toEqual(ARENA_MODELS);
  expect(arenaModels({ ARENA_MODELS: "not json" })).toEqual([]);
  expect(arenaModels({})).toEqual([]);
});
