import { activity, fires, follows, orders, theses, users, type Db } from "@proviso/db";
import type { Spec } from "@proviso/dsl";
import {
  network,
  perpAssetInfo,
  roundPrice,
  roundSize,
  type ExchangeClient,
  type InfoClient,
  type Meta,
  type OrderRequest,
  type OrderStatus,
  type Builder,
  decodeCloid,
} from "@proviso/hl";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  backstopStops,
  exitHit,
  exitLevels,
  planEntryWaves,
  planExitWaves,
  type AllowEntry,
  type ExitLevels,
  type Follow,
  type Limits,
  type PlannedOrder,
  type Rounder,
  type Side,
  type SizeRule,
} from "../faircopy/planner";
import { AgentKeyManager, type SealedAgentKey } from "../signer/agentKey";
import { checkOrder, type Hex, type OrderIntent, type PolicyContext, type PolicyIdea } from "../signer/policy";
import { builders, currentAgentKey } from "./agents";
import type { ExecutorPort } from "./port";
import type { SwapFire } from "../rhc/runner";

// Executor (testnet only): turns fires into Fair Copy waves, watches exits, and stops ideas.
// Every order goes through checkOrder before it is signed; every attempt is an orders row.

export type ExchangeLike = Pick<ExchangeClient, "placeOrders" | "cancelByCloid" | "updateLeverage"> & {
  network?: { name: string };
};
export type InfoLike = Pick<InfoClient, "meta" | "l2Book" | "clearinghouseState"> &
  Partial<Pick<InfoClient, "maxBuilderFee">>;
export type ExitReason = "stop" | "take" | "stopped";
export type ExitEvent = { thesisId: bigint; at: Date; reason: ExitReason; pnl?: number };

export type ExecutorDeps = {
  db: Db;
  /** Build an exchange client that signs with this agent key. Must be on testnet. */
  exchangeFor(agentPrivKey: Hex): ExchangeLike;
  info: InfoLike;
  /** 32-byte agent-key seal key (derived in the enclave). */
  sealKey: Uint8Array;
  now?: () => Date;
  onExit?: (e: ExitEvent) => void;
  /** Reads HL_PERPS_BUILDER / HL_SPOT_BUILDER. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Robinhood Chain swaps (R4). Without it, ideas with swap actions are refused. */
  swaps?: {
    run(f: SwapFire): Promise<void>;
    /** Sell a mixed idea's swap legs as part of this executor's exit (no separate report). */
    close(thesisId: bigint, reason: ExitReason): Promise<void>;
    /** Stop an idea only the swap runner holds; false if it holds none. */
    stop(thesisId: bigint): Promise<boolean>;
  };
};

/** Builder fee in tenths of a basis point: perps 0.05%, spot 0.30%. */
export const BUILDER_FEE = { perps: 50, spot: 300 } as const;
const BUILDER_CACHE_MS = 60_000;
const SPOT_ASSET_OFFSET = 10_000;

export type RestoreResult = { restored: bigint[]; skipped: { thesisId: bigint; reason: string }[] };

/** A one-tap confirm from the `confirm` queue. */
export type CopyConfirm = { followId: string; fireId: string; address: string; at?: string | number | Date };
export type ConfirmResult = "placed" | "duplicate" | "expired" | "refused" | "failed";
/** The pgmq helper shape (read/delete) the runtime already has. */
export type ConfirmQueue = {
  read<T>(queue: string, vtSec: number, qty: number): Promise<{ msgId: bigint; readCt: number; message: T }[]>;
  delete(queue: string, msgId: bigint): Promise<void>;
};
export const CONFIRM_QUEUE = "confirm";
const DEFAULT_CONFIRM_WINDOW_SEC = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Role = "caller" | "follower";
type Holding = {
  userId: string;
  account: Hex;
  role: Role;
  key: SealedAgentKey;
  /** Signed size this idea holds on the account (from confirmed fills). */
  szi: number;
  entryPx: number;
  backstops: Hex[];
};
type OpenLeg = {
  leg: number;
  coin: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  side: Side;
  refMark: number;
  holdings: Holding[];
};
type OpenIdea = {
  thesisId: bigint;
  owner: string;
  fireId: string;
  fireSeq: number;
  spec: Spec;
  /** Stop/take from the trigger mark, on the first leg's coin. */
  levels: ExitLevels;
  legs: OpenLeg[];
  busy: boolean;
  nextNonce: number;
  pnl: number;
  pnlKnown: boolean;
};
type FireInput = Parameters<ExecutorPort["onFire"]>[0];
type SendResult = { status: string; filled: number; avgPx: number | null; error?: string };

const asLimits = (j: unknown): Limits | null => {
  const l = j as Partial<Limits> | null;
  return l && l.maxUsd! > 0 && l.maxLev! > 0 && Number.isFinite(l.maxUsd) && Number.isFinite(l.maxLev)
    ? { maxUsd: l.maxUsd!, maxLev: l.maxLev! }
    : null;
};
const minLimits = (a: Limits | null, b: Limits | null): Limits | null =>
  a && b ? { maxUsd: Math.min(a.maxUsd, b.maxUsd), maxLev: Math.min(a.maxLev, b.maxLev) } : null;

/** Sizes round down so a capped notional stays under its cap after rounding. */
const rounder = (szDecimals: number): Rounder => ({
  px: (px) => roundPrice(px, szDecimals),
  sz: (sz) => roundSize(Math.floor(sz * 10 ** szDecimals) / 10 ** szDecimals, szDecimals),
});

