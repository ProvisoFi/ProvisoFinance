import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalize, Spec } from "@proviso/dsl";
import { priceAbove, spec } from "../evaluator/testkit.ts";
import { TESTER_VERSION, testId } from "./testId.ts";

describe("testId", () => {
  const s = spec(priceAbove("BTC", 100));
  test("sha256(canonical spec ‖ JSON sorted ids ‖ version)", () => {
    const ids = ["b", "a"];
    const expected = createHash("sha256")
      .update(canonicalize(Spec.parse(s)))
      .update(JSON.stringify(["a", "b"]))
      .update(TESTER_VERSION)
      .digest("hex");
    expect(testId(s, ids)).toBe(expected);
    expect(testId(s, ids)).toMatch(/^[0-9a-f]{64}$/);
  });
  test("id order and key order don't matter; defaults are filled", () => {
    const shuffled = Object.fromEntries(Object.entries(s).reverse()) as typeof s;
    expect(testId(shuffled, ["x", "y"])).toBe(testId(s, ["y", "x"]));
    expect(testId({ ...s, fire: "once", cooldown: "0m" }, [])).toBe(testId(s, []));
  });
  test("spec, ids and version all change it", () => {
    const base = testId(s, ["a"]);
    expect(testId(spec(priceAbove("BTC", 101)), ["a"])).not.toBe(base);
    expect(testId(s, ["a", "b"])).not.toBe(base);
    expect(testId(s, ["a"], "2")).not.toBe(base);
  });
});
