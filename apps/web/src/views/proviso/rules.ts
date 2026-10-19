export type Rule = {
  market: string;
  price: number;
  side: "long" | "short";
  leverage: number;
  stop: number;
  take: number;
};
export type Limits = { size: number; leverage: number; loss: number };
export type Draft = {
  id: string;
  text: string;
  rule: Rule;
  size: number;
  created: string;
};
export const defaultLimits: Limits = { size: 500, leverage: 3, loss: 100 };
export const defaultRule: Rule = {
  market: "HYPE",
  price: 40,
  side: "long",
  leverage: 3,
  stop: 6,
  take: 15,
};
export const markets = ["HYPE", "BTC", "ETH", "NVDA", "GOLD"];
export function ruleText(r: Rule) {
  return `If ${r.market} funding turns negative while price holds above $${r.price}, ${r.side} ${r.market} ${r.leverage}×, stop −${r.stop}%, take +${r.take}%.`;
}
export function validateRule(r: Rule): string | null {
  if (!["long", "short"].includes(r.side))
    return "Choose a long or short direction.";
  if (!markets.includes(r.market)) return "Choose a supported example market.";
  if (![r.price, r.leverage, r.stop, r.take].every(Number.isFinite))
    return "Every rule value must be a valid number.";
  if (r.price <= 0 || r.price > 10000000)
    return "The price threshold must be greater than zero and no more than 10,000,000.";
  if (!Number.isInteger(r.leverage) || r.leverage < 1 || r.leverage > 10)
    return "Leverage must be a whole number from 1× to 10×.";
  if (r.stop <= 0 || r.stop >= 100 || r.take <= 0 || r.take > 1000)
    return "Set a stop between 0% and 100%, and a target above 0% and no more than 1,000%.";
  return null;
}
export function parseRule(text: string): {
  rule: Rule | null;
  error: string | null;
} {
  const normalized = text.trim().replace(/[−–]/g, "-").replace(/×/g, "x");
  const match = normalized.match(
    /^if\s+(HYPE|BTC|ETH|NVDA|GOLD)\s+funding\s+turns\s+negative\s+while\s+price\s+holds\s+above\s+\$?([\d]+(?:\.\d+)?),\s*(long|short)\s+(HYPE|BTC|ETH|NVDA|GOLD)\s+(\d+)x,\s*stop\s*-([\d]+(?:\.\d+)?)%,\s*take\s*\+([\d]+(?:\.\d+)?)%\.?$/i,
  );
  if (!match)
    return {
      rule: null,
      error:
        "Use the sentence pattern shown below, or switch to the rule builder to define each condition directly.",
    };
  if (match[1].toUpperCase() !== match[4].toUpperCase())
    return {
      rule: null,
      error:
        "The condition and action must use the same market. Use the structured builder to review the market selection.",
    };
  const rule: Rule = {
    market: match[1].toUpperCase(),
    price: Number(match[2]),
    side: match[3].toLowerCase() as Rule["side"],
    leverage: Number(match[5]),
    stop: Number(match[6]),
    take: Number(match[7]),
  };
  const error = validateRule(rule);
  return { rule: error ? null : rule, error };
}
export function validateLimits(l: Limits) {
  return (
    Number.isFinite(l.size) &&
    l.size > 0 &&
    l.size <= 1000000 &&
    Number.isInteger(l.leverage) &&
    l.leverage >= 1 &&
    l.leverage <= 10 &&
    Number.isFinite(l.loss) &&
    l.loss > 0 &&
    l.loss <= 1000000
  );
}
export function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const d = value as Draft;
  return (
    typeof d.id === "string" &&
    typeof d.text === "string" &&
    typeof d.created === "string" &&
    Number.isFinite(d.size) &&
    d.size > 0 &&
    !!d.rule &&
    validateRule(d.rule) === null
  );
}
