import { expect, test } from "bun:test";
import type { MachineEvent } from "../evaluator/machine.ts";
import { fireGate } from "./index.ts";

test("L-3: fires wait for the restart restore, then go through in order; expiries never wait", () => {
  const seen: string[] = [];
  const gate = fireGate((e) => seen.push(`${e.kind}:${e.id}`));
  const fire = (id: string) => ({ kind: "fire", id, at: 0, coin: "BTC", mark: 1, n: 1, flags: [] }) as MachineEvent;
  gate.onEvent(fire("1"));
  gate.onEvent({ kind: "expire", id: "2", at: 0 });
  gate.onEvent(fire("3"));
  expect(seen).toEqual(["expire:2"]); // nothing bought before positions are rebuilt
  gate.open();
  gate.onEvent(fire("4"));
  expect(seen).toEqual(["expire:2", "fire:1", "fire:3", "fire:4"]);
});