function toRequest(o: OrderIntent): OrderRequest {
  return {
    asset: o.asset, isBuy: o.isBuy, limitPx: o.px, sz: o.sz, reduceOnly: o.reduceOnly, cloid: o.cloid,
    orderType: o.trigger
      ? { trigger: { triggerPx: o.trigger.triggerPx, isMarket: o.trigger.isMarket, tpsl: o.trigger.tpsl } }
      : { limit: { tif: o.tif } },
  };
}

function fromStatus(st: OrderStatus | undefined, sz: number): SendResult & { oid?: number } {
  if (st === "waitingForFill" || st === "waitingForTrigger") return { status: "acked", filled: 0, avgPx: null };
  if (st && typeof st === "object") {
    if ("filled" in st) {
      const filled = Number(st.filled.totalSz);
      return { status: filled >= sz ? "filled" : "partial", filled, avgPx: Number(st.filled.avgPx), oid: st.filled.oid };
    }
    if ("resting" in st) return { status: "acked", filled: 0, avgPx: null, oid: st.resting.oid };
    if ("error" in st) return { status: "rejected", filled: 0, avgPx: null, error: st.error };
  }
  return { status: "failed", filled: 0, avgPx: null, error: "no order status" };
}

const venueSzi = (state: Awaited<ReturnType<InfoLike["clearinghouseState"]>>, coin: string) =>
  Number(state.assetPositions.find((p) => p.position.coin === coin)?.position.szi ?? 0);

export class Executor implements ExecutorPort {
  private readonly db: Db;
  private readonly info: InfoLike;
  private readonly manager: AgentKeyManager;
  private readonly now: () => Date;
  private readonly open = new Map<string, OpenIdea>();
  private readonly marks = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly firing = new Set<string>();
  private readonly builders: Partial<Record<"perps" | "spot", Builder>>;
  private readonly approvals = new Map<string, { at: number; ok: boolean }>();
  private readonly builderWarned = new Set<string>();
  private readonly confirming = new Set<string>();
  private readonly confirmWindowMs: number;
  private meta?: Meta;

  constructor(private readonly deps: ExecutorDeps) {
    if (network().name !== "testnet") throw new Error("Executor is testnet only (HL_NETWORK must be testnet)");
    this.db = deps.db;
    this.info = deps.info;
    this.manager = new AgentKeyManager(deps.sealKey);
    this.now = deps.now ?? (() => new Date());
    const env = deps.env ?? process.env;
    this.builders = Object.fromEntries(
      builders(env).map((b) => [b.kind, { b: b.builder, f: BUILDER_FEE[b.kind] }]),
    );
    const win = Number(env.COPY_CONFIRM_WINDOW_SEC ?? DEFAULT_CONFIRM_WINDOW_SEC);
    this.confirmWindowMs = (Number.isFinite(win) && win >= 0 ? win : DEFAULT_CONFIRM_WINDOW_SEC) * 1000;
  }

  /** Resolves once every exit started by onMark has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Thesis ids with a tracked open position. */
  openIdeas(): bigint[] {
    return [...this.open.values()].map((i) => i.thesisId);
  }

  // ------------------------------------------------------------ fire

  async onFire(e: FireInput) {
    const k = e.thesisId.toString();
    if (this.firing.has(k))
      return this.log(e.owner.toLowerCase(), "fire_refused", { thesisId: k, fireId: e.fireId, reason: "already_open" });
    this.firing.add(k);
    try {
      await this.fire(e);
    } finally {
      this.firing.delete(k);
    }
  }

