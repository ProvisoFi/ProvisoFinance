// Per-idea state machine: edge-triggered firing, once/repeat with cooldown, hard expiry.
import { durationMs, MAX_EXPIRY_DAYS, Spec, type SpecInput } from "@proviso/dsl";
import {
  actionKeys,
  actionsReady,
  and3,
  DEFAULT_CONFIG,
  evalCondition,
  leafKeys,
  leaves,
  UNKNOWN,
  type EvalConfig,
  type EvalMemo,
  type Truth,
} from "./conditions.ts";
import type { MarketView } from "./state.ts";

export type Flag = "trivially_true" | "self_triggered";
export type FireEvent = { kind: "fire"; id: string; at: number; coin: string; mark: number; n: number; flags: Flag[] };
export type ExpireEvent = { kind: "expire"; id: string; at: number };
export type MachineEvent = FireEvent | ExpireEvent;
export type MachineStatus = "live" | "fired" | "expired";

const MAX_EXPIRY_MS = MAX_EXPIRY_DAYS * 86_400_000;
const lower = (hs: readonly string[]) => new Set(hs.map((h) => h.replace(/^@/, "").toLowerCase()));

/** True when a post condition targets an account the caller controls. */
export function selfTriggered(spec: Spec, linkedHandles: readonly string[]): boolean {
  const mine = lower(linkedHandles);
  return leaves(spec.entry.when).some(({ leaf }) => "post" in leaf && mine.has(leaf.post.account.toLowerCase()));
}

/** Flags recorded at stamp time. trivially_true: the entry condition already holds now. */
export function stampFlags(
  spec: Spec,
  view: MarketView,
  now: number,
  linkedHandles: readonly string[] = [],
  cfg: EvalConfig = DEFAULT_CONFIG,
): Flag[] {
  const flags: Flag[] = [];
  if (evalCondition(spec.entry.when, view, now, new Map(), cfg) === true) flags.push("trivially_true");
  if (selfTriggered(spec, linkedHandles)) flags.push("self_triggered");
  return flags;
}

/** Index keys an idea reads, from its condition and its actions. */
export function readKeys(spec: Spec, cfg: EvalConfig = DEFAULT_CONFIG): string[] {
  const keys = new Set<string>();
  for (const { leaf } of leaves(spec.entry.when)) for (const k of leafKeys(leaf)) keys.add(k);
  for (const a of spec.entry.then) for (const k of actionKeys(a, cfg)) keys.add(k);
  return [...keys];
}

export type MachineInit = {
  id: string;
  spec: Spec | SpecInput;
  stampedAt: number;
  /** Defaults to stampedAt + spec.expires; always capped at 30 days from the stamp. */
  expiresAt?: number;
  linkedHandles?: readonly string[];
  config?: EvalConfig;
};

/** One idea's state machine: edge-triggered firing, once/repeat with cooldown, and a hard expiry capped at 30 days from the stamp. */
export class ThesisMachine {
  readonly id: string;
  readonly spec: Spec;
  readonly stampedAt: number;
  readonly expiresAt: number;
  readonly cfg: EvalConfig;
  readonly keys: string[];
  private readonly flags: Flag[];
  private readonly memo: EvalMemo = new Map();
  private readonly cooldownMs: number;
  /** Last true/false value of the gate; undefined until the first known evaluation. */
  private lastKnown: boolean | undefined;
  private lastFireAt: number | undefined;
  private fires = 0;
  status: MachineStatus = "live";

  constructor(init: MachineInit) {
    this.id = init.id;
    this.spec = Spec.parse(init.spec);
    this.stampedAt = init.stampedAt;
    this.expiresAt = Math.min(init.expiresAt ?? Infinity, init.stampedAt + durationMs(this.spec.expires), init.stampedAt + MAX_EXPIRY_MS);
    this.cfg = init.config ?? DEFAULT_CONFIG;
    this.keys = readKeys(this.spec, this.cfg);
    this.flags = selfTriggered(this.spec, init.linkedHandles ?? []) ? ["self_triggered"] : [];
    this.cooldownMs = durationMs(this.spec.cooldown);
  }

  get done() {
    return this.status !== "live";
  }

  /**
   * Re-evaluates at `now`. Fires on a false -> true edge of (entry condition AND action markets
   * ready); unknown leaves the edge state untouched, so false -> unknown -> true still fires but
   * true -> unknown -> true does not. The first known evaluation never fires.
   */
  step(view: MarketView, now: number): MachineEvent[] {
    if (this.done) return [];
    if (now >= this.expiresAt) {
      this.status = "expired";
      return [{ kind: "expire", id: this.id, at: now }];
    }
    const when = evalCondition(this.spec.entry.when, view, now, this.memo, this.cfg);
    const ready = actionsReady(this.spec.entry.then, view, now, this.cfg);
    const gate: Truth = and3([when, ready.ok]);
    if (gate === UNKNOWN) return [];
    const edge = gate && this.lastKnown === false;
    this.lastKnown = gate;
    if (!edge || ready.mark === undefined) return [];
    // An edge inside the cooldown is consumed: the condition must go false -> true again.
    if (this.lastFireAt !== undefined && now - this.lastFireAt < this.cooldownMs) return [];
    this.lastFireAt = now;
    this.fires++;
    if (this.spec.fire === "once") this.status = "fired";
    return [{ kind: "fire", id: this.id, at: now, coin: ready.coin, mark: ready.mark, n: this.fires, flags: [...this.flags] }];
  }
}
