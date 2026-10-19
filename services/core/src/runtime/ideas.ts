// Loads sealed theses, verifies their commitments and registers them with the evaluator.
// Plaintext specs and salts live only in this process's memory: never logged, never written.
import { Spec, splitCommitments } from "@proviso/dsl";
import { activity, fires, reveals, theses, xHandles, type Db } from "@proviso/db";
import { bytesToHex } from "@noble/hashes/utils.js";
import { openSpec } from "@proviso/seal";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { EvalConfig } from "../evaluator/conditions.ts";
import type { Evaluator } from "../evaluator/engine.ts";
import { leaves } from "../evaluator/conditions.ts";
import { readKeys } from "../evaluator/machine.ts";
import { pgmq, type Executes, type Log, type Queue } from "./ports.ts";

export type Idea = {
  thesisId: bigint;
  owner: string;
  spec: Spec;
  saltE: `0x${string}`;
  saltX: `0x${string}`;
  canonicalEntry: Uint8Array;
  canonicalExit: Uint8Array;
  stampedAt: Date;
  expiresAt: Date;
};

/** live/alert ideas are evaluated; fired ones stay in memory until their exit is revealed. */
const ACTIVE = ["live", "alert"] as const;
const KEPT = [...ACTIVE, "fired"];

export type IdeasDeps = {
  db: Db;
  evaluator: Evaluator;
  specKey: Uint8Array;
  /** X handles the owner controls, for the self_triggered flag. Default: none known. */
  linkedHandles?: (owner: string) => Promise<string[]>;
  /** Evaluator config for every machine (e.g. testnet liquidity floors). */
  config?: EvalConfig;
  /**
   * Whether a retired idea still holds a position (its plaintext is then kept for the exit
   * reveal). Default: it has any fires row; the exit report or a stop releases it.
   */
  hasOpenPosition?: (thesisId: bigint) => Promise<boolean>;
  queueFor?: (db: Executes) => Queue;
  log?: Log;
};

/** X accounts a spec's post conditions read: lowercase, without @. */
export const postHandles = (spec: Spec) =>
  [...new Set(leaves(spec.entry.when).flatMap(({ leaf }) => ("post" in leaf ? [leaf.post.account.replace(/^@/, "").toLowerCase()] : [])))].sort();

export class IdeaRegistry {
  private ideas = new Map<string, Idea>();
  /** Retired ideas kept in memory only until their exit is revealed. */
  private retiredKept = new Set<string>();
  private readonly log: Log;
  private readonly queueFor: (db: Executes) => Queue;
  constructor(private readonly d: IdeasDeps) {
    this.log = d.log ?? console.error;
    this.queueFor = d.queueFor ?? pgmq;
  }

  /** Handles the evaluated (live/alert) ideas read; the posts feed refreshes exactly these. */
  postHandles(): string[] {
    const hs = new Set<string>();
    for (const [id, i] of this.ideas) if (this.d.evaluator.get(id)) for (const h of postHandles(i.spec)) hs.add(h);
    return [...hs].sort();
  }

  /** The executor reported the exit: a retired idea kept for it can go now. */
  exited(thesisId: bigint | string) {
    if (this.retiredKept.has(String(thesisId))) this.remove(thesisId);
  }

  get(thesisId: bigint | string): Idea | undefined {
    return this.ideas.get(String(thesisId));
  }
  get size() {
    return this.ideas.size;
  }

  /** Coins whose marks the live and fired ideas need (conditions and actions). */
  hlCoins(): string[] {
    const coins = new Set<string>();
    for (const i of this.ideas.values())
      for (const k of readKeys(i.spec)) if (k.startsWith("hl:")) coins.add(k.slice(3));
    return [...coins].sort();
  }

  remove(thesisId: bigint | string) {
    this.retiredKept.delete(String(thesisId));
    this.ideas.delete(String(thesisId));
    this.d.evaluator.remove(String(thesisId));
  }

