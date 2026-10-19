// Read-only checks against the public testnet API. Run with HL_LIVE_TESTS=1.
// Always testnet, regardless of HL_NETWORK. Never touches /exchange.
import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { NETWORKS } from "../src/config.ts";
import { InfoClient } from "../src/info.ts";
import { perpAssetInfo, roundPrice, spotAssetInfo } from "../src/market.ts";
import { HlSocket } from "../src/ws.ts";

const live = process.env.HL_LIVE_TESTS === "1";
const net = NETWORKS.testnet;
const info = new InfoClient({ network: net });

function hasKeys(obj: unknown, keys: string[]) {
  expect(obj).toBeObject();
  for (const k of keys) expect(obj as object).toHaveProperty(k);
}

// Find an address that is trading right now, so user-level endpoints return data.
async function activeUser(): Promise<Hex> {
  const trades = await info.post<{ users: [Hex, Hex] }[]>({ type: "recentTrades", coin: "BTC" });
  expect(trades.length).toBeGreaterThan(0);
  return trades[trades.length - 1]!.users[0];
}

describe.skipIf(!live)("testnet info (live)", () => {
  test("meta / metaAndAssetCtxs", async () => {
    const meta = await info.meta();
    hasKeys(meta, ["universe", "marginTables", "collateralToken"]);
    hasKeys(meta.universe[0], ["name", "szDecimals", "maxLeverage", "marginTableId"]);
    const [m, ctxs] = await info.metaAndAssetCtxs();
    expect(ctxs.length).toBe(m.universe.length);
    hasKeys(ctxs[0], ["funding", "openInterest", "prevDayPx", "dayNtlVlm", "premium", "oraclePx", "markPx", "midPx", "impactPxs", "dayBaseVlm"]);
    const btc = perpAssetInfo(m, "BTC");
    expect(m.universe[btc.asset]!.name).toBe("BTC");
  });

  test("spotMetaAndAssetCtxs + spot asset ids", async () => {
    const [spot, ctxs] = await info.spotMetaAndAssetCtxs();
    hasKeys(spot.universe[0], ["name", "tokens", "index", "isCanonical"]);
    hasKeys(spot.tokens[0], ["name", "szDecimals", "weiDecimals", "index", "tokenId", "isCanonical", "evmContract", "fullName"]);
    hasKeys(ctxs[0], ["coin", "prevDayPx", "dayNtlVlm", "markPx", "midPx", "circulatingSupply", "totalSupply", "dayBaseVlm"]);
    const purr = spotAssetInfo(spot, "PURR/USDC");
    expect(purr.asset).toBeGreaterThanOrEqual(10000);
  });

  test("allMids / l2Book", async () => {
    const mids = await info.allMids();
    expect(typeof mids.BTC).toBe("string");
    const book = await info.l2Book("BTC");
    hasKeys(book, ["coin", "time", "levels"]);
    expect(book.levels.length).toBe(2);
    if (book.levels[0].length) hasKeys(book.levels[0][0], ["px", "sz", "n"]);
    // Book prices conform to our tick rounding (they are valid resting prices).
    const meta = await info.meta();
    const { szDecimals } = perpAssetInfo(meta, "BTC");
    for (const l of [...book.levels[0], ...book.levels[1]].slice(0, 10)) expect(roundPrice(Number(l.px), szDecimals)).toBe(Number(l.px));
  });

  test("user state endpoints", async () => {
    const user = await activeUser();
    const ch = await info.clearinghouseState(user);
    hasKeys(ch, ["marginSummary", "crossMarginSummary", "crossMaintenanceMarginUsed", "withdrawable", "assetPositions", "time"]);
    hasKeys(ch.marginSummary, ["accountValue", "totalNtlPos", "totalRawUsd", "totalMarginUsed"]);
    for (const p of ch.assetPositions) {
      hasKeys(p, ["type", "position"]);
      hasKeys(p.position, ["coin", "szi", "leverage", "entryPx", "positionValue", "unrealizedPnl", "returnOnEquity", "liquidationPx", "marginUsed", "maxLeverage", "cumFunding"]);
    }
    const spot = await info.spotClearinghouseState(user);
    expect(Array.isArray(spot.balances)).toBe(true);
    for (const b of spot.balances) hasKeys(b, ["coin", "token", "total", "hold", "entryNtl"]);
    const orders = await info.openOrders(user);
    for (const o of orders.slice(0, 5)) hasKeys(o, ["coin", "side", "limitPx", "sz", "oid", "timestamp", "origSz"]);
    const agents = await info.extraAgents(user);
    expect(Array.isArray(agents)).toBe(true);
    for (const a of agents) hasKeys(a, ["name", "address", "validUntil"]);
    expect(typeof (await info.maxBuilderFee(user, "0x0000000000000000000000000000000000000001"))).toBe("number");
  });

  test("fills and orderStatus by oid and cloid", async () => {
    const user = await activeUser();
    const fills = await info.userFills(user);
    expect(fills.length).toBeGreaterThan(0);
    hasKeys(fills[0], ["coin", "px", "sz", "side", "time", "startPosition", "dir", "closedPnl", "hash", "oid", "crossed", "fee", "tid", "feeToken"]);
    const byTime = await info.userFillsByTime(user, Date.now() - 86_400_000);
    expect(Array.isArray(byTime)).toBe(true);
    const st = await info.orderStatus(user, fills[0]!.oid);
    expect(st.status).toBe("order");
    if (st.status === "order") {
      hasKeys(st.order, ["order", "status", "statusTimestamp"]);
      hasKeys(st.order.order, ["coin", "side", "limitPx", "sz", "oid", "timestamp", "origSz", "orderType", "tif", "cloid", "reduceOnly"]);
    }
    expect((await info.orderStatus(user, "0xffffffffffffffffffffffffffff0001")).status).toBe("unknownOid");
  });

  test("candleSnapshot + candles() pagination over the 5000 cap", async () => {
    const now = Date.now();
    const one = await info.candleSnapshot("BTC", "1h", now - 3 * 3_600_000, now);
    hasKeys(one[0], ["t", "T", "s", "i", "o", "c", "h", "l", "v", "n"]);
    // 15m over 60 days ≈ 5760 candles, past the 5000 cap. Observed on testnet: the API only
    // keeps the most recent ~5000 candles per interval, so the helper should return exactly
    // what is available (and stop on the empty older page), ascending and de-duplicated.
    const start = now - 60 * 86_400_000;
    const all = await info.candles("BTC", "15m", start, now);
    const single = await info.candleSnapshot("BTC", "15m", start, now);
    expect(all.length).toBeGreaterThanOrEqual(5000);
    expect(all.length).toBeGreaterThanOrEqual(single.length);
    expect(all[0]!.t).toBeLessThanOrEqual(single[0]!.t);
    for (let i = 1; i < all.length; i++) expect(all[i]!.t).toBeGreaterThan(all[i - 1]!.t);
  }, 30_000);

  test("fundingHistory", async () => {
    const f = await info.fundingHistory("BTC", Date.now() - 6 * 3_600_000);
    expect(f.length).toBeGreaterThan(0);
    hasKeys(f[0], ["coin", "fundingRate", "premium", "time"]);
  });

  test("websocket: allMids, l2Book, activeAssetCtx", async () => {
    const sock = new HlSocket({ network: net });
    const seen = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${[...seen]}`)), 20_000);
      const mark = (k: string) => {
        seen.add(k);
        if (seen.size === 3) {
          clearTimeout(timer);
          resolve();
        }
      };
      sock.subscribe({ type: "allMids" }, (d) => (expect(typeof d.mids.BTC).toBe("string"), mark("allMids")));
      sock.subscribe({ type: "l2Book", coin: "BTC" }, (d) => (expect(d.coin).toBe("BTC"), mark("l2Book")));
      sock.subscribe({ type: "activeAssetCtx", coin: "BTC" }, (d) => (expect(d.coin).toBe("BTC"), mark("ctx")));
    });
    sock.close();
  }, 30_000);
});
