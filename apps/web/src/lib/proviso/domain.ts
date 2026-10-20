import type { Condition as DslCondition, SpecInput } from "@proviso/dsl";
export type Signal = "price" | "funding" | "oi" | "change" | "fear_greed";
export type Condition = {
  id: string;
  signal: Signal;
  op: ">" | "<" | ">=" | "<=";
  value: number;
};
export type Thesis = {
  id: string;
  title: string;
  market: string;
  side: "long" | "short";
  leverage: number;
  allocation: number;
  conditions: Condition[];
  match: "all" | "any";
  stop: number;
  take: number;
  expiryDays: number;
  cooldownMinutes: number;
  intent: "alert" | "live";
  /**
   * Set: a Robinhood Chain swap (USDG into this Stock Token) instead of the perp, or with it when
   * `withPerp` (both actions, each sized at `allocation`; the perp leg then owns the exit).
   */
  swap?: { tokenOut: string; slipPct: number; withPerp?: boolean };
  created: string;
  updated: string;
};
/** Robinhood Chain testnet swap tokens (bought with USDG); embedded wallets only. */
export const swapTokens = ["TSLA", "AMZN"];
export type RiskLimits = {
  maxAllocation: number;
  maxLeverage: number;
  dailyLoss: number;
  maxSlippage: number;
};
export type CopyPolicy = {
  allocation: number;
  leverage: number;
  markets: string[];
  side: "both" | "long" | "short";
  sealed: "confirm" | "allowlist";
};
export type LocalEvent = {
  id: string;
  at: string;
  kind: "draft" | "limits" | "copy" | "test";
  title: string;
  detail: string;
};
export type Workspace = {
  version: 2;
  drafts: Thesis[];
  limits: RiskLimits;
  copy: CopyPolicy;
  events: LocalEvent[];
};
export const exampleMarkets = ["HYPE", "BTC", "ETH", "NVDA", "GOLD"];
export const signalLabels: Record<Signal, string> = {
  price: "Mark price",
  funding: "Funding rate",
  oi: "Open interest",
  change: "Price change · 24h",
  fear_greed: "Fear & Greed",
};
export const initialWorkspace: Workspace = {
  version: 2,
  drafts: [],
  limits: {
    maxAllocation: 500,
    maxLeverage: 3,
    dailyLoss: 100,
    maxSlippage: 1,
  },
  copy: {
    allocation: 100,
    leverage: 2,
    markets: ["HYPE", "BTC", "ETH"],
    side: "both",
    sealed: "confirm",
  },
  events: [],
};
export function newThesis(): Thesis {
  return {
    id: "",
    title: "Funding reversal",
    market: "HYPE",
    side: "long",
    leverage: 3,
    allocation: 250,
    conditions: [
      { id: "c1", signal: "funding", op: "<", value: 0 },
      { id: "c2", signal: "price", op: ">", value: 40 },
    ],
    match: "all",
    stop: 6,
    take: 15,
    expiryDays: 30,
    cooldownMinutes: 60,
    intent: "alert",
    created: "",
    updated: "",
  };
}
export function validateThesis(t: Thesis, limits?: RiskLimits): string[] {
  const errors: string[] = [];
  if (!t.title.trim() || t.title.length > 100)
    errors.push("Give the idea a title of 1–100 characters.");
  if (!exampleMarkets.includes(t.market))
    errors.push("Choose a market from the example universe.");
  if (
    !["long", "short"].includes(t.side) ||
    !["all", "any"].includes(t.match) ||
    !["alert", "live"].includes(t.intent)
  )
    errors.push("Choose valid direction, matching and execution settings.");
  if (
    !Number.isFinite(t.allocation) ||
    t.allocation <= 0 ||
    t.allocation * (t.swap?.withPerp ? 2 : 1) > (limits?.maxAllocation ?? 1000000)
  )
    errors.push(
      `Allocation must be above $0 and within the $${limits?.maxAllocation ?? 1000000} per-idea limit.`,
    );
  if (
    !Number.isInteger(t.leverage) ||
    t.leverage < 1 ||
    t.leverage > Math.min(10, limits?.maxLeverage ?? 10)
  )
    errors.push(
      `Leverage must be a whole number between 1× and ${Math.min(10, limits?.maxLeverage ?? 10)}×.`,
    );
  if (
    !Number.isFinite(t.stop) ||
    t.stop <= 0 ||
    t.stop >= 100 ||
    !Number.isFinite(t.take) ||
    t.take <= 0 ||
    t.take > 1000
  )
    errors.push(
      "Set a stop between 0% and 100%, and a target above 0% and at most 1,000%.",
    );
  if (
    t.swap &&
    (!swapTokens.includes(t.swap.tokenOut) ||
      !Number.isFinite(t.swap.slipPct) ||
      t.swap.slipPct <= 0 ||
      t.swap.slipPct > 2)
  )
    errors.push("Choose a swap token and a slippage between 0% and 2%.");
  if (!Number.isInteger(t.expiryDays) || t.expiryDays < 1 || t.expiryDays > 30)
    errors.push("Expiry must be between 1 and 30 whole days.");
  if (
    !Number.isInteger(t.cooldownMinutes) ||
    t.cooldownMinutes < 0 ||
    t.cooldownMinutes > 43200
  )
    errors.push("Cooldown must be between 0 and 43,200 whole minutes.");
  if (
    !Array.isArray(t.conditions) ||
    t.conditions.length < 1 ||
    t.conditions.length > 8
  )
    errors.push("Add between 1 and 8 conditions.");
  else
    t.conditions.forEach((c, i) => {
      if (
        !Object.hasOwn(signalLabels, c.signal) ||
        ![">", "<", ">=", "<="].includes(c.op) ||
        !Number.isFinite(c.value)
      )
        errors.push(
          `Condition ${i + 1} needs a supported signal, operator and numeric value.`,
        );
      else if (
        (["price", "oi"].includes(c.signal) && c.value <= 0) ||
        (c.signal === "fear_greed" && (c.value < 0 || c.value > 100))
      )
        errors.push(`Condition ${i + 1} is outside the signal’s valid range.`);
    });
  return errors;
}
export function validateRisk(l: RiskLimits) {
  return (
    [l.maxAllocation, l.dailyLoss].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 1000000,
    ) &&
    Number.isInteger(l.maxLeverage) &&
    l.maxLeverage >= 1 &&
    l.maxLeverage <= 10 &&
    Number.isFinite(l.maxSlippage) &&
    l.maxSlippage > 0 &&
    l.maxSlippage <= 2
  );
}
export function validateCopy(p: CopyPolicy) {
  return (
    Number.isFinite(p.allocation) &&
    p.allocation > 0 &&
    p.allocation <= 1000000 &&
    Number.isInteger(p.leverage) &&
    p.leverage >= 1 &&
    p.leverage <= 10 &&
    p.markets.length > 0 &&
    p.markets.every((m) => exampleMarkets.includes(m)) &&
    ["both", "long", "short"].includes(p.side) &&
    ["confirm", "allowlist"].includes(p.sealed)
  );
}
export function isThesis(v: unknown): v is Thesis {
  try {
    const t = v as Thesis;
    return (
      !!t &&
      typeof t.id === "string" &&
      typeof t.created === "string" &&
      typeof t.updated === "string" &&
      validateThesis(t).length === 0
    );
  } catch {
    return false;
  }
}
export function formatCondition(c: Condition, market: string) {
  return `${c.signal}(${c.signal === "fear_greed" ? "index" : market}) ${c.op} ${c.value}${c.signal === "change" || c.signal === "funding" ? "%" : ""}`;
}
const leaf = (c: Condition, coin: string): DslCondition => {
  const cmp = { coin, op: c.op, value: c.value };
  switch (c.signal) {
    case "price":
      return { price: cmp };
    case "funding":
      return { funding: cmp };
    case "oi":
      return { oi: cmp };
    case "change":
      return { change: { ...cmp, window: "24h" } };
    case "fear_greed":
      return { fear_greed: { op: c.op, value: c.value } };
  }
};
/** DSL v1 rule for this draft (see @proviso/dsl). Parse it with `Spec` before sealing. */
export function toSpec(t: Thesis): SpecInput {
  const conds = t.conditions.map((c) => leaf(c, t.market));
  return {
    v: 1,
    entry: {
      when: t.match === "all" ? { all: conds } : { any: conds },
      then: [
        ...(!t.swap || t.swap.withPerp
          ? [{ venue: "hl" as const, action: "open" as const, coin: t.market, side: t.side, lev: t.leverage, size: { usd: t.allocation } }]
          : []),
        ...(t.swap
          ? [{ venue: "rhc" as const, action: "swap" as const, tokenIn: "USDG", tokenOut: t.swap.tokenOut, size: { usd: t.allocation }, maxSlipPct: t.swap.slipPct }]
          : []),
      ],
      legs: { atomic: false, onPartial: "unwind" },
    },
    exit: {
      stop: { pct: -t.stop },
      take: { pct: t.take },
      ref: "trigger_mark",
    },
    limits: {
      maxUsd: t.allocation * (t.swap?.withPerp ? 2 : 1),
      maxLev: t.swap && !t.swap.withPerp ? 1 : t.leverage,
    },
    mode: t.intent,
    fire: "once",
    expires: `${t.expiryDays}d`,
    cooldown: `${t.cooldownMinutes}m`,
  };
}
export function exportJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const dollars = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
