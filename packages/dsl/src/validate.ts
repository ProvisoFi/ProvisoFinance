import { MAX_LEVERAGE, Spec, type Condition } from "./schema.ts";

export const MIN_HL_VOLUME_USD = 250_000;
export const MIN_POOL_DEPTH_USD = 100_000;
/** C17 choice: bound rule complexity so evaluation and read-back stay legible. */
export const MAX_LEAF_CONDITIONS = 8;
export const MAX_CONDITION_DEPTH = 4;

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
};

export type ValidationCode =
  | "schema"
  | "unknown_market"
  | "not_canonical"
  | "illiquid"
  | "limits_over_user"
  | "size_over_limit"
  | "lev_over_limit"
  | "too_complex";
export type Path = (string | number)[];
export type ValidationError = { code: ValidationCode; path: Path; message: string };
export type ValidationResult =
  | { ok: true; spec: Spec; errors: [] }
  | { ok: false; errors: ValidationError[] };

const get = <T>(r: Record<string, T> | undefined, k: string) =>
  r && Object.hasOwn(r, k) ? r[k] : undefined;

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
  if (!(spec.limits.maxUsd <= user.maxUsd))
    err("limits_over_user", ["limits", "maxUsd"], `Idea limit exceeds your $${user.maxUsd} limit`);
  if (!(spec.limits.maxLev <= user.maxLev))
    err("limits_over_user", ["limits", "maxLev"], `Idea leverage exceeds your ${user.maxLev}× limit`);

  const maxUsd = Math.min(spec.limits.maxUsd, user.maxUsd);
  let total = 0;
  spec.entry.then.forEach((a, i) => {
    const path: Path = ["entry", "then", i];
    if ("size" in a) total += a.size.usd;
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
    if ("price" in c) perp(c.price.coin, [...path, "price", "coin"]);
    else if ("change" in c) perp(c.change.coin, [...path, "change", "coin"]);
    else if ("funding" in c) perp(c.funding.coin, [...path, "funding", "coin"]);
    else if ("oi" in c) perp(c.oi.coin, [...path, "oi", "coin"]);
    else if ("gap" in c) {
      perp(c.gap.coin, [...path, "gap", "coin"]);
      token(c.gap.coin, [...path, "gap", "coin"]);
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
