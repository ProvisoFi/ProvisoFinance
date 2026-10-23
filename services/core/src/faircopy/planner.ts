import { durationMs, type Exit } from "@proviso/dsl";
import { encodeCloid, type CloidParts } from "@proviso/hl";
import type { Hex, OrderIntent } from "../signer/policy";

// Fair Copy (Backend §6): followers trade before the caller, at the same reference levels,
// within a depth budget, and get out first.

export const DEPTH_LEVELS = 10;
export const DEPTH_SHARE = 0.2;
export const IOC_BAND = 0.01;
export const MIN_ORDER_USD = 10; // Hyperliquid rejects orders under $10 notional
/**
 * Backstop distance as a multiple of the stop distance, drawn per leg: a fixed multiple on a public
 * book would reveal the sealed stop %. Always beyond the stop (> 1×).
 */
export const BACKSTOP_MULT_RANGE = [1.8, 2.6] as const;
/** Draws one backstop multiple uniformly from BACKSTOP_MULT_RANGE with crypto randomness. */
export const backstopMult = () => {
  const [lo, hi] = BACKSTOP_MULT_RANGE;
  return lo + ((hi - lo) * crypto.getRandomValues(new Uint32Array(1))[0]!) / 2 ** 32;
};
export const BACKSTOP_SLIPPAGE = 0.1;

export type Side = "long" | "short";
export type Level = { px: number; sz: number };
export type Book = { bids: Level[]; asks: Level[] };
/** Exchange rounding for a coin. `sz` should round down so caps still hold. */
export type Rounder = { px(px: number, coin: string): number; sz(sz: number, coin: string): number };
export type { CloidParts };
/** Order i of a plan gets nonce + i, so every order (and orders row) has its own cloid. */
const cloidAt = (p: CloidParts, i: number) => encodeCloid({ ...p, nonce: p.nonce + i });
export type Limits = { maxUsd: number; maxLev: number };

export type Fire = CloidParts & {
  coin: string;
  asset: number;
  side: Side;
  /** The caller's notional for this leg. Cloids: caller nonce, followers nonce + 1 + i. */
  notionalUsd: number;
  lev: number;
  sealed: boolean;
};
export type Caller = { id: string; account: Hex; copyPromise?: boolean };
export type SizeRule = { kind: "fixed"; usd: number } | { kind: "ratio"; ratio: number };
export type AllowEntry = { coin: string; side: Side | "both"; maxUsd: number; maxLev: number };
export type Follow = {
  followerId: string;
  account: Hex;
  callerId: string;
  /** null/undefined = every idea of this caller. */
  thesisId?: bigint | null;
  active: boolean;
  size: SizeRule;
  /** Required to auto-copy a sealed idea. */
  allow?: AllowEntry[];
};

export type PlannedOrder = { userId: string; account: Hex; lev: number | null; notionalUsd: number; intent: OrderIntent };
export type Wave = {
  wave: 1 | 2;
  /** Wave 2 may only be sent once every wave-1 order is acknowledged. */
  after: "none" | "wave1_acks";
  orders: PlannedOrder[];
  /** Filled by the executor. */
  sentAt: number | null;
  ackedAt: number | null;
};
export type ConfirmRequest = { followerId: string; account: Hex; notionalUsd: number; lev: number };
export type Skip = { followerId: string; reason: "no_limits" | "zero_limits" | "below_min" };

export type EntryInput = {
  fire: Fire;
  caller: Caller;
  follows: Follow[];
  book: Book;
  marks: Record<string, number>;
  /** Each follower's limits, by followerId. A follower without limits is skipped. */
  limits: Record<string, Limits>;
  round: Rounder;
};
export type EntryPlan = {
  waves: [Wave, Wave];
  confirmRequired: ConfirmRequest[];
  skipped: Skip[];
  /** Pro-rata factor applied to follower sizes (1 = not depth-capped). */
  scale: number;
  depthCapUsd: number;
  callerNotionalUsd: number;
  followerNotionalUsd: number;
  /** Caller notional / total wave-1 follower notional; null with no auto followers. */
  callerToFollowerRatio: number | null;
};

