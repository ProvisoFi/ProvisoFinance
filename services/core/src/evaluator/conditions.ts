// Three-valued condition evaluation (true / false / "unknown") with fail-closed source checks.
// UNKNOWN comes from stale data, failed per-leg agreement, a halted or illiquid market, or a
// missing input; the machine never fires on it.
import { durationMs, marketSession, MIN_HL_VOLUME_USD, MIN_POOL_DEPTH_USD, sessionTradable, type Action, type Condition, type Leaf } from "@proviso/dsl";
import type { MarketView, Stamped } from "./state.ts";

export const UNKNOWN = "unknown" as const;
export type Truth = boolean | typeof UNKNOWN;

export type Source = "hl" | "rhc" | "session" | "fg" | "earnings" | "corp" | "posts";
export type EvalConfig = {
  /** Per-source maximum age of the source timestamp at evaluation time. */
  maxAgeMs: Record<Source, number>;
  /** The past mark used by `change` must sit within this of `now - window`. */
  historyToleranceMs: number;
  /** Each price must agree with its own second source within this percent. */
  agreementPct: number;
  minHlVolumeUsd: number;
  minPoolDepthUsd: number;
  /** Pool depth a gap condition needs while the Stock Token carries the closed-session flag. */
  closedGapDepthUsd: number;
  /** A matching post counts for this long after it was published. */
  postWindowMs: number;
  /** The quote token of Robinhood Chain pools; it needs no depth or price of its own. */
  quoteToken: string;
};

export const DEFAULT_CONFIG: EvalConfig = {
  maxAgeMs: {
    hl: 30_000, // streamed, 5 s debounce
    rhc: 180_000, // polled every 60 s
    session: 180_000,
    fg: 26 * 3_600_000, // the index itself is published daily
    earnings: 48 * 3_600_000, // fetched daily
    corp: 48 * 3_600_000,
    posts: 180_000, // polled every 30-60 s
  },
  historyToleranceMs: 120_000,
  agreementPct: 1,
  minHlVolumeUsd: MIN_HL_VOLUME_USD,
  minPoolDepthUsd: MIN_POOL_DEPTH_USD,
  closedGapDepthUsd: MIN_POOL_DEPTH_USD,
  postWindowMs: 3_600_000,
  quoteToken: "USDG",
};

/** DEFAULT_CONFIG with overrides; `maxAgeMs` entries merge per source. */
export function config(over: Partial<Omit<EvalConfig, "maxAgeMs">> & { maxAgeMs?: Partial<EvalConfig["maxAgeMs"]> } = {}): EvalConfig {
  return { ...DEFAULT_CONFIG, ...over, maxAgeMs: { ...DEFAULT_CONFIG.maxAgeMs, ...over.maxAgeMs } };
}

/** `after` state: node path -> time its inner condition started holding. */
export type EvalMemo = Map<string, number>;

/** Three-valued AND: any false is false, else any unknown is unknown. */
export const and3 = (vs: Truth[]): Truth => (vs.includes(false) ? false : vs.includes(UNKNOWN) ? UNKNOWN : true);
/** Three-valued OR: any true is true, else any unknown is unknown. */
export const or3 = (vs: Truth[]): Truth => (vs.includes(true) ? true : vs.includes(UNKNOWN) ? UNKNOWN : false);
/** Three-valued NOT: unknown stays unknown. */
export const not3 = (v: Truth): Truth => (v === UNKNOWN ? UNKNOWN : !v);

type U = typeof UNKNOWN;
const fresh = <T>(s: Stamped<T> | undefined, now: number, maxAge: number): T | U =>
  s !== undefined && now - s.at <= maxAge ? s.value : UNKNOWN;
const num = (v: number | U): number | U => (v !== UNKNOWN && Number.isFinite(v) ? v : UNKNOWN);

