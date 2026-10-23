import { expect, test } from "bun:test";
import { listedDexes } from "./config.ts";
import type { Meta, PerpAssetCtx, PerpDex } from "./info.ts";
import { DEX_ASSET_BASE, isDexCoin, perpAssetInfo, perpUniverse } from "./market.ts";

const ctx = (mark: string): PerpAssetCtx =>
  ({ funding: "0", openInterest: "1", prevDayPx: mark, dayNtlVlm: "1000000", premium: null, oraclePx: mark, markPx: mark, midPx: mark, impactPxs: null, dayBaseVlm: "1" });
const meta = (names: string[], extra: Partial<Meta["universe"][number]> = {}): Meta => ({
  universe: names.map((name) => ({ name, szDecimals: 3, maxLeverage: 20, marginTableId: 20, ...extra })),
  marginTables: [],
  collateralToken: 0,
});
const info = {
  calls: [] as (string | undefined)[],
  async metaAndAssetCtxs(dex?: string): Promise<[Meta, PerpAssetCtx[]]> {
    this.calls.push(dex);
    if (!dex) return [meta(["BTC", "ETH"]), [ctx("100000"), ctx("4000")]];
    if (dex === "xyz") return [meta(["xyz:XYZ100", "xyz:NVDA"], { onlyIsolated: true }), [ctx("29000"), ctx("213.6")]];
    throw new Error(`no dex ${dex}`);
  },
  async perpDexs(): Promise<(PerpDex | null)[]> {
    return [null, { name: "xyz", fullName: "XYZ", deployer: "0x1" }, { name: "flx", fullName: "Felix", deployer: "0x2" }];
  },
};

test("perpUniverse: main markets keep their positions; HIP-3 markets follow with ids 100000 + dex × 10000 + position", async () => {
  const [m, c] = await perpUniverse(info, ["xyz", "gone"]); // "gone" isn't a dex any more: skipped
  expect(m.universe.map((u) => [u.name, u.asset ?? null, u.dex ?? null])).toEqual([
    ["BTC", null, null],
    ["ETH", null, null],
    ["xyz:XYZ100", DEX_ASSET_BASE + 10_000, "xyz"],
    ["xyz:NVDA", DEX_ASSET_BASE + 10_001, "xyz"],
  ]);
  expect(c.map((x) => x.markPx)).toEqual(["100000", "4000", "29000", "213.6"]);
  expect(perpAssetInfo(m, "ETH")).toEqual({ asset: 1, szDecimals: 3, isSpot: false });
  expect(perpAssetInfo(m, "xyz:NVDA")).toEqual({ asset: 110_001, szDecimals: 3, isSpot: false });
  expect(m.universe[3]!.onlyIsolated).toBe(true); // HIP-3 margin rules travel with the entry
  expect(() => perpAssetInfo(m, "xyz:UNKNOWN")).toThrow("Unknown perp xyz:UNKNOWN");
});

test("perpUniverse with no dexes is just the main universe, without a perpDexs call", async () => {
  info.calls = [];
  const [m] = await perpUniverse(info, []);
  expect(m.universe.map((u) => u.name)).toEqual(["BTC", "ETH"]);
  expect(info.calls).toEqual([undefined]);
});

test("listedDexes: xyz by default, HL_DEXES overrides, junk ignored; isDexCoin", () => {
  expect(listedDexes({})).toEqual(["xyz"]);
  expect(listedDexes({ HL_DEXES: "xyz, km" })).toEqual(["xyz", "km"]);
  expect(listedDexes({ HL_DEXES: "" })).toEqual([]);
  expect(listedDexes({ HL_DEXES: "xyz,../etc,A B" })).toEqual(["xyz"]);
  expect(isDexCoin("xyz:NVDA")).toBe(true);
  expect(isDexCoin("BTC")).toBe(false);
});