const wave = (n: 1 | 2, orders: PlannedOrder[]): Wave => ({
  wave: n,
  after: n === 1 ? "none" : "wave1_acks",
  orders,
  sentAt: null,
  ackedAt: null,
});

const markOf = (marks: Record<string, number>, coin: string) => {
  const m = marks[coin];
  if (!(typeof m === "number" && Number.isFinite(m) && m > 0)) throw new Error(`no mark for ${coin}`);
  return m;
};

/** IOC limit at mark ± 1%: buys pay up to +1%, sells accept down to −1%. */
const iocPx = (mark: number, isBuy: boolean, coin: string, round: Rounder) =>
  round.px(mark * (isBuy ? 1 + IOC_BAND : 1 - IOC_BAND), coin);

const sumUsd = (levels: Level[]) =>
  levels.slice(0, DEPTH_LEVELS).reduce((s, l) => s + (l.px > 0 && l.sz > 0 ? l.px * l.sz : 0), 0);

function ioc(
  userId: string, account: Hex, usd: number, lev: number | null, coin: string, asset: number,
  isBuy: boolean, mark: number, round: Rounder, cloid: Hex,
): PlannedOrder | null {
  const px = iocPx(mark, isBuy, coin, round);
  const sz = round.sz(usd / px, coin);
  if (!(px > 0 && sz > 0)) return null;
  return {
    userId, account, lev, notionalUsd: px * sz,
    intent: { coin, asset, isBuy, px, sz, reduceOnly: false, tif: "Ioc", cloid },
  };
}

/** Max-min fair split of `cap` over `wants` (same order): smallest wants are filled first, each at most an equal share of what is left. */
export function fairShare(wants: readonly number[], cap: number): number[] {
  const out = new Array<number>(wants.length).fill(0);
  let left = cap;
  const order = wants.map((w, i) => [w, i] as const).sort((a, b) => a[0] - b[0]);
  order.forEach(([w, i], k) => {
    const give = Math.min(w, left / (order.length - k));
    out[i] = give;
    left -= give;
  });
  return out;
}