function compare(op: ">" | "<" | ">=" | "<=", a: number | U, b: number): Truth {
  if (a === UNKNOWN || !Number.isFinite(a)) return UNKNOWN;
  return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
}

/** |a - ref| / ref within agreementPct. NaN or a non-positive ref fails. */
export function agrees(a: number, ref: number, pct: number): boolean {
  return ref > 0 && Math.abs(a - ref) / ref <= pct / 100 + 1e-12;
}

/**
 * HL market usable at all: inside its external session (session guards: HIP-3 markets read unknown when
 * closed, on holidays and for the first minutes after a reopen), fresh 24h volume over the floor, not halted.
 */
export function hlMarketOk(coin: string, view: MarketView, now: number, cfg: EvalConfig): boolean {
  if (!sessionTradable(marketSession(coin, now))) return false;
  if (view.hlHalted(coin)?.value === true) return false;
  const vol = num(fresh(view.hlVolume24h(coin), now, cfg.maxAgeMs.hl));
  return vol !== UNKNOWN && vol >= cfg.minHlVolumeUsd;
}

/** HL mark that passed its own leg check (fresh mark and oracle within agreementPct, liquid, not halted). */
export function hlPrice(coin: string, view: MarketView, now: number, cfg: EvalConfig): number | U {
  if (!hlMarketOk(coin, view, now, cfg)) return UNKNOWN;
  const mark = num(fresh(view.hlMark(coin), now, cfg.maxAgeMs.hl));
  const oracle = num(fresh(view.hlOracle(coin), now, cfg.maxAgeMs.hl));
  if (mark === UNKNOWN || oracle === UNKNOWN || !agrees(mark, oracle, cfg.agreementPct)) return UNKNOWN;
  return mark;
}

/** Pool depth fresh and at least `minDepth`. */
export function rhcLiquid(coin: string, view: MarketView, now: number, cfg: EvalConfig, minDepth = cfg.minPoolDepthUsd) {
  const depth = num(fresh(view.rhcDepth(coin), now, cfg.maxAgeMs.rhc));
  return depth !== UNKNOWN && depth >= minDepth;
}

/** RHC pool price that passed its own leg check (fresh pool and reference within agreementPct, liquid). */
export function rhcPrice(coin: string, view: MarketView, now: number, cfg: EvalConfig): number | U {
  if (!rhcLiquid(coin, view, now, cfg)) return UNKNOWN;
  const pool = num(fresh(view.rhcPool(coin), now, cfg.maxAgeMs.rhc));
  const ref = num(fresh(view.rhcRef(coin), now, cfg.maxAgeMs.rhc));
  if (pool === UNKNOWN || ref === UNKNOWN || !agrees(pool, ref, cfg.agreementPct)) return UNKNOWN;
  return pool;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Wall-clock weekday (0 = Sunday) and minute of day in `tz`. */
export function localTime(now: number, tz: string): { day: number; minute: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday], minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}
const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** [from, to) in tz; from > to wraps past midnight and the after-midnight part belongs to the previous day. from == to is empty. */
function inTimeWindow(c: Extract<Leaf, { time_window: unknown }>["time_window"], now: number): boolean {
  const { day, minute } = localTime(now, c.tz);
  const from = hhmm(c.from);
  const to = hhmm(c.to);
  const dayOk = (d: number) => !c.days || c.days.includes(d);
  if (from < to) return minute >= from && minute < to && dayOk(day);
  if (from > to) return (minute >= from && dayOk(day)) || (minute < to && dayOk((day + 6) % 7));
  return false;
}

