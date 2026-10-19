import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { NETWORKS, network } from "../src/config.ts";
import { decodeCloid, encodeCloid, thesisIdOfCloid } from "../src/cloid.ts";
import {
  perpAssetIndex,
  perpAssetInfo,
  roundPrice,
  roundSize,
  spotAssetIndex,
  spotAssetInfo,
} from "../src/market.ts";
import { HlError, InfoClient, type Candle, type FetchLike, type Meta, type SpotMeta } from "../src/info.ts";
import { ExchangeClient, nextNonce } from "../src/exchange.ts";
import { actionHash, approveAgentAction, l1TypedData, signApproveAgent } from "../src/signing.ts";

// ---------------------------------------------------------------- config

describe("config", () => {
  const saved = process.env.HL_NETWORK;
  afterEach(() => {
    if (saved === undefined) delete process.env.HL_NETWORK;
    else process.env.HL_NETWORK = saved;
  });

  test("defaults to testnet", () => {
    delete process.env.HL_NETWORK;
    expect(network()).toBe(NETWORKS.testnet);
    expect(network().apiUrl).toBe("https://api.hyperliquid-testnet.xyz");
    expect(network().wsUrl).toBe("wss://api.hyperliquid-testnet.xyz/ws");
    expect(network().source).toBe("b");
    expect(network().hyperliquidChain).toBe("Testnet");
    expect(network().signatureChainId).toBe("0x66eee");
  });

  test("HL_NETWORK=mainnet switches, typos throw", () => {
    process.env.HL_NETWORK = "mainnet";
    expect(network()).toEqual({
      name: "mainnet",
      apiUrl: "https://api.hyperliquid.xyz",
      wsUrl: "wss://api.hyperliquid.xyz/ws",
      source: "a",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
    });
    process.env.HL_NETWORK = "mainet";
    expect(() => network()).toThrow();
  });

  test("clients default to testnet", () => {
    delete process.env.HL_NETWORK;
    expect(new InfoClient().network.name).toBe("testnet");
    expect(new ExchangeClient().network.name).toBe("testnet");
  });
});

// ---------------------------------------------------------------- cloid

describe("cloid", () => {
  test("layout", () => {
    const c = encodeCloid({ thesisId: 1n, fireSeq: 2, leg: 3, nonce: 4 });
    expect(c).toBe("0x00000000000000010000000203000004");
    expect(thesisIdOfCloid(c)).toBe(1n);
  });

  test("round trip (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 2 ** 24 - 1 }),
        (thesisId, fireSeq, leg, nonce) => {
          const c = encodeCloid({ thesisId, fireSeq, leg, nonce });
          expect(c).toMatch(/^0x[0-9a-f]{32}$/);
          expect(decodeCloid(c)).toEqual({ thesisId, fireSeq, leg, nonce });
          expect(thesisIdOfCloid(c)).toBe(thesisId);
        },
      ),
      { numRuns: 2000 },
    );
  });

  test("rejects out-of-range parts and malformed ids", () => {
    expect(() => encodeCloid({ thesisId: 2n ** 64n, fireSeq: 0, leg: 0, nonce: 0 })).toThrow();
    expect(() => encodeCloid({ thesisId: -1n, fireSeq: 0, leg: 0, nonce: 0 })).toThrow();
    expect(() => encodeCloid({ thesisId: 0n, fireSeq: 2 ** 32, leg: 0, nonce: 0 })).toThrow();
    expect(() => encodeCloid({ thesisId: 0n, fireSeq: 0, leg: 256, nonce: 0 })).toThrow();
    expect(() => encodeCloid({ thesisId: 0n, fireSeq: 0, leg: 0, nonce: 2 ** 24 })).toThrow();
    expect(() => encodeCloid({ thesisId: 0n, fireSeq: 1.5, leg: 0, nonce: 0 })).toThrow();
    expect(() => decodeCloid("0x1234")).toThrow();
  });
});

// ---------------------------------------------------------------- market

const meta: Meta = {
  universe: [
    { name: "SOL", szDecimals: 2, maxLeverage: 10, marginTableId: 10 },
    { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 54 },
  ],
  marginTables: [],
  collateralToken: 0,
};
const tok = (name: string, index: number, szDecimals: number) => ({
  name,
  index,
  szDecimals,
  weiDecimals: 8,
  tokenId: "0x00" as Hex,
  isCanonical: true,
  evmContract: null,
  fullName: null,
  deployerTradingFeeShare: "0.0",
});
const spotMeta: SpotMeta = {
  tokens: [tok("USDC", 0, 8), tok("PURR", 1, 0), tok("HYPE", 2, 2)],
  // Position and `index` deliberately differ, as they do on testnet.
  universe: [
    { name: "PURR/USDC", tokens: [1, 0], index: 0, isCanonical: true },
    { name: "@7", tokens: [2, 0], index: 7, isCanonical: false },
  ],
};