/** Plans one fire's entry: wave 1 is follower IOCs (auto-copy only when the idea is unsealed or an allow-list entry covers it), wave 2 the caller's IOC. Follower sizes are capped by their limits and share DEPTH_SHARE of the book's top DEPTH_LEVELS max-min fairly; copies under MIN_ORDER_USD are skipped and confirm-only followers get a confirm request instead. Throws when `marks` has no positive mark for the coin. */
export function planEntryWaves({ fire, caller, follows, book, marks, limits, round }: EntryInput): EntryPlan {
  const mark = markOf(marks, fire.coin);
  const isBuy = fire.side === "long";
  const skipped: Skip[] = [];
  const sized: { f: Follow; usd: number; lev: number; auto: boolean }[] = [];

  for (const f of follows) {
    if (!f.active || f.callerId !== caller.id) continue;
    if (f.thesisId != null && f.thesisId !== fire.thesisId) continue;
    const lim = limits[f.followerId];
    if (!lim) { skipped.push({ followerId: f.followerId, reason: "no_limits" }); continue; }
    const want = f.size.kind === "fixed" ? f.size.usd : f.size.ratio * fire.notionalUsd;
    const usd = Math.min(want, lim.maxUsd);
    const lev = Math.floor(Math.min(fire.lev, lim.maxLev));
    if (!(usd > 0) || !(lev >= 1)) { skipped.push({ followerId: f.followerId, reason: "zero_limits" }); continue; }
    // A sealed idea is invisible to the follower, so only a standing allow-list authorizes an auto order.
    const auto = !fire.sealed || (f.allow ?? []).some((a) =>
      a.coin === fire.coin && (a.side === "both" || a.side === fire.side) && usd <= a.maxUsd && lev <= a.maxLev);
    sized.push({ f, usd, lev, auto });
  }

  // Auto (wave-1) followers share the depth budget first, confirm-only followers what is left. Each
  // share is max-min fair (smallest copies filled first, nobody above an equal split of the rest), so
  // one follower with a huge size takes one slice instead of scaling every real copy below the minimum
  // (P-M3). A confirm costs nothing until pressed, so it never counts against wave 1. The cap holds
  // even if every confirm is pressed.
  const depthCapUsd = DEPTH_SHARE * sumUsd(isBuy ? book.asks : book.bids);
  const autoIx = sized.flatMap((x, i) => (x.auto ? [i] : []));
  const confirmIx = sized.flatMap((x, i) => (x.auto ? [] : [i]));
  const alloc = new Array<number>(sized.length).fill(0);
  const autoUsed = fairShare(autoIx.map((i) => sized[i]!.usd), depthCapUsd).reduce((s, v, k) => ((alloc[autoIx[k]!] = v), s + v), 0);
  fairShare(confirmIx.map((i) => sized[i]!.usd), Math.max(0, depthCapUsd - autoUsed)).forEach((v, k) => (alloc[confirmIx[k]!] = v));
  const autoWant = autoIx.reduce((s, i) => s + sized[i]!.usd, 0);
  const scale = autoWant > 0 ? autoUsed / autoWant : 1;

  const orders: PlannedOrder[] = [];
  const confirmRequired: ConfirmRequest[] = [];
  for (const [i, { f, lev, auto }] of sized.entries()) {
    const scaled = alloc[i]!;
    if (scaled < MIN_ORDER_USD) { skipped.push({ followerId: f.followerId, reason: "below_min" }); continue; }
    if (!auto) { confirmRequired.push({ followerId: f.followerId, account: f.account, notionalUsd: scaled, lev }); continue; }
    const o = ioc(f.followerId, f.account, scaled, lev, fire.coin, fire.asset, isBuy, mark, round, cloidAt(fire, 1 + i));
    if (o && o.notionalUsd >= MIN_ORDER_USD) orders.push(o);
    else skipped.push({ followerId: f.followerId, reason: "below_min" });
  }

  const callerOrder = ioc(caller.id, caller.account, fire.notionalUsd, fire.lev, fire.coin, fire.asset, isBuy, mark, round, cloidAt(fire, 0));
  const followerNotionalUsd = orders.reduce((s, o) => s + o.notionalUsd, 0);
  const callerNotionalUsd = callerOrder?.notionalUsd ?? 0;
  return {
    waves: [wave(1, orders), wave(2, callerOrder ? [callerOrder] : [])],
    confirmRequired,
    skipped,
    scale,
    depthCapUsd,
    callerNotionalUsd,
    followerNotionalUsd,
    callerToFollowerRatio: followerNotionalUsd > 0 ? callerNotionalUsd / followerNotionalUsd : null,
  };
}

// ---------------------------------------------------------------- exits

export type ExitLevels = { stopPx: number; takePx: number | null };

/** Stop and target from the reference (trigger) mark, computed once and shared by everyone. */
export function exitLevels(exit: Exit, referencePx: number, side: Side): ExitLevels {
  if (!(referencePx > 0)) throw new Error("referencePx must be positive");
  const dir = side === "long" ? 1 : -1;
  const takePx = referencePx * (1 + (dir * exit.take.pct) / 100);
  return { stopPx: referencePx * (1 + (dir * exit.stop.pct) / 100), takePx: takePx > 0 ? takePx : null };
}

/** Which exit level `mark` has reached for a position on `side`: the stop, the target, or null. */
export function exitHit(levels: ExitLevels, side: Side, mark: number): "stop" | "take" | null {
  const { stopPx, takePx } = levels;
  if (side === "long") return mark <= stopPx ? "stop" : takePx !== null && mark >= takePx ? "take" : null;
  return mark >= stopPx ? "stop" : takePx !== null && mark <= takePx ? "take" : null;
}

/** Per-idea exit progress (TU-32): best mark since the fire, partial targets taken, share of the original position closed. */
export type ExitProgress = { peak: number; taken: number; closed: number; firedAt: number };

export type ExitStep =
  | { kind: "stop" | "take" | "trail" | "time" }
  /** Close `share` of what's still open (the partial's fraction of the original position). */
  | { kind: "partial"; index: number; share: number };