/** Evaluates one leaf against the market view at `now`; unknown when its inputs are stale, disagree, illiquid or missing. */
export function evalLeaf(c: Leaf, view: MarketView, now: number, cfg: EvalConfig = DEFAULT_CONFIG): Truth {
  const age = cfg.maxAgeMs;
  if ("price" in c) return compare(c.price.op, hlPrice(c.price.coin, view, now, cfg), c.price.value);
  if ("change" in c) {
    const { coin, op, value, window } = c.change;
    const cur = hlPrice(coin, view, now, cfg);
    const target = now - durationMs(window);
    const past = view.hlMarkAt(coin, target);
    if (cur === UNKNOWN || !past || target - past.at > cfg.historyToleranceMs || !(past.value > 0)) return UNKNOWN;
    return compare(op, ((cur - past.value) / past.value) * 100, value);
  }
  if ("funding" in c || "oi" in c) {
    const [{ coin, op, value }, s] =
      "funding" in c ? [c.funding, view.hlFunding(c.funding.coin)] : [c.oi, view.hlOi(c.oi.coin)];
    if (!hlMarketOk(coin, view, now, cfg)) return UNKNOWN;
    return compare(op, num(fresh(s, now, age.hl)), value);
  }
  if ("fear_greed" in c) return compare(c.fear_greed.op, num(fresh(view.fearGreed(), now, age.fg)), c.fear_greed.value);
  if ("time_window" in c) return inTimeWindow(c.time_window, now);
  if ("market_session" in c) {
    const s = fresh(view.session(), now, age.session);
    return s === UNKNOWN ? UNKNOWN : s === c.market_session.is;
  }
  if ("earnings_window" in c) {
    const { coin, within, relative } = c.earnings_window;
    const dates = fresh(view.earnings(coin), now, age.earnings);
    if (dates === UNKNOWN) return UNKNOWN;
    const w = durationMs(within);
    return dates.some((e) => {
      const d = e - now; // > 0: earnings ahead of now
      return relative === "before" ? d >= 0 && d <= w : relative === "after" ? d <= 0 && -d <= w : Math.abs(d) <= w;
    });
  }
  if ("corporate_action" in c) {
    const { coin, kind, within } = c.corporate_action;
    const acts = fresh(view.corporateActions(coin), now, age.corp);
    if (acts === UNKNOWN) return UNKNOWN;
    const w = durationMs(within);
    return acts.some((a) => a.kind === kind && Math.abs(a.at - now) <= w); // either side of now
  }
  if ("gap" in c) {
    // Each leg passes its own check; the two legs are never required to agree with each other.
    const { coin, op, value } = c.gap;
    const perp = hlPrice(coin, view, now, cfg);
    const token = rhcPrice(coin, view, now, cfg);
    if (perp === UNKNOWN || token === UNKNOWN) return UNKNOWN;
    const closed = view.rhcClosed(coin);
    // A missing flag is treated as closed (the stricter depth rule).
    if ((closed === undefined || closed.value) && !rhcLiquid(coin, view, now, cfg, cfg.closedGapDepthUsd)) return UNKNOWN;
    return compare(op, ((token - perp) / perp) * 100, value);
  }
  // post: every string in `contains`, case-insensitive, in one post published within postWindowMs.
  const { account, contains } = c.post;
  const posts = fresh(view.posts(account), now, age.posts);
  if (posts === UNKNOWN) return UNKNOWN;
  const needles = contains.map((s) => s.toLowerCase());
  return posts.some((p) => {
    if (p.at > now || now - p.at > cfg.postWindowMs) return false;
    const text = p.text.toLowerCase();
    return needles.every((n) => text.includes(n));
  });
}

/**
 * Evaluates a condition tree. Every child is evaluated (no short-circuit) so `after` nodes keep
 * their persistence state. `after` is true once its condition has held for `n`; false or unknown
 * resets it (continuity is unproven while data is unknown) and unknown propagates.
 */
