import { expect, test } from "bun:test";
import type { Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sql } from "drizzle-orm";
import { appRouter } from "./index";

const address = "0x" + "ab".repeat(20);

// Records every query; the rate-limit call answers `allowed`.
const mockDb = (allowed: boolean) => {
  const sent: string[] = [];
  const db = {
    execute: async (q: unknown) => {
      const s = JSON.stringify(q);
      sent.push(s);
      return s.includes("rate_limit_hit") ? [{ ok: allowed }] : [];
    },
  } as unknown as Db;
  return { db, sent };
};

test("limiter lets a call through within budget, keyed by procedure and address", async () => {
  const { db, sent } = mockDb(true);
  const out = await appRouter.createCaller({ db, auth: { uid: "u1", address } }).idea.test({ encSpec: "AAAA" });
  expect(out.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[0]).toContain("rate_limit_hit");
  expect(sent[0]).toContain(`test:${address}`);
  expect(sent[1]).toContain("pgmq.send");
});

test("limiter blocks over budget with TOO_MANY_REQUESTS and nothing queued", async () => {
  const { db, sent } = mockDb(false);
  const call = appRouter.createCaller({ db, auth: { uid: "u1", address } });
  await expect(call.idea.test({ encSpec: "AAAA" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining("30 per hour") });
  await expect(call.swapKey.revoke({ signatures: ["0x00"] })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining("5 per day") });
  expect(sent.some((s) => s.includes("pgmq.send"))).toBe(false);
});

test("rate_limit_hit counts per key and window in Postgres", async () => {
  const tdb = await createTestDb();
  const hit = async (key: string) =>
    ((await tdb.execute(sql`select public.rate_limit_hit(${key}, 2, 3600) as ok`)) as unknown as { rows: { ok: boolean }[] }).rows[0].ok;
  expect([await hit("a"), await hit("a"), await hit("a")]).toEqual([true, true, false]);
  expect(await hit("b")).toBe(true);
});

const fetchErr = async (path: string, db: Db, auth: { uid: string; address: string } | null) => {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request(`http://localhost/trpc/${path}`),
    router: appRouter,
    createContext: () => ({ db, auth }),
  });
  return ((await res.json()) as { error: { json: { message: string; data: { code: string; stack?: string } } } }).error.json;
};

test("unexpected errors reach the client as a generic message", async () => {
  const db = {
    select: () => {
      throw new Error("request to https://rpc.example/secret-key failed");
    },
  } as unknown as Db;
  const err = await fetchErr("hl.status", db, { uid: "u1", address });
  expect(err.data.code).toBe("INTERNAL_SERVER_ERROR");
  expect(JSON.stringify(err)).not.toContain("secret-key");
  expect(err.message).toContain("went wrong");
});

test("intentional TRPCError messages are kept", async () => {
  const err = await fetchErr("idea.mine", mockDb(true).db, null);
  expect(err.data.code).toBe("UNAUTHORIZED");
  expect(err.message).toBe("Sign in with your wallet first.");
});