  private async fire(e: FireInput) {
    const owner = e.owner.toLowerCase();
    const tid = e.thesisId;
    const log = (kind: string, payload: Record<string, unknown> = {}, address = owner) =>
      this.log(address, kind, { thesisId: tid.toString(), fireId: e.fireId, ...payload });

    if (e.spec.mode !== "live") return log("alert_fired", { mark: e.mark });
    const [thesis] = await this.db.select().from(theses).where(eq(theses.id, tid));
    if (!thesis || thesis.owner !== owner) return log("fire_refused", { reason: "unknown_idea" });
    if (this.open.has(tid.toString())) return log("fire_refused", { reason: "already_open" });
    const actions = e.spec.entry.then;
    // Robinhood Chain swaps run first (their own Fair Copy waves), then any Hyperliquid legs.
    // In a mixed idea the Hyperliquid side owns the exit and sells the swap legs with it.
    const swaps = actions.flatMap((a) => (a.venue === "rhc" ? [a] : []));
    const opens = actions.flatMap((a) => (a.venue === "hl" && a.action === "open" ? [a] : []));
    if (opens.length + swaps.length !== actions.length || (swaps.length && !this.deps.swaps))
      return log("fire_refused", { reason: "unsupported_action" });
    if (swaps.length) await this.deps.swaps!.run({ owner, thesisId: tid, fireId: e.fireId, actions: swaps, spec: e.spec });
    if (!opens.length) return;
    // The trigger mark is the first action's; when that's a swap, leg 0 uses its own HL mark.
    const ref0 = actions[0] === opens[0] ? e.mark : this.marks.get(opens[0]!.coin);
    if (!ref0) return log("leg_failed", { leg: 0, reason: "no_mark" });

    const now = this.now();
    const callerKey = await currentAgentKey(this.db, owner, now);
    if (!callerKey) return log("needs_onboarding");
    await this.db.insert(fires).values({ id: e.fireId, thesisId: tid, firedAt: e.at, refMark: String(e.mark) })
      .onConflictDoNothing();

    // Followers with a usable agent key.
    const rows = await this.db.select().from(follows).where(and(
      eq(follows.caller, owner), eq(follows.active, true), or(isNull(follows.thesisId), eq(follows.thesisId, tid)),
    ));
    const people = [owner, ...rows.map((r) => r.follower)];
    const userLimits = new Map(
      (await this.db.select().from(users).where(inArray(users.address, people))).map((u) => [u.address, asLimits(u.limits)]),
    );
    const keys = new Map<string, SealedAgentKey>([[owner, callerKey]]);
    const plannerFollows: Follow[] = [];
    const followLimits: Record<string, Limits> = {};
    for (const r of rows) {
      const key = await currentAgentKey(this.db, r.follower, now);
      if (!key) { await log("needs_onboarding", { copying: owner }, r.follower); continue; }
      keys.set(r.follower, key);
      const lim = minLimits(asLimits(r.limits), userLimits.get(r.follower) ?? null);
      if (lim) followLimits[r.follower] = lim;
      plannerFollows.push({
        followerId: r.follower, account: r.follower as Hex, callerId: r.caller, thesisId: r.thesisId,
        active: r.active, size: r.sizeRule as SizeRule,
        allow: Array.isArray(r.sealedAllowlist) ? (r.sealedAllowlist as AllowEntry[]) : undefined,
      });
    }

    const meta = await this.loadMeta();
    const callerPolicy: PolicyIdea = {
      thesisId: tid, confirmed: true,
      state: thesis.state === "live" || thesis.state === "fired" ? "live" : thesis.state,
      spec: e.spec,
    };
    const idea: OpenIdea = {
      thesisId: tid, owner, fireId: e.fireId, fireSeq: e.n, spec: e.spec, legs: [], busy: true,
      nextNonce: (await this.maxNonce(tid, e.n)) + 1,
      pnl: 0, pnlKnown: true,
      levels: exitLevels(e.spec.exit, ref0, opens[0]!.side),
    };
    const filledLegs = new Map<string, number>();
    let callerFailed = false;

    for (const [i, a] of opens.entries()) {
      let ai;
      try { ai = perpAssetInfo(meta, a.coin); } catch { await log("leg_failed", { leg: i, reason: "unknown_coin" }); callerFailed = true; break; }
      const maxLeverage = meta.universe[ai.asset]!.maxLeverage;
      const mark = i === 0 ? ref0 : this.marks.get(a.coin);
      if (!mark) { await log("leg_failed", { leg: i, reason: "no_mark" }); callerFailed = true; break; }
      const book = await this.info.l2Book(a.coin);
      const toLevels = (ls: { px: string; sz: string }[]) => ls.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
      const round = rounder(ai.szDecimals);
      const lev = Math.min(a.lev, maxLeverage);
      const plan = planEntryWaves({
        // ponytail: every idea is treated as sealed (followers never see the spec before the fire),
        // so auto-copy needs an allow-list; flip per idea once reveal state is modelled here.
        fire: { thesisId: tid, fireSeq: e.n, leg: i, nonce: this.alloc(idea, plannerFollows.length + 1),
          coin: a.coin, asset: ai.asset, side: a.side, notionalUsd: a.size.usd, lev, sealed: true },
        caller: { id: owner, account: owner as Hex },
        follows: plannerFollows,
        book: { bids: toLevels(book.levels[0]), asks: toLevels(book.levels[1]) },
        marks: { [a.coin]: mark },
        limits: followLimits,
        round,
      });
      for (const c of plan.confirmRequired)
        await log("copy_confirm_required", { leg: i, coin: a.coin, side: a.side, notionalUsd: c.notionalUsd, lev: c.lev, caller: owner }, c.followerId);
      for (const s of plan.skipped) await log("copy_skipped", { leg: i, reason: s.reason, caller: owner }, s.followerId);

      const leg: OpenLeg = { leg: i, coin: a.coin, asset: ai.asset, szDecimals: ai.szDecimals, maxLeverage, side: a.side, refMark: mark, holdings: [] };
      idea.legs.push(leg);
      const market = { coin: a.coin, asset: ai.asset, mark, maxLeverage };
      const run = async (o: PlannedOrder, role: Role, wave: 1 | 2) => {
        const isCaller = role === "caller";
        const lim = isCaller ? null : followLimits[o.userId]!;
        const policy: PolicyContext = {
          idea: isCaller ? callerPolicy : followerIdea(callerPolicy, lim!),
          user: userLimits.get(o.userId) ?? null,
          market,
          leverage: o.lev,
        };
        const r = await this.send(o, { thesisId: tid, fireId: e.fireId, role, wave, key: keys.get(o.userId)!, policy, lev: o.lev });
        if (r.filled > 0) {
          const dir = o.intent.isBuy ? 1 : -1;
          leg.holdings.push({ userId: o.userId, account: o.account, role, key: keys.get(o.userId)!, szi: dir * r.filled, entryPx: r.avgPx ?? o.intent.px, backstops: [] });
          filledLegs.set(o.account, (filledLegs.get(o.account) ?? 0) + 1);
        }
        return r;
      };

      // Wave 1: every follower on its own account, all acknowledged before the caller goes.
      const [w1, w2] = plan.waves;
      w1.sentAt = Date.now();
      await Promise.all(w1.orders.map((o) => run(o, "follower", 1)));
      w1.ackedAt = Date.now();
      w2.sentAt = Date.now();
      const callerResults = await Promise.all(w2.orders.map((o) => run(o, "caller", 2)));
      w2.ackedAt = Date.now();
      await log("wave_done", {
        leg: i, coin: a.coin, followers: w1.orders.length, scale: plan.scale, callerToFollowerRatio: plan.callerToFollowerRatio,
      });
      if (!callerResults.some((r) => r.filled > 0)) { await log("leg_failed", { leg: i, reason: "caller_not_filled" }); callerFailed = true; break; }
    }

    // A later leg failed: unwind accounts holding only some legs (atomic, or onPartial "unwind").
    const { atomic, onPartial } = e.spec.entry.legs;
    const partial = new Set([...filledLegs].filter(([, n]) => n < opens.length).map(([acct]) => acct));
    if (partial.size && (atomic || onPartial === "unwind")) {
      await log("unwinding", { accounts: partial.size, callerFailed });
      await this.closeSet(idea, (h) => partial.has(h.account), "unwind");
      for (const leg of idea.legs) leg.holdings = leg.holdings.filter((h) => h.szi !== 0);
    }
    idea.legs = idea.legs.filter((l) => l.holdings.length);

    if (idea.legs.length) {
      await this.placeBackstops(idea);
      this.open.set(tid.toString(), idea);
      await log("entered", { legs: idea.legs.length, accounts: new Set(idea.legs.flatMap((l) => l.holdings.map((h) => h.account))).size, ...idea.levels });
    } else {
      await log("no_position");
    }
    idea.busy = false;
  }