export function evalCondition(
  cond: Condition,
  view: MarketView,
  now: number,
  memo: EvalMemo,
  cfg: EvalConfig = DEFAULT_CONFIG,
  path = "$",
): Truth {
  if ("all" in cond) return and3(cond.all.map((c, i) => evalCondition(c, view, now, memo, cfg, `${path}.all[${i}]`)));
  if ("any" in cond) return or3(cond.any.map((c, i) => evalCondition(c, view, now, memo, cfg, `${path}.any[${i}]`)));
  if ("not" in cond) return not3(evalCondition(cond.not, view, now, memo, cfg, `${path}.not`));
  if ("after" in cond) {
    const key = `${path}.after`;
    const v = evalCondition(cond.after.cond, view, now, memo, cfg, `${key}.cond`);
    if (v !== true) {
      memo.delete(key);
      return v;
    }
    const since = memo.get(key) ?? now;
    memo.set(key, since);
    return now - since >= durationMs(cond.after.n);
  }
  return evalLeaf(cond, view, now, cfg);
}

/** Every leaf with its path, in evaluation order. */
export function leaves(cond: Condition, path = "$"): { path: string; leaf: Leaf }[] {
  if ("all" in cond) return cond.all.flatMap((c, i) => leaves(c, `${path}.all[${i}]`));
  if ("any" in cond) return cond.any.flatMap((c, i) => leaves(c, `${path}.any[${i}]`));
  if ("not" in cond) return leaves(cond.not, `${path}.not`);
  if ("after" in cond) return leaves(cond.after.cond, `${path}.after.cond`);
  return [{ path, leaf: cond }];
}

/** Input keys a leaf reads (same keys as updateKey). time_window reads only the clock. */
export function leafKeys(l: Leaf): string[] {
  if ("price" in l) return [`hl:${l.price.coin}`];
  if ("change" in l) return [`hl:${l.change.coin}`];
  if ("funding" in l) return [`hl:${l.funding.coin}`];
  if ("oi" in l) return [`hl:${l.oi.coin}`];
  if ("gap" in l) return [`hl:${l.gap.coin}`, `rhc:${l.gap.coin}`];
  if ("fear_greed" in l) return ["fg"];
  if ("market_session" in l) return ["session"];
  if ("earnings_window" in l) return [`earnings:${l.earnings_window.coin}`];
  if ("corporate_action" in l) return [`corp:${l.corporate_action.coin}`];
  if ("post" in l) return [`posts:${l.post.account.toLowerCase()}`];
  return [];
}

/** The coin an action is about: the perp/spot coin, or the non-quote token of a swap. */
export function actionCoin(a: Action, cfg: EvalConfig = DEFAULT_CONFIG): string {
  if (a.venue === "hl") return a.coin;
  return a.tokenOut === cfg.quoteToken ? a.tokenIn : a.tokenOut;
}

/** Input keys an action's markets read: `hl:<coin>`, or `rhc:<token>` for each non-quote token of a swap. */
export function actionKeys(a: Action, cfg: EvalConfig = DEFAULT_CONFIG): string[] {
  if (a.venue === "hl") return [`hl:${a.coin}`];
  return [a.tokenIn, a.tokenOut].filter((t) => t !== cfg.quoteToken).map((t) => `rhc:${t}`);
}

/**
 * Liquidity floors for every market in the actions, plus a checked price for the first action's
 * coin (the trigger mark). Unknown when any market fails.
 */
export function actionsReady(
  actions: Action[],
  view: MarketView,
  now: number,
  cfg: EvalConfig = DEFAULT_CONFIG,
): { ok: Truth; coin: string; mark?: number } {
  const first = actions[0];
  const coin = actionCoin(first, cfg);
  const liquid = actions.every((a) =>
    a.venue === "hl"
      ? hlMarketOk(a.coin, view, now, cfg)
      : [a.tokenIn, a.tokenOut].every((t) => t === cfg.quoteToken || rhcLiquid(t, view, now, cfg)),
  );
  const mark = first.venue === "hl" ? hlPrice(coin, view, now, cfg) : rhcPrice(coin, view, now, cfg);
  if (!liquid || mark === UNKNOWN) return { ok: UNKNOWN, coin };
  return { ok: true, coin, mark };
}
