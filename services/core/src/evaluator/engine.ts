// Holds every live idea, applies market updates and re-steps only the ideas that read them.
import { MemoryMarketView, type Update } from "./state.ts";
import { ThesisMachine, type MachineEvent, type MachineInit } from "./machine.ts";

export class Evaluator {
  private machines = new Map<string, ThesisMachine>();
  private byKey = new Map<string, Set<string>>();

  constructor(
    private readonly onEvent: (e: MachineEvent) => void,
    readonly view: MemoryMarketView = new MemoryMarketView(),
  ) {}

  get size() {
    return this.machines.size;
  }
  get(id: string) {
    return this.machines.get(id);
  }

  /** Adds an idea (replacing one with the same id). Returns its machine. */
  add(m: ThesisMachine | MachineInit): ThesisMachine {
    const machine = m instanceof ThesisMachine ? m : new ThesisMachine(m);
    this.remove(machine.id);
    this.machines.set(machine.id, machine);
    for (const k of machine.keys) {
      let s = this.byKey.get(k);
      if (!s) this.byKey.set(k, (s = new Set()));
      s.add(machine.id);
    }
    return machine;
  }

  remove(id: string) {
    const m = this.machines.get(id);
    if (!m) return;
    this.machines.delete(id);
    for (const k of m.keys) {
      const s = this.byKey.get(k);
      s?.delete(id);
      if (s?.size === 0) this.byKey.delete(k);
    }
  }

  /** Applies updates, then steps each affected idea once at `now`. */
  apply(updates: Update | Update[], now: number): MachineEvent[] {
    const ids = new Set<string>();
    for (const u of Array.isArray(updates) ? updates : [updates]) {
      for (const id of this.byKey.get(this.view.apply(u)) ?? []) ids.add(id);
    }
    return this.stepIds(ids, now);
  }

  /** Steps every idea: call on a clock (e.g. every 5 s) for expiry, time_window, `after` and staleness. */
  tick(now: number): MachineEvent[] {
    return this.stepIds(this.machines.keys(), now);
  }

  private stepIds(ids: Iterable<string>, now: number): MachineEvent[] {
    const out: MachineEvent[] = [];
    for (const id of [...ids]) {
      const m = this.machines.get(id);
      if (!m) continue;
      for (const e of m.step(this.view, now)) {
        out.push(e);
        this.onEvent(e);
      }
      if (m.done) this.remove(id);
    }
    return out;
  }
}