  /** One poll: register new ideas, drop ideas that left live/alert/fired. */
  async sync(): Promise<{ added: string[]; removed: string[]; invalid: string[] }> {
    const rows = await this.d.db.select().from(theses).where(inArray(theses.state, KEPT));
    const seen = new Set<string>();
    const added: string[] = [];
    const invalid: string[] = [];
    for (const row of rows) {
      const id = row.id.toString();
      seen.add(id);
      if (this.ideas.has(id)) continue;
      const idea = this.verify(row);
      if (!idea) {
        await this.reject(row.id, row.owner);
        seen.delete(id);
        invalid.push(id);
        continue;
      }
      this.ideas.set(id, idea);
      if ((ACTIVE as readonly string[]).includes(row.state)) {
        const handles = (await this.d.linkedHandles?.(row.owner)) ?? [];
        this.d.evaluator.add({
          id,
          spec: idea.spec,
          stampedAt: row.stampedAt.getTime(),
          expiresAt: row.expiresAt.getTime(),
          linkedHandles: handles,
          config: this.d.config,
        });
        const hs = postHandles(idea.spec);
        if (hs.length) await this.d.db.insert(xHandles).values(hs.map((handle) => ({ handle }))).onConflictDoNothing();
      }
      added.push(id);
    }
    const gone = [...this.ideas.keys()].filter((id) => !seen.has(id) && !this.retiredKept.has(id));
    const states = gone.length
      ? await this.d.db.select({ id: theses.id, state: theses.state }).from(theses).where(inArray(theses.id, gone.map(BigInt)))
      : [];
    const removed: string[] = [];
    for (const id of gone) {
      if (states.find((r) => r.id.toString() === id)?.state === "retired") await this.retire(id);
      else this.remove(id);
      if (!this.retiredKept.has(id)) removed.push(id);
    }
    await this.pruneHandles();
    return { added, removed, invalid };
  }

  /** Deletes x_handles rows no evaluated idea reads any more. */
  private async pruneHandles() {
    const used = this.postHandles();
    await this.d.db.delete(xHandles).where(used.length ? notInArray(xHandles.handle, used) : undefined);
  }

  /** Owner retired on-chain: reveal the entry (unless already revealed), then drop or keep the plaintext. */
  private async retire(id: string) {
    const idea = this.ideas.get(id)!;
    const tid = idea.thesisId;
    this.d.evaluator.remove(id); // no new fires
    const [revealed] = await this.d.db
      .select({ at: reveals.revealedAt })
      .from(reveals)
      .where(and(eq(reveals.thesisId, tid), eq(reveals.part, "entry"), isNotNull(reveals.revealedAt)));
    await this.d.db.transaction(async (tx) => {
      if (!revealed)
        await this.queueFor(tx).send("reveal", {
          thesisId: tid.toString(),
          part: "entry",
          kind: "RETIRED",
          canonical: `0x${bytesToHex(idea.canonicalEntry)}`,
          salt: idea.saltE,
        });
      await tx.insert(activity).values({ address: idea.owner, kind: "retired", payload: { thesisId: tid.toString() } });
    });
    const open = this.d.hasOpenPosition
      ? await this.d.hasOpenPosition(tid)
      : (await this.d.db.select({ id: fires.id }).from(fires).where(eq(fires.thesisId, tid)).limit(1)).length > 0;
    if (open) this.retiredKept.add(id);
    else this.remove(id);
  }

  /** Opens the box and checks it reproduces both on-chain commitments exactly. Null on any failure. */
  private verify(row: typeof theses.$inferSelect): Idea | null {
    try {
      const p = openSpec(this.d.specKey, row.encSpec);
      const spec = Spec.parse(p.spec);
      const c = splitCommitments(spec, { saltE: p.saltE, saltX: p.saltX });
      if (c.entryHash.toLowerCase() !== row.entryHash.toLowerCase() || c.exitHash.toLowerCase() !== row.exitHash.toLowerCase())
        return null;
      return {
        thesisId: row.id,
        owner: row.owner,
        spec,
        saltE: p.saltE,
        saltX: p.saltX,
        canonicalEntry: c.canonicalEntry,
        canonicalExit: c.canonicalExit,
        stampedAt: row.stampedAt,
        expiresAt: row.expiresAt,
      };
    } catch {
      return null; // never surface the error: it could quote plaintext
    }
  }

  private async reject(id: bigint, owner: string) {
    this.log(`ideas: thesis ${id} failed commitment verification, stopping it`);
    await this.d.db.transaction(async (tx) => {
      await tx
        .update(theses)
        .set({
          state: "stopped",
          flags: sql`case when 'invalid_commitment' = any(${theses.flags}) then ${theses.flags} else array_append(${theses.flags}, 'invalid_commitment') end`,
        })
        .where(and(eq(theses.id, id), inArray(theses.state, KEPT)));
      await tx.insert(activity).values({ address: owner, kind: "idea_invalid", payload: { thesisId: id.toString(), reason: "invalid_commitment" } });
    });
  }
}
