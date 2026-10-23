import { MAX_LEVERAGE, Spec, type Condition } from "./schema.ts";
import { hasSessionCalendar, marketSession } from "./sessions.ts";

/** The Stock Token behind a perp: "xyz:TSLA" and "TSLA" both trade against the TSLA token (gap conditions). */
export const stockSymbol = (coin: string) => coin.split(":").at(-1)!;

export const MIN_HL_VOLUME_USD = 250_000;
export const MIN_POOL_DEPTH_USD = 100_000;
/** C17 choice: bound rule complexity so evaluation and read-back stay legible. */
export const MAX_LEAF_CONDITIONS = 8;
export const MAX_CONDITION_DEPTH = 4;

/**
 * What a spec may use: actions as `venue:action`, conditions by their leaf key. `hip3Live`: whether
 * live orders on HIP-3 markets ("xyz:NVDA": stocks, metals, oil, indices) are allowed; alerts on them always are.
 */
export type Capabilities = { actions: readonly string[]; conditions: readonly string[]; hip3Live?: boolean };

/**
 * What core runs today (TU-02). Anything else seals fine and never trades: Hyperliquid close,
 * reduce and spot actions are refused at fire time, and no data source feeds market-session,
 * earnings or corporate-action conditions yet (they stay unknown, so the idea never fires).
 * Widen this as TU-27 (feeds) and TU-31 (spot) land.
 */
export const CORE_CAPABILITIES: Capabilities = {
  // HIP-3 live trading: session guards, per-dex collateral and the carry budget are in (expansion.md #2–#4).
  hip3Live: true,
  actions: ["hl:open", "rhc:swap"],
  conditions: ["price", "change", "funding", "oi", "gap", "fear_greed", "time_window", "post"],
};

/** Everything the rule language can describe. */
export const ALL_CAPABILITIES: Capabilities = {
  hip3Live: true,
  actions: ["hl:open", "hl:close", "hl:reduce", "hl:spot", "rhc:swap"],
  conditions: [...CORE_CAPABILITIES.conditions, "market_session", "earnings_window", "corporate_action"],
};

const UNSUPPORTED_ACTION: Record<string, string> = {
  "hl:close": "Closing a position as an entry action isn't supported yet: ideas exit on their stop and target",
  "hl:reduce": "Reducing a position as an entry action isn't supported yet: ideas exit on their stop and target",
  "hl:spot": "Hyperliquid spot trades aren't supported yet: use a perp or a Robinhood Chain swap",
};
const UNFED_CONDITION: Record<string, string> = {
  market_session: "market-session",
  earnings_window: "earnings",
  corporate_action: "corporate-action",
};

export type HlPerpMeta = { maxLeverage: number; volume24hUsd: number };
export type HlSpotMeta = { volume24hUsd: number };
/** Stock Token / token on Robinhood Chain; depth is its pool against USDG. */
export type RhcTokenMeta = { isCanonical: boolean; poolDepthUsd: number };
export type ValidateContext = {
  hl: Record<string, HlPerpMeta>;
  hlSpot?: Record<string, HlSpotMeta>;
  rhc?: Record<string, RhcTokenMeta>;
  user: { maxUsd: number; maxLev: number };
  /** Liquidity floors; default to the spec's. Lowered only on testnet, where volumes are tiny. */
  floors?: { hlVolumeUsd?: number; poolDepthUsd?: number };
  /** What may be used; defaults to CORE_CAPABILITIES (what core runs today). */
  capabilities?: Capabilities;
};

export type ValidationCode =
  | "schema"
  | "unknown_market"
  | "not_canonical"
  | "illiquid"
  | "limits_over_user"
  | "size_over_limit"
  | "lev_over_limit"
  | "too_complex"
  | "unsupported";
export type Path = (string | number)[];
export type ValidationError = { code: ValidationCode; path: Path; message: string };
export type ValidationResult =
  | { ok: true; spec: Spec; errors: [] }
  | { ok: false; errors: ValidationError[] };