describe("market", () => {
  test("asset indices", () => {
    expect(perpAssetIndex(meta, "BTC")).toBe(1);
    expect(perpAssetInfo(meta, "SOL")).toEqual({ asset: 0, szDecimals: 2, isSpot: false });
    expect(spotAssetIndex(spotMeta, "PURR/USDC")).toBe(10000);
    expect(spotAssetIndex(spotMeta, "@7")).toBe(10007);
    expect(spotAssetIndex(spotMeta, "HYPE/USDC")).toBe(10007);
    expect(spotAssetInfo(spotMeta, "@7")).toEqual({ asset: 10007, szDecimals: 2, isSpot: true });
    expect(() => perpAssetIndex(meta, "NOPE")).toThrow();
    expect(() => spotAssetIndex(spotMeta, "NOPE/USDC")).toThrow();
  });

  test("price: 5 significant figures", () => {
    expect(roundPrice(1.234567, 0)).toBe(1.2346);
    expect(roundPrice(81234.56, 5)).toBe(81235);
    expect(roundPrice(2386.649, 4)).toBe(2386.6);
  });

  test("price: max decimals 6 - szDecimals (perp), 8 - szDecimals (spot)", () => {
    expect(roundPrice(0.000123456, 0)).toBe(0.000123);
    expect(roundPrice(0.000123456, 0, true)).toBe(0.00012346);
    expect(roundPrice(0.0123456, 5)).toBe(0.0);
    expect(roundPrice(0.0123456, 4)).toBe(0.01);
    expect(roundPrice(0.0123456, 2, true)).toBe(0.012346);
    expect(roundPrice(1.23456, 6)).toBe(1);
  });

  test("price: integers are always allowed", () => {
    expect(roundPrice(123456.7, 2)).toBe(123457);
    expect(roundPrice(100000, 5)).toBe(100000);
  });

  test("size: szDecimals", () => {
    expect(roundSize(0.123456, 4)).toBe(0.1235);
    expect(roundSize(12.6, 0)).toBe(13);
    expect(roundSize(0.00016, 5)).toBe(0.00016);
  });

  test("rounded prices always survive floatToWire (property)", async () => {
    const { floatToWire } = await import("../src/signing.ts");
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e7, noNaN: true }), fc.integer({ min: 0, max: 6 }), fc.boolean(), (px, d, spot) => {
        expect(() => floatToWire(roundPrice(px, d, spot))).not.toThrow();
      }),
    );
  });
});

// ---------------------------------------------------------------- info

function mockFetch(handler: (url: string, body: any) => { status?: number; body: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const r = handler(url, body);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text };
  };
  return { fetch, calls };
}

