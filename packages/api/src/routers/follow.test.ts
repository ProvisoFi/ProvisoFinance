// follow.create against the real migrations: per-hour limiter, active-follow cap, one follow per caller/idea.
import { expect, test } from "bun:test";
import { follows, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { appRouter } from "../index";
import { MAX_ACTIVE_FOLLOWS } from "./follow";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const CALLER = addr(0xc1);
const input = { caller: CALLER, sizeRule: { kind: "fixed" as const, usd: 10 }, limits: { maxUsd: 100, maxLev: 2 } };

async function world() {
  const pg = await createTestDb();
  // PGlite's execute returns { rows }; the API's postgres-js client returns the rows array.
  const db = new Proxy(pg, {
    get: (t, k) => (k === "execute" ? async (q: unknown) => ((await t.execute(q as never)) as unknown as { rows: unknown[] }).rows : Reflect.get(t, k)),
  }) as Db;
  await db.insert(users).values(Array.from({ length: 200 }, (_, i) => ({ address: addr(i + 1) })));
  const as = (address: string) => appRouter.createCaller({ db, auth: { uid: address, address } }).follow;
  return { db, as };
}

test("a second active follow of the same caller is refused with a clear message", async () => {
  const { as } = await world();
  const me = as(addr(1));
  await me.create(input);
  await expect(me.create(input)).rejects.toMatchObject({ code: "CONFLICT", message: "You already follow this caller." });
  const [f] = await me.mine();
  await me.stop({ id: f!.id });
  await me.create(input); // stopped follows don't count
});

test(`at most ${MAX_ACTIVE_FOLLOWS} active follows per address`, async () => {
  const { db, as } = await world();
  const me = addr(2);
  await db.insert(follows).values(Array.from({ length: MAX_ACTIVE_FOLLOWS }, (_, i) => ({ ...input, follower: me, caller: addr(100 + i) })));
  await expect(as(me).create(input)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(`up to ${MAX_ACTIVE_FOLLOWS}`) });
});

test("follow.create is limited to 30 calls an hour per address", async () => {
  const { as } = await world();
  const me = as(addr(3));
  for (let i = 0; i < 30; i++) await expect(me.create({ ...input, caller: addr(3) })).rejects.toThrow("can't follow yourself");
  await expect(me.create(input)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  await as(addr(4)).create(input); // another address has its own budget
});
