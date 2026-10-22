// Feeds X posts from the ops poller (queue `posts`) into the evaluator. Matching stays the
// evaluator's plain substring test; post text is never logged and never sent anywhere else.
import type { Evaluator } from "../evaluator/engine.ts";
import type { Post } from "../evaluator/state.ts";
import { pgmq, type Executes, type Log, type Queue } from "./ports.ts";

export type PostMessage = { handle: string; id: string; text: string; createdAt: string };
export type PostsDeps = {
  db: Executes;
  evaluator: Pick<Evaluator, "apply">;
  /** Handles the evaluated ideas read (IdeaRegistry.postHandles). */
  handles: () => string[];
  queueFor?: (db: Executes) => Queue;
  now?: () => number;
  log?: Log;
};

const HANDLE = /^[a-z0-9_]{1,15}$/;

/** Feeds X posts from the ops poller (queue `posts`) into the evaluator; post text is never logged or sent anywhere else. */
export class PostsFeed {
  private readonly queue: Queue;
  private readonly now: () => number;
  private readonly log: Log;
  private busy = false;

  constructor(private readonly d: PostsDeps) {
    this.queue = (d.queueFor ?? pgmq)(d.db);
    this.now = d.now ?? Date.now;
    this.log = d.log ?? console.error;
  }

  /**
   * Reads new posts and applies one update per handle in use, stamped now. A successful read
   * also refreshes handles with no new post, so their post conditions evaluate false rather than
   * stale-unknown; if ops stops polling, posts are missed (false, never a false fire).
   */
  async poll(batch = 100) {
    if (this.busy) return;
    this.busy = true;
    try {
      const msgs = await this.queue.read<PostMessage>("posts", 30, batch);
      const now = this.now();
      const byHandle = new Map<string, Post[]>(this.d.handles().map((h) => [h, []]));
      for (const m of msgs) {
        const p = m.message;
        const handle = typeof p?.handle === "string" ? p.handle.replace(/^@/, "").toLowerCase() : "";
        const at = Date.parse(String(p?.createdAt));
        if (!HANDLE.test(handle) || typeof p.id !== "string" || typeof p.text !== "string" || !Number.isFinite(at)) {
          this.log(`posts: malformed message ${m.msgId} dropped`);
          continue;
        }
        const list = byHandle.get(handle) ?? [];
        list.push({ id: p.id, at, text: p.text });
        byHandle.set(handle, list);
      }
      for (const [account, posts] of byHandle) this.d.evaluator.apply({ src: "posts", account, at: now, posts }, now);
      // Applied in memory: a delete failure only means a redelivery, which merges by id.
      for (const m of msgs) await this.queue.delete("posts", m.msgId).catch((e) => this.log(`posts: delete ${m.msgId} failed`, e));
    } finally {
      this.busy = false;
    }
  }
}
