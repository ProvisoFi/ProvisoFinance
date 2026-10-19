import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Spec, type Condition } from "@proviso/dsl";
import { actionsReady, evalCondition, and3, UNKNOWN, config } from "./conditions.ts";
import { readKeys, stampFlags, ThesisMachine, type MachineEvent } from "./machine.ts";
import { MemoryMarketView } from "./state.ts";
import { HOUR, hl, MIN, priceAbove, rhc, spec, T0 } from "./testkit.ts";

/** Drives one machine over a BTC mark path, one minute apart. */
function run(m: ThesisMachine, marks: (number | null)[], start = T0, v = new MemoryMarketView()) {
  const out: { i: number; e: MachineEvent }[] = [];
  marks.forEach((mark, i) => {
    const t = start + i * MIN;
    if (mark !== null) v.apply(hl("BTC", t, mark));
    for (const e of m.step(v, t)) out.push({ i, e });
  });
  return out;
}
const machine = (when: Condition = priceAbove("BTC", 100), over = {}, init = {}) =>
  new ThesisMachine({ id: "x", spec: spec(when, over), stampedAt: T0, ...init });

describe("edge triggering", () => {
  test("fires on false -> true with the trigger mark of the first action's coin", () => {
    const ev = run(machine(), [90, 95, 105, 110]);
    expect(ev).toEqual([{ i: 2, e: { kind: "fire", id: "x", at: T0 + 2 * MIN, coin: "BTC", mark: 105, n: 1, flags: [] } }]);
  });
  test("first evaluation already true does not fire, and needs a fresh edge", () => {
    expect(run(machine(), [105, 110, 120])).toEqual([]);
    const ev = run(machine(), [105, 90, 105]);
    expect(ev.map((x) => x.i)).toEqual([2]);
  });
  test("fire once stops the machine", () => {
    const m = machine();
    const ev = run(m, [90, 105, 90, 105]);
    expect(ev.map((x) => x.i)).toEqual([1]);
    expect(m.status).toBe("fired");
  });
  test("unknown leaves edge state: false -> unknown -> true fires, true -> unknown -> true does not", () => {
    expect(run(machine(), [90, null, null, 105]).map((x) => x.i)).toEqual([3]); // null: no update -> stale after 30 s
    expect(run(machine(priceAbove("BTC", 100), { fire: "repeat" }), [90, 105, null, 110]).map((x) => x.i)).toEqual([1]);
  });
  test("first evaluation unknown then true does not fire", () => {
    expect(run(machine(), [null, 105])).toEqual([]);
  });
  test("trigger mark uses the first action's coin, not the condition's", () => {
    const m = new ThesisMachine({
      id: "x",
      spec: spec(priceAbove("BTC", 100), {
        entry: {
          when: priceAbove("BTC", 100),
          then: [{ venue: "hl", action: "open", coin: "ETH", side: "short", lev: 1, size: { usd: 100 } }],
          legs: { atomic: false, onPartial: "unwind" },
        },
      }),
      stampedAt: T0,
    });
    const v = new MemoryMarketView();
    v.apply(hl("ETH", T0, 3000));
    v.apply(hl("BTC", T0, 90));
    m.step(v, T0);
    v.apply(hl("ETH", T0 + MIN, 3100));
    v.apply(hl("BTC", T0 + MIN, 105));
    expect(m.step(v, T0 + MIN)).toMatchObject([{ kind: "fire", coin: "ETH", mark: 3100 }]);
  });
});