  // ------------------------------------------------------------ marks and exits

  onMark(coin: string, mark: number, at: Date): void {
    if (!(mark > 0)) return;
    this.marks.set(coin, mark);
    for (const idea of this.open.values()) {
      const first = idea.legs[0];
      if (idea.busy || !first || first.coin !== coin) continue;
      const hit = exitHit(idea.levels, first.side, mark);
      if (hit) this.track(this.exit(idea, hit, at));
    }
  }

  async stop(thesisId: bigint, owner: string): Promise<void> {
    const o = owner.toLowerCase();
    const k = thesisId.toString();
    // Ownership comes from the database, not only the in-memory set (which is empty after a restart).
    const [row] = await this.db.select({ owner: theses.owner }).from(theses).where(eq(theses.id, thesisId));
    const idea = this.open.get(k);
    if (!row || row.owner.toLowerCase() !== o || (idea && idea.owner !== o))
      return this.log(o, "stop_refused", { thesisId: k, reason: "not_owner" });
    await this.log(o, "stop_requested", { thesisId: k });
    await this.idle();
    const current = this.open.get(k);
    if (current) await this.exit(current, "stopped", this.now());
    else await this.deps.swaps?.stop(thesisId); // swap-only ideas (or mixed ones whose HL side never opened)
    // Cancel this idea's resting orders, except backstops still guarding an unclosed position.
    const guarding = new Set(this.open.get(k)?.legs.flatMap((l) => l.holdings.flatMap((h) => h.backstops)) ?? []);
    const resting = await this.db.select().from(orders).where(and(eq(orders.thesisId, thesisId), eq(orders.status, "acked")));
    const meta = await this.loadMeta();
    for (const r of resting) {
      if (!r.cloid || guarding.has(r.cloid as Hex)) continue;
      const key = await currentAgentKey(this.db, r.account, this.now());
      if (key) await this.cancel(key, perpAssetInfo(meta, r.coin).asset, r.cloid as Hex);
    }
    const left = this.open.get(k);
    await this.log(o, "stopped", {
      thesisId: k,
      tracked: !!idea,
      // Only confirmed fills make an idea flat; an incomplete stop says so.
      flat: !left,
      remaining: left?.legs.flatMap((l) => l.holdings.filter((h) => h.szi !== 0).map((h) => ({ account: h.account, coin: l.coin, szi: h.szi }))) ?? [],
    });
  }

  private async exit(idea: OpenIdea, reason: ExitReason, at: Date) {
    if (idea.busy) return;
    idea.busy = true;
    try {
      await this.closeSet(idea, () => true, reason);
      const remaining = idea.legs.flatMap((l) => l.holdings.filter((h) => h.szi !== 0));
      if (remaining.length) {
        await this.log(idea.owner, "exit_incomplete", { thesisId: idea.thesisId.toString(), reason, remaining: remaining.length });
        return;
      }
      this.open.delete(idea.thesisId.toString());
      await this.deps.swaps?.close(idea.thesisId, reason); // a mixed idea's swap legs go with it
      const pnl = idea.pnlKnown ? idea.pnl : undefined;
      await this.log(idea.owner, "exit", { thesisId: idea.thesisId.toString(), reason, ...(pnl !== undefined && { pnl }) });
      this.deps.onExit?.({ thesisId: idea.thesisId, at, reason, ...(pnl !== undefined && { pnl }) });
    } finally {
      idea.busy = false;
    }
  }

