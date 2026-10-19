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
} from "@proviso/hl";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
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
import { currentAgentKey } from "./agents";
import type { ExecutorPort } from "./port";

// Executor (testnet only): turns fires into Fair Copy waves, watches exits, and stops ideas.
// Every order goes through checkOrder before it is signed; every attempt is an orders row.

export type ExchangeLike = Pick<ExchangeClient, "placeOrders" | "cancelByCloid" | "updateLeverage"> & {
  network?: { name: string };
};
export type InfoLike = Pick<InfoClient, "meta" | "l2Book" | "clearinghouseState">;
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
};

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
  private meta?: Meta;

  constructor(private readonly deps: ExecutorDeps) {
    if (network().name !== "testnet") throw new Error("Executor is testnet only (HL_NETWORK must be testnet)");
    this.db = deps.db;
    this.info = deps.info;
    this.manager = new AgentKeyManager(deps.sealKey);
    this.now = deps.now ?? (() => new Date());
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
    const opens = actions.flatMap((a) => (a.venue === "hl" && a.action === "open" ? [a] : []));
    if (opens.length !== actions.length) return log("fire_refused", { reason: "unsupported_action" });

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
      thesisId: tid, owner, fireId: e.fireId, fireSeq: e.n, spec: e.spec, legs: [], busy: true, nextNonce: 0,
      pnl: 0, pnlKnown: true,
      levels: exitLevels(e.spec.exit, e.mark, opens[0]!.side),
    };
    const filledLegs = new Map<string, number>();
    let callerFailed = false;

    for (const [i, a] of opens.entries()) {
      let ai;
      try { ai = perpAssetInfo(meta, a.coin); } catch { await log("leg_failed", { leg: i, reason: "unknown_coin" }); callerFailed = true; break; }
      const maxLeverage = meta.universe[ai.asset]!.maxLeverage;
      const mark = i === 0 ? e.mark : this.marks.get(a.coin);
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

  private async placeBackstops(idea: OpenIdea) {
    const backstopIdea: PolicyIdea = { thesisId: idea.thesisId, confirmed: true, state: "live", spec: idea.spec };
    for (const leg of idea.legs) {
      const { orders: planned } = backstopStops({
        coin: leg.coin, asset: leg.asset, side: leg.side, exit: idea.spec.exit, referencePx: leg.refMark,
        positions: leg.holdings, round: rounder(leg.szDecimals),
        cloid: { thesisId: idea.thesisId, fireSeq: idea.fireSeq, leg: leg.leg, nonce: this.alloc(idea, leg.holdings.length) },
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
      const [st] = await ex.placeOrders([toRequest(it)]);
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
