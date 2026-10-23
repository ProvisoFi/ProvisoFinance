// records.byId: the public facts behind a call's share card (TU-13).
import { expect, test } from "bun:test";
import { fires, reveals, stamps, theses, users } from "@proviso/db";
import { addr, as, testDb } from "../api.testkit";

const H32 = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;
const OWNER = addr(0xa1);

test("records.byId returns public facts only: state, times, seal tx, fires, reveal kind and P&L", async () => {
  const db = await testDb();
  await db.insert(users).values({ address: OWNER });
  const now = new Date();
  await db.insert(theses).values({
    id: 7n, owner: OWNER, state: "closed", mode: "live", encSpec: Buffer.alloc(80, 1), entryHash: H32, exitHash: H32,
    signedAt: now, stampedAt: now, sealTx: TX, expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(fires).values({ thesisId: 7n, firedAt: now, refMark: "101.5" });
  await db.insert(reveals).values({ thesisId: 7n, part: "entry", kind: "FIRED", dueAt: now, revealedAt: now, tx: TX });
  await db.insert(stamps).values({ leaf: `0x${"01".repeat(32)}`, thesisId: 7n, seq: 1, kind: "PNL", data: { pnlUsd: 3.25 }, hourStart: now });

  const c = await as(db, null).records.byId({ id: "7" }); // no sign-in needed
  expect(c).toMatchObject({ id: "7", owner: OWNER, state: "closed", mode: "live", sealTx: TX, revealKind: "FIRED", revealTx: TX, pnlUsd: 3.25 });
  expect(c.fires).toEqual([{ at: now, refMark: "101.5" }]);
  expect(Object.keys(c)).not.toContain("entryHash"); // never the commitments or anything sealed
  expect(JSON.stringify(c)).not.toContain(H32);
});

test("records.byId: unknown id is NOT_FOUND, malformed ids are refused, an unrevealed call shows no reveal or P&L", async () => {
  const db = await testDb();
  await expect(as(db, null).records.byId({ id: "999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const id of ["", "-1", "1e3", "abc", "1".repeat(31)])
    await expect(as(db, null).records.byId({ id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await db.insert(users).values({ address: OWNER });
  const now = new Date();
  await db.insert(theses).values({
    id: 8n, owner: OWNER, state: "live", mode: "alert", encSpec: Buffer.alloc(80, 1), entryHash: H32, exitHash: H32,
    signedAt: now, stampedAt: now, sealTx: TX, expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(reveals).values({ thesisId: 8n, part: "entry", dueAt: now }); // due, not yet revealed
  expect(await as(db, null).records.byId({ id: "8" })).toMatchObject({ state: "live", fires: [], revealKind: null, revealTx: null, pnlUsd: null });
});
