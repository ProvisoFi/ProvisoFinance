import { beforeEach, describe, expect, mock, test } from "bun:test";
import { xHandles, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import { xPoller, type XPost } from "./xposts";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const tw = (id: number, minutes: number) => ({ id: String(id), text: `post ${id}`, created_at: iso(minutes) });

type Route = (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> };

/** Fake fetch over a route function; records every URL. */
function fakeX(route: Route) {
  const calls: URL[] = [];
  const fetch = mock(async (u: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const url = new URL(u);
    calls.push(url);
    const r = route(url);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  });
  return { fetch, calls };
}
const userRoute = (url: URL) => {
  const m = url.pathname.match(/^\/2\/users\/by\/username\/(\w+)$/);
  return m ? { body: { data: { id: `id_${m[1]}` } } } : null;
};

let db: Db;
let sent: XPost[];
const send = async (p: XPost) => void sent.push(p);
const lastSeen = async (handle: string) => (await db.select().from(xHandles).where(eq(xHandles.handle, handle)))[0]!.lastSeenId;

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
});

describe("X poller", () => {
  test("first poll keeps only posts made after the handle was added, then pages with since_id", async () => {
    await db.insert(xHandles).values({ handle: "alice", addedAt: new Date(T0) });
    let round = 1;
    const { fetch, calls } = fakeX((url) => {
      const u = userRoute(url);
      if (u) return u;
      expect(url.pathname).toBe("/2/users/id_alice/tweets");
      expect(url.searchParams.get("tweet.fields")).toBe("created_at");
      if (round === 1) {
        expect(url.searchParams.has("since_id")).toBe(false);
        return { body: { data: [tw(101, 2), tw(100, -5)], meta: { next_token: "ignored" } } };
      }
      expect(url.searchParams.get("since_id")).toBe("101");
      if (!url.searchParams.has("pagination_token")) return { body: { data: [tw(105, 9), tw(104, 8)], meta: { next_token: "p2" } } };
      expect(url.searchParams.get("pagination_token")).toBe("p2");
      return { body: { data: [tw(103, 7), tw(102, 6)], meta: {} } };
    });
    const p = xPoller(db, { token: "tok", send, fetch, now: () => T0 + 3_600_000 });

    expect(await p.pollOnce()).toBe(1);
    expect(sent).toEqual([{ handle: "alice", id: "101", text: "post 101", createdAt: iso(2) }]);
    expect(await lastSeen("alice")).toBe("101");
    expect(calls).toHaveLength(2); // user lookup + one page (first poll never pages back)

    round = 2;
    sent = [];
    expect(await p.pollOnce()).toBe(4);
    expect(sent.map((s) => s.id)).toEqual(["102", "103", "104", "105"]); // oldest first
    expect(await lastSeen("alice")).toBe("105");
    expect(calls.filter((u) => u.pathname.includes("/by/username/"))).toHaveLength(1); // id looked up once
  });

  test("no new posts leaves last_seen_id alone; ids compare as numbers, not strings", async () => {
    await db.insert(xHandles).values({ handle: "bob", addedAt: new Date(T0), lastSeenId: "99" });
    const { fetch } = fakeX((url) => userRoute(url) ?? { body: { data: [tw(1000, 1), tw(100, 0)] } });
    const p = xPoller(db, { token: "tok", send, fetch, now: () => T0 });
    await p.pollOnce();
    expect(sent.map((s) => s.id)).toEqual(["100", "1000"]);
    expect(await lastSeen("bob")).toBe("1000");

    const empty = xPoller(db, { token: "tok", send, fetch: fakeX((url) => userRoute(url) ?? { body: { meta: { result_count: 0 } } }).fetch });
    expect(await empty.pollOnce()).toBe(0);
    expect(await lastSeen("bob")).toBe("1000");
  });

  test("429 pauses until the reset header and stops the rest of the pass", async () => {
    await db.insert(xHandles).values([
      { handle: "a1", addedAt: new Date(T0) },
      { handle: "a2", addedAt: new Date(T0 + 1) },
    ]);
    let now = T0;
    let limited = true;
    const { fetch, calls } = fakeX((url) => {
      if (limited) return { status: 429, headers: { "x-rate-limit-reset": String(T0 / 1000 + 120) } };
      return userRoute(url) ?? { body: { data: [] } };
    });
    const logs: string[] = [];
    const p = xPoller(db, { token: "tok", send, fetch, now: () => now, log: (m) => logs.push(m) });

    await p.pollOnce();
    expect(calls).toHaveLength(1); // a2 wasn't tried
    expect(p.pausedUntil()).toBe(T0 + 120_000);
    expect(logs.some((l) => l.includes("rate limited"))).toBe(true);

    now = T0 + 60_000;
    limited = false;
    await p.pollOnce();
    expect(calls).toHaveLength(1); // still paused

    now = T0 + 120_000;
    await p.pollOnce();
    expect(calls.map((u) => u.pathname)).toEqual([
      "/2/users/by/username/a1",
      "/2/users/by/username/a1",
      "/2/users/id_a1/tweets",
      "/2/users/by/username/a2",
      "/2/users/id_a2/tweets",
    ]);
  });

  test("over the cap, handles are polled in rotation so every one gets a turn", async () => {
    await db.insert(xHandles).values(["r1", "r2", "r3", "r4", "r5"].map((handle, i) => ({ handle, addedAt: new Date(T0 + i) })));
    const { fetch, calls } = fakeX((url) => userRoute(url) ?? { body: { data: [] } });
    const p = xPoller(db, { token: "tok", send, fetch, maxHandles: 2, log: () => {} });
    const polled = async () => {
      const n = calls.length;
      await p.pollOnce();
      return calls.slice(n).filter((u) => u.pathname.endsWith("/tweets")).map((u) => u.pathname.split("/")[3]);
    };
    expect(await polled()).toEqual(["id_r1", "id_r2"]);
    expect(await polled()).toEqual(["id_r3", "id_r4"]);
    expect(await polled()).toEqual(["id_r5", "id_r1"]);
  });

  test("hard cap on handles (oldest first), invalid handles skipped, one failing handle doesn't stop the rest", async () => {
    await db.insert(xHandles).values([
      { handle: "h1", addedAt: new Date(T0) },
      { handle: "bad/../x", addedAt: new Date(T0 + 1) },
      { handle: "h3", addedAt: new Date(T0 + 2) },
      { handle: "h4", addedAt: new Date(T0 + 3) },
    ]);
    const { fetch, calls } = fakeX((url) => {
      if (url.pathname.endsWith("/h1")) return { status: 503 };
      return userRoute(url) ?? { body: { data: [] } };
    });
    const logs: string[] = [];
    const p = xPoller(db, { token: "tok", send, fetch, maxHandles: 3, log: (m) => logs.push(m) });
    await p.pollOnce();
    const looked = calls.filter((u) => u.pathname.includes("/by/username/")).map((u) => u.pathname.split("/").at(-1));
    expect(looked).toEqual(["h1", "h3"]); // h4 is over the cap, bad/../x invalid
    expect(logs.some((l) => l.includes("more than 3 X handles"))).toBe(true);
    expect(logs.some((l) => l.includes("invalid X handle"))).toBe(true);
    expect(logs.some((l) => l.includes("@h1 failed"))).toBe(true);
  });

  test("stops paging at maxPages and says so", async () => {
    await db.insert(xHandles).values({ handle: "busy", addedAt: new Date(T0), lastSeenId: "1" });
    let n = 10;
    const { fetch } = fakeX((url) => userRoute(url) ?? { body: { data: [tw(n--, 0)], meta: { next_token: `p${n}` } } });
    const logs: string[] = [];
    const p = xPoller(db, { token: "tok", send, fetch, maxPages: 2, log: (m) => logs.push(m) });
    expect(await p.pollOnce()).toBe(2);
    expect(await lastSeen("busy")).toBe("10");
    expect(logs.some((l) => l.includes("more than 2 pages"))).toBe(true);
  });
});

describe("X poller loop", () => {
  test("run polls at once, logs a failed pass, and stops on abort", async () => {
    await db.insert(xHandles).values({ handle: "alice", addedAt: new Date(T0) });
    const logs: string[] = [];
    const { fetch, calls } = fakeX((url) => userRoute(url) ?? { body: { data: [tw(200, 1)] } });
    const p = xPoller(db, { token: "tok", send, fetch, now: () => T0 + 60_000, log: (m) => logs.push(m) });
    const ac = new AbortController();
    const done = p.run(ac.signal);
    while (!sent.length) await Bun.sleep(1);
    ac.abort();
    await done;
    expect(sent.map((s) => s.id)).toEqual(["200"]);
    expect(calls.length).toBe(2);

    const broken = xPoller({} as Db, { token: "tok", send, fetch, log: (m) => logs.push(m) }); // the handle list can't be read
    const ac2 = new AbortController();
    const done2 = broken.run(ac2.signal);
    while (!logs.includes("ops: X poll failed")) await Bun.sleep(1);
    ac2.abort();
    await done2;
  });
});