  /** Reduce-only closes of the picked holdings: followers first, then the caller. */
  private async closeSet(idea: OpenIdea, pick: (h: Holding) => boolean, reason: ExitReason | "unwind") {
    const exitIdea: PolicyIdea = { thesisId: idea.thesisId, confirmed: true, state: "closing", spec: idea.spec };
    for (const leg of idea.legs) {
      const picked = leg.holdings.filter((h) => h.szi !== 0 && pick(h));
      if (!picked.length) continue;
      // Sync with the venue: a backstop or liquidation may already have closed some of it.
      const venue = new Map<string, number>();
      for (const h of picked) {
        const v = venueSzi(await this.info.clearinghouseState(h.account), leg.coin);
        venue.set(h.account, v);
        if (Math.sign(v) !== Math.sign(h.szi)) {
          h.szi = 0;
          if (h.role === "caller") idea.pnlKnown = false;
          await this.log(h.userId, "closed_by_venue", { thesisId: idea.thesisId.toString(), coin: leg.coin });
        } else if (Math.abs(v) < Math.abs(h.szi)) h.szi = v;
      }
      const live = picked.filter((h) => h.szi !== 0);
      if (!live.length) { await this.cancelBackstops(leg); continue; }
      const mark = this.marks.get(leg.coin) ?? leg.refMark;
      const caller = live.find((h) => h.role === "caller");
      const plan = planExitWaves({
        coin: leg.coin, asset: leg.asset, side: leg.side, exit: idea.spec.exit, referencePx: leg.refMark, mark,
        caller: caller ?? { userId: idea.owner, account: idea.owner as Hex, szi: 0 },
        followers: live.filter((h) => h.role === "follower"),
        round: rounder(leg.szDecimals),
        cloid: { thesisId: idea.thesisId, fireSeq: idea.fireSeq, leg: leg.leg, nonce: this.alloc(idea, live.length + 1) },
      });
      const market = { coin: leg.coin, asset: leg.asset, mark, maxLeverage: leg.maxLeverage };
      const run = async (o: PlannedOrder, wave: 1 | 2) => {
        const h = live.find((x) => x.account === o.account)!;
        const r = await this.send(o, {
          thesisId: idea.thesisId, fireId: idea.fireId, role: h.role, wave, key: h.key, lev: null,
          policy: { idea: exitIdea, market, positionSzi: venue.get(h.account) ?? null },
        });
        if (r.filled > 0) {
          h.szi += o.intent.isBuy ? r.filled : -r.filled;
          if (Math.abs(h.szi) < 1e-12) h.szi = 0;
          if (h.role === "caller") idea.pnl += (leg.side === "long" ? 1 : -1) * ((r.avgPx ?? o.intent.px) - h.entryPx) * r.filled;
        }
      };
      await Promise.all(plan.waves[0].orders.map((o) => run(o, 1)));
      await Promise.all(plan.waves[1].orders.map((o) => run(o, 2)));
      await this.log(idea.owner, "exit_wave_done", { thesisId: idea.thesisId.toString(), leg: leg.leg, reason, stopPx: plan.stopPx, takePx: plan.takePx });
      await this.cancelBackstops(leg);
    }
  }

  private async placeBackstops(idea: OpenIdea, pick: (h: Holding) => boolean = () => true) {
    const backstopIdea: PolicyIdea = { thesisId: idea.thesisId, confirmed: true, state: "live", spec: idea.spec };
    for (const leg of idea.legs) {
      const picked = leg.holdings.filter((h) => h.szi !== 0 && pick(h));
      if (!picked.length) continue;
      const { orders: planned } = backstopStops({
        coin: leg.coin, asset: leg.asset, side: leg.side, exit: idea.spec.exit, referencePx: leg.refMark,
        positions: picked, round: rounder(leg.szDecimals),
        cloid: { thesisId: idea.thesisId, fireSeq: idea.fireSeq, leg: leg.leg, nonce: this.alloc(idea, picked.length) },
      });
      const market = { coin: leg.coin, asset: leg.asset, mark: this.marks.get(leg.coin) ?? leg.refMark, maxLeverage: leg.maxLeverage };
      for (const o of planned) {
        const h = leg.holdings.find((x) => x.account === o.account)!;
        const szi = venueSzi(await this.info.clearinghouseState(h.account), leg.coin);
        const r = await this.send(o, {
          thesisId: idea.thesisId, fireId: idea.fireId, role: h.role, wave: h.role === "caller" ? 2 : 1, key: h.key, lev: null,
          policy: { idea: backstopIdea, market, positionSzi: szi },
        });
        if (r.status === "acked") h.backstops.push(o.intent.cloid);
      }
    }
  }

  private async cancelBackstops(leg: OpenLeg) {
    for (const h of leg.holdings) {
      if (h.szi !== 0) continue;
      for (const c of h.backstops.splice(0)) await this.cancel(h.key, leg.asset, c);
    }
  }

  // ------------------------------------------------------------ restart recovery

