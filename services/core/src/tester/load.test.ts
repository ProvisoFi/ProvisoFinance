import { describe, expect, test } from "bun:test";
import { MIN, priceAbove, spec, T0 } from "../evaluator/testkit.ts";
import { framesFromRows, type CandleRow, type SnapshotRow } from "./load.ts";
import { replay } from "./replay.ts";

const snap = (i: number, mark: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  coin: "BTC",
  ts: new Date(T0 + i * MIN),
  mark,
  oracle: mark,
  funding: "0.0000125",
  oi: "1000",
  volume24h: "900000000",
  ...over,
});
const candle = (i: number, c: string): CandleRow => ({
  coin: "BTC",
  interval: "1m",
  ts: new Date(T0 + i * MIN),
  o: c,
  h: c,
  l: c,
  c,
  v: "1",
});

describe("framesFromRows", () => {
  test("unit conversion: funding to percent/h, oi to USD", () => {
    const { frames } = framesFromRows({ snapshots: [snap(0, "100")], candles: [], fearGreed: [] });
    expect(frames).toEqual([
      { t: T0, updates: [{ src: "hl", coin: "BTC", at: T0, mark: 100, oracle: 100, funding: 0.00125, oi: 100_000, volume24h: 9e8 }] },
    ]);
  });
  test("nulls stay missing; candles fill only minutes without a snapshot, at close time", () => {
    const { frames } = framesFromRows({
      snapshots: [snap(0, "100", { oracle: null, funding: null, oi: null, volume24h: null })],
      candles: [candle(-1, "99"), candle(0, "101"), candle(1, "102")],
      fearGreed: [{ ts: new Date(T0 - 60 * MIN), value: 40 }],
    });
    expect(frames.map((f) => f.t)).toEqual([T0 - 60 * MIN, T0, T0 + MIN, T0 + 2 * MIN]);
    expect(frames[0].updates).toEqual([{ src: "fg", at: T0 - 60 * MIN, value: 40 }]);
    // candle(-1) closes at T0, where a snapshot exists -> dropped
    expect(frames[1].updates).toEqual([{ src: "hl", coin: "BTC", at: T0, mark: 100, oracle: undefined, funding: undefined, oi: undefined, volume24h: undefined }]);
    // candle(0) closes at T0+1m (no snapshot) -> kept; candle(1) closes at T0+2m -> kept
    expect(frames[2].updates).toEqual([{ src: "hl", coin: "BTC", at: T0 + MIN, mark: 101 }]);
  });
  test("snapshot ids are content hashes per table/coin, stable and sensitive to every value", () => {
    const rows = { snapshots: [snap(0, "100"), snap(1, "101")], candles: [candle(5, "1")], fearGreed: [{ ts: new Date(T0), value: 50 }] };
    const a = framesFromRows(rows).snapshotIds;
    expect(a).toHaveLength(3);
    for (const id of a) expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(framesFromRows(structuredClone(rows)).snapshotIds).toEqual(a);
    const changed = framesFromRows({ ...rows, snapshots: [snap(0, "100"), snap(1, "101.5")] }).snapshotIds;
    expect(changed).not.toEqual(a);
    expect(changed.filter((x) => a.includes(x))).toHaveLength(2); // candles and fear_greed unchanged
  });
  test("candle-only data extends the mark path but cannot satisfy a price condition", () => {
    const { frames } = framesFromRows({ snapshots: [], candles: [candle(0, "90"), candle(1, "110")], fearGreed: [] });
    const r = replay({ spec: spec(priceAbove("BTC", 100)), frames, slippageBps: 0 });
    expect(r.fires).toEqual([]);
    expect(r.coverage[0]).toMatchObject({ supported: true, knownFrames: 0, unknownFrames: 2 });
  });
  test("recorded snapshots drive a replay", () => {
    const { frames } = framesFromRows({ snapshots: [snap(0, "95"), snap(1, "105")], candles: [], fearGreed: [] });
    expect(replay({ spec: spec(priceAbove("BTC", 100)), frames, slippageBps: 0 }).fires).toEqual([{ at: T0 + MIN, coin: "BTC", mark: 105 }]);
  });
});
