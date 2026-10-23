import { expect, test } from "bun:test";
import { activity, fires, orders, theses, users } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import type { Spec } from "@proviso/dsl";
import type { L2Book } from "@proviso/hl";
import { asc, eq } from "drizzle-orm";
import { liquidated, PAPER_BUILDER_FEE, PAPER_TAKER_FEE, PaperEngine, walkBook, type PaperExit } from "./engine";

const OWNER = "0x00000000000000000000000000000000000000aa";
const IN_SESSION = new Date("2026-10-21T14:00:00Z"); // Wednesday 10:00 New York
const WEEKEND = new Date("2026-10-24T16:00:00Z");
const FEE = PAPER_TAKER_FEE + PAPER_BUILDER_FEE;

/** Asks from 100.1 up, bids from 99.9 down, 10 units a level, 0.1 apart. */
const book = (mid = 100, sz = 10): L2Book => ({
  coin: "X",
  time: 0,
  levels: [
    Array.from({ length: 40 }, (_, i) => ({ px: String(mid - 0.1 * (i + 1)), sz: String(sz), n: 1 })),
    Array.from({ length: 40 }, (_, i) => ({ px: String(mid + 0.1 * (i + 1)), sz: String(sz), n: 1 })),
  ],
});

const spec = (coin = "BTC", over: Partial<Spec> = {}): Spec => ({
  v: 1,
  entry: {
    when: { price: { coin, op: ">", value: 1 } },
    then: [{ venue: "hl", action: "open", coin, side: "long", lev: 2, size: { usd: 1000 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" },
  limits: { maxUsd: 1000, maxLev: 2 },
  mode: "paper",
  fire: "once",
  cooldown: "0m",
  expires: "7d",
  ...over,
});

async function setup(mid = 100) {
  const db = await createTestDb();
  await db.insert(users).values({ address: OWNER, limits: {} });
  await db.insert(theses).values({
    id: 7n, owner: OWNER, encSpec: new Uint8Array([1]), entryHash: "0x1", exitHash: "0x2", mode: "paper",
    signedAt: new Date(), stampedAt: new Date(), sealTx: "0xtx", expiresAt: new Date(Date.now() + 86_400_000), state: "fired",
  });
  const [f] = await db.insert(fires).values({ thesisId: 7n, firedAt: IN_SESSION, refMark: String(mid) }).returning();
  const exits: PaperExit[] = [];
  const state = { book: book(mid) };
  const engine = new PaperEngine({
    db,
    info: { l2Book: async () => state.book },
    maxLeverage: () => 20,
    onExit: (e) => exits.push(e),
    log: async (owner, kind, payload) => void (await db.insert(activity).values({ address: owner, kind, payload })),
  });
  const fire = (s: Spec) => engine.onFire({ fireId: f!.id, thesisId: 7n, owner: OWNER, spec: s, mark: mid, at: IN_SESSION, n: 1 });
  const rows = () => db.select().from(orders).where(eq(orders.thesisId, 7n)).orderBy(asc(orders.createdAt));
  return { db, engine, exits, state, fire, rows };
}

test("walkBook takes levels in order, only within 2% of the mark", () => {
  const f = walkBook(book(100), true, 1500, 100);
  expect(f.sz).toBeCloseTo(10 + 499 / 100.2, 9); // 10 @ 100.1, then the rest @ 100.2
  expect(f.avgPx).toBeCloseTo(1500 / f.sz, 9);
  const thin = walkBook(book(100, 1), true, 1_000_000, 100); // 1 unit a level: 100.1 … 102.0, the band edge included
  expect(thin.sz).toBeCloseTo(20, 6);
  expect(thin.avgPx).toBeLessThanOrEqual(102);
});

test("a paper fire fills on the book and records a paper order (the FILL stamp source); alerts and live are ignored", async () => {
  const { engine, fire, rows } = await setup();
  await fire(spec("BTC", { mode: "live" }));
  await fire(spec("BTC", { mode: "alert" }));
  expect(await rows()).toEqual([]);
  await fire(spec());
  const [r] = await rows();
  expect(r).toMatchObject({ venue: "paper", role: "caller", coin: "BTC", side: "long", status: "filled", reduceOnly: false, account: OWNER });
  expect(Number(r!.filledSize) * Number(r!.avgPx)).toBeCloseTo(1000, 6);
  expect(engine.openIdeas()).toEqual([7n]);
});

test("take profit in session: exit walks the bids; P&L counts both fills' fees", async () => {
  const { engine, exits, fire, rows, state } = await setup();
  await fire(spec());
  const [entry] = await rows();
  state.book = book(111);
  engine.onMark("BTC", 111, IN_SESSION);
  await Bun.sleep(10);
  expect(exits).toHaveLength(1);
  const exitRow = (await rows())[1]!;
  expect(exitRow).toMatchObject({ venue: "paper", reduceOnly: true, side: "sell", status: "filled" });
  const sz = Number(entry!.filledSize), inPx = Number(entry!.avgPx), outPx = Number(exitRow.avgPx);
  expect(exits[0]).toMatchObject({ thesisId: 7n, reason: "take" });
  expect(exits[0]!.pnlUsd).toBeCloseTo((outPx - inPx) * sz - sz * (inPx + outPx) * FEE, 6);
  expect(engine.openIdeas()).toEqual([]);
});

test("outside a market's session the stop waits; liquidation does not", async () => {
  const { engine, exits, fire } = await setup();
  await fire(spec("xyz:NVDA"));
  engine.onMark("xyz:NVDA", 94, WEEKEND); // through the 5% stop, but the market is closed
  await Bun.sleep(10);
  expect(exits).toEqual([]);
  engine.onMark("xyz:NVDA", 50, WEEKEND); // a 2x long loses its margin near -50%
  await Bun.sleep(10);
  expect(exits).toMatchObject([{ reason: "liquidated" }]);
  expect(exits[0]!.pnlUsd).toBeLessThan(-500); // margin (~$500) plus the entry fee
});

test("liquidation math: margin plus unrealized minus funding against maintenance at max leverage", () => {
  const leg = { coin: "X", side: "long" as const, sz: 10, entryPx: 100, lev: 2, maxLev: 20 };
  expect(liquidated(leg, 60)).toBe(false); // margin 500, loss 400, maintenance 15
  expect(liquidated(leg, 51)).toBe(true); // loss 490 leaves 10 < 12.75
  expect(liquidated(leg, 60, 390)).toBe(true); // funding paid eats the rest
});

test("funding accrues hourly (longs pay positive funding) and comes off the P&L; Stop closes on the book", async () => {
  const { engine, exits, fire } = await setup();
  await fire(spec());
  engine.onMark("BTC", 100, IN_SESSION);
  engine.accrueFunding(() => 0.0001);
  engine.accrueFunding(() => 0.0001);
  expect(await engine.stopPaper(7n, "0x00000000000000000000000000000000000000bb")).toBe(false); // not the owner
  expect(await engine.stopPaper(7n, OWNER)).toBe(true);
  expect(exits[0]).toMatchObject({ reason: "stopped" });
  expect(exits[0]!.fundingUsd).toBeCloseTo(2 * 0.0001 * 100 * (1000 / 100.1), 3);
});

test("a restart rebuilds an open paper position from its orders rows; a closed one stays closed", async () => {
  const { db, engine, fire } = await setup();
  await fire(spec());
  const fresh = new PaperEngine({ db, info: { l2Book: async () => book(100) } });
  expect(await fresh.restore(() => spec())).toEqual([7n]);
  expect(await fresh.restore(() => spec())).toEqual([]); // already open
  expect(await new PaperEngine({ db, info: { l2Book: async () => book(100) } }).restore(() => spec("BTC", { mode: "live" }))).toEqual([]);
  await engine.stopPaper(7n, OWNER);
  expect(await new PaperEngine({ db, info: { l2Book: async () => book(100) } }).restore(() => spec())).toEqual([]);
});

test("advanced exits on paper (TU-32): a partial target closes half, survives a restart, then the final target closes the rest", async () => {
  const { db, engine, exits, fire, rows, state } = await setup();
  const s = spec("BTC", { exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark", partials: [{ pct: 5, fraction: 0.5 }] } });
  await fire(s);
  const opened = Number((await rows())[0]!.filledSize);
  state.book = book(105.5);
  engine.onMark("BTC", 105.5, IN_SESSION);
  await Bun.sleep(10);
  const half = (await rows())[1]!;
  expect(half).toMatchObject({ reduceOnly: true, side: "sell" });
  expect(Number(half.filledSize)).toBeCloseTo(opened / 2, 9);
  expect(exits).toEqual([]);
  // A restart in between keeps the half that's left and remembers the partial was taken.
  const fresh = new PaperEngine({ db, info: { l2Book: async () => state.book }, onExit: (e) => exits.push(e) });
  expect(await fresh.restore(() => s)).toEqual([7n]);
  fresh.onMark("BTC", 106, IN_SESSION); // past the partial again: not taken twice
  await Bun.sleep(10);
  expect((await rows()).length).toBe(2);
  state.book = book(111);
  fresh.onMark("BTC", 111, IN_SESSION);
  await Bun.sleep(10);
  expect(exits).toMatchObject([{ reason: "take" }]);
  const all = await rows();
  expect(Number(all[2]!.filledSize)).toBeCloseTo(opened / 2, 9);
  expect(exits[0]!.pnlUsd).toBeGreaterThan(0);
});
