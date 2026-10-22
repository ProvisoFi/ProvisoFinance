// Rule writer: plain English → DSL v1 draft + readable rendering + ambiguity list.
// Nothing here runs a rule; the user reviews the read-back and confirms before sealing.
// Prompts and drafts are never logged or stored (the text may describe a sealed idea).
import { Ambiguity, render, Spec } from "@proviso/dsl";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

export const WRITER_SYSTEM = `You translate one trading idea into Proviso rule language v1 (JSON).
Schema (all keys required unless marked optional):
{ "v": 1,
  "entry": { "when": Condition, "then": [Action, ...1-4], "legs": { "atomic": false, "onPartial": "unwind" } },
  "exit": { "stop": { "pct": <negative %> }, "take": { "pct": <positive %> }, "ref": "trigger_mark" },
  "limits": { "maxUsd": <usd>, "maxLev": <1-10> },
  "mode": "live" | "alert", "fire": "once" | "repeat" (optional, default once), "cooldown": "<n>m|h|d" (optional),
  "expires": "<n>m|h|d" (max 30d) }
Condition leaves (op is one of > < >= <=):
  {"price":{"coin","op","value"}} USD mark · {"change":{"coin","op","value","window"}} percent over window ·
  {"funding":{"coin","op","value"}} hourly rate in percent · {"oi":{"coin","op","value"}} USD open interest ·
  {"fear_greed":{"op","value"}} 0-100 · {"time_window":{"from":"HH:MM","to":"HH:MM","tz":"IANA","days":[0-6]?}} ·
  {"market_session":{"is":"pre"|"regular"|"post"|"closed"}} · {"earnings_window":{"coin","within","relative":"before"|"after"|"either"}} ·
  {"corporate_action":{"coin","kind":"split"|"reverse_split"|"dividend"|"merger"|"spinoff","within"}} ·
  {"gap":{"coin","op","value"}} percent, Robinhood Chain Stock Token vs Hyperliquid perp ·
  {"post":{"account":"handle without @","contains":["text",...]}}
Combinators: {"all":[...]}, {"any":[...]}, {"not":C}, {"after":{"n":"<duration>","cond":C}} (held continuously for n).
Actions: {"venue":"hl","action":"open","coin","side":"long"|"short","lev","size":{"usd"}} ·
  {"venue":"hl","action":"close","coin"} · {"venue":"hl","action":"reduce","coin","pct"} ·
  {"venue":"hl","action":"spot","coin","side":"buy"|"sell","size":{"usd"}} ·
  {"venue":"rhc","action":"swap","tokenIn","tokenOut","size":{"usd"},"maxSlipPct":<=2}
Rules:
- Coins are upper-case tickers as written (HYPE, BTC, ETH, NVDA...).
- Never guess a vague phrase ("tight stop", "big size", "when it pumps", "soon"). Put a sensible option
  into the spec, AND add an ambiguity: {"path": JSON path to that value, "phrase": the user's words,
  "options": [{"label","value"}, ...at least 2, first = the value you used]}.
- If the user gives no stop, target, size, leverage, expiry or mode, that is ambiguous too: add an ambiguity.
- limits.maxUsd = total size; limits.maxLev = highest leverage used.
- List anything the language cannot express in "unsupported" instead of approximating it.
Output: "spec" is the complete rule as JSON text (one JSON object, as above); "ambiguities" is a JSON
array as text ("[]" when nothing is ambiguous); "unsupported" is a list of strings.`;

// The rule travels as JSON text: an open `record` field let structured output return `{}` (the
// model reasoned out the rule, then emitted an empty object). Parsed and validated below.
const WriterOutput = z.object({
  spec: z.string().describe("The complete rule as JSON text (Proviso rule language v1)"),
  ambiguities: z.string().describe('JSON array of ambiguities as text, "[]" if none'),
  unsupported: z.array(z.string()),
});
const json = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

export type Draft = {
  spec: Spec;
  rendering: string;
  ambiguities: Ambiguity[];
  unsupported: string[];
};

/** A rule-writer failure whose message is safe to show the user (not configured, too long, no valid draft). */
export class WriterError extends Error {}

// Cost caps: every call is bounded in input, output, time and retries (the repair round below is
// the only second call).
export const MAX_IDEA_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 60_000; // both attempts together
const MAX_LIST = 20; // ambiguities / unsupported items returned
const MAX_ITEM_CHARS = 300;

/** The AI Gateway model id from WRITER_MODEL; throws WriterError if unset. */
export function writerModel(): LanguageModel {
  const id = process.env.WRITER_MODEL;
  if (!id) throw new WriterError("The rule writer is not configured (WRITER_MODEL).");
  return id; // AI Gateway model string, e.g. "<provider>/<model>"
}

/**
 * Drafts a DSL v1 rule from plain English, with its rendering, ambiguities and unsupported parts.
 * One repair round: if the draft doesn't parse, the schema errors go back to the model.
 * Throws WriterError if the text exceeds MAX_IDEA_CHARS or neither attempt validates; 60 s total.
 */
export async function draftRule(text: string, model: LanguageModel = writerModel()): Promise<Draft> {
  if (text.length > MAX_IDEA_CHARS) throw new WriterError(`Keep the idea under ${MAX_IDEA_CHARS} characters.`);
  const abortSignal = AbortSignal.timeout(TIMEOUT_MS);
  let prompt = text;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { output } = await generateText({
      model,
      system: WRITER_SYSTEM,
      prompt,
      output: Output.object({ schema: WriterOutput }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal,
      // Only providers with zero-data-retention agreements (the idea may describe a sealed rule).
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
    const spec = Spec.safeParse(json(output.spec));
    const ambiguities = z.array(Ambiguity).safeParse(json(output.ambiguities));
    if (spec.success && ambiguities.success)
      return {
        spec: spec.data,
        rendering: render(spec.data),
        ambiguities: ambiguities.data.slice(0, MAX_LIST),
        unsupported: output.unsupported.slice(0, MAX_LIST).map((u) => u.slice(0, MAX_ITEM_CHARS)),
      };
    const issues = [...(spec.error?.issues ?? []), ...(ambiguities.error?.issues ?? [])]
      .slice(0, MAX_LIST)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    prompt = `${text}\n\nYour previous JSON was invalid:\n${issues}\nReturn corrected JSON.`;
  }
  throw new WriterError("The writer could not produce a valid rule. Try rephrasing the idea.");
}
