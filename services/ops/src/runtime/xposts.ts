// X poller (Backend §8): pay-per-use reads of a bounded set of handles via the X API v2.
// Core upserts x_handles when an idea with a post condition loads (ops can't read specs); ops
// forwards every new post to the `posts` queue. Matching stays in core; text never goes to a model.
import { xHandles, type Db } from "@proviso/db";
import { asc, eq } from "drizzle-orm";

export const X_API = "https://api.x.com/2";
const HANDLE = /^[a-z0-9_]{1,15}$/i; // X usernames; also keeps the URL path safe

export type XPost = { handle: string; id: string; text: string; createdAt: string };
type Tweet = { id: string; text: string; created_at: string };
type TweetsBody = { data?: Tweet[]; meta?: { next_token?: string } };

export type XPollerOptions = {
  token: string;
  send: (post: XPost) => Promise<unknown>; // queues.send("posts", post)
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  maxHandles?: number; // hard cap (X_MAX_HANDLES)
  maxPages?: number; // per handle per poll
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
};

class RateLimited extends Error {
  constructor(readonly resetAt: number) {
    super("X API rate limited");
  }
}

const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

export function xPoller(db: Db, o: XPollerOptions) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const log = o.log ?? console.error;
  const maxHandles = o.maxHandles ?? 50;
  const maxPages = o.maxPages ?? 5;
  const userIds = new Map<string, string>(); // handle → user id, looked up once
  let pausedUntil = 0;

  async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await f(`${X_API}${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${o.token}` } });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset")); // unix seconds
      throw new RateLimited(reset > 0 ? reset * 1000 : now() + 15 * 60_000);
    }
    if (!res.ok) throw new Error(`X API ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  async function userId(handle: string) {
    let id = userIds.get(handle);
    if (!id) {
      id = (await get<{ data?: { id: string } }>(`/users/by/username/${handle}`)).data?.id;
      if (!id) throw new Error(`X user @${handle} not found`);
      userIds.set(handle, id);
    }
    return id;
  }

  /**
   * New posts since last_seen_id, oldest first. The first poll of a handle reads one page and
   * keeps only posts made after the handle was added, so old posts never trigger anything.
   */
  async function pollHandle(h: typeof xHandles.$inferSelect): Promise<number> {
    const id = await userId(h.handle);
    const tweets: Tweet[] = [];
    let next: string | undefined;
    let pages = 0;
    do {
      const params: Record<string, string> = { max_results: "100", "tweet.fields": "created_at" };
      if (h.lastSeenId) params.since_id = h.lastSeenId;
      if (next) params.pagination_token = next;
      const body = await get<TweetsBody>(`/users/${id}/tweets`, params);
      tweets.push(...(body.data ?? []));
      next = h.lastSeenId ? body.meta?.next_token : undefined;
    } while (next && ++pages < maxPages);
    if (next) log(`ops: @${h.handle} has more than ${maxPages} pages of new posts; older ones skipped`);

    const fresh = tweets
      .filter((t) => h.lastSeenId || Date.parse(t.created_at) >= h.addedAt.getTime())
      .sort(byId);
    for (const t of fresh) await o.send({ handle: h.handle, id: t.id, text: t.text, createdAt: t.created_at });
    // Advanced after sending: a crash in between re-sends (core dedupes by post id), never skips.
    const newest = tweets.sort(byId).at(-1)?.id;
    if (newest && newest !== h.lastSeenId) await db.update(xHandles).set({ lastSeenId: newest }).where(eq(xHandles.handle, h.handle));
    return fresh.length;
  }

  /** One pass over the watched handles; returns how many posts were sent. */
  async function pollOnce(): Promise<number> {
    if (now() < pausedUntil) return 0;
    const rows = await db.select().from(xHandles).orderBy(asc(xHandles.addedAt), asc(xHandles.handle)).limit(maxHandles + 1);
    if (rows.length > maxHandles) log(`ops: more than ${maxHandles} X handles watched; polling the oldest ${maxHandles}`);
    let sent = 0;
    for (const h of rows.slice(0, maxHandles)) {
      if (!HANDLE.test(h.handle)) {
        log(`ops: skipping invalid X handle ${JSON.stringify(h.handle)}`);
        continue;
      }
      try {
        sent += await pollHandle(h);
      } catch (e) {
        if (!(e instanceof RateLimited)) {
          log(`ops: X poll of @${h.handle} failed`, e);
          continue;
        }
        pausedUntil = e.resetAt;
        log(`ops: X rate limited until ${new Date(e.resetAt).toISOString()}`);
        break;
      }
    }
    return sent;
  }

  /** Polls every 30–60 s (or after a rate-limit reset) until `signal` aborts. */
  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      await pollOnce().catch((e) => log("ops: X poll failed", e));
      const wait = Math.max(pausedUntil - now(), 30_000 + Math.random() * 30_000);
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
  }

  return { pollOnce, run, pausedUntil: () => pausedUntil };
}