  /**
   * Rebuild open positions after a restart from fires/orders rows, reconciled against the venue.
   * Call once at start, before marks flow. Ideas whose spec is unavailable are logged and skipped.
   */
  async restore(specFor: (thesisId: bigint) => Spec | undefined): Promise<RestoreResult> {
    const out: RestoreResult = { restored: [], skipped: [] };
    const meta = await this.loadMeta();
    const now = this.now();
    const candidates = await this.db.select().from(theses).where(inArray(theses.state, ["fired", "live", "retired"]));
    for (const t of candidates) {
      const tid = t.id;
      if (this.open.has(tid.toString())) continue;
      const skip = async (reason: string) => {
        out.skipped.push({ thesisId: tid, reason });
        await this.log(t.owner, "restore_skipped", { thesisId: tid.toString(), reason });
      };
      const rows = (await this.db.select().from(orders).where(eq(orders.thesisId, tid)).orderBy(asc(orders.createdAt)))
        .filter((r) => r.venue === "hl" && r.cloid && r.fireId);
      const opened = rows.filter((r) => !r.reduceOnly && Number(r.filledSize) > 0);
      if (!opened.length) continue;
      const fireRows = await this.db.select().from(fires).where(inArray(fires.id, [...new Set(opened.map((r) => r.fireId!))]));
      const lastFire = fireRows.sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())[0];
      if (!lastFire) { await skip("no_fire_row"); continue; }
      const mine = rows.filter((r) => r.fireId === lastFire.id);
      const fireSeq = decodeCloid(mine[0]!.cloid!).fireSeq;

      // Net filled size and entry price per (leg, account); acked reduce-only rows are resting backstops.
      type Acc = { role: Role; szi: number; cost: number; qty: number; closes: { sz: number; px: number }[]; backstops: Hex[] };
      const byLeg = new Map<number, Map<string, Acc>>();
      for (const r of mine) {
        const legIx = decodeCloid(r.cloid!).leg;
        if (!byLeg.has(legIx)) byLeg.set(legIx, new Map());
        const m = byLeg.get(legIx)!;
        const a = m.get(r.account) ?? { role: r.role as Role, szi: 0, cost: 0, qty: 0, closes: [], backstops: [] };
        m.set(r.account, a);
        if (r.reduceOnly && r.status === "acked") a.backstops.push(r.cloid as Hex);
        const filled = Number(r.filledSize);
        if (!(filled > 0)) continue;
        a.szi += r.side === "buy" || r.side === "long" ? filled : -filled;
        const px = Number(r.avgPx ?? r.px);
        if (r.reduceOnly) a.closes.push({ sz: filled, px });
        else { a.cost += filled * px; a.qty += filled; }
      }
      const flat = (x: number) => Math.abs(x) < 1e-12;
      const stillOpen = [...byLeg.values()].some((m) => [...m.values()].some((a) => !flat(a.szi)));
      if (!stillOpen) continue; // closed before the restart

      const spec = specFor(tid);
      if (!spec) { await skip("spec_unavailable"); continue; }
      const opens = spec.entry.then.flatMap((a) => (a.venue === "hl" && a.action === "open" ? [a] : []));
      if (opens.length !== spec.entry.then.length) { await skip("unsupported_action"); continue; }

      const refMark = Number(lastFire.refMark);
      const idea: OpenIdea = {
        thesisId: tid, owner: t.owner, fireId: lastFire.id, fireSeq, spec, legs: [], busy: false,
        nextNonce: (await this.maxNonce(tid, fireSeq)) + 1,
        pnl: 0, pnlKnown: true,
        levels: exitLevels(spec.exit, refMark, opens[0]!.side),
      };
      for (const [legIx, accounts] of [...byLeg].sort((a, b) => a[0] - b[0])) {
        const a = opens[legIx];
        if (!a) continue;
        const ai = perpAssetInfo(meta, a.coin);
        const leg: OpenLeg = {
          leg: legIx, coin: a.coin, asset: ai.asset, szDecimals: ai.szDecimals,
          maxLeverage: meta.universe[ai.asset]!.maxLeverage, side: a.side, holdings: [],
          // ponytail: only the trigger mark is stored; later legs fall back to the caller entry price.
          refMark: legIx === 0 ? refMark : 0,
        };
        for (const [account, acc] of accounts) {
          if (flat(acc.szi) && !acc.backstops.length) continue;
          const key = await currentAgentKey(this.db, account, now);
          if (!key) { await this.log(account, "restore_no_key", { thesisId: tid.toString(), coin: a.coin }); continue; }
          const entryPx = acc.qty > 0 ? acc.cost / acc.qty : refMark;
          if (acc.role === "caller") {
            if (!leg.refMark) leg.refMark = entryPx;
            for (const c of acc.closes) idea.pnl += (a.side === "long" ? 1 : -1) * (c.px - entryPx) * c.sz;
          }
          const h: Holding = {
            userId: account, account: account as Hex, role: acc.role, key,
            szi: flat(acc.szi) ? 0 : acc.szi, entryPx, backstops: acc.backstops,
          };
          // Reconcile with the venue: whatever it already closed is flat.
          const v = venueSzi(await this.info.clearinghouseState(h.account), a.coin);
          if (h.szi !== 0 && Math.sign(v) !== Math.sign(h.szi)) {
            h.szi = 0;
            if (h.role === "caller") idea.pnlKnown = false;
            await this.log(h.userId, "closed_by_venue", { thesisId: tid.toString(), coin: a.coin, restored: true });
          } else if (Math.abs(v) < Math.abs(h.szi)) h.szi = v;
          leg.holdings.push(h);
        }
        if (!leg.refMark) leg.refMark = refMark;
        await this.cancelBackstops(leg); // backstops of positions that are already flat
        leg.holdings = leg.holdings.filter((h) => h.szi !== 0);
        if (leg.holdings.length) idea.legs.push(leg);
      }
      if (!idea.legs.length) { await this.log(t.owner, "restored_flat", { thesisId: tid.toString() }); continue; }
      this.open.set(tid.toString(), idea);
      out.restored.push(tid);
      await this.log(t.owner, "restored", {
        thesisId: tid.toString(), fireId: lastFire.id, legs: idea.legs.length,
        accounts: new Set(idea.legs.flatMap((l) => l.holdings.map((h) => h.account))).size, ...idea.levels,
      });
    }
    return out;
  }

  /** Highest cloid nonce stored for (thesis, fireSeq), or -1, so new cloids never collide with old rows. */
  private async maxNonce(thesisId: bigint, fireSeq: number): Promise<number> {
    const rows = await this.db.select({ cloid: orders.cloid }).from(orders).where(eq(orders.thesisId, thesisId));
    let max = -1;
    for (const r of rows) {
      if (!r.cloid) continue;
      try {
        const c = decodeCloid(r.cloid);
        if (c.fireSeq === fireSeq) max = Math.max(max, c.nonce);
      } catch {
        // not a Proviso cloid
      }
    }
    return max;
  }

  // ------------------------------------------------------------ one-tap confirms

  /**
   * A follower confirmed a copy they were asked about. Places it as a late wave-1 follower order,
   * sized from the follow and the current book, with its own cloid, backstop and exit tracking.
   * Deduped by (followId, fireId); presses after the window expire.
   */
  async confirmCopy(c: CopyConfirm): Promise<ConfirmResult> {
    const key = String(c.followId) + "|" + String(c.fireId);
    if (this.confirming.has(key)) return "duplicate";
    this.confirming.add(key);
    let keep = false;
    try {
      const r = await this.confirmOnce(c, String(c.address ?? "").toLowerCase());
      keep = r === "placed" || r === "duplicate" || r === "failed";
      return r;
    } finally {
      if (!keep) this.confirming.delete(key);
    }
  }

  /** Drain the `confirm` queue once (call on a clock). Returns how many messages were read. */
  async pollConfirms(queue: ConfirmQueue, opts: { qty?: number; vtSec?: number; maxReads?: number } = {}): Promise<number> {
    const msgs = await queue.read<CopyConfirm>(CONFIRM_QUEUE, opts.vtSec ?? 30, opts.qty ?? 20);
    for (const m of msgs) {
      try {
        await this.confirmCopy(m.message);
      } catch (err) {
        console.error("executor: confirm", err);
        if (m.readCt < (opts.maxReads ?? 5)) continue; // retried after the visibility timeout
      }
      await queue.delete(CONFIRM_QUEUE, m.msgId);
    }
    return msgs.length;
  }

  private async confirmOnce(c: CopyConfirm, address: string): Promise<ConfirmResult> {
    const ref = { followId: String(c.followId), fireId: String(c.fireId) };
    const refuse = async (reason: string) => {
      await this.log(address || "unknown", "copy_confirm_refused", { ...ref, reason });
      return "refused" as const;
    };
    if (!UUID_RE.test(ref.followId) || !UUID_RE.test(ref.fireId)) return refuse("bad_request");
    const [f] = await this.db.select().from(follows).where(eq(follows.id, ref.followId));
    if (!f || !f.active) return refuse("follow_inactive");
    if (f.follower !== address) return refuse("not_follower");
    const [fr] = await this.db.select().from(fires).where(eq(fires.id, ref.fireId));
    if (!fr) return refuse("unknown_fire");
    const [thesis] = await this.db.select().from(theses).where(eq(theses.id, fr.thesisId));
    if (!thesis || thesis.owner !== f.caller || (f.thesisId != null && f.thesisId !== fr.thesisId)) return refuse("follow_mismatch");
    // Any earlier entry attempt for this fire on this account (auto copy, earlier press, before a restart).
    const prior = await this.db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.fireId, ref.fireId), eq(orders.account, address), eq(orders.reduceOnly, false))).limit(1);
    if (prior.length) return "duplicate";
    const ageMs = this.now().getTime() - fr.firedAt.getTime();
    if (ageMs > this.confirmWindowMs) {
      await this.log(address, "copy_confirm_expired", { ...ref, thesisId: fr.thesisId.toString(), ageSec: Math.round(ageMs / 1000) });
      return "expired";
    }
    const idea = this.open.get(fr.thesisId.toString());
    const callerOpen = !!idea && idea.fireId === ref.fireId &&
      idea.legs[0]?.holdings.some((h) => h.role === "caller" && h.szi !== 0);
    if (!idea || !callerOpen) return refuse("caller_position_closed");
    if (idea.busy) return refuse("idea_busy");
    const agent = await currentAgentKey(this.db, address, this.now());
    if (!agent) { await this.log(address, "needs_onboarding", { ...ref }); return "refused"; }
    const [u] = await this.db.select().from(users).where(eq(users.address, address));
    const userLim = asLimits(u?.limits);
    const lim = minLimits(asLimits(f.limits), userLim);
    if (!lim) return refuse("no_limits");

    const tid = idea.thesisId;
    const callerPolicy: PolicyIdea = {
      thesisId: tid, confirmed: true,
      state: thesis.state === "live" || thesis.state === "fired" ? "live" : thesis.state,
      spec: idea.spec,
    };
    const opens = idea.spec.entry.then.flatMap((a) => (a.venue === "hl" && a.action === "open" ? [a] : []));
    const mine = (h: Holding) => h.account === address && h.role === "follower";
    idea.busy = true; // no exit runs while the late copy goes in
    try {
      let failed = false;
      for (const leg of idea.legs) {
        const a = opens[leg.leg];
        if (!a) { failed = true; break; }
        const mark = this.marks.get(leg.coin) ?? leg.refMark;
        const book = await this.info.l2Book(leg.coin);
        const toLevels = (ls: { px: string; sz: string }[]) => ls.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
        // Same sizing, depth cap and IOC band as wave 1; the press itself is the authorization.
        const plan = planEntryWaves({
          fire: { thesisId: tid, fireSeq: idea.fireSeq, leg: leg.leg, nonce: this.alloc(idea, 2),
            coin: leg.coin, asset: leg.asset, side: leg.side, notionalUsd: a.size.usd,
            lev: Math.min(a.lev, leg.maxLeverage), sealed: false },
          caller: { id: idea.owner, account: idea.owner as Hex },
          follows: [{ followerId: address, account: address as Hex, callerId: f.caller, thesisId: f.thesisId, active: true, size: f.sizeRule as SizeRule }],
          book: { bids: toLevels(book.levels[0]), asks: toLevels(book.levels[1]) },
          marks: { [leg.coin]: mark },
          limits: { [address]: lim },
          round: rounder(leg.szDecimals),
        });
        const o = plan.waves[0].orders[0];
        if (!o) {
          await this.log(address, "copy_skipped", { ...ref, leg: leg.leg, reason: plan.skipped[0]?.reason ?? "no_order" });
          failed = true;
          break;
        }
        const r = await this.send(o, {
          thesisId: tid, fireId: idea.fireId, role: "follower", wave: 1, key: agent, lev: o.lev,
          policy: {
            idea: followerIdea(callerPolicy, lim), user: userLim,
            market: { coin: leg.coin, asset: leg.asset, mark, maxLeverage: leg.maxLeverage }, leverage: o.lev,
          },
        });
        if (!(r.filled > 0)) { failed = true; break; }
        leg.holdings.push({
          userId: address, account: address as Hex, role: "follower", key: agent,
          szi: (o.intent.isBuy ? 1 : -1) * r.filled, entryPx: r.avgPx ?? o.intent.px, backstops: [],
        });
      }
      const { atomic, onPartial } = idea.spec.entry.legs;
      if (failed && (atomic || onPartial === "unwind") && idea.legs.some((l) => l.holdings.some(mine))) {
        await this.closeSet(idea, mine, "unwind");
        for (const leg of idea.legs) leg.holdings = leg.holdings.filter((h) => h.szi !== 0);
      }
      if (idea.legs.some((l) => l.holdings.some((h) => mine(h) && h.szi !== 0))) await this.placeBackstops(idea, mine);
      await this.log(address, failed ? "copy_confirm_failed" : "copy_confirmed", { ...ref, thesisId: tid.toString() });
      return failed ? "failed" : "placed";
    } finally {
      idea.busy = false;
    }
  }

  // ------------------------------------------------------------ builder fees

  /** The builder to attach for this account, only once it has approved at least our fee (cached a minute). */
  private async builderFor(account: string, asset: number): Promise<Builder | undefined> {
    const kind = asset >= SPOT_ASSET_OFFSET ? "spot" : "perps";
    const builder = this.builders[kind];
    if (!builder) return undefined;
    const key = account.toLowerCase() + "|" + builder.b.toLowerCase();
    const t = Date.now();
    let c = this.approvals.get(key);
    if (!c || t - c.at >= BUILDER_CACHE_MS) {
      let ok = false;
      try {
        const max = await this.info.maxBuilderFee?.(account as Hex, builder.b);
        ok = typeof max === "number" && max >= builder.f;
      } catch {
        // unknown counts as not approved: place without a builder
      }
      this.approvals.set(key, (c = { at: t, ok }));
    }
    if (c.ok) return builder;
    if (!this.builderWarned.has(key)) {
      this.builderWarned.add(key);
      await this.log(account.toLowerCase(), "builder_not_approved", { builder: builder.b, kind, fee: builder.f });
    }
    return undefined;
  }

  // ------------------------------------------------------------ plumbing

  private async send(
    o: PlannedOrder,
    s: { thesisId: bigint; fireId: string; role: Role; wave: number; key: SealedAgentKey; policy: PolicyContext; lev: number | null },
  ): Promise<SendResult> {
    const it = o.intent;
    const base = {
      fireId: s.fireId, thesisId: s.thesisId, account: o.account, role: s.role, wave: s.wave, venue: "hl",
      cloid: it.cloid, coin: it.coin, side: it.isBuy ? "buy" : "sell", size: String(it.sz), px: String(it.px),
      reduceOnly: it.reduceOnly,
    };
    const verdict = checkOrder(it, s.policy);
    if (!verdict.ok) {
      await this.db.insert(orders).values({ ...base, status: "rejected", error: verdict.reason });
      return { status: "rejected", filled: 0, avgPx: null, error: verdict.reason };
    }
    const [row] = await this.db.insert(orders).values({ ...base, status: "pending" }).returning({ id: orders.id });
    let r: SendResult & { oid?: number };
    try {
      const ex = this.exchange(s.key);
      if (s.lev != null) await ex.updateLeverage(it.asset, s.lev);
      // The builder rides on the action only; checkOrder above saw the same order.
      const builder = await this.builderFor(o.account, it.asset);
      const [st] = await ex.placeOrders([toRequest(it)], builder ? { builder } : {});
      r = fromStatus(st, it.sz);
    } catch (err) {
      r = { status: "failed", filled: 0, avgPx: null, error: err instanceof Error ? err.message : String(err) };
    }
    await this.db.update(orders).set({
      status: r.status, filledSize: String(r.filled), avgPx: r.avgPx == null ? null : String(r.avgPx),
      venueOrderId: r.oid == null ? null : String(r.oid), error: r.error ?? null, updatedAt: this.now(),
    }).where(eq(orders.id, row!.id));
    return r;
  }

  private async cancel(key: SealedAgentKey, asset: number, cloid: Hex) {
    try {
      const [st] = await this.exchange(key).cancelByCloid([{ asset, cloid }]);
      if (st === "success")
        await this.db.update(orders).set({ status: "cancelled", updatedAt: this.now() }).where(eq(orders.cloid, cloid));
    } catch {
      // Left as acked; a later stop retries it.
    }
  }

  private exchange(key: SealedAgentKey): ExchangeLike {
    const ex = this.deps.exchangeFor(this.manager.unseal(key));
    if (ex.network && ex.network.name !== "testnet") throw new Error("Executor is testnet only");
    return ex;
  }

  private alloc(idea: OpenIdea, n: number) {
    const base = idea.nextNonce;
    idea.nextNonce += n;
    return base;
  }

  private async loadMeta() {
    // ponytail: meta cached for the process lifetime; refresh on a timer if listings change mid-run.
    return (this.meta ??= await this.info.meta());
  }

  private track(p: Promise<void>) {
    const t = p.catch((err) => console.error("executor:", err)).finally(() => this.pending.delete(t));
    this.pending.add(t);
  }

  private async log(address: string, kind: string, payload: Record<string, unknown>) {
    await this.db.insert(activity).values({ address, kind, payload, at: this.now() });
  }
}

/** The caller's idea as the signer sees it for one follower: sized and levered to that follower's limits. */
function followerIdea(caller: PolicyIdea, lim: Limits): PolicyIdea {
  const then = caller.spec.entry.then.map((a) =>
    a.venue === "hl" && a.action === "open" ? { ...a, size: { usd: lim.maxUsd }, lev: Math.min(a.lev, lim.maxLev) } : a);
  return { ...caller, spec: { entry: { ...caller.spec.entry, then }, limits: { maxUsd: lim.maxUsd, maxLev: lim.maxLev } } };
}
