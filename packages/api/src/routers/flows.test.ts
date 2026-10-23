// Happy paths and their upstream failure modes, router by router, against the real migrations.
// Chain RPC, Hyperliquid, Relay and the core enclave are stubbed at fetch; nothing leaves the process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { thesisSealAbi } from "@proviso/chain";
import { activity, agentKeys, fires, orders, pushSubscriptions, reveals, routes, stampRequests, stamps, telegramCodes, telegramLinks, testRuns, theses, users, type Db } from "@proviso/db";
import { appendLeaf } from "@proviso/ops/stamps/store";
import { and, eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { addr, as, RPC_URL, sent, setEnv, stubFetch, testDb } from "../api.testkit";

const ME = addr(1);
const OTHER = addr(2);
const CALLER = addr(3);
const NOAGENT = addr(4);
const SEAL = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const H32 = ("0x" + "11".repeat(32)) as Hex;
const TX = ("0x" + "22".repeat(32)) as Hex;
const AGENT = addr(0xa9);
const BUILDER = addr(0xb1);

let db: Db;
let restoreFetch: () => void;
let restoreEnv: () => void;

// What the stubs answer; tests change these.
let receipt: { status: string; logs: unknown[] } | null = null;
let relay = { quote: { status: 200, body: {} as unknown }, status: { status: 200, body: {} as unknown } };
let hlAgents: { address: string }[] = [];
let hlMaxFee = 0;
const hlPosts: { type?: string; action?: { type: string } }[] = [];
let core: Response = new Response("down", { status: 503 });

const thesis = (id: bigint, owner: string, state: string, stampedAt = new Date()) => ({
  id, owner, state, mode: "live", encSpec: Buffer.alloc(80, 1), entryHash: H32, exitHash: H32,
  signedAt: stampedAt, stampedAt, sealTx: TX, expiresAt: new Date(Date.now() + 86_400_000),
});

const retiredLog = (id: bigint, address = SEAL) => ({
  address,
  topics: encodeEventTopics({ abi: thesisSealAbi, eventName: "Retired", args: { id } }),
  data: encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }], [1_900_000_000n, 1_900_086_400n]),
  blockHash: H32, blockNumber: "0x10", transactionHash: TX, transactionIndex: "0x0", logIndex: "0x0", removed: false,
});

beforeAll(async () => {
  restoreEnv = setEnv({
    CHAIN_NETWORK: "testnet", HL_NETWORK: "testnet", THESIS_SEAL_ADDRESS: SEAL, RHC_RPC_URL: RPC_URL, CORE_URL: undefined,
    TELEGRAM_BOT_USERNAME: undefined, NEXT_PUBLIC_VAPID_PUBLIC_KEY: "vapid", HL_PERPS_BUILDER: BUILDER, HL_SPOT_BUILDER: undefined,
    WRITER_MODEL: undefined, RELAY_API_KEY: undefined,
  });
  restoreFetch = stubFetch({
    rpc: (method) => {
      if (method === "eth_getTransactionReceipt")
        return receipt && {
          transactionHash: TX, transactionIndex: "0x0", blockHash: H32, blockNumber: "0x10", from: ME, to: SEAL, cumulativeGasUsed: "0x1",
          gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: "0x" + "00".repeat(256), type: "0x2", ...receipt,
        };
      if (method === "eth_call") return "0x" + "00".repeat(32); // pool depth reads: an empty pool
      throw new Error(`unexpected ${method}`);
    },
    hosts: {
      "api.relay.link": (url) => {
        const r = url.pathname.startsWith("/quote") ? relay.quote : relay.status;
        return Response.json(r.body, { status: r.status });
      },
      "api.hyperliquid-testnet.xyz": (url, body) => {
        hlPosts.push(body);
        if (url.pathname === "/exchange") return { status: "ok", response: { type: "default" } };
        if (body.type === "extraAgents") return hlAgents;
        if (body.type === "maxBuilderFee") return hlMaxFee;
        if (body.type === "referral") return { builderRewards: "12.5" };
        if (body.type === "perpDexs") return [null, { name: "xyz", fullName: "XYZ", deployer: "0x1" }];
        if (body.type === "metaAndAssetCtxs" && body.dex === "xyz")
          return [
            { universe: [{ name: "xyz:NVDA", maxLeverage: 20, onlyIsolated: true }, { name: "xyz:VIX", maxLeverage: 5, isDelisted: true }], marginTables: [], collateralToken: 0 },
            [{ dayNtlVlm: "900000", markPx: "213.6" }, { dayNtlVlm: "0", markPx: "1" }],
          ];
        if (body.type === "metaAndAssetCtxs")
          return [
            { universe: [{ name: "BTC", maxLeverage: 40 }, { name: "OLD", maxLeverage: 3, isDelisted: true }, { name: "HYPE", maxLeverage: 10 }], marginTables: [], collateralToken: 0 },
            [{ dayNtlVlm: "1000000", markPx: "60000" }, { dayNtlVlm: "1", markPx: "1" }, { dayNtlVlm: "500000", markPx: "30" }],
          ];
        throw new Error(`unexpected HL ${body.type}`);
      },
      "core.stub": () => core,
    },
  });
  db = await testDb();
  await db.insert(users).values([ME, OTHER, CALLER, NOAGENT].map((address) => ({ address })));
});
afterAll(() => {
  restoreFetch();
  restoreEnv();
});

