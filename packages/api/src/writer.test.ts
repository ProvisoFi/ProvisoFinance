import { expect, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { draftRule, MAX_IDEA_CHARS, WriterError, writerModel } from "./writer";

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

// The model returns the rule and ambiguities as JSON text inside the structured output.
const asText = (o: Record<string, unknown>) => ({ ...o, spec: JSON.stringify(o.spec), ambiguities: JSON.stringify(o.ambiguities) });
const reply = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(asText(obj as Record<string, unknown>)) }],
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
  const calls: Parameters<MockLanguageModelV4["doGenerate"]>[0][] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      calls.push(opts);
      prompts.push(opts.prompt);
      return reply(outputs[Math.min(i++, outputs.length - 1)]);
    },
  });
  return { m, prompts, calls };
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

test("every call is capped and asks for zero data retention", async () => {
  const { m, calls } = model({ spec, ambiguities: [], unsupported: Array.from({ length: 50 }, () => "x".repeat(1000)) });
  const d = await draftRule("long HYPE", m);
  expect(calls[0].maxOutputTokens).toBe(8192);
  expect(calls[0].abortSignal).toBeInstanceOf(AbortSignal);
  expect(calls[0].providerOptions).toEqual({ gateway: { zeroDataRetention: true } });
  expect(d.unsupported).toHaveLength(20);
  expect(d.unsupported[0]).toHaveLength(300);
});

test("no transport retries, and over-long ideas never reach the model", async () => {
  let n = 0;
  const m = new MockLanguageModelV4({
    doGenerate: async () => {
      n++;
      throw new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 529, isRetryable: true });
    },
  });
  await expect(draftRule("long HYPE", m)).rejects.toThrow();
  expect(n).toBe(1);
  await expect(draftRule("x".repeat(MAX_IDEA_CHARS + 1), m)).rejects.toBeInstanceOf(WriterError);
  expect(n).toBe(1);
});

test("text that isn't JSON is repaired like a schema error, then refused", async () => {
  const raw = { ...reply({}), content: [{ type: "text" as const, text: JSON.stringify({ spec: "not json", ambiguities: "[", unsupported: [] }) }] };
  let n = 0;
  const m = new MockLanguageModelV4({ doGenerate: async () => (n++, raw) });
  await expect(draftRule("long HYPE", m)).rejects.toBeInstanceOf(WriterError);
  expect(n).toBe(2);
});

test("the default model comes from WRITER_MODEL", () => {
  const before = process.env.WRITER_MODEL;
  try {
    delete process.env.WRITER_MODEL;
    expect(() => writerModel()).toThrow(WriterError);
    process.env.WRITER_MODEL = "provider/model";
    expect(writerModel()).toBe("provider/model");
  } finally {
    if (before === undefined) delete process.env.WRITER_MODEL;
    else process.env.WRITER_MODEL = before;
  }
});
