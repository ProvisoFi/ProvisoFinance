import { expect, test } from "bun:test";
import { Exit, type Exit as ExitT } from "@proviso/dsl";
import { exitLevels, exitProgress, nextExit } from "./planner";

const H = 3_600_000;
const base: ExitT = { stop: { pct: -5 }, take: { pct: 20 }, ref: "trigger_mark" };
const run = (exit: ExitT, side: "long" | "short", path: number[], t0 = 0, dt = 60_000) => {
  const levels = exitLevels(exit, 100, side);
  const p = exitProgress(100, t0);
  const out: string[] = [];
  path.forEach((mark, i) => {
    const s = nextExit(exit, levels, side, 100, mark, p, t0 + i * dt);
    if (!s) return;
    out.push(s.kind === "partial" ? `partial${s.index}:${s.share.toFixed(3)}` : s.kind);
    if (s.kind === "partial") (p.taken = s.index + 1), (p.closed += exit.partials![s.index]!.fraction);
  });
  return out;
};

test("a trailing stop follows the best mark and only tightens; the fixed stop still applies", () => {
  const exit = { ...base, trail: { pct: 3 } };
  expect(run(exit, "long", [101, 104, 108, 106, 104.7])).toEqual(["trail"]); // 108 × 0.97 = 104.76
  expect(run(exit, "long", [99, 98.5, 97])).toEqual(["trail"]); // never above 100: trail at 97
  expect(run(exit, "short", [99, 95, 97.9])).toEqual(["trail"]); // 95 × 1.03 = 97.85
  expect(run({ ...base, trail: { pct: 10 } }, "long", [96, 94.9])).toEqual(["stop"]); // fixed stop first
});

test("partial targets take their share of the original position, then the final target closes the rest", () => {
  const exit = { ...base, partials: [{ pct: 5, fraction: 0.25 }, { pct: 10, fraction: 0.25 }] };
  // 25% of the original = 25% of all; the next 25% of the original = 1/3 of the 75% left.
  expect(run(exit, "long", [103, 105, 107, 111, 121])).toEqual(["partial0:0.250", "partial1:0.333", "take"]);
  expect(run(exit, "short", [95, 89, 79])).toEqual(["partial0:0.250", "partial1:0.333", "take"]);
});

test("maxHold closes what's left once the time is up", () => {
  const exit = { ...base, maxHold: "2h" };
  expect(run(exit, "long", [101, 102, 103], 0, H)).toEqual(["time"]); // at the third mark, 2h after the fire
});

test("the rule language checks advanced exits", () => {
  const ok = Exit.safeParse({ ...base, trail: { pct: 3 }, partials: [{ pct: 5, fraction: 0.5 }], maxHold: "3d" });
  expect(ok.success).toBe(true);
  expect(Exit.safeParse({ ...base, partials: [{ pct: 10, fraction: 0.3 }, { pct: 5, fraction: 0.3 }] }).success).toBe(false); // not rising
  expect(Exit.safeParse({ ...base, partials: [{ pct: 25, fraction: 0.3 }] }).success).toBe(false); // past the final target
  expect(Exit.safeParse({ ...base, partials: [{ pct: 5, fraction: 0.6 }, { pct: 10, fraction: 0.4 }] }).success).toBe(false); // nothing left
  expect(Exit.safeParse({ ...base, maxHold: "100d" }).success).toBe(false);
  expect(Exit.safeParse({ ...base, trail: { pct: 60 } }).success).toBe(false);
});