/**
 * The exit due at `mark` (TU-32): updates the progress's peak, then returns the first of the time
 * exit, the fixed stop, the trailing stop, the final target and the next partial target that applies.
 */
export function nextExit(exit: Exit, levels: ExitLevels, side: Side, refPx: number, mark: number, p: ExitProgress, now: number): ExitStep | null {
  const long = side === "long";
  p.peak = long ? Math.max(p.peak, mark) : Math.min(p.peak, mark);
  if (exit.maxHold && now - p.firedAt >= durationMs(exit.maxHold)) return { kind: "time" };
  const hit = exitHit(levels, side, mark);
  if (hit === "stop") return { kind: "stop" };
  if (exit.trail) {
    const trailPx = long ? p.peak * (1 - exit.trail.pct / 100) : p.peak * (1 + exit.trail.pct / 100);
    if (long ? mark <= trailPx : mark >= trailPx) return { kind: "trail" };
  }
  if (hit === "take") return { kind: "take" };
  const next = exit.partials?.[p.taken];
  if (next) {
    const px = refPx * (1 + ((long ? 1 : -1) * next.pct) / 100);
    if (long ? mark >= px : mark <= px) return { kind: "partial", index: p.taken, share: next.fraction / (1 - p.closed) };
  }
  return null;
}

/** Fresh progress at the fire. */
export const exitProgress = (refPx: number, firedAt: number): ExitProgress => ({ peak: refPx, taken: 0, closed: 0, firedAt });

export type Position = { userId: string; account: Hex; szi: number };

function closeOrder(p: Position, sz: number, coin: string, asset: number, mark: number, round: Rounder, cloid: Hex): PlannedOrder {
  const isBuy = p.szi < 0;
  const px = iocPx(mark, isBuy, coin, round);
  return {
    userId: p.userId, account: p.account, lev: null, notionalUsd: px * sz,
    intent: { coin, asset, isBuy, px, sz, reduceOnly: true, tif: "Ioc", cloid },
  };
}

export type ExitInput = {
  coin: string;
  asset: number;
  side: Side;
  exit: Exit;
  referencePx: number;
  /** Current mark, used to price the closes when they are sent. */
  mark: number;
  caller: Position;
  followers: Position[];
  round: Rounder;
  cloid: CloidParts;
  /** Share of each open position to close (partial targets, TU-32); 1 closes it all. */
  share?: number;
};

/** Reduce-only closes (all, or `share` of each position): followers in wave 1, the caller in wave 2. Cloids: caller nonce, followers nonce + 1 + i. */
export function planExitWaves(x: ExitInput): ExitLevels & { waves: [Wave, Wave] } {
  const levels = exitLevels(x.exit, x.referencePx, x.side);
  const dir = x.side === "long" ? 1 : -1;
  const share = Math.min(1, x.share ?? 1);
  const size = (p: Position) => (share >= 1 ? Math.abs(p.szi) : x.round.sz(Math.abs(p.szi) * share, x.coin));
  const close = (ps: Position[], first: number) =>
    ps.flatMap((p, i) => Math.sign(p.szi) === dir && size(p) > 0
      ? [closeOrder(p, size(p), x.coin, x.asset, x.mark, x.round, cloidAt(x.cloid, first + i))]
      : []);
  return { ...levels, waves: [wave(1, close(x.followers, 1)), wave(2, close([x.caller], 0))] };
}

export type BackstopInput = Omit<ExitInput, "mark" | "caller" | "followers"> & {
  positions: Position[];
  /** From backstopMult(); keep one per leg so repeated placements don't sample the range. */
  mult: number;
};