describe("action markets", () => {
  test("illiquid or unchecked action market blocks the fire (unknown), then fires when it recovers", () => {
    const m = new ThesisMachine({
      id: "x",
      spec: spec(priceAbove("BTC", 100), {
        entry: {
          when: priceAbove("BTC", 100),
          then: [
            { venue: "hl", action: "open", coin: "BTC", side: "long", lev: 2, size: { usd: 100 } },
            { venue: "hl", action: "open", coin: "THIN", side: "short", lev: 2, size: { usd: 100 } },
          ],
          legs: { atomic: false, onPartial: "unwind" },
        },
      }),
      stampedAt: T0,
    });
    const v = new MemoryMarketView();
    v.apply(hl("THIN", T0, 1, { volume24h: 1e9 }));
    v.apply(hl("BTC", T0, 90));
    expect(m.step(v, T0)).toEqual([]);
    v.apply(hl("THIN", T0 + MIN, 1, { volume24h: 100_000 }));
    v.apply(hl("BTC", T0 + MIN, 105));
    expect(m.step(v, T0 + MIN)).toEqual([]);
    v.apply(hl("THIN", T0 + 2 * MIN, 1, { volume24h: 1e9 }));
    v.apply(hl("BTC", T0 + 2 * MIN, 106));
    expect(m.step(v, T0 + 2 * MIN)).toMatchObject([{ kind: "fire", mark: 106 }]);
  });
  test("rhc swap needs both pools deep; the quote token is exempt; trigger mark is the stock token pool price", () => {
    const s = Spec.parse(
      spec(priceAbove("BTC", 1), {
        entry: {
          when: priceAbove("BTC", 1),
          then: [{ venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "NVDA", size: { usd: 100 }, maxSlipPct: 1 }],
          legs: { atomic: false, onPartial: "unwind" },
        },
      }),
    );
    const v = new MemoryMarketView();
    v.apply(rhc("NVDA", T0, 180, { depth: 50_000 }));
    expect(actionsReady(s.entry.then, v, T0).ok).toBe(UNKNOWN);
    v.apply(rhc("NVDA", T0, 180));
    expect(actionsReady(s.entry.then, v, T0)).toEqual({ ok: true, coin: "NVDA", mark: 180 });
    expect(readKeys(s)).toEqual(["hl:BTC", "rhc:NVDA"]);
  });
});

describe("repeat and cooldown", () => {
  test("repeat fires on each edge outside the cooldown; edges inside it are consumed", () => {
    const m = machine(priceAbove("BTC", 100), { fire: "repeat", cooldown: "3m" });
    //                 0   1    2   3    4   5   6    7
    const ev = run(m, [90, 105, 90, 105, 90, 90, 105, 110]);
    expect(ev.map((x) => x.i)).toEqual([1, 6]); // edge at 3 is 2 min after the fire at 1
    expect(ev.map((x) => (x.e.kind === "fire" ? x.e.n : 0))).toEqual([1, 2]);
    expect(m.status).toBe("live");
  });
  test("cooldown 0m fires on every edge", () => {
    expect(run(machine(priceAbove("BTC", 100), { fire: "repeat" }), [90, 105, 90, 105]).map((x) => x.i)).toEqual([1, 3]);
  });
});

describe("expiry", () => {
  test("hard expiry emits expire once and stops", () => {
    const m = machine(priceAbove("BTC", 100), { expires: "3m" });
    const ev = run(m, [90, 90, 90, 105, 90, 105]);
    expect(ev).toEqual([{ i: 3, e: { kind: "expire", id: "x", at: T0 + 3 * MIN } }]);
    expect(m.status).toBe("expired");
  });
  test("expiresAt is capped at 30 days from the stamp", () => {
    const m = machine(priceAbove("BTC", 100), {}, { expiresAt: T0 + 90 * 24 * HOUR });
    expect(m.expiresAt).toBe(T0 + 30 * 24 * HOUR);
    expect(machine(priceAbove("BTC", 100), { expires: "1d" }, { expiresAt: T0 + 2 * 24 * HOUR }).expiresAt).toBe(T0 + 24 * HOUR);
  });
});

describe("after in the machine", () => {
  test("fires once the condition held for n", () => {
    const m = machine({ after: { n: "2m", cond: priceAbove("BTC", 100) } });
    expect(run(m, [90, 105, 105, 105, 105]).map((x) => x.i)).toEqual([3]);
  });
});

