import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { fires, orders, theses, users } from "./schema.ts";
import { createTestDb } from "./testing.ts";

// The fill trigger calls pgmq.send, which PGlite lacks: stub it to record messages.
const STUB = `
create schema if not exists pgmq;
create table pgmq.sent (queue text, msg jsonb);
create function pgmq.send(queue text, msg jsonb) returns bigint language sql as
  $$ insert into pgmq.sent values (queue, msg); select 1::bigint $$;
`;
const MIGRATION = readFileSync(join(import.meta.dirname, "../../../supabase/migrations/20261021190000_orders_fill_stamp.sql"), "utf8");

test("fills queue one FILL stamp leaf per new filled size, without the account", async () => {
  const db = await createTestDb();
  const pg = (db as unknown as { $client: { exec(s: string): Promise<unknown>; query<T>(s: string): Promise<{ rows: T[] }> } }).$client;
  await pg.exec(STUB + MIGRATION);
  const sent = async () => (await pg.query<{ queue: string; msg: any }>("select * from pgmq.sent")).rows;

  await db.insert(users).values({ address: "0xowner" });
  const now = new Date();
  await db.insert(theses).values({
    id: 7n, owner: "0xowner", encSpec: Buffer.from([1]), entryHash: "0x1", exitHash: "0x2", mode: "live",
    signedAt: now, stampedAt: now, sealTx: "0x3", expiresAt: new Date(now.getTime() + 86_400_000), state: "fired",
  });
  const [fire] = await db.insert(fires).values({ thesisId: 7n, firedAt: now, refMark: "1" }).returning({ id: fires.id });
  const base = { fireId: fire!.id, thesisId: 7n, account: "0xfollower", role: "follower", wave: 1, coin: "TSLA", size: "2000000" };

  // Swap path: pending row, then settled as filled -> one leaf.
  const [swap] = await db.insert(orders).values({ ...base, venue: "rhc", side: "buy" }).returning({ id: orders.id });
  expect(await sent()).toHaveLength(0);
  await db.update(orders).set({ status: "filled", filledSize: "5191208111040740", avgPx: "385.27" }).where(eq(orders.id, swap!.id));
  // Unrelated updates don't stamp again.
  await db.update(orders).set({ error: "note" }).where(eq(orders.id, swap!.id));
  await db.update(orders).set({ status: "filled" }).where(eq(orders.id, swap!.id));

  // HL path: IOC partial inserted directly, later grows, and a rejected order never stamps.
  const [hl] = await db.insert(orders).values({ ...base, venue: "hl", side: "long", status: "partial", filledSize: "0.5", avgPx: "84400" }).returning({ id: orders.id });
  await db.update(orders).set({ status: "filled", filledSize: "1" }).where(eq(orders.id, hl!.id));
  await db.insert(orders).values({ ...base, venue: "hl", side: "long", status: "rejected" });

  const msgs = await sent();
  expect(msgs.map((m) => [m.queue, m.msg.kind, m.msg.data.venue, m.msg.data.filled])).toEqual([
    ["stamp_leaf", "FILL", "rhc", "5191208111040740"],
    ["stamp_leaf", "FILL", "hl", "0.5"],
    ["stamp_leaf", "FILL", "hl", "1"],
  ]);
  const m = msgs[0]!.msg;
  expect(m.thesisId).toBe("7");
  expect(m.data).toMatchObject({ orderId: swap!.id, fireId: fire!.id, role: "follower", wave: 1, side: "buy", avgPx: "385.27" });
  expect(Number.isNaN(new Date(m.at).getTime())).toBe(false); // ops parses it with new Date()
  expect(JSON.stringify(msgs)).not.toContain("0xfollower"); // leaf data is public
});