describe("InfoClient", () => {
  test("posts typed requests to testnet /info", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { status: "unknownOid" } }));
    const info = new InfoClient({ network: NETWORKS.testnet, fetch });
    await info.orderStatus("0x0000000000000000000000000000000000000001", "0x00000000000000000000000000000001");
    await info.userFillsByTime("0x0000000000000000000000000000000000000001", 5);
    expect(calls[0]).toEqual({
      url: "https://api.hyperliquid-testnet.xyz/info",
      body: { type: "orderStatus", user: "0x0000000000000000000000000000000000000001", oid: "0x00000000000000000000000000000001" },
    });
    expect(calls[1]!.body).toEqual({ type: "userFillsByTime", user: "0x0000000000000000000000000000000000000001", startTime: 5 });
  });

  test("HTTP errors surface as HlError with the body", async () => {
    const { fetch } = mockFetch(() => ({ status: 422, body: "Failed to deserialize the JSON body" }));
    const err = await new InfoClient({ fetch }).meta().catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("deserialize");
  });

  test("candles() pages backwards past the per-request cap", async () => {
    const step = 60_000;
    const cap = 5;
    // Fake API: candles every minute from 0, returns the most recent `cap` in range.
    const { fetch, calls } = mockFetch((_u, b) => {
      const { startTime, endTime } = b.req;
      const out: Candle[] = [];
      for (let t = Math.floor(endTime / step) * step; t >= Math.max(0, startTime) && out.length < cap; t -= step) {
        if (t < 0) break;
        out.unshift({ t, T: t + step - 1, s: "BTC", i: "1m", o: "1", c: "1", h: "1", l: "1", v: "0", n: 0 });
      }
      return { body: out };
    });
    const info = new InfoClient({ fetch });
    const got = await info.candles("BTC", "1m", 0, 12 * step);
    expect(got.map((c) => c.t / step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(calls.length).toBe(3);
    // Range start inside history stops once reached.
    expect((await info.candles("BTC", "1m", 3 * step, 9 * step)).map((c) => c.t / step)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------- exchange

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("ExchangeClient", () => {
  test("nonces are strictly increasing per signer", () => {
    const a = nextNonce("0xAA", 1000);
    const b = nextNonce("0xaa", 1000);
    const c = nextNonce("0xaa", 500);
    const other = nextNonce("0xbb", 1000);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
    expect(other).toBe(1000);
  });

  test("placeOrders posts a payload whose signature recovers to the signer", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: {
        status: "ok",
        response: {
          type: "order",
          data: {
            statuses: [
              { resting: { oid: 77 } },
              { filled: { totalSz: "0.02", avgPx: "1891.4", oid: 78 } },
              { error: "Order must have minimum value of $10." },
            ],
          },
        },
      },
    }));
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    const ex = new ExchangeClient({ account: agent, network: NETWORKS.testnet, fetch, vaultAddress: vault, expiresAfter: 9e12 });
    const order = { asset: 4, isBuy: true, limitPx: 1891.4, sz: 0.02, reduceOnly: false, orderType: { limit: { tif: "Gtc" as const } } };
    const statuses = await ex.placeOrders([order, order, order]);
    expect(statuses[0]).toEqual({ resting: { oid: 77 } });
    expect(statuses[2]).toEqual({ error: "Order must have minimum value of $10." });

    const { url, body } = calls[0]!;
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(Object.keys(body).sort()).toEqual(["action", "expiresAfter", "nonce", "signature", "vaultAddress"]);
    expect(body.action.orders[0]).toEqual({ a: 4, b: true, p: "1891.4", s: "0.02", r: false, t: { limit: { tif: "Gtc" } } });
    const hash = actionHash(body.action, vault, body.nonce, body.expiresAfter);
    const recovered = await recoverTypedDataAddress({
      ...l1TypedData(hash, NETWORKS.testnet),
      signature: { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) },
    });
    expect(recovered).toBe(agent.address);
  });

  test("status err and malformed responses throw HlError", async () => {
    const order = { asset: 0, isBuy: true, limitPx: 1, sz: 1, reduceOnly: false, orderType: { limit: { tif: "Ioc" as const } } };
    let { fetch } = mockFetch(() => ({ body: { status: "err", response: "User or API Wallet 0x1 does not exist." } }));
    let err = await new ExchangeClient({ account: agent, fetch }).placeOrders([order]).catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.message).toContain("does not exist");

    ({ fetch } = mockFetch(() => ({ body: { status: "ok", response: { type: "order", data: { statuses: [] } } } })));
    err = await new ExchangeClient({ account: agent, fetch }).placeOrders([order]).catch((e) => e);
    expect(err).toBeInstanceOf(HlError);

    await expect(new ExchangeClient({ fetch }).cancel([{ asset: 0, oid: 1 }])).rejects.toThrow(/account/);
  });

  test("cancel / cancelByCloid / updateLeverage payloads omit unset vault and expiry", async () => {
    const { fetch, calls } = mockFetch((_u, b) => ({
      body:
        b.action.type === "updateLeverage"
          ? { status: "ok", response: { type: "default" } }
          : { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } },
    }));
    const ex = new ExchangeClient({ account: agent, fetch });
    expect(await ex.cancel([{ asset: 1, oid: 2 }])).toEqual(["success"]);
    expect(await ex.cancelByCloid([{ asset: 1, cloid: "0x00000000000000000000000000000001" }])).toEqual(["success"]);
    await ex.updateLeverage(1, 3, false);
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["action", "nonce", "signature"]);
    expect(calls[1]!.body.action).toEqual({ type: "cancelByCloid", cancels: [{ asset: 1, cloid: "0x00000000000000000000000000000001" }] });
    expect(calls[2]!.body.action).toEqual({ type: "updateLeverage", asset: 1, isCross: false, leverage: 3 });
    expect(calls[2]!.body.nonce).toBeGreaterThan(calls[1]!.body.nonce);
  });

  test("approveAgent submits a pre-signed action and drops an empty agentName", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { status: "ok", response: { type: "default" } } }));
    const main = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
    const action = approveAgentAction({ agentAddress: agent.address, nonce: 1700000000000 }, NETWORKS.testnet);
    const sig = await signApproveAgent(main, action);
    await new ExchangeClient({ fetch }).approveAgent(action, sig);
    const { body } = calls[0]!;
    expect(body.nonce).toBe(1700000000000);
    expect(body.action).toEqual({
      type: "approveAgent",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      agentAddress: agent.address,
      nonce: 1700000000000,
    });
    expect(body.vaultAddress).toBeUndefined();
    expect(body.signature).toEqual(sig);
  });
});
