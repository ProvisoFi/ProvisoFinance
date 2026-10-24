import { expect, test } from "bun:test";
import { ruleFromHash } from "./handoff";

const rule = {
  v: 1,
  entry: { when: { price: { coin: "BTC", op: ">", value: 100000 } }, then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 2, size: { usd: 100 } }], legs: { atomic: false, onPartial: "unwind" } },
  exit: { stop: { pct: -3 }, take: { pct: 6 }, ref: "trigger_mark" },
  limits: { maxUsd: 100, maxLev: 2 },
  mode: "paper",
  expires: "7d",
};
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("a prepare_seal fragment opens as the exact rule; anything else is ignored", () => {
  expect(ruleFromHash(`#rule=${enc(rule)}`)).toMatchObject({ mode: "paper", entry: { then: [{ coin: "BTC" }] }, fire: "once" });
  expect(ruleFromHash(`#x=1&rule=${enc(rule)}`)?.mode).toBe("paper");
  expect(ruleFromHash("")).toBeNull();
  expect(ruleFromHash("#rule=not*base64")).toBeNull();
  expect(ruleFromHash(`#rule=${enc({ ...rule, exit: { stop: { pct: 5 } } })}`)).toBeNull(); // not a valid rule
  expect(ruleFromHash(`#rule=${enc({ ...rule, title: "café ✓" })}`)).toBeNull(); // strict: unknown fields refused
});
