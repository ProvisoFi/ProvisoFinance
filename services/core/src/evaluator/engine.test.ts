import { describe, expect, test } from "bun:test";
import { Evaluator } from "./engine.ts";
import { ThesisMachine, type MachineEvent } from "./machine.ts";
import { MemoryMarketView, Ring } from "./state.ts";
import { hl, MIN, priceAbove, spec, T0 } from "./testkit.ts";

const ethSpec = () =>
  spec(priceAbove("ETH", 3000), {
    entry: {
      when: priceAbove("ETH", 3000),
      then: [{ venue: "hl", action: "open", coin: "ETH", side: "long", lev: 1, size: { usd: 10 } }],
      legs: { atomic: false, onPartial: "unwind" },
    },
  });

describe("Evaluator", () => {
  test("an update re-steps only the ideas that read it", () => {
    const events: MachineEvent[] = [];
    const ev = new Evaluator((e) => events.push(e));
    const btc = ev.add({ id: "btc", spec: spec(priceAbove("BTC", 100)), stampedAt: T0 });
    const eth = ev.add({ id: "eth", spec: ethSpec(), stampedAt: T0 });
    const steps = { btc: 0, eth: 0 };
    for (const m of [btc, eth]) {
      const orig = m.step.bind(m);
      m.step = (v, now) => (steps[m.id as "btc" | "eth"]++, orig(v, now));
    }
    ev.apply(hl("BTC", T0, 90), T0);
    expect(steps).toEqual({ btc: 1, eth: 0 });
    ev.apply([hl("ETH", T0, 2900), hl("SOL", T0, 1)], T0);
    expect(steps).toEqual({ btc: 1, eth: 1 });
    ev.apply([hl("BTC", T0 + MIN, 105), hl("ETH", T0 + MIN, 2950)], T0 + MIN);
    expect(steps).toEqual({ btc: 2, eth: 2 });
    expect(events).toMatchObject([{ kind: "fire", id: "btc", mark: 105 }]);
    expect(ev.size).toBe(1); // fire once -> removed
    expect(ev.get("btc")).toBeUndefined();
  });

  test("tick steps everything: expiry without data", () => {
    const events: MachineEvent[] = [];
    const ev = new Evaluator((e) => events.push(e));
    ev.add(new ThesisMachine({ id: "a", spec: spec(priceAbove("BTC", 100), { expires: "5m" }), stampedAt: T0 }));
    ev.tick(T0 + 4 * MIN);
    expect(events).toEqual([]);
    expect(ev.tick(T0 + 5 * MIN)).toEqual([{ kind: "expire", id: "a", at: T0 + 5 * MIN }]);
    expect(events).toHaveLength(1);
    expect(ev.size).toBe(0);
  });

  test("remove and replace keep the index consistent", () => {
    const ev = new Evaluator(() => {});
    ev.add({ id: "a", spec: spec(priceAbove("BTC", 100)), stampedAt: T0 });
    ev.add({ id: "a", spec: ethSpec(), stampedAt: T0 });
    expect(ev.size).toBe(1);
    ev.remove("a");
    expect(ev.apply(hl("ETH", T0, 1), T0)).toEqual([]);
    expect(ev.size).toBe(0);
  });
});

describe("MemoryMarketView", () => {
  test("ring buffer keeps one sample per resolution, evicts oldest, finds latest <= t", () => {
    const r = new Ring(3, 10);
    for (const t of [0, 5, 10, 20, 30, 25]) r.push(t, t * 2);
    expect(r.size).toBe(3);
    expect(r.at(9)).toBeUndefined(); // 0 evicted
    expect(r.at(15)).toEqual({ value: 20, at: 10 });
    expect(r.at(1000)).toEqual({ value: 60, at: 30 });
  });
  test("partial updates keep older fields and their timestamps", () => {
    const v = new MemoryMarketView();
    v.apply(hl("BTC", T0, 100));
    v.apply({ src: "hl", coin: "BTC", at: T0 + MIN, mark: 101 });
    expect(v.hlMark("BTC")).toEqual({ value: 101, at: T0 + MIN });
    expect(v.hlOracle("BTC")).toEqual({ value: 100, at: T0 });
    expect(v.hlMarkAt("BTC", T0 + 30_000)).toEqual({ value: 100, at: T0 });
  });
  test("posts merge by id, account is case-insensitive, old posts are pruned", () => {
    const v = new MemoryMarketView({ postRetentionMs: 10 * MIN });
    v.apply({ src: "posts", account: "Bob", at: T0, posts: [{ id: "1", at: T0, text: "a" }] });
    v.apply({ src: "posts", account: "bob", at: T0 + MIN, posts: [{ id: "2", at: T0 + MIN, text: "b" }] });
    expect(v.posts("BOB")?.value.map((p) => p.id)).toEqual(["1", "2"]);
    v.apply({ src: "posts", account: "bob", at: T0 + 10.5 * MIN, posts: [] });
    expect(v.posts("bob")?.value.map((p) => p.id)).toEqual(["2"]);
  });
});
