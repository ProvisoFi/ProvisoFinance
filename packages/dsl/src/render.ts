import { durationMs, type Action, type Condition, type SpecInput, Spec } from "./schema.ts";

const OP = { ">": "above", "<": "below", ">=": "at or above", "<=": "at or below" } as const;
// Significant digits under $1 so a 0.0042 threshold doesn't read "$0".
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", Math.abs(n) < 1 ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 })}`;
/**
 * User text as one quoted, escaped token: JSON escapes quotes, backslashes, newlines and C0
 * controls; C1 controls, line/paragraph separators, zero-width and bidi marks are escaped too,
 * so the text can't end its quote or forge lines of the read-back.
 */
const quote = (t: string) =>
  JSON.stringify(t).replace(/[\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const pct = (n: number) => `${n}%`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}%`;
const UNITS = { m: "minute", h: "hour", d: "day" } as const;
const dur = (d: string) => {
  const n = Number(d.slice(0, -1));
  return `${n} ${UNITS[d.at(-1) as keyof typeof UNITS]}${n === 1 ? "" : "s"}`;
};

/** Plain-English read-back of one condition; user-supplied post text is quoted and escaped. */
export function renderCondition(c: Condition): string {
  if ("all" in c) return c.all.length === 1 ? renderCondition(c.all[0]) : `(${c.all.map(renderCondition).join(" and ")})`;
  if ("any" in c) return c.any.length === 1 ? renderCondition(c.any[0]) : `(${c.any.map(renderCondition).join(" or ")})`;
  if ("not" in c) return `it is not true that ${renderCondition(c.not)}`;
  if ("after" in c) return `${renderCondition(c.after.cond)} for at least ${dur(c.after.n)}`;
  if ("price" in c) return `${c.price.coin} mark price is ${OP[c.price.op]} ${usd(c.price.value)}`;
  if ("change" in c)
    return `${c.change.coin} has moved ${OP[c.change.op]} ${signed(c.change.value)} over ${dur(c.change.window)}`;
  if ("funding" in c) return `${c.funding.coin} hourly funding is ${OP[c.funding.op]} ${pct(c.funding.value)}`;
  if ("oi" in c) return `${c.oi.coin} open interest is ${OP[c.oi.op]} ${usd(c.oi.value)}`;
  if ("fear_greed" in c) return `the Fear & Greed index is ${OP[c.fear_greed.op]} ${c.fear_greed.value}`;
  if ("time_window" in c) {
    const t = c.time_window;
    const days = t.days ? ` on ${t.days.map((d) => DAYS[d]).join(", ")}` : "";
    return `the time is between ${t.from} and ${t.to} (${t.tz})${days}`;
  }
  if ("market_session" in c) return `the US market is in its ${c.market_session.is} session`;
  if ("earnings_window" in c) {
    const e = c.earnings_window;
    const rel = { before: "before", after: "after", either: "before or after" }[e.relative];
    return `${e.coin} earnings are within ${dur(e.within)} ${rel}`;
  }
  if ("corporate_action" in c)
    return `${c.corporate_action.coin} has a ${c.corporate_action.kind.replace("_", " ")} within ${dur(c.corporate_action.within)}`;
  if ("gap" in c)
    return `the ${c.gap.coin} Stock Token trades ${OP[c.gap.op]} ${signed(c.gap.value)} versus its Hyperliquid perp`;
  return `@${c.post.account} posts ${c.post.contains.map(quote).join(" and ")}`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Plain-English read-back of one action, naming the venue, size in USD and slippage or leverage. */
export function renderAction(a: Action): string {
  if (a.venue === "rhc")
    return `swap ${usd(a.size.usd)} of ${a.tokenIn} for ${a.tokenOut} on Robinhood Chain (max ${pct(a.maxSlipPct)} slippage)`;
  switch (a.action) {
    case "open":
      return `open a ${a.lev}× ${a.side} on ${a.coin} for ${usd(a.size.usd)} on Hyperliquid`;
    case "close":
      return `close the ${a.coin} position on Hyperliquid`;
    case "reduce":
      return `reduce the ${a.coin} position by ${pct(a.pct)} on Hyperliquid`;
    case "spot":
      return `${a.side} ${usd(a.size.usd)} of ${a.coin} spot on Hyperliquid`;
  }
}

/** Plain-English read-back of a whole spec. Throws on an invalid spec. */
export function render(input: SpecInput): string {
  const s = Spec.parse(input);
  const then = s.entry.then.map(renderAction);
  const legs =
    then.length > 1
      ? s.entry.legs.atomic
        ? " All legs fill together or not at all."
        : ` Legs are not atomic; if one only partly fills, the rest is ${s.entry.legs.onPartial === "unwind" ? "unwound" : "kept"}.`
      : "";
  const act = s.mode === "live" ? `Proviso will ${then.join(", then ")}.` : `Proviso will alert you to ${then.join(", then ")} (alert only: no order is placed).`;
  const fire =
    s.fire === "once"
      ? "Fires once"
      : `Can fire again${durationMs(s.cooldown) ? ` after a ${dur(s.cooldown)} cooldown` : ""}`;
  return [
    `When ${renderCondition(s.entry.when)}: ${act}${legs}`,
    `Exit at ${signed(s.exit.stop.pct)} (stop) or ${signed(s.exit.take.pct)} (target) from the trigger mark.`,
    `Limits: ${usd(s.limits.maxUsd)} and ${s.limits.maxLev}×. ${fire}; expires ${dur(s.expires)} after sealing.`,
  ].join("\n");
}
