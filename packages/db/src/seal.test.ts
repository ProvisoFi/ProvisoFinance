import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { stampRequests, theses, users } from "./schema";
import { recordSeal } from "./seal";
import { createTestDb } from "./testing";

const OWNER = "0x00000000000000000000000000000000000000aa";

test("a sealed paper call is recorded with mode paper and waits like an alert", async () => {
  const db = await createTestDb();
  await db.insert(users).values({ address: OWNER });
  const stamp = { entryHash: "0x" + "1".repeat(64), exitHash: "0x" + "2".repeat(64), expiresAt: String(Math.floor(Date.now() / 1000) + 86_400), mode: "paper" };
  const [req] = await db.insert(stampRequests).values({ owner: OWNER, encSpec: new Uint8Array(80), stamp, ownerSig: "0x01", signedAt: new Date() }).returning();
  expect(await recordSeal(db, req!, { id: 9n, tx: "0xtx", stampedAt: new Date() })).toBe(true);
  const [t] = await db.select().from(theses).where(eq(theses.id, 9n));
  expect({ mode: t!.mode, state: t!.state }).toEqual({ mode: "paper", state: "alert" });
});
