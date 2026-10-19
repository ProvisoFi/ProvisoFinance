import { describe, expect, test } from "bun:test";
import { NETWORKS, type Meta, type PerpAssetCtx, type WsActiveAssetCtx } from "@proviso/hl";
import type { Update } from "../evaluator/state.ts";
import { evalConfigFor } from "./index.ts";
import { ctxUpdate, fearGreedUpdate, HlMarket, type SocketPort } from "./market.ts";

const ctx = (markPx: string, over: Partial<PerpAssetCtx> = {}): PerpAssetCtx => ({
  funding: "0.0000125",
  openInterest: "1500",
  prevDayPx: "100",
  dayNtlVlm: "316000",
  premium: null,
  oraclePx: "100.5",
  markPx,
  midPx: null,
  impactPxs: null,
  dayBaseVlm: "1",
  ...over,
});

function fakeSocket() {
  const handlers = new Map<string, (d: WsActiveAssetCtx) => void>();
  const unsubscribed: string[] = [];
  const socket: SocketPort = {
    subscribe(sub, h) {
      handlers.set(sub.coin, h);
      return () => {
        handlers.delete(sub.coin);
        unsubscribed.push(sub.coin);
      };
    },
  };
  return { socket, handlers, unsubscribed, push: (coin: string, c: PerpAssetCtx) => handlers.get(coin)?.({ coin, ctx: c }) };
}

describe("unit conversion", () => {
  test("funding ×100 -> %/h, OI coins × mark -> USD, mark/oracle/volume as numbers", () => {
    expect(ctxUpdate("SOL", ctx("100"), 5, false)).toEqual({
      src: "hl",
      coin: "SOL",
      at: 5,
      mark: 100,
      oracle: 100.5,
      funding: 0.00125,
      oi: 150_000,
      volume24h: 316_000,
      halted: false,
    });
    expect(ctxUpdate("X", ctx("abc"), 1)).toMatchObject({ mark: undefined, oi: undefined });
  });
});

describe("HlMarket", () => {
  test("subscribes only to the requested coins, forwards every mark, debounces evaluator updates", () => {
    const s = fakeSocket();
    let now = 0;
    const applied: Update[] = [];
    const marks: [string, number][] = [];
    const m = new HlMarket({ socket: s.socket, apply: (u) => applied.push(u), onMark: (c, px) => marks.push([c, px]), now: () => now });
    m.setCoins(["SOL", "BTC"]);
    expect([...s.handlers.keys()]).toEqual(["SOL", "BTC"]);
    s.push("SOL", ctx("100"));
    now = 1000;
    s.push("SOL", ctx("101"));
    now = 2000;
    s.push("SOL", ctx("102"));
    expect(marks).toEqual([["SOL", 100], ["SOL", 101], ["SOL", 102]]);
    expect(applied.map((u) => (u as { mark?: number }).mark)).toEqual([100]);
    now = 4999;
    m.flush();
    expect(applied).toHaveLength(1);
    now = 5000;
    m.flush();
    expect(applied.map((u) => [(u as { mark?: number }).mark, u.at])).toEqual([[100, 0], [102, 5000]]);
    m.setCoins(["BTC"]);
    expect(s.unsubscribed).toEqual(["SOL"]);
    s.push("SOL", ctx("1"));
    expect(marks).toHaveLength(3);
  });

  test("spot contexts are ignored", () => {
    const s = fakeSocket();
    const applied: Update[] = [];
    const m = new HlMarket({ socket: s.socket, apply: (u) => applied.push(u) });
    m.setCoins(["PURR/USDC"]);
    s.handlers.get("PURR/USDC")!({ coin: "PURR/USDC", ctx: { coin: "PURR/USDC", prevDayPx: "1", dayNtlVlm: "1", markPx: "1", midPx: null, circulatingSupply: "1", totalSupply: "1", dayBaseVlm: "1" } });
    expect(applied).toEqual([]);
  });

  test("meta refresh sets halted from isDelisted and backs up the stream", async () => {
    const s = fakeSocket();
    const applied: Update[] = [];
    const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 1 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, marginTableId: 1, isDelisted: true }], marginTables: [], collateralToken: 0 } as Meta;
    const m = new HlMarket({ socket: s.socket, apply: (u) => applied.push(u), info: { metaAndAssetCtxs: async () => [meta, [ctx("90000"), ctx("1")]] }, now: () => 10 });
    m.setCoins(["OLD", "BTC"]);
    await m.refreshMeta();
    expect(applied.map((u) => [(u as { coin: string }).coin, (u as { halted?: boolean }).halted])).toEqual([["BTC", false], ["OLD", true]]);
  });
});

test("fear & greed response", () => {
  expect(fearGreedUpdate({ data: [{ value: "23", timestamp: "1760918400" }] })).toEqual({ src: "fg", at: 1760918400000, value: 23 });
  expect(fearGreedUpdate({ data: [] })).toBeUndefined();
});

test("testnet lowers the HL volume floor; mainnet keeps the spec floors", () => {
  expect(evalConfigFor(NETWORKS.testnet, {}).minHlVolumeUsd).toBe(1000);
  expect(evalConfigFor(NETWORKS.testnet, { TESTNET_MIN_HL_VOLUME_USD: "5000" }).minHlVolumeUsd).toBe(5000);
  expect(evalConfigFor(NETWORKS.mainnet, { TESTNET_MIN_HL_VOLUME_USD: "5000" })).toMatchObject({ minHlVolumeUsd: 250_000, minPoolDepthUsd: 100_000 });
  expect(() => evalConfigFor(NETWORKS.testnet, { TESTNET_MIN_HL_VOLUME_USD: "x" })).toThrow();
});
