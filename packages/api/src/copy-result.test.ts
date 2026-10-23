import { afterAll, beforeAll, expect, test } from "bun:test";
import { theses, users, type Db } from "@proviso/db";
import { appendLeaf } from "@proviso/ops/stamps/store";
import { addr, as, setEnv, stubFetch, testDb } from "./api.testkit";
import { copyCalls, copySummary, type FillLeaf } from "./copy-result";

let n = 0;
const fill = (role: string, side: string, reduceOnly: boolean, filled: number, avgPx: number, over: Partial<FillLeaf> = {}): FillLeaf => ({
  orderId: `o${++n}`, role, venue: "hl", coin: "BTC", side, reduceOnly, filled: String(filled), avgPx: String(avgPx), ...over,
});

test("followers' P&L comes from their stamped fills; the caller's from theirs on the same call", () => {
  const calls = copyCalls([
    // Followers fill first (wave 1) at 100, the caller after at 101; all exit at 110.
    { thesisId: "1", data: fill("follower", "buy", false, 2, 100) },
    { thesisId: "1", data: fill("follower", "buy", false, 1, 100) },
    { thesisId: "1", data: fill("caller", "buy", false, 1, 101) },
    { thesisId: "1", data: fill("follower", "sell", true, 3, 110) },
    { thesisId: "1", data: fill("caller", "sell", true, 1, 110) },
  ]);
  const c = calls.get("1")!;
  expect(c.follower).toEqual({ pnlUsd: 30, closedUsd: 300 });
  expect(c.caller.pnlUsd).toBeCloseTo(9, 9);
  const s = copySummary(calls.values())!;
  expect(s).toMatchObject({ copiedCalls: 1, followerPnlUsd: 30 });
  expect(s.followerReturnPct).toBeCloseTo(10, 9);
  expect(s.callerReturnPct).toBeCloseTo((9 / 101) * 100, 9);
});

test("shorts, open size, re-stamped partials, swaps and calls nobody copied", () => {
  const partial = fill("follower", "sell", false, 1, 100);
  const calls = copyCalls([
    { thesisId: "2", data: partial },
    { thesisId: "2", data: { ...partial, filled: "2" } }, // the same order grew to 2: counted once
    { thesisId: "2", data: fill("follower", "buy", true, 1, 90) }, // half closed, short: +10
    { thesisId: "3", data: fill("caller", "buy", false, 1, 100) },
    { thesisId: "3", data: fill("caller", "sell", true, 1, 120) },
    { thesisId: "4", data: fill("follower", "buy", false, 1, 100, { venue: "rhc" }) },
    { thesisId: "4", data: fill("follower", "sell", true, 1, 200, { venue: "rhc" }) },
    { thesisId: "5", data: fill("follower", "buy", false, 1, 100) }, // still open: nothing closed yet
  ]);
  expect([...calls.keys()]).toEqual(["2"]);
  expect(calls.get("2")).toEqual({ follower: { pnlUsd: 10, closedUsd: 100 }, caller: { pnlUsd: 0, closedUsd: 0 } });
  expect(copySummary(calls.values())!.callerReturnPct).toBeNull();
  expect(copySummary([])).toBeNull();
});

let db: Db;
let restore: () => void;
beforeAll(async () => {
  const a = stubFetch({});
  const b = setEnv({ CHAIN_NETWORK: "testnet" });
  restore = () => (a(), b());
  db = await testDb();
});
afterAll(() => restore());

test("records and the leaderboard show what followers made, from FILL stamps of live calls only", async () => {
  const ME = addr(0xc1);
  await db.insert(users).values({ address: ME });
  const base = { owner: ME, encSpec: new Uint8Array([1]), entryHash: "0x1", exitHash: "0x2", signedAt: new Date(), stampedAt: new Date(), sealTx: "0xtx", expiresAt: new Date(Date.now() + 86_400_000), state: "closed" };
  await db.insert(theses).values([{ ...base, id: 41n, mode: "live" }, { ...base, id: 42n, mode: "paper" }]);
  const leaves: [bigint, FillLeaf][] = [
    [41n, fill("follower", "buy", false, 1, 100)],
    [41n, fill("caller", "buy", false, 1, 100)],
    [41n, fill("follower", "sell", true, 1, 105)],
    [41n, fill("caller", "sell", true, 1, 104)],
    [42n, fill("follower", "buy", false, 1, 100)], // a paper call can't have followers: ignored if it ever did
    [42n, fill("follower", "sell", true, 1, 999)],
  ];
  for (const [thesisId, data] of leaves) await appendLeaf(db, { thesisId, kind: "FILL", data, at: new Date() });
  const r = await as(db, null).records.get({ caller: ME });
  expect(r.copy).toMatchObject({ copiedCalls: 1, followerPnlUsd: 5 });
  expect(r.copy!.followerReturnPct).toBeCloseTo(5, 9);
  expect(r.copy!.callerReturnPct).toBeCloseTo(4, 9);
  expect(r.ideas.find((i) => i.id === "41")!.copy).toMatchObject({ followerPnlUsd: 5 });
  expect(r.ideas.find((i) => i.id === "42")!.copy).toBeNull();
  expect((await as(db, null).records.byId({ id: "41" })).copy!.followerReturnPct).toBeCloseTo(5, 9);
  const board = await as(db, null).records.leaderboard();
  expect(board.byFollowers.map((c) => c.caller)).toEqual([ME]);
  expect(board.callers.find((c) => c.caller === ME)!.copy!.followerPnlUsd).toBeCloseTo(5, 9);
});
