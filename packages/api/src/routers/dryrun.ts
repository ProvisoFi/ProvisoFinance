// Dry Run (try the call before you trust it): public, no wallet needed, rate-limited per IP.
// Nothing is stored: the rule replays and is checked against live prices, then the browser keeps it.
import { render, Spec, type SpecInput } from "@proviso/dsl";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { checkDryRun, coinsOf, dryRun, dryRunNow, dryRunSpec, hourly, stats } from "../dryrun";
import { publicLimitedProcedure, publicProcedure, router } from "../trpc";
import { aiReview, mathChecks, replayChecks } from "../rule-check";
import { draftRule, MAX_IDEA_CHARS, WriterError, writerModel } from "../writer";
import { perps } from "./market";

const specInput = z.custom<SpecInput>((v) => typeof v === "object" && v !== null, "A rule is required");
const coin = z.string().regex(/^[A-Za-z0-9:_.-]{1,32}$/);

/** The rule as Dry Run runs it, or BAD_REQUEST with the reasons it can't run. */
async function prepare(input: SpecInput) {
  let spec;
  try {
    spec = dryRunSpec(input);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That rule isn't complete yet." });
  }
  const errors = await checkDryRun(spec);
  if (errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: errors.map((e) => e.message).join("; ") });
  const coins = coinsOf(spec);
  if (coins.length > 4) throw new TRPCError({ code: "BAD_REQUEST", message: "Dry Run handles rules on up to 4 markets." });
  const series = new Map(await Promise.all(coins.map(async (c) => [c, await hourly(c)] as const)));
  return { spec, series, coins };
}

export const dryRunRouter = router({
  /** Public: a market's last close, 24h move and 7-day range (starter ideas fill their numbers from these). */
  market: publicProcedure.input(z.object({ coin })).query(async ({ input }) => {
    try {
      return stats(await hourly(input.coin));
    } catch {
      throw new TRPCError({ code: "NOT_FOUND", message: "No history for that market." });
    }
  }),

  /** Public: replays the rule over the last 90 days of Hyperliquid history (paper-v1 on hourly closes). */
  try: publicLimitedProcedure("dryRun")
    .input(z.object({ spec: specInput }))
    .mutation(async ({ input }) => {
      const { spec, series } = await prepare(input.spec);
      try {
        return { rule: render(spec), result: dryRun(spec, series) };
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "The replay failed." });
      }
    }),

  /** Public: would the rule fire right now, on live prices? Polled while the Dry Run page is open. */
  now: publicLimitedProcedure("dryRunNow")
    .input(z.object({ spec: specInput }))
    .query(async ({ input }) => {
      const { spec, series, coins } = await prepare(input.spec);
      const live = (await perps()).filter((p) => coins.includes(p.coin));
      return { ...dryRunNow(spec, series, live.map((p) => ({ coin: p.coin, mark: p.mark, volume24hUsd: p.volume24hUsd }))), at: Date.now() };
    }),

  /**
   * Public: the rule check before sealing. Exact math on the rule's numbers, the 90-day replay and
   * the live check (when the rule can be replayed), and an AI review of its wording (never advice).
   * Nothing is stored. The AI part has a shared hourly budget; past it, the rest still runs.
   */
  check: publicLimitedProcedure("ruleCheck")
    .input(z.object({ spec: specInput }))
    .mutation(async ({ ctx, input }) => {
      let spec: Spec;
      try {
        spec = Spec.parse(input.spec);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That rule isn't complete yet." });
      }
      const live = await perps();
      const findings = mathChecks(spec, Object.fromEntries(live.map((p) => [p.coin, p])));
      let replayed: ReturnType<typeof dryRun> | null = null;
      let replayNote: string | null = null;
      let state: "would_fire" | "waiting" | "unknown" | null = null;
      try {
        const p = await prepare(input.spec);
        replayed = dryRun(p.spec, p.series);
        state = dryRunNow(p.spec, p.series, live.filter((m) => p.coins.includes(m.coin))).state;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        replayNote = /lev/i.test(msg) ? "Dry Run replays rules up to 5× leverage (pre-IPO 2×)" : msg || "The replay couldn't run";
      }
      findings.push(...replayChecks(replayed, state));
      const [g] = (await ctx.db.execute(sql`select public.rate_limit_hit(${"ruleCheckAi:all"}, ${600}::int, ${3600}::int) as ok`)) as unknown as { ok: boolean }[];
      let ai: Awaited<ReturnType<typeof aiReview>> = null;
      if (g?.ok) {
        try {
          ai = await aiReview(spec, writerModel(), findings);
        } catch {
          ai = null; // writer not configured
        }
      }
      if (ai) findings.push(...ai);
      return {
        findings,
        aiChecked: ai !== null,
        replay: replayed && { days: replayed.days, fires: replayed.fires, returnPct: replayed.returnPct, maxDrawdownPct: replayed.maxDrawdownPct },
        replayNote,
      };
    }),

  /** Public: plain English to a Dry Run rule with the rule writer (always paper). */
  draft: publicLimitedProcedure("dryRunDraft")
    .input(z.object({ text: z.string().min(3).max(MAX_IDEA_CHARS) }))
    .mutation(async ({ input }) => {
      try {
        const d = await draftRule(input.text);
        return { ...d, spec: { ...d.spec, mode: "paper" as const } };
      } catch (e) {
        if (e instanceof WriterError) throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: e.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The rule writer is unavailable." });
      }
    }),
});
