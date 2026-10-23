import { expect, test } from "bun:test";
import { HlError } from "@proviso/hl";
import { Evaluator } from "../evaluator/engine.ts";
import type { MachineEvent } from "../evaluator/machine.ts";
import { hl, MIN, priceAbove, spec, T0 } from "../evaluator/testkit.ts";
import { VenueHealth, venueFault, type VenueState } from "./venue.ts";

test("degraded after 3 failures in a row, healthy again after 3 answers; one answer resets the count", () => {
  const changes: VenueState[] = [];
  let t = 0;
  const v = new VenueHealth({ onChange: (s) => changes.push(s), now: () => t });
  v.fail("a");
  v.fail("b");
  v.ok(); // an answer in between: not degraded
  v.fail("c");
  v.fail("d");
  expect(v.state.down).toBe(false);
  t = 5;
  v.fail("timeout");
  expect(v.state).toEqual({ down: true, reason: "timeout", since: 5 });
  v.ok();
  v.ok();
  expect(v.state.down).toBe(true);
  v.ok();
  expect(v.state.down).toBe(false);
  expect(changes.map((c) => c.down)).toEqual([true, false]);
});

test("probe: a throw or a reply slower than 5 s counts as a failure", async () => {
  let t = 0;
  const v = new VenueHealth({ onChange: () => {}, now: () => t });
  for (let i = 0; i < 3; i++) await v.probe(async () => { t += 6_000; });
  expect(v.state).toMatchObject({ down: true, reason: "slow: 6000 ms" });
  const w = new VenueHealth({ onChange: () => {} });
  for (let i = 0; i < 3; i++) await w.probe(async () => { throw new Error("fetch failed"); });
  expect(w.state).toMatchObject({ down: true, reason: "fetch failed" });
});

test("only missing answers count against the venue: network errors and 5xx, not order rejections", () => {
  expect(venueFault(new Error("fetch failed"))).toBe(true);
  expect(venueFault(new HlError("Bad gateway", 502))).toBe(true);
  expect(venueFault(new HlError("Exchange error: Insufficient margin"))).toBe(false);
  expect(venueFault(new HlError("Rate limited", 429))).toBe(false);
});

test("while Hyperliquid is degraded no rule fires; an edge that turned true meanwhile fires after recovery", () => {
  const events: MachineEvent[] = [];
  const ev = new Evaluator((e) => events.push(e));
  ev.add({ id: "1", spec: spec(priceAbove("BTC", 100)), stampedAt: T0 });
  ev.apply(hl("BTC", T0, 90), T0); // false: the edge is armed
  ev.apply({ src: "venue", venue: "hl", at: T0 + MIN, down: true }, T0 + MIN);
  ev.apply(hl("BTC", T0 + 2 * MIN, 120), T0 + 2 * MIN); // true, but the venue is down
  ev.tick(T0 + 2 * MIN);
  expect(events).toEqual([]);
  ev.apply({ src: "venue", venue: "hl", at: T0 + 3 * MIN, down: false }, T0 + 3 * MIN);
  ev.apply(hl("BTC", T0 + 3 * MIN, 121), T0 + 3 * MIN);
  expect(events).toMatchObject([{ kind: "fire", id: "1", mark: 121 }]);
});
