import { expect, test } from "bun:test";
import { Spec, type SpecInput } from "@proviso/dsl";
import { MockLanguageModelV4 } from "ai/test";
import type { DryRunResult } from "./dryrun";
import { aiReview, liquidationPct, mathChecks, replayChecks } from "./rule-check";

const rule = (over: Partial<SpecInput> = {}, lev = 3, usd = 1000): Spec =>
  Spec.parse({
    v: 1,
    entry: {
      when: { price: { coin: "BTC", op: ">", value: 100_000 } },
      then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev, size: { usd } }],
      legs: { atomic: false, onPartial: "unwind" },
    },
    exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" },
    limits: { maxUsd: usd, maxLev: lev },
    mode: "live",
    expires: "7d",
    ...over,
  });
const BTC = { BTC: { maxLeverage: 40, volume24hUsd: 2e9 } };
const titles = (f: { title: string }[]) => f.map((x) => x.title);

test("liquidation distance: 1/lev minus maintenance (half the initial margin at max leverage)", () => {
  expect(liquidationPct(10, 40)).toBeCloseTo(8.75, 9);
  expect(liquidationPct(1, 40)).toBeCloseTo(98.75, 9);
});

test("a sound rule raises nothing", () => {
  expect(mathChecks(rule(), BTC)).toEqual([]);
});

test("math: liquidation before the stop, stop near liquidation, size against volume, targets eaten by fees", () => {
  expect(titles(mathChecks(rule({ exit: { stop: { pct: -10 }, take: { pct: 20 }, ref: "trigger_mark" } }, 10), BTC))).toEqual(["Liquidated before your stop"]);
  expect(titles(mathChecks(rule({ exit: { stop: { pct: -7.5 }, take: { pct: 20 }, ref: "trigger_mark" } }, 10), BTC))).toEqual(["Stop close to liquidation"]);
  expect(titles(mathChecks(rule({}, 3, 30_000_000), BTC))).toEqual(["Large for this market"]);
  // BTC: 0.095% a fill, 0.19% in and out.
  expect(mathChecks(rule({ exit: { stop: { pct: -1 }, take: { pct: 0.15 }, ref: "trigger_mark" } }), BTC)).toMatchObject([{ level: "warn", title: "Target smaller than fees" }]);
  expect(mathChecks(rule({ exit: { stop: { pct: -1 }, take: { pct: 0.3 }, ref: "trigger_mark" } }), BTC)).toMatchObject([{ level: "info", title: "Target close to fees" }]);
  expect(titles(mathChecks(rule({ fire: "repeat", cooldown: "7d" }), BTC))).toEqual(["Repeat can't repeat"]);
  expect(titles(mathChecks(rule({ exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark", trail: { pct: 6 } } }), BTC))).toEqual(["Trailing stop never tighter"]);
  expect(mathChecks(rule({}, 3), {})).toEqual([]); // unknown market: only what the rule alone shows
});

test("replay: true right now, never fired, fires constantly, inputs with no history", () => {
  const r = (fires: number, noData: string[] = []) => ({ days: 89, fires, noData }) as unknown as DryRunResult;
  expect(titles(replayChecks(r(10), "would_fire"))).toEqual(["True right now"]);
  expect(titles(replayChecks(r(0), "waiting"))).toEqual(["Never fired in 90 days"]);
  expect(titles(replayChecks(r(60), "waiting"))).toEqual(["Fires very often"]);
  expect(titles(replayChecks(r(5, ["oi(BTC)"]), null))).toEqual(["No history for some inputs"]);
  expect(replayChecks(null, null)).toEqual([]);
});

const reply = (issues: { title: string; detail: string }[]) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ issues }) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
  warnings: [],
});

test("ai: reviews the plain-English rule with zero data retention, drops anything that reads as advice, null when it fails", async () => {
  const seen: unknown[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (o) => (
      seen.push(o),
      reply([
        { title: "Contradictory conditions", detail: "BTC can't be above $100k and below $90k at once." },
        { title: "Looks good", detail: "We recommend buying here, it is bullish." },
      ])
    ),
  });
  const f = await aiReview(rule(), m);
  expect(f).toEqual([{ level: "info", source: "ai", title: "Contradictory conditions", detail: "BTC can't be above $100k and below $90k at once." }]);
  expect(JSON.stringify(seen[0])).toContain("BTC mark price is above $100,000");
  expect(JSON.stringify((seen[0] as { providerOptions: unknown }).providerOptions)).toContain('"zeroDataRetention":true');
  const broken = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("down")) });
  expect(await aiReview(rule(), broken)).toBeNull();
});

test("ai: told what the math already reported, and that stop and target signs are never wrong", async () => {
  const seen: unknown[] = [];
  const m = new MockLanguageModelV4({ doGenerate: async (o) => (seen.push(o), reply([])) });
  expect(await aiReview(rule(), m, [{ level: "warn", source: "math", title: "Liquidated before your stop", detail: "" }])).toEqual([]);
  const sent = JSON.stringify((seen[0] as { prompt: unknown }).prompt);
  expect(JSON.parse(sent)[1].content[0].text).toContain("Already reported:\n- Liquidated before your stop");
  expect(sent).toContain("Never flag their sign");
});
