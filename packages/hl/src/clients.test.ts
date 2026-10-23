import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { NETWORKS } from "./config.ts";
import { ExchangeClient } from "./exchange.ts";
import { HlError, InfoClient, type FetchLike } from "./info.ts";
import {
  actionHash,
  approveAgentAction,
  approveAgentTypedData,
  approveBuilderFeeAction,
  approveBuilderFeeTypedData,
  l1TypedData,
  signApproveBuilderFee,
  splitSignature,
} from "./signing.ts";

// Stub transport: records each POST and answers with `reply` (string bodies go out as plain text).
function stub(reply: (body: any) => { status?: number; body: unknown } = () => ({ body: OK })) {
  const calls: { url: string; init: { method: string; headers: Record<string, string> }; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const r = reply(body);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, text: async () => text };
  };
  return { fetch, calls };
}

const OK = { status: "ok", response: { type: "default" } };
const USER: Hex = "0x0000000000000000000000000000000000000001";
const BUILDER: Hex = "0x00000000000000000000000000000000000000b0";
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const main = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");

async function l1Signer(body: any, vault: Hex | null, net = NETWORKS.testnet) {
  const hash = actionHash(body.action, vault, body.nonce, body.expiresAfter);
  return recoverTypedDataAddress({
    ...l1TypedData(hash, net),
    signature: { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) },
  });
}

describe("ExchangeClient L1 actions", () => {
  test("updateLeverage defaults to cross and signs with vault + expiry on mainnet", async () => {
    const { fetch, calls } = stub();
    const vault: Hex = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    const ex = new ExchangeClient({ account: agent, network: NETWORKS.mainnet, fetch, vaultAddress: vault, expiresAfter: 9e12 });
    await ex.updateLeverage(7, 5);
    const { url, init, body } = calls[0]!;
    expect(url).toBe("https://api.hyperliquid.xyz/exchange");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(body.action).toEqual({ type: "updateLeverage", asset: 7, isCross: true, leverage: 5 });
    expect(body.vaultAddress).toBe(vault);
    expect(body.expiresAfter).toBe(9e12);
    expect(await l1Signer(body, vault, NETWORKS.mainnet)).toBe(agent.address);
  });

  test("scheduleCancel sends the time, or clears it when omitted", async () => {
    const { fetch, calls } = stub();
    const ex = new ExchangeClient({ account: agent, network: NETWORKS.testnet, fetch });
    await ex.scheduleCancel(1_800_000_000_000);
    await ex.scheduleCancel();
    expect(calls[0]!.body.action).toEqual({ type: "scheduleCancel", time: 1_800_000_000_000 });
    expect(calls[1]!.body.action).toEqual({ type: "scheduleCancel" });
    expect(Object.keys(calls[1]!.body).sort()).toEqual(["action", "nonce", "signature"]);
    expect(await l1Signer(calls[1]!.body, null)).toBe(agent.address);
  });

  test("an exchange refusal of a void action throws HlError carrying the body", async () => {
    const refusal = { status: "err", response: "Cannot set leverage above max" };
    const { fetch } = stub(() => ({ body: refusal }));
    const err = await new ExchangeClient({ account: agent, fetch }).updateLeverage(0, 100).catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.message).toBe("Exchange error: Cannot set leverage above max");
    expect(err.status).toBeUndefined();
    expect(err.body).toEqual(refusal);
  });

  test("scheduleCancel without an account refuses before any request", async () => {
    const { fetch, calls } = stub();
    await expect(new ExchangeClient({ fetch }).scheduleCancel()).rejects.toThrow("ExchangeClient needs an account to sign L1 actions");
    expect(calls).toHaveLength(0);
  });

  test("malformed exchange replies throw HlError", async () => {
    for (const body of [null, "nonsense", { response: "no status" }]) {
      const { fetch } = stub(() => ({ body }));
      const err = await new ExchangeClient({ account: agent, fetch }).scheduleCancel().catch((e) => e);
      expect(err).toBeInstanceOf(HlError);
      expect(err.message).toBe("Malformed exchange response");
    }
  });

  test("a cancel answered with the wrong response type throws", async () => {
    const { fetch } = stub(() => ({ body: { status: "ok", response: { type: "order", data: { statuses: ["success"] } } } }));
    const err = await new ExchangeClient({ account: agent, fetch }).cancel([{ asset: 0, oid: 1 }]).catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.message).toBe("Unexpected cancel response");
  });

  test("HTTP failures from /exchange surface status and parsed body", async () => {
    const { fetch } = stub(() => ({ status: 429, body: { error: "rate limited" } }));
    const err = await new ExchangeClient({ account: agent, fetch }).scheduleCancel().catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.status).toBe(429);
    expect(err.message).toBe('HTTP 429: {"error":"rate limited"}');
    expect(err.body).toEqual({ error: "rate limited" });
  });
});

