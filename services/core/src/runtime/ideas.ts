// Loads sealed theses, verifies their commitments and registers them with the evaluator.
// Plaintext specs and salts live only in this process's memory: never logged, never written.
import { Spec, splitCommitments } from "@proviso/dsl";
import { activity, theses, type Db } from "@proviso/db";
import { openSpec } from "@proviso/seal";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { EvalConfig } from "../evaluator/conditions.ts";
import type { Evaluator } from "../evaluator/engine.ts";
import { readKeys } from "../evaluator/machine.ts";
import type { Log } from "./ports.ts";

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
  log?: Log;
};

export class IdeaRegistry {
  private ideas = new Map<string, Idea>();
  private readonly log: Log;
  constructor(private readonly d: IdeasDeps) {
    this.log = d.log ?? console.error;
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
      }
      added.push(id);
    }
    const removed = [...this.ideas.keys()].filter((id) => !seen.has(id));
    for (const id of removed) this.remove(id);
    return { added, removed, invalid };
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
