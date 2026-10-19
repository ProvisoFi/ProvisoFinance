import { expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { draftRule, WriterError } from "./writer";

const spec = {
  v: 1,
  entry: {
    when: { funding: { coin: "HYPE", op: "<", value: 0 } },
    then: [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 3, size: { usd: 500 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -6 }, take: { pct: 15 }, ref: "trigger_mark" },
  limits: { maxUsd: 500, maxLev: 3 },
  mode: "live",
  expires: "30d",
};

const reply = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  warnings: [],
});

const model = (...outputs: unknown[]) => {
  let i = 0;
  const prompts: unknown[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      prompts.push(opts.prompt);
      return reply(outputs[Math.min(i++, outputs.length - 1)]);
    },
  });
  return { m, prompts };
};

test("valid draft comes back parsed, rendered, with ambiguities", async () => {
  const amb = { path: ["exit", "stop", "pct"], phrase: "a tight stop", options: [{ label: "3%", value: -3 }, { label: "5%", value: -5 }] };
  const { m } = model({ spec, ambiguities: [amb], unsupported: [] });
  const d = await draftRule("long HYPE when funding goes negative, tight stop", m);
  expect(d.spec.fire).toBe("once"); // defaults filled by the schema
  expect(d.ambiguities).toEqual([amb]);
  expect(d.rendering.length).toBeGreaterThan(10);
});

test("invalid JSON gets one repair round with the schema errors", async () => {
  const bad = { ...spec, exit: { ...spec.exit, stop: { pct: 6 } } }; // stop must be negative
  const { m, prompts } = model({ spec: bad, ambiguities: [], unsupported: [] }, { spec, ambiguities: [], unsupported: [] });
  const d = await draftRule("long HYPE", m);
  expect(d.spec.exit.stop.pct).toBe(-6);
  expect(JSON.stringify(prompts[1])).toContain("exit.stop.pct");
});

test("gives up after the repair round", async () => {
  const { m } = model({ spec: { v: 2 }, ambiguities: [], unsupported: [] });
  await expect(draftRule("??", m)).rejects.toBeInstanceOf(WriterError);
});