describe("stamp flags", () => {
  test("trivially_true when the entry condition holds at stamp", () => {
    const v = new MemoryMarketView();
    v.apply(hl("BTC", T0, 105));
    const s = Spec.parse(spec(priceAbove("BTC", 100)));
    expect(stampFlags(s, v, T0)).toEqual(["trivially_true"]);
    expect(stampFlags(Spec.parse(spec(priceAbove("BTC", 200))), v, T0)).toEqual([]);
    expect(stampFlags(Spec.parse(spec(priceAbove("ETH", 1))), v, T0)).toEqual([]); // unknown is not true
  });
  test("self_triggered when a post condition targets a linked handle (case-insensitive, @ optional)", () => {
    const s = Spec.parse(spec({ any: [priceAbove("BTC", 1e9), { post: { account: "MyHandle", contains: ["go"] } }] }));
    const v = new MemoryMarketView();
    expect(stampFlags(s, v, T0, ["@myhandle"])).toEqual(["self_triggered"]);
    expect(stampFlags(s, v, T0, ["someoneelse"])).toEqual([]);
    const m = new ThesisMachine({ id: "x", spec: s, stampedAt: T0, linkedHandles: ["MYHANDLE"] });
    v.apply({ src: "posts", account: "myhandle", at: T0, posts: [] });
    v.apply(hl("BTC", T0, 1));
    m.step(v, T0);
    v.apply({ src: "posts", account: "myhandle", at: T0 + MIN, posts: [{ id: "1", at: T0 + MIN, text: "GO time" }] });
    v.apply(hl("BTC", T0 + MIN, 1));
    expect(m.step(v, T0 + MIN)).toMatchObject([{ kind: "fire", flags: ["self_triggered"] }]);
  });
});

describe("property: unknown never fires", () => {
  const COINS = ["A", "B", "C"];
  const leaf = fc.constantFrom(...COINS).map((c): Condition => priceAbove(c, 100));
  const tree = fc.letrec<{ c: Condition }>((tie) => ({
    c: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      leaf,
      fc.array(tie("c"), { minLength: 1, maxLength: 3 }).map((all): Condition => ({ all })),
      fc.array(tie("c"), { minLength: 1, maxLength: 3 }).map((any): Condition => ({ any })),
      tie("c").map((not): Condition => ({ not })),
    ),
  })).c;
  // Per step and coin: 0 = true (110), 1 = false (90), 2 = unknown (oracle disagrees), 3 = unknown (no update -> stale)
  const steps = fc.array(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 25 });

  test("fires only at steps where the gate is true and the previous known gate was false", () => {
    fc.assert(
      fc.property(tree, steps, fc.boolean(), (when, path, repeat) => {
        const s = spec(when, {
          fire: repeat ? "repeat" : "once",
          entry: {
            when,
            then: [{ venue: "hl", action: "open", coin: "ACT", side: "long", lev: 1, size: { usd: 10 } }],
            legs: { atomic: false, onPartial: "unwind" },
          },
        });
        const m = new ThesisMachine({ id: "p", spec: s, stampedAt: T0 });
        const v = new MemoryMarketView();
        let lastKnown: boolean | undefined;
        path.forEach((states, i) => {
          const t = T0 + i * MIN;
          v.apply(hl("ACT", t, 1));
          states.forEach((st, j) => {
            if (st === 3) return;
            v.apply(hl(COINS[j], t, st === 0 ? 110 : 90, st === 2 ? { oracle: 200 } : {}));
          });
          const gate = and3([evalCondition(when, v, t, new Map()), true]);
          const fired = m.step(v, t).some((e) => e.kind === "fire");
          if (gate === UNKNOWN) expect(fired).toBe(false);
          if (fired) {
            expect(gate).toBe(true);
            expect(lastKnown).toBe(false);
          }
          if (gate !== UNKNOWN) lastKnown = gate;
        });
      }),
      { numRuns: 300 },
    );
  });

  test("a rule whose inputs are all unknown never fires", () => {
    fc.assert(
      fc.property(tree, fc.array(fc.integer({ min: 2, max: 3 }), { minLength: 1, maxLength: 30 }), (when, path) => {
        const m = new ThesisMachine({ id: "p", spec: spec(when, { fire: "repeat" }), stampedAt: T0 });
        const v = new MemoryMarketView();
        return path.every((st, i) => {
          const t = T0 + i * MIN;
          v.apply(hl("BTC", t, 1));
          if (st === 2) for (const c of COINS) v.apply(hl(c, t, 110, { oracle: 200 }));
          return m.step(v, t).length === 0;
        });
      }),
    );
  });
});

test("config overrides merge per source", () => {
  const c = config({ maxAgeMs: { hl: 1 } });
  expect(c.maxAgeMs.hl).toBe(1);
  expect(c.maxAgeMs.rhc).toBe(180_000);
});