const me = () => as(db, ME);

test("health answers without a session", async () => {
  expect(await as(db, null).health()).toEqual({ ok: true });
});

test("account: limits round-trip; unset limits read back as null", async () => {
  expect((await me().account.get()).limits).toBeNull();
  const limits = { maxAllocation: 500, maxLeverage: 3, dailyLoss: 50, maxSlippage: 0.5 };
  expect(await me().account.setLimits(limits)).toEqual(limits);
  expect(await me().account.get()).toMatchObject({ address: ME, limits, hlBuildersApprovedAt: null });
});

test("follow: a live idea can be followed once", async () => {
  await db.insert(theses).values(thesis(10n, CALLER, "live"));
  const input = { caller: CALLER, thesisId: "10", sizeRule: { kind: "ratio" as const, ratio: 1 }, limits: { maxUsd: 100, maxLev: 2 } };
  const { id } = await me().follow.create(input);
  await expect(me().follow.create(input)).rejects.toMatchObject({ code: "CONFLICT", message: "You already follow this idea." });
  expect(await me().follow.stop({ id })).toEqual({ stopped: true });
});

test("notify: push subscribe (re-subscribe moves the device), status, unsubscribe; telegram link and unlink", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  const keys = { p256dh: "k", auth: "a" };
  await as(db, OTHER).notify.subscribePush({ endpoint, keys });
  expect(await me().notify.subscribePush({ endpoint, keys })).toEqual({ subscribed: true });
  expect((await db.select().from(pushSubscriptions))[0]!.address).toBe(ME);
  expect(await me().notify.status()).toEqual({ telegram: false, pushDevices: 1, vapidPublicKey: "vapid" });
  await me().notify.unsubscribePush({ endpoint });
  expect(await db.select().from(pushSubscriptions)).toEqual([]);

  const restore = setEnv({ TELEGRAM_BOT_USERNAME: "provisobot" });
  try {
    const { url, expiresInMinutes } = await me().notify.telegramLink();
    expect(expiresInMinutes).toBe(15);
    const code = url.match(/^https:\/\/t\.me\/provisobot\?start=([\w-]{16})$/)![1]!;
    expect((await db.select().from(telegramCodes).where(eq(telegramCodes.code, code)))[0]!.address).toBe(ME);
  } finally {
    restore();
  }
  await db.insert(telegramLinks).values({ address: ME, chatId: 7n });
  expect((await me().notify.status()).telegram).toBe(true);
  await me().notify.unlinkTelegram();
  expect((await me().notify.status()).telegram).toBe(false);
});