/** Native reduce-only stop on every account at reference ± mult × the stop distance (disaster backstop). Cloid nonce + i per position. */
export function backstopStops(x: BackstopInput): { triggerPx: number | null; orders: PlannedOrder[] } {
  const [lo, hi] = BACKSTOP_MULT_RANGE;
  if (!(x.mult >= lo && x.mult <= hi)) throw new Error(`backstop multiple ${x.mult} outside [${lo}, ${hi}]`);
  const dist = (x.referencePx * Math.abs(x.exit.stop.pct)) / 100;
  const isLong = x.side === "long";
  const raw = x.referencePx + (isLong ? -1 : 1) * x.mult * dist;
  if (!(raw > 0)) return { triggerPx: null, orders: [] }; // a long stop this deep has no backstop above zero
  const triggerPx = x.round.px(raw, x.coin);
  const px = x.round.px(raw * (isLong ? 1 - BACKSTOP_SLIPPAGE : 1 + BACKSTOP_SLIPPAGE), x.coin);
  const orders = x.positions
    .flatMap((p, i): PlannedOrder[] => Math.sign(p.szi) !== (isLong ? 1 : -1) ? [] : [{
      userId: p.userId, account: p.account, lev: null, notionalUsd: px * Math.abs(p.szi),
      intent: {
        coin: x.coin, asset: x.asset, isBuy: !isLong, px, sz: Math.abs(p.szi), reduceOnly: true, tif: "Gtc",
        trigger: { tpsl: "sl", triggerPx, isMarket: true }, cloid: cloidAt(x.cloid, i),
      },
    }]);
  return { triggerPx, orders };
}

// ---------------------------------------------------------------- outside closes

export type CallerPositionUpdate = {
  callerId: string;
  coin: string;
  asset: number;
  prevSzi: number;
  szi: number;
  /** True when the change came from an order Proviso signed (check against the signer's cloid log). */
  signedByProviso: boolean;
  /** The caller holds the Copy Promise badge. */
  copyPromise: boolean;
};
export type CopiedPosition = Position & { callerId: string; thesisId: bigint; coin: string };
export type Breach = "outside_close" | "opposite_trade";
export type OutsideCloseResult = {
  closedOutside: boolean;
  /** Share of each copied position to close (1 = all). */
  fraction: number;
  breaches: Breach[];
  /** Reduce-only follower closes, to send as one wave. */
  closes: PlannedOrder[];
};

/** Checks a caller position change not signed by Proviso: a reduce or flip closes the same share of each copied position (an opposite trade closes all), and with the Copy Promise badge records the breach. Returns reduce-only follower closes to send as one wave. */
export function detectOutsideClose(
  u: CallerPositionUpdate,
  open: CopiedPosition[],
  /** Cloids: each copy's own thesisId with fireSeq/leg, nonce + i. */
  pricing: { mark: number; round: Rounder; fireSeq: number; leg: number; nonce: number },
): OutsideCloseResult {
  const none: OutsideCloseResult = { closedOutside: false, fraction: 0, breaches: [], closes: [] };
  if (u.signedByProviso) return none;
  const copies = open.filter((p) => p.callerId === u.callerId && p.coin === u.coin && p.szi !== 0);
  const prev = Math.sign(u.prevSzi);
  const next = Math.sign(u.szi);
  const flipped = prev !== 0 && next === -prev;
  const reduced = prev !== 0 && (flipped || Math.abs(u.szi) < Math.abs(u.prevSzi));
  const closeFraction = !reduced ? 0 : flipped ? 1 : 1 - Math.abs(u.szi) / Math.abs(u.prevSzi);
  const copyDir = copies.length ? Math.sign(copies[0]!.szi) : 0;
  const opposite = copyDir !== 0 && next === -copyDir;
  const fraction = opposite ? 1 : closeFraction;
  const breaches: Breach[] = [];
  if (u.copyPromise && closeFraction > 0) breaches.push("outside_close");
  if (u.copyPromise && opposite) breaches.push("opposite_trade");
  const closes = fraction <= 0 ? [] : copies.flatMap((p, i) => {
    const full = Math.abs(p.szi);
    const sz = fraction >= 1 ? full : Math.min(full, pricing.round.sz(full * fraction, u.coin));
    if (!(sz > 0)) return [];
    const cloid = encodeCloid({ thesisId: p.thesisId, fireSeq: pricing.fireSeq, leg: pricing.leg, nonce: pricing.nonce + i });
    return [closeOrder(p, sz, u.coin, u.asset, pricing.mark, pricing.round, cloid)];
  });
  return { closedOutside: closeFraction > 0, fraction, breaches, closes };
}