describe("ExchangeClient user-signed actions", () => {
  test("approveAgent keeps a named agent and splits a hex signature", async () => {
    const { fetch, calls } = stub();
    const action = approveAgentAction({ agentAddress: agent.address, agentName: "proviso", nonce: 1_700_000_000_001 }, NETWORKS.testnet);
    const typed = approveAgentTypedData(action);
    const hex = await main.signTypedData(typed as Parameters<typeof main.signTypedData>[0]);
    await new ExchangeClient({ fetch }).approveAgent(action, hex);
    const { body } = calls[0]!;
    expect(body.action).toEqual(action);
    expect(body.action.agentName).toBe("proviso");
    expect(body.nonce).toBe(1_700_000_000_001);
    expect(body.signature).toEqual(splitSignature(hex));
    const recovered = await recoverTypedDataAddress({
      ...typed,
      signature: { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) },
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(main.address);
  });

  test("approveBuilderFee posts the action with an object or hex signature", async () => {
    const { fetch, calls } = stub();
    const action = approveBuilderFeeAction({ builder: BUILDER, maxFeeRate: "0.05%", nonce: 1_700_000_000_002 }, NETWORKS.mainnet);
    const sig = await signApproveBuilderFee(main, action);
    const hex = await main.signTypedData(approveBuilderFeeTypedData(action) as Parameters<typeof main.signTypedData>[0]);
    const ex = new ExchangeClient({ fetch, network: NETWORKS.mainnet });
    await ex.approveBuilderFee(action, sig);
    await ex.approveBuilderFee(action, hex);
    expect(calls[0]!.url).toBe("https://api.hyperliquid.xyz/exchange");
    expect(calls[0]!.body).toEqual({ action, nonce: 1_700_000_000_002, signature: sig });
    expect(calls[1]!.body.signature).toEqual(sig);
    expect(action).toMatchObject({ type: "approveBuilderFee", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet" });
  });

  test("a refused approveBuilderFee throws HlError", async () => {
    const { fetch } = stub(() => ({ body: { status: "err", response: "Insufficient balance" } }));
    const action = approveBuilderFeeAction({ builder: BUILDER, maxFeeRate: "0.1%", nonce: 1 }, NETWORKS.testnet);
    const sig = await signApproveBuilderFee(main, action);
    await expect(new ExchangeClient({ fetch }).approveBuilderFee(action, sig)).rejects.toThrow("Exchange error: Insufficient balance");
  });
});

describe("InfoClient reads", () => {
  test("each read posts its request type to /info", async () => {
    const { fetch, calls } = stub(() => ({ body: [] }));
    const info = new InfoClient({ network: NETWORKS.testnet, fetch });
    await info.metaAndAssetCtxs();
    await info.spotMeta();
    await info.spotMetaAndAssetCtxs();
    await info.allMids();
    await info.l2Book("BTC");
    await info.l2Book("ETH", { nSigFigs: 5, mantissa: 2 });
    await info.clearinghouseState(USER);
    await info.spotClearinghouseState(USER);
    await info.openOrders(USER);
    await info.userFills(USER);
    await info.userFills(USER, true);
    await info.userFillsByTime(USER, 1, 2, false);
    await info.candleSnapshot("BTC", "1h", 10, 20);
    await info.fundingHistory("BTC", 100);
    await info.fundingHistory("BTC", 100, 200);
    await info.maxBuilderFee(USER, BUILDER);
    await info.extraAgents(USER);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(["https://api.hyperliquid-testnet.xyz/info"]));
    expect(calls.map((c) => c.body)).toEqual([
      { type: "metaAndAssetCtxs" },
      { type: "spotMeta" },
      { type: "spotMetaAndAssetCtxs" },
      { type: "allMids" },
      { type: "l2Book", coin: "BTC" },
      { type: "l2Book", coin: "ETH", nSigFigs: 5, mantissa: 2 },
      { type: "clearinghouseState", user: USER },
      { type: "spotClearinghouseState", user: USER },
      { type: "openOrders", user: USER },
      { type: "userFills", user: USER },
      { type: "userFills", user: USER, aggregateByTime: true },
      { type: "userFillsByTime", user: USER, startTime: 1, endTime: 2, aggregateByTime: false },
      { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: 10, endTime: 20 } },
      { type: "fundingHistory", coin: "BTC", startTime: 100 },
      { type: "fundingHistory", coin: "BTC", startTime: 100, endTime: 200 },
      { type: "maxBuilderFee", user: USER, builder: BUILDER },
      { type: "extraAgents", user: USER },
    ]);
  });

  test("replies are parsed JSON, and plain-text 2xx replies stay strings", async () => {
    let { fetch } = stub(() => ({ body: { BTC: "65000.5" } }));
    expect(await new InfoClient({ fetch }).allMids()).toEqual({ BTC: "65000.5" });
    ({ fetch } = stub(() => ({ body: 30 })));
    expect(await new InfoClient({ fetch }).maxBuilderFee(USER, BUILDER)).toBe(30);
    ({ fetch } = stub(() => ({ body: "null-ish text" })));
    expect(await new InfoClient({ fetch }).post<string>({ type: "weird" })).toBe("null-ish text");
  });

  test("non-2xx replies throw HlError with status and body (JSON and plain text)", async () => {
    let { fetch } = stub(() => ({ status: 500, body: { error: "internal" } }));
    let err = await new InfoClient({ fetch }).clearinghouseState(USER).catch((e) => e);
    expect(err).toBeInstanceOf(HlError);
    expect(err.name).toBe("HlError");
    expect(err.status).toBe(500);
    expect(err.message).toBe('HTTP 500: {"error":"internal"}');
    expect(err.body).toEqual({ error: "internal" });

    ({ fetch } = stub(() => ({ status: 404, body: "Not Found" })));
    err = await new InfoClient({ fetch }).openOrders(USER).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toBe("HTTP 404: Not Found");
    expect(err.body).toBe("Not Found");
  });

  test("a transport failure propagates unchanged", async () => {
    const boom = new TypeError("fetch failed");
    const fetch: FetchLike = async () => {
      throw boom;
    };
    await expect(new InfoClient({ fetch }).spotMeta()).rejects.toBe(boom);
  });
});
