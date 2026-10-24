// Rule check before sealing (expansion section 6 #9): what could go wrong with the rule itself, never
// whether to trade. Three layers, each labelled with where it comes from:
//  - math: exact consequences of the numbers (liquidation before the stop, a target eaten by fees,
//    size against the market's daily volume, a repeat that can't repeat);
//  - replay: the same 90-day Dry Run replay (never fired, fires constantly, already true right now);
//  - ai: a wording and logic review by the rule writer's model, told never to give advice.
import { durationMs, render, type Spec } from "@proviso/dsl";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { takerFeeBps, type DryRunResult } from "./dryrun";

export type Finding = { level: "warn" | "info"; source: "math" | "replay" | "ai"; title: string; detail: string };
export type Market = { maxLeverage: number; volume24hUsd: number };

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Price move (%) against a leveraged position that leaves only maintenance margin (half the initial margin at max leverage). */
export const liquidationPct = (lev: number, maxLev: number) => (1 / lev - 1 / (2 * maxLev)) * 100;

/** Exact checks on the rule's own numbers and the live market's size and leverage. */
export function mathChecks(spec: Spec, markets: Record<string, Market | undefined>): Finding[] {
  const out: Finding[] = [];
  const stop = -spec.exit.stop.pct;
  for (const a of spec.entry.then) {
    if (a.venue !== "hl" || a.action !== "open") continue;
    const m = markets[a.coin];
    if (m) {
      const liq = liquidationPct(a.lev, m.maxLeverage);
      if (stop >= liq)
        out.push({
          level: "warn",
          source: "math",
          title: "Liquidated before your stop",
          detail: `At ${a.lev}× on ${a.coin}, a move of about ${pct(liq)} against you liquidates the position, but your stop is at −${pct(stop)}. Lower the leverage or tighten the stop.`,
        });
      else if (stop >= liq * 0.8)
        out.push({ level: "info", source: "math", title: "Stop close to liquidation", detail: `Your −${pct(stop)} stop sits near the ~${pct(liq)} liquidation distance at ${a.lev}×; a fast gap can reach liquidation first.` });
      if (m.volume24hUsd > 0 && a.size.usd > m.volume24hUsd * 0.01)
        out.push({
          level: "warn",
          source: "math",
          title: "Large for this market",
          detail: `${usd(a.size.usd)} is ${pct((a.size.usd / m.volume24hUsd) * 100)} of ${a.coin}'s last 24h volume (${usd(m.volume24hUsd)}). Expect fills to move the price.`,
        });
    }
    const fees = (takerFeeBps(a.coin) / 100) * 2; // in and out, as a price move
    const targets = [spec.exit.take.pct, ...(spec.exit.partials ?? []).map((p) => p.pct)];
    const smallest = Math.min(...targets);
    if (smallest <= fees * 2)
      out.push({
        level: smallest <= fees ? "warn" : "info",
        source: "math",
        title: smallest <= fees ? "Target smaller than fees" : "Target close to fees",
        detail: `A +${pct(smallest)} target on ${a.coin} pays about ${pct(fees)} in fees in and out (venue + Proviso's 0.05% each way).`,
      });
  }
  if (spec.fire === "repeat" && durationMs(spec.cooldown) >= durationMs(spec.expires))
    out.push({ level: "info", source: "math", title: "Repeat can't repeat", detail: `The ${spec.cooldown} cooldown is as long as the ${spec.expires} expiry, so it fires once at most.` });
  if (spec.exit.trail && spec.exit.trail.pct >= stop)
    out.push({ level: "info", source: "math", title: "Trailing stop never tighter", detail: `A ${pct(spec.exit.trail.pct)} trail starts at or behind your −${pct(stop)} stop, so it only matters after a gain.` });
  return out;
}

/** What the 90-day replay and the live check say about how often the rule fires. */
export function replayChecks(r: DryRunResult | null, now: "would_fire" | "waiting" | "unknown" | null): Finding[] {
  const out: Finding[] = [];
  if (now === "would_fire")
    out.push({ level: "warn", source: "replay", title: "True right now", detail: "Its conditions already hold on live prices. A call fires when its condition turns true, so this one waits until it turns false and then true again, which may never happen." });
  if (!r) return out;
  if (r.fires === 0)
    out.push({ level: "info", source: "replay", title: "Never fired in 90 days", detail: `Replayed over the last ${r.days} days it didn't fire once. Check the levels are reachable.` });
  else if (r.fires >= r.days * 0.5)
    out.push({ level: "info", source: "replay", title: "Fires very often", detail: `It fired ${r.fires} times in ${r.days} days (re-armed daily): the condition is true most of the time.` });
  if (r.noData.length) out.push({ level: "info", source: "replay", title: "No history for some inputs", detail: `${r.noData.join(", ")}: these parts couldn't be replayed.` });
  return out;
}

const REVIEW_SYSTEM = `You review a trading rule for mistakes in its logic and wording. The rule is already
written in plain English below. Report only problems with the rule itself, for example:
conditions that contradict each other or can never be true together; AND vs OR mix-ups; units that look mistaken (funding is percent per hour, change is
percent over the window); a window or expiry too short for the condition; stock or commodity markets
that close at weekends or overnight, so the rule can't act then; numbers that look like typos.
Stop and target are always measured in the position's favour: "-12% (stop)" means a 12% loss and
"+5% (target)" a 5% gain, for shorts as for longs. Never flag their sign.
Skip anything listed under "Already reported"; those are checked separately.
Never give advice: do not say whether to trade, whether it will make money, where prices are going,
or what the user should buy or sell. Do not suggest strategies. If nothing is wrong, return no issues.
At most 5 issues; each title under 8 words, each detail one or two sentences.`;
const ReviewOutput = z.object({ issues: z.array(z.object({ title: z.string(), detail: z.string() })) });
/** Belt and braces: drop any item that drifts into advice or market views. */
const ADVICE = /\b(recommend|financial advice|bullish|bearish|will (go|rise|fall|pump|dump)|price target|you should (buy|sell|trade))\b/i;

/** The model's wording review of `spec` (zero data retention: the rule isn't public yet). Null if it couldn't run. */
export async function aiReview(spec: Spec, model: LanguageModel, already: readonly Finding[] = []): Promise<Finding[] | null> {
  try {
    const { output } = await generateText({
      model,
      system: REVIEW_SYSTEM,
      prompt: already.length ? `${render(spec)}\n\nAlready reported:\n${already.map((f) => `- ${f.title}`).join("\n")}` : render(spec),
      output: Output.object({ schema: ReviewOutput }),
      maxOutputTokens: 1500,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
    return output.issues
      .slice(0, 5)
      .filter((i) => !ADVICE.test(`${i.title} ${i.detail}`))
      .map((i) => ({ level: "info" as const, source: "ai" as const, title: i.title.slice(0, 80), detail: i.detail.slice(0, 400) }));
  } catch {
    return null;
  }
}
