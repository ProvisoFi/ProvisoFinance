import { expect, test } from "bun:test";
import { users } from "./schema.ts";
import { createTestDb } from "./testing.ts";

test("test database applies the real migration", async () => {
  const db = await createTestDb();
  await db.insert(users).values({ address: "0xabc" });
  expect(await db.select().from(users)).toHaveLength(1);
});
