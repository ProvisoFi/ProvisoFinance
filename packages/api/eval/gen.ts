// Generates the writer eval set (300 ideas, deterministic): 240 fully specified ideas with the
// exact expected rule, and 60 ideas with a vague or missing part that must be flagged.
//   bun packages/api/eval/gen.ts  →  packages/api/eval/ideas.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpecInput } from "@proviso/dsl";

let seed = 20261019;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const coins = ["HYPE", "BTC", "ETH", "SOL", "DOGE"] as const;
const days = [1, 3, 7, 14, 30];

type Cond = { text: string; cond: SpecInput["entry"]["when"] };
const kinds = (coin: string): (() => Cond)[] => [
    () => {
      const v = int(10, 90) * (coin === "BTC" ? 1000 : 1);
      const up = rnd() < 0.5;
      return { text: `${coin} trades ${up ? "above" : "below"} $${v}`, cond: { price: { coin, op: up ? ">" : "<", value: v } } };
    },
    () =>
      rnd() < 0.5
        ? { text: `${coin} funding turns negative`, cond: { funding: { coin, op: "<", value: 0 } } }
        : { text: `${coin} hourly funding is above 0.01%`, cond: { funding: { coin, op: ">", value: 0.01 } } },
    () => {
      const v = int(3, 15);
      const up = rnd() < 0.5;
      const w = pick(["1h", "4h", "24h"]);
      return {
        text: `${coin} is ${up ? "up" : "down"} more than ${v}% over ${w}`,
        cond: { change: { coin, op: up ? ">" : "<", value: up ? v : -v, window: w } },
      };
    },
    () => {
      const v = int(50, 900);
      return { text: `${coin} open interest goes above $${v}M`, cond: { oi: { coin, op: ">", value: v * 1e6 } } };
    },
    () => {
      const v = int(10, 40);
      return { text: `the Fear & Greed index drops below ${v}`, cond: { fear_greed: { op: "<", value: v } } };
    },
];
// Distinct condition kinds per idea, so no idea contradicts itself.
const leaves = (coin: string, n: number): Cond[] =>
  kinds(coin)
    .map((k) => ({ k, r: rnd() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map(({ k }) => k());

function clear(i: number) {
  const coin = pick(coins);
  const parts = leaves(coin, int(1, 3));
  const any = parts.length > 1 && rnd() < 0.3;
  const when = parts.length === 1 ? parts[0].cond : any ? { any: parts.map((p) => p.cond) } : { all: parts.map((p) => p.cond) };
  const join = any ? " or " : " and ";
  const side = pick(["long", "short"] as const);
  const lev = int(1, 5);
  const usd = int(1, 20) * 100;
  const stop = int(2, 10);
  const take = int(5, 30);
  const exp = pick(days);
  const mode = pick(["live", "alert"] as const);
  const repeat = rnd() < 0.15;
  const cooldown = `${pick([1, 4, 12])}h`;
  const text =
    `${side === "long" ? "Go long" : "Short"} ${coin} with $${usd} at ${lev}x when ${parts.map((p) => p.text).join(join)}. ` +
    `Stop loss ${stop}%, take profit ${take}%. ` +
    `${repeat ? `It can fire again after a ${cooldown} cooldown. ` : "Fire once. "}` +
    `Expires in ${exp} day${exp > 1 ? "s" : ""}. ${mode === "live" ? "Trade it live." : "Alert only, no trades."}`;
  const spec: SpecInput = {
    v: 1,
    entry: {
      when,
      then: [{ venue: "hl", action: "open", coin, side, lev, size: { usd } }],
      legs: { atomic: false, onPartial: "unwind" },
    },
    exit: { stop: { pct: -stop }, take: { pct: take }, ref: "trigger_mark" },
    limits: { maxUsd: usd, maxLev: lev },
    mode,
    fire: repeat ? "repeat" : "once",
    cooldown: repeat ? cooldown : "0m",
    expires: `${exp}d`,
  };
  return { id: `clear-${i}`, text, ambiguous: false, expected: spec };
}

const vague = [
  (c: string) => `Long ${c} with $500 at 3x when it pumps. Stop 5%, target 10%, expires in 7 days, live.`,
  (c: string) => `Short ${c} with $300 at 2x when funding is negative, tight stop, take profit 12%, 7 days, live.`,
  (c: string) => `Go long ${c} with a big position at 2x when price is above $40, stop 5%, target 15%, 14 days, live.`,
  (c: string) => `Long ${c} $400 3x when funding turns negative. Take profit 10%. Expires in 7 days. Live.`,
  (c: string) => `Short ${c} with $200 at 2x when it is down more than 5% over 4h. Stop 4%, target 8%. Live.`,
  (c: string) => `Long ${c} with $600 when the Fear & Greed index drops below 20. Stop 6%, target 18%, 30 days, live.`,
  (c: string) => `Buy the dip on ${c} with $500 at 2x soon. Stop 5%, target 10%, 7 days, live.`,
  (c: string) => `Long ${c} with $500 at 3x when funding goes negative, stop 5%, target 10%, expires in 7 days.`,
  (c: string) => `Short ${c} with some size at 2x when it trades above $50, stop 3%, target 9%, 3 days, live.`,
  (c: string) => `Long ${c} $300 at high leverage when open interest goes above $500M, stop 5%, target 10%, 7 days, live.`,
];

const items = [
  ...Array.from({ length: 240 }, (_, i) => clear(i)),
  ...Array.from({ length: 60 }, (_, i) => ({ id: `vague-${i}`, text: vague[i % vague.length](coins[i % coins.length]), ambiguous: true })),
];
writeFileSync(join(import.meta.dir, "ideas.json"), JSON.stringify(items, null, 1) + "\n");
console.log(`wrote ${items.length} ideas`);