const get = <T>(r: Record<string, T> | undefined, k: string) =>
  r && Object.hasOwn(r, k) ? r[k] : undefined;

/**
 * The structural limits alone (no market data), for re-checking a sealed spec before running it.
 * Null when within limits, else a short reason.
 */
export function complexityError(when: Condition): string | null {
  let leaves = 0;
  let depth = 0;
  const walk = (c: Condition, d: number): void => {
    depth = Math.max(depth, d);
    if ("all" in c) return c.all.forEach((x) => walk(x, d + 1));
    if ("any" in c) return c.any.forEach((x) => walk(x, d + 1));
    if ("not" in c) return walk(c.not, d + 1);
    if ("after" in c) return walk(c.after.cond, d + 1);
    leaves++;
  };
  walk(when, 1);
  if (depth > MAX_CONDITION_DEPTH) return `nested ${depth} deep (max ${MAX_CONDITION_DEPTH})`;
  if (leaves > MAX_LEAF_CONDITIONS) return `${leaves} conditions (max ${MAX_LEAF_CONDITIONS})`;
  return null;
}

/** Schema + market + limit checks. Comparisons are written `!(x <= cap)` so NaN fails closed. */
export function validate(input: unknown, ctx: ValidateContext): ValidationResult {
  const parsed = Spec.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: "schema",
        path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
        message: i.message,
      })),
    };
  const spec = parsed.data;
  const errors: ValidationError[] = [];
  const err = (code: ValidationCode, path: Path, message: string) =>
    errors.push({ code, path, message });

  const minHl = ctx.floors?.hlVolumeUsd ?? MIN_HL_VOLUME_USD;
  const minPool = ctx.floors?.poolDepthUsd ?? MIN_POOL_DEPTH_USD;
  const perp = (coin: string, path: Path) => {
    const m = get(ctx.hl, coin);
    if (!m) err("unknown_market", path, `${coin} is not a Hyperliquid perp`);
    else if (!hasSessionCalendar(coin))
      err("unsupported", path, `${coin} has no published session calendar yet, so Proviso can't tell its real prices from off-hours ones`);
    else if (!(m.volume24hUsd >= minHl))
      err("illiquid", path, `${coin} trades under $${minHl.toLocaleString("en-US")} a day on Hyperliquid`);
    return m;
  };
  const spot = (coin: string, path: Path) => {
    const m = get(ctx.hlSpot, coin);
    if (!m) err("unknown_market", path, `${coin} is not a Hyperliquid spot market`);
    else if (!(m.volume24hUsd >= minHl))
      err("illiquid", path, `${coin} trades under $${minHl.toLocaleString("en-US")} a day on Hyperliquid spot`);
  };
  const token = (coin: string, path: Path) => {
    const m = get(ctx.rhc, coin);
    if (!m) err("unknown_market", path, `${coin} is not on Robinhood Chain`);
    else if (!m.isCanonical) err("not_canonical", path, `${coin} is not a canonical Stock Token`);
    else if (!(m.poolDepthUsd >= minPool))
      err("illiquid", path, `${coin} pool depth is under $${minPool.toLocaleString("en-US")}`);
  };

  const { user, hl } = ctx;
  const can = ctx.capabilities ?? CORE_CAPABILITIES;
  if (!(spec.limits.maxUsd <= user.maxUsd))
    err("limits_over_user", ["limits", "maxUsd"], `Idea limit exceeds your $${user.maxUsd} limit`);
  if (!(spec.limits.maxLev <= user.maxLev))
    err("limits_over_user", ["limits", "maxLev"], `Idea leverage exceeds your ${user.maxLev}× limit`);

  const maxUsd = Math.min(spec.limits.maxUsd, user.maxUsd);
  let total = 0;
  spec.entry.then.forEach((a, i) => {
    const path: Path = ["entry", "then", i];
    if ("size" in a) total += a.size.usd;
    const kind = `${a.venue}:${a.action}`;
    if (!can.actions.includes(kind))
      err("unsupported", [...path, "action"], UNSUPPORTED_ACTION[kind] ?? `${kind} actions aren't supported yet`);
    else if (a.venue === "hl" && "coin" in a && a.coin.includes(":") && spec.mode === "live" && !can.hip3Live)
      err(
        "unsupported",
        [...path, "coin"],
        `Live trading on ${a.coin} (stocks, metals, oil and indices) isn't open here; seal it as an alert for now`,
      );
    else if (a.venue === "hl" && "coin" in a && spec.mode === "live" && marketSession(a.coin, 0) === "preipo")
      err(
        "unsupported",
        [...path, "coin"],
        `${a.coin} is a pre-IPO market: its price comes only from its own order book, so it stays alert-only for now`,
      );
    if (a.venue === "rhc") {
      token(a.tokenIn, [...path, "tokenIn"]);
      token(a.tokenOut, [...path, "tokenOut"]);
    } else if (a.action === "spot") spot(a.coin, [...path, "coin"]);
    else {
      const m = perp(a.coin, [...path, "coin"]);
      if (a.action === "open") {
        const cap = Math.min(spec.limits.maxLev, user.maxLev, m?.maxLeverage ?? MAX_LEVERAGE, MAX_LEVERAGE);
        if (!(a.lev <= cap)) err("lev_over_limit", [...path, "lev"], `Leverage is capped at ${cap}× here`);
      }
    }
  });
  if (!(total <= maxUsd))
    err("size_over_limit", ["entry", "then"], `Total size $${total} exceeds the $${maxUsd} limit`);

  let leaves = 0;
  const walk = (c: Condition, path: Path, depth: number) => {
    if (depth > MAX_CONDITION_DEPTH)
      return err("too_complex", path, `Nest conditions at most ${MAX_CONDITION_DEPTH} deep`);
    if ("all" in c) return c.all.forEach((x, i) => walk(x, [...path, "all", i], depth + 1));
    if ("any" in c) return c.any.forEach((x, i) => walk(x, [...path, "any", i], depth + 1));
    if ("not" in c) return walk(c.not, [...path, "not"], depth + 1);
    if ("after" in c) return walk(c.after.cond, [...path, "after", "cond"], depth + 1);
    leaves++;
    const leaf = Object.keys(c)[0]!;
    if (!can.conditions.includes(leaf))
      err("unsupported", [...path, leaf], `No live data feeds ${UNFED_CONDITION[leaf] ?? leaf} conditions yet, so this idea would never fire`);
    if ("price" in c) perp(c.price.coin, [...path, "price", "coin"]);
    else if ("change" in c) perp(c.change.coin, [...path, "change", "coin"]);
    else if ("funding" in c) perp(c.funding.coin, [...path, "funding", "coin"]);
    else if ("oi" in c) perp(c.oi.coin, [...path, "oi", "coin"]);
    else if ("gap" in c) {
      perp(c.gap.coin, [...path, "gap", "coin"]);
      token(stockSymbol(c.gap.coin), [...path, "gap", "coin"]);
    } else if ("earnings_window" in c || "corporate_action" in c) {
      const [k, coin] =
        "earnings_window" in c
          ? ["earnings_window", c.earnings_window.coin]
          : ["corporate_action", c.corporate_action.coin];
      if (!get(hl, coin) && !get(ctx.rhc, coin))
        err("unknown_market", [...path, k, "coin"], `${coin} is not a known equity market`);
    }
  };
  walk(spec.entry.when, ["entry", "when"], 1);
  if (leaves > MAX_LEAF_CONDITIONS)
    err("too_complex", ["entry", "when"], `Use at most ${MAX_LEAF_CONDITIONS} conditions`);

  return errors.length ? { ok: false, errors } : { ok: true, spec, errors: [] };
}