test("records: an empty record, then ideas with reveals, fires, stamps, sizes and gaps; proofs", async () => {
  expect(await as(db, null).records.get({ caller: OTHER })).toMatchObject({ caller: OTHER, displayName: null, ideas: [], standing: { sealedCalls: 0, followable: false } });
  await expect(as(db, null).records.get({ caller: "bob" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await db.insert(theses).values([thesis(20n, OTHER, "fired", new Date(Date.now() - 1000)), thesis(21n, OTHER, "live")]);
  await db.insert(reveals).values([
    { thesisId: 20n, part: "entry", kind: "FIRED", dueAt: new Date(Date.now() - 1000) }, // overdue
    { thesisId: 20n, part: "exit", dueAt: new Date(), revealedAt: new Date(), tx: TX },
  ]);
  const [f] = await db.insert(fires).values({ thesisId: 20n, firedAt: new Date(), refMark: "100" }).returning();
  const order = { fireId: f!.id, thesisId: 20n, wave: 0, venue: "hl", coin: "BTC", side: "long", size: "1", filledSize: "2", avgPx: "50" };
  await db.insert(orders).values([{ ...order, account: OTHER, role: "caller" }, { ...order, account: ME, role: "follower", filledSize: "4" }]);
  for (let i = 0; i < 3; i++) await appendLeaf(db, { thesisId: 20n, kind: "FIRE", data: { i }, at: new Date() });
  await db.delete(stamps).where(and(eq(stamps.thesisId, 20n), eq(stamps.seq, 2))); // a gap at seq 2
  await appendLeaf(db, { thesisId: 20n, kind: "PNL", data: { pnlUsd: 7 }, at: new Date() });

  const { ideas } = await as(db, null).records.get({ caller: OTHER.toUpperCase().replace("0X", "0x") });
  expect(ideas.map((i) => i.id)).toEqual(["21", "20"]);
  const [live, fired] = ideas;
  expect(live).toMatchObject({ fires: [], entryReveal: null, exitReveal: null, stampCount: 0, sequenceGaps: [], callerToFollowerRatio: null });
  expect(fired).toMatchObject({ entryReveal: { kind: "FIRED", overdue: true }, exitReveal: { tx: TX }, stampCount: 3, sequenceGaps: [2], callerToFollowerRatio: 2, pnlUsd: 7 });
  expect(fired!.fires).toHaveLength(1);
  // Standing: 2 sealed calls, one scored at +7 on the caller's $100 filled; the leaderboard ranks the same.
  const { standing: st } = await as(db, null).records.get({ caller: OTHER });
  expect(st).toMatchObject({ sealedCalls: 2, scoredCalls: 1, followable: false, checks: { calls: false, days: false, drawdown: true } });
  expect(st.returnPct).toBeCloseTo(7, 9);
  // A paper call counts toward the ladder, but its big simulated win never enters a live score.
  await db.insert(theses).values({ ...thesis(22n, OTHER, "closed"), mode: "paper" });
  await appendLeaf(db, { thesisId: 22n, kind: "PNL", data: { pnlUsd: 999 }, at: new Date() });
  expect((await as(db, null).records.get({ caller: OTHER })).standing).toMatchObject({ sealedCalls: 3, scoredCalls: 1, basis: "live" });
  const board = await as(db, null).records.leaderboard();
  expect(board.ladder).toEqual({ minCalls: 20, minDays: 30, maxDrawdownPct: 25 });
  expect(board.callers.find((c) => c.caller === OTHER)?.standing.returnPct).toBeCloseTo(7, 9);

  const p = await as(db, null).records.proof({ thesisId: "20", seq: 3 });
  expect(p).toMatchObject({ thesisId: "20", seq: 3, kindName: "FIRE", tx: null });
  await expect(as(db, null).records.proof({ thesisId: "20", seq: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(as(db, null).records.proof({ thesisId: "20", seq: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("route: availability follows the network; quotes are stored, relayer failures are BAD_GATEWAY", async () => {
  expect(await as(db, null).route.availability()).toMatchObject({ available: false });
  const restore = setEnv({ CHAIN_NETWORK: "mainnet" });
  try {
    expect(await as(db, null).route.availability()).toEqual({ available: true });
    relay.quote = { status: 200, body: { requestId: "0xq1", steps: [], details: { currencyOut: { amount: "19", minimumAmount: "18" }, timeEstimate: 30 } } };
    expect(await me().route.quote({ direction: "fund", amountUsd: 20 })).toMatchObject({ requestId: "0xq1", amountOut: "19", minimumOut: "18", timeEstimateSec: 30 });
    expect((await db.select().from(routes))[0]).toMatchObject({ id: "0xq1", address: ME, kind: "fund", status: "quoted" });
    relay.quote = { status: 200, body: { steps: [] } };
    await expect(me().route.quote({ direction: "exit", amountUsd: 20 })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "The relayer returned no request id." });
    relay.quote = { status: 400, body: { message: "Amount too low" } };
    await expect(me().route.quote({ direction: "fund", amountUsd: 5 })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "Amount too low" });

    // status: only the owner's route; relayer states update it until it is final.
    await expect(as(db, OTHER).route.status({ requestId: "0xq1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    relay.status = { status: 200, body: { status: "pending", inTxHashes: ["0xin"] } };
    expect(await me().route.status({ requestId: "0xq1" })).toMatchObject({ status: "bridging", srcTx: "0xin", dstTx: null });
    relay.status = { status: 200, body: { status: "success", txHashes: ["0xout"] } };
    expect(await me().route.status({ requestId: "0xq1" })).toMatchObject({ status: "done", srcTx: "0xin", dstTx: "0xout" });
    relay.status = { status: 500, body: {} }; // final: the relayer isn't asked again
    expect(await me().route.status({ requestId: "0xq1" })).toMatchObject({ status: "done" });
    await db.insert(routes).values({ id: "0xq2", address: ME, kind: "exit", amountIn: "10", status: "submitted" });
    relay.status = { status: 200, body: { status: "refund", txHashes: ["0xback"] } };
    expect(await me().route.status({ requestId: "0xq2" })).toMatchObject({ status: "refunded", refundTx: "0xback" });
    expect((await me().route.mine()).map((r) => r.id).sort()).toEqual(["0xq1", "0xq2"]);
  } finally {
    restore();
  }
});

test("market: perps skip delisted coins and include the listed HIP-3 dex (xyz); the validation context carries markets, the user's limits and floors", async () => {
  const { perps } = await as(db, null).market.perps();
  expect(perps).toEqual([
    { coin: "BTC", maxLeverage: 40, volume24hUsd: 1_000_000, mark: 60000 },
    { coin: "HYPE", maxLeverage: 10, volume24hUsd: 500_000, mark: 30 },
    { coin: "xyz:NVDA", maxLeverage: 20, volume24hUsd: 900_000, mark: 213.6, dex: "xyz", onlyIsolated: true },
  ]);
  const ctx = await me().market.validationContext(); // ME set limits above
  expect(ctx.hl.BTC).toEqual({ maxLeverage: 40, volume24hUsd: 1_000_000 });
  expect(ctx.hl["xyz:NVDA"]).toEqual({ maxLeverage: 20, volume24hUsd: 900_000 });
  expect(ctx.hl["xyz:VIX"]).toBeUndefined(); // delisted
  expect(ctx.user).toEqual({ maxUsd: 500, maxLev: 3 });
  expect(ctx.floors).toEqual({ hlVolumeUsd: 1000, poolDepthUsd: 25 });
  expect(ctx.rhc!.USDG).toEqual({ isCanonical: true, poolDepthUsd: Infinity });
  expect(Object.values(ctx.rhc!).some((t) => t.poolDepthUsd === 0)).toBe(true); // stubbed pools are empty
  expect((await as(db, OTHER).market.validationContext()).user).toEqual({ maxUsd: 1_000_000, maxLev: 10 });
});

test("hl: prepareAgent returns the agent and builder approvals to sign; submitApprovals relays and records them", async () => {
  // The enclave's key: created_at ahead of the request, so the first poll finds it.
  await db.insert(agentKeys).values({ address: ME, version: 1, agentAddr: AGENT, name: "proviso", validUntil: new Date(1_900_000_000_000), sealedPriv: Buffer.alloc(1), createdAt: new Date(Date.now() + 60_000) });
  const prep = await me().hl.prepareAgent();
  expect(await sent(db, "agent")).toEqual([{ owner: ME }]);
  expect(prep.version).toBe(1);
  expect(prep.agent.action).toMatchObject({ type: "approveAgent", agentAddress: AGENT, agentName: "proviso valid_until 1900000000000" });
  expect(prep.builders).toHaveLength(1);
  expect(prep.builders[0]!.action).toMatchObject({ builder: BUILDER, maxFeeRate: "0.05%", nonce: prep.agent.action.nonce + 1 });

  const signature = { r: "0x1", s: "0x2", v: 27 };
  const input = { version: 1, agent: { action: prep.agent.action as never, signature }, builders: [{ action: prep.builders[0]!.action as never, signature }] };
  hlAgents = [];
  await expect(me().hl.submitApprovals(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  hlAgents = [{ address: AGENT.toUpperCase().replace("0X", "0x") }];
  expect(await me().hl.submitApprovals(input)).toEqual({ approved: true });
  expect(hlPosts.filter((p) => p.action).map((p) => p.action!.type)).toEqual(["approveAgent", "approveBuilderFee", "approveAgent", "approveBuilderFee"]);
  const { keys, network } = await me().hl.status();
  expect(network).toBe("testnet");
  expect(keys[0]).toMatchObject({ version: 1, agentAddr: AGENT });
  expect(keys[0]!.approvedAt).toBeInstanceOf(Date);
});

test("hl builder fees: status shows approval, prepare gives the typed data, submit relays it", async () => {
  hlMaxFee = 0;
  expect(await me().hl.builderStatus()).toMatchObject([{ kind: "perps", builder: BUILDER, maxFeeRate: "0.05%", approved: false }]);
  const prep = await me().hl.prepareBuilders();
  expect(prep).toHaveLength(1);
  expect(prep[0]!.action).toMatchObject({ type: "approveBuilderFee", builder: BUILDER, maxFeeRate: "0.05%" });
  const before = hlPosts.length;
  expect(await me().hl.submitBuilders({ builders: [{ action: prep[0]!.action as never, signature: { r: "0x1", s: "0x2", v: 27 } }] })).toEqual({ approved: true });
  expect(hlPosts.slice(before).map((p) => p.action?.type)).toEqual(["approveBuilderFee"]);
  hlMaxFee = 50; // 0.05% in tenths of a basis point
  expect((await me().hl.builderStatus())[0]!.approved).toBe(true);
});

test("records.builderProof: Hyperliquid's builder fees and the lowercase daily fills URLs, for anyone", async () => {
  const p = (await as(db, null).records.builderProof())!;
  expect(p.builder).toBe(BUILDER.toLowerCase());
  expect(p.feesUsd).toBe(12.5);
  expect(p.files).toHaveLength(7);
  expect(p.files[0]!.url.startsWith(`https://stats-data.hyperliquid.xyz/Testnet/builder_fills/${BUILDER.toLowerCase()}/`)).toBe(true);
  expect(p.files[0]!.url).toEndWith(`/${p.files[0]!.day.replaceAll("-", "")}.csv.lz4`);
});

test("hl.prepareAgent: TIMEOUT when the enclave never answers", async () => {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as typeof setTimeout; // skip the 10 s of polling
  try {
    await expect(as(db, NOAGENT).hl.prepareAgent()).rejects.toMatchObject({ code: "TIMEOUT" });
  } finally {
    globalThis.setTimeout = real;
  }
});

test("idea: seal target and enclave attestation (cached once fetched)", async () => {
  expect(await as(db, null).idea.sealTarget()).toEqual({ address: SEAL, chainId: 46630 });
  await expect(as(db, null).idea.attestation()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const restore = setEnv({ CORE_URL: "http://core.stub" });
  try {
    await expect(as(db, null).idea.attestation()).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    core = Response.json({ quote: "q" });
    expect(await as(db, null).idea.attestation()).toEqual({ quote: "q" } as never);
    core = new Response("down", { status: 503 });
    expect(await as(db, null).idea.attestation()).toEqual({ quote: "q" } as never);
  } finally {
    restore();
  }
  const restoreSeal = setEnv({ THESIS_SEAL_ADDRESS: undefined, CHAIN_NETWORK: "local" });
  try {
    await expect(as(db, null).idea.sealTarget()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  } finally {
    restoreSeal();
  }
});

test("idea.draft: an unconfigured writer is UNPROCESSABLE; a failing one is a generic error", async () => {
  await expect(me().idea.draft({ text: "long BTC" })).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT", message: expect.stringContaining("WRITER_MODEL") });
  const restore = setEnv({ WRITER_MODEL: "stub/model", AI_GATEWAY_API_KEY: "test-not-a-key" });
  try {
    // The gateway call hits the blocked fetch stub.
    await expect(me().idea.draft({ text: "long BTC" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "The rule writer is unavailable." });
  } finally {
    restore();
  }
});

test("idea: stamp status, stop, test runs and the owner's list", async () => {
  const [req] = await db.insert(stampRequests).values({ owner: ME, encSpec: Buffer.alloc(80), stamp: {}, ownerSig: "0x01", signedAt: new Date() }).returning();
  expect(await me().idea.stampStatus({ requestId: req!.id })).toEqual({ status: "pending", error: null, thesisId: null });
  await expect(as(db, OTHER).idea.stampStatus({ requestId: req!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

  await db.insert(theses).values(thesis(30n, ME, "fired"));
  expect(await me().idea.stop({ id: "30" })).toEqual({ requested: true });
  expect(await sent(db, "stop")).toEqual([{ thesisId: "30", owner: ME }]);

  const { requestId } = await me().idea.test({ encSpec: "AAAA", days: 30 });
  expect(await sent(db, "test")).toEqual([{ requestId, owner: ME, encSpec: "AAAA", days: 30, slippageBps: 10 }]);
  expect(await me().idea.testResult({ requestId })).toEqual({ status: "queued" });
  await db.insert(testRuns).values({ testId: "t1", requestId, owner: ME, snapshotIds: ["s"], testerVersion: "1", status: "done", result: { pnl: 1 } });
  expect(await me().idea.testResult({ requestId })).toEqual({ status: "done", testId: "t1", snapshotIds: ["s"], testerVersion: "1", result: { pnl: 1 } });
  expect(await as(db, OTHER).idea.testResult({ requestId })).toEqual({ status: "queued" }); // not OTHER's run

  expect((await me().idea.mine()).map((t) => t.id)).toEqual([30n]);
});

test("idea.retired: recorded only for a successful Retired event of this idea from ThesisSeal", async () => {
  await db.insert(theses).values(thesis(40n, ME, "live"));
  await db.insert(reveals).values({ thesisId: 40n, part: "entry", dueAt: new Date(2_000_000_000_000) });
  const bad = { code: "BAD_REQUEST", message: "That transaction didn't retire this idea." };
  for (const r of [null, { status: "0x0", logs: [retiredLog(40n)] }, { status: "0x1", logs: [retiredLog(41n)] }, { status: "0x1", logs: [retiredLog(40n, OTHER)] }]) {
    receipt = r;
    await expect(me().idea.retired({ id: "40", tx: TX })).rejects.toMatchObject(bad);
  }
  receipt = { status: "0x1", logs: [retiredLog(40n)] };
  expect(await me().idea.retired({ id: "40", tx: TX })).toEqual({ retiredAt: new Date(1_900_000_000_000) });
  expect((await db.select().from(theses).where(eq(theses.id, 40n)))[0]).toMatchObject({ state: "retired", retiredAt: new Date(1_900_000_000_000) });
  expect((await db.select().from(reveals).where(eq(reveals.thesisId, 40n)))[0]!.dueAt).toEqual(new Date(1_900_086_400_000));
  expect((await db.select().from(activity)).filter((a) => a.kind === "retired")).toEqual([expect.objectContaining({ address: ME, payload: { thesisId: "40", tx: TX } })]);
});
