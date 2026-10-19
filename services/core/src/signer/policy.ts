import { MAX_LEVERAGE, type Spec } from "@proviso/dsl";

// Signer policy (Backend §4). Runs inside the enclave before any signature; every check
// fails closed: a missing or inconsistent piece of context is a refusal, never a pass.

export type Hex = `0x${string}`;
export type Tif = "Ioc" | "Gtc" | "Alo";

/** One Hyperliquid order as the signer sees it (perps only). */
export type OrderIntent = {
  coin: string;
  /** Hyperliquid asset index; this is what gets signed, so it is checked against `market`. */
  asset: number;
  isBuy: boolean;
  px: number;
  sz: number;
  reduceOnly: boolean;
  /** Ignored by Hyperliquid when `trigger` is set. */
  tif: Tif;
  trigger?: { tpsl: "sl" | "tp"; triggerPx: number; isMarket: boolean };
  /** 16 bytes: thesisId u64 ‖ fireSeq u32 ‖ leg+nonce u32, big-endian. */
  cloid: Hex;
};

export type PolicyIdea = {
  thesisId: bigint;
  confirmed: boolean;
  /** Opens need "live"; exits accept "live" or "closing". Anything else is refused. */
  state: string;
  spec: Pick<Spec, "entry" | "limits">;
};

export type PolicyContext = {
  /** The idea the enclave loaded for this cloid's thesisId. */
  idea?: PolicyIdea | null;
  /** The user's global limits (required for opens). */
  user?: { maxUsd: number; maxLev: number } | null;
  /** Trusted market metadata for the order's coin. */
  market?: { coin: string; asset: number; mark: number; maxLeverage: number } | null;
  /** The account's leverage setting for this coin (required for opens). */
  leverage?: number | null;
  /** Signed position size in coin units on this account (required for exits). */
  positionSzi?: number | null;
};

export type PolicyResult = { ok: true } | { ok: false; reason: string };

export const PX_BAND = 0.02;

const CLOID_RE = /^0x[0-9a-fA-F]{32}$/;
const U32 = 0xffff_ffff;

export function encodeCloid(thesisId: bigint, fireSeq: number, legNonce: number): Hex {
  if (thesisId < 0n || thesisId >= 1n << 64n) throw new RangeError("thesisId must be a u64");
  for (const n of [fireSeq, legNonce])
    if (!Number.isInteger(n) || n < 0 || n > U32) throw new RangeError("fireSeq and legNonce must be u32");
  const hex = (v: number | bigint, w: number) => v.toString(16).padStart(w, "0");
  return `0x${hex(thesisId, 16)}${hex(fireSeq, 8)}${hex(legNonce, 8)}`;
}

/** The thesisId in a cloid, or null if it is not a 16-byte hex cloid. */
export const cloidThesisId = (cloid: unknown): bigint | null =>
  typeof cloid === "string" && CLOID_RE.test(cloid) ? BigInt(cloid.slice(0, 18)) : null;

const pos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const no = (reason: string): PolicyResult => ({ ok: false, reason });
const OK: PolicyResult = { ok: true };

function wellFormed(o: OrderIntent): boolean {
  if (typeof o !== "object" || o === null) return false;
  const t = o.trigger;
  return (
    typeof o.coin === "string" &&
    Number.isInteger(o.asset) &&
    o.asset >= 0 &&
    typeof o.isBuy === "boolean" &&
    typeof o.reduceOnly === "boolean" &&
    pos(o.px) &&
    pos(o.sz) &&
    (o.tif === "Ioc" || o.tif === "Gtc" || o.tif === "Alo") &&
    (t === undefined ||
      (typeof t === "object" && t !== null && (t.tpsl === "sl" || t.tpsl === "tp") &&
        pos(t.triggerPx) && typeof t.isMarket === "boolean"))
  );
}

const inBand = (px: number, mark: number) => Math.abs(px - mark) <= PX_BAND * mark;

export function checkOrder(o: OrderIntent, ctx: PolicyContext): PolicyResult {
  if (!wellFormed(o)) return no("malformed_order");
  const thesisId = cloidThesisId(o.cloid);
  if (thesisId === null) return no("bad_cloid");
  const { idea, market } = ctx ?? {};
  if (!idea || idea.thesisId !== thesisId || !idea.spec) return no("unknown_idea");
  if (idea.confirmed !== true) return no("idea_unconfirmed");
  if (!market || market.coin !== o.coin || market.asset !== o.asset || !pos(market.mark))
    return no("missing_market");
  return o.reduceOnly ? checkExit(o, idea, market.mark, ctx.positionSzi) : checkOpen(o, idea, ctx, market);
}

function checkOpen(
  o: OrderIntent,
  idea: PolicyIdea,
  ctx: PolicyContext,
  market: NonNullable<PolicyContext["market"]>,
): PolicyResult {
  if (idea.state !== "live") return no("idea_not_live");
  if (o.trigger) return no("trigger_open_refused");
  const { user, leverage } = ctx;
  const { limits } = idea.spec;
  if (!user || !pos(user.maxUsd) || !pos(user.maxLev) || !pos(leverage) || !pos(market.maxLeverage) ||
    !pos(limits?.maxUsd) || !pos(limits?.maxLev))
    return no("missing_context");
  const action = idea.spec.entry?.then?.find(
    (a) => a.venue === "hl" && a.action === "open" && a.coin === o.coin && (a.side === "long") === o.isBuy,
  );
  if (!action || action.venue !== "hl" || action.action !== "open") return no("no_matching_action");
  const notional = o.px * o.sz;
  if (!(notional <= action.size.usd)) return no("over_action_size");
  if (!(notional <= limits.maxUsd)) return no("over_idea_limit");
  if (!(notional <= user.maxUsd)) return no("over_user_limit");
  const maxLev = Math.min(action.lev, limits.maxLev, user.maxLev, market.maxLeverage, MAX_LEVERAGE);
  if (!(leverage <= maxLev)) return no("over_leverage");
  if (!inBand(o.px, market.mark)) return no("px_off_mark");
  return OK;
}

function checkExit(o: OrderIntent, idea: PolicyIdea, mark: number, szi: number | null | undefined): PolicyResult {
  if (idea.state !== "live" && idea.state !== "closing") return no("idea_not_live");
  if (!idea.spec.entry?.then?.some((a) => a.venue === "hl" && a.coin === o.coin)) return no("coin_not_in_idea");
  if (typeof szi !== "number" || !Number.isFinite(szi)) return no("missing_context");
  if (szi === 0) return no("no_position");
  const isLong = szi > 0;
  if (o.isBuy === isLong) return no("wrong_side");
  if (o.sz > Math.abs(szi)) return no("exceeds_position");
  if (o.trigger) {
    // Protective side: a long's stop sits below mark and its take above; a short mirrors it.
    const below = o.trigger.triggerPx < mark;
    const above = o.trigger.triggerPx > mark;
    const ok = o.trigger.tpsl === "sl" ? (isLong ? below : above) : isLong ? above : below;
    return ok ? OK : no("trigger_not_protective");
  }
  return inBand(o.px, mark) ? OK : no("px_off_mark");
}
