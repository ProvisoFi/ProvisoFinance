import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { activity, agentKeys, follows, orders, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import type { Spec } from "@proviso/dsl";
import { decodeCloid, type ExtraAgent, type Meta, type OrderRequest, type OrderStatus } from "@proviso/hl";
import { asc, eq } from "drizzle-orm";
import { addressOf, AgentKeyManager } from "../signer/agentKey";
import type { Hex } from "../signer/policy";
import { confirmAgent, currentAgentKey, handleAgentRequest } from "./agents";
import { Executor, type ExchangeLike, type ExitEvent, type InfoLike } from "./executor";

// Nothing here may reach a real endpoint.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => { throw new Error("network access in executor tests"); }) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

const sealKey = new Uint8Array(32).fill(3);
const manager = new AgentKeyManager(sealKey);
const C = "0x00000000000000000000000000000000000000c1";
const F1 = "0x00000000000000000000000000000000000000f1";
const F2 = "0x00000000000000000000000000000000000000f2";
const F3 = "0x00000000000000000000000000000000000000f3";
const NOKEY = "0x00000000000000000000000000000000000000aa";
const META: Meta = {
  universe: [
    { name: "BTC", szDecimals: 3, maxLeverage: 40, marginTableId: 1 },
    { name: "ETH", szDecimals: 2, maxLeverage: 25, marginTableId: 1 },
  ],
  marginTables: [],
  collateralToken: 0,
};

/** In-memory Hyperliquid: IOC orders fill at their limit price, triggers rest. */
class FakeVenue {
  seq: { account: string; kind: "order" | "leverage" | "cancel"; req?: OrderRequest }[] = [];
  positions = new Map<string, Map<string, number>>();
  resting = new Set<string>();
  agents = new Map<string, ExtraAgent[]>(); // user → approved agents
  reject: (account: string, coin: string, req: OrderRequest) => string | null = () => null;
  private oid = 1;

  pos(account: string, coin: string) {
    return this.positions.get(account)?.get(coin) ?? 0;
  }
  private userOf(agent: string) {
    for (const [user, list] of this.agents) if (list.some((a) => a.address === agent)) return user;
    throw new Error(`agent ${agent} not approved`);
  }
  exchangeFor = (pk: Hex): ExchangeLike => {
    const account = this.userOf(addressOf(pk));
    return {
      network: { name: "testnet" },
      updateLeverage: async () => { this.seq.push({ account, kind: "leverage" }); },
      cancelByCloid: async (cs) => cs.map((c) => {
        this.seq.push({ account, kind: "cancel" });
        return this.resting.delete(c.cloid) ? "success" as const : { error: "Order was never placed" };
      }),
      placeOrders: async (reqs) => reqs.map((r) => this.place(account, r)),
    };
  };
  private place(account: string, r: OrderRequest): OrderStatus {
    this.seq.push({ account, kind: "order", req: r });
    const coin = META.universe[r.asset]!.name;
    const err = this.reject(account, coin, r);
    if (err) return { error: err };
    if ("trigger" in r.orderType) {
      this.resting.add(r.cloid!);
      return { resting: { oid: this.oid++, cloid: r.cloid } };
    }
    const cur = this.pos(account, coin);
    let sz = r.sz;
    if (r.reduceOnly) sz = Math.sign(cur) === (r.isBuy ? -1 : 1) ? Math.min(sz, Math.abs(cur)) : 0;
    if (sz <= 0) return { error: "Reduce only order would increase position" };
    if (!this.positions.has(account)) this.positions.set(account, new Map());
    this.positions.get(account)!.set(coin, cur + (r.isBuy ? sz : -sz));
    return { filled: { totalSz: String(sz), avgPx: String(r.limitPx), oid: this.oid++, cloid: r.cloid } };
  }
  info: InfoLike & { extraAgents(u: Hex): Promise<ExtraAgent[]> } = {
    meta: async () => META,
    l2Book: async (coin: string) => ({
      coin, time: 0,
      levels: [
        Array.from({ length: 10 }, (_, i) => ({ px: String(99 - i), sz: "1000", n: 1 })),
        Array.from({ length: 10 }, (_, i) => ({ px: String(101 + i), sz: "1000", n: 1 })),
      ],
    }),
    clearinghouseState: async (user: Hex) => ({
      assetPositions: [...(this.positions.get(user) ?? new Map<string, number>())].map(([coin, szi]) => ({
        type: "oneWay", position: { coin, szi: String(szi) },
      })),
    }) as unknown as Awaited<ReturnType<InfoLike["clearinghouseState"]>>,
    extraAgents: async (user: Hex) => this.agents.get(user) ?? [],
  };
}

const spec = (over: Partial<Spec> = {}): Spec => ({
  v: 1,
  entry: {
    when: { price: { coin: "BTC", op: ">", value: 1 } },
    then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 3, size: { usd: 1000 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" },
  limits: { maxUsd: 1000, maxLev: 3 },
  mode: "live",
  fire: "once",
  cooldown: "0m",
  expires: "7d",
  ...over,
});

async function onboard(db: Db, venue: FakeVenue, owner: string) {
  const req = await handleAgentRequest(db, manager, { owner });
  venue.agents.set(owner, [...(venue.agents.get(owner) ?? []), { name: req.agentName, address: req.agentAddress, validUntil: req.validUntil }]);
  expect(await confirmAgent(db, venue.info, owner, req.version)).toBe(true);
  return req;
}

async function setup(opts: { callerLimits?: object } = {}) {
  const db = await createTestDb();
  const venue = new FakeVenue();
  const limits = { maxUsd: 5000, maxLev: 10 };
  await db.insert(users).values([
    { address: C, limits: opts.callerLimits ?? limits },
    ...[F1, F2, F3, NOKEY].map((address) => ({ address, limits })),
  ]);
  const day = 86_400_000;
  const thesis = (id: bigint, owner: string) => ({
    id, owner, encSpec: new Uint8Array([1]), entryHash: "0x1", exitHash: "0x2", mode: "live",
    signedAt: new Date(), stampedAt: new Date(), sealTx: "0xtx", expiresAt: new Date(Date.now() + 7 * day), state: "live",
  });
  await db.insert(theses).values([thesis(7n, C), thesis(8n, NOKEY)]);
  const allow = [{ coin: "BTC", side: "long", maxUsd: 1000, maxLev: 5 }];
  await db.insert(follows).values([
    { follower: F1, caller: C, thesisId: null, sizeRule: { kind: "fixed", usd: 200 }, limits: { maxUsd: 500, maxLev: 3 }, sealedAllowlist: allow },
    { follower: F2, caller: C, thesisId: 7n, sizeRule: { kind: "ratio", ratio: 0.5 }, limits: { maxUsd: 500, maxLev: 3 }, sealedAllowlist: allow },
    { follower: F3, caller: C, thesisId: null, sizeRule: { kind: "fixed", usd: 200 }, limits: { maxUsd: 500, maxLev: 3 } },
  ]);
  for (const a of [C, F1, F2, F3]) await onboard(db, venue, a);
  const exits: ExitEvent[] = [];
  const ex = new Executor({ db, exchangeFor: venue.exchangeFor, info: venue.info, sealKey, onExit: (e) => exits.push(e) });
  return { db, venue, ex, exits };
}

const fire = (s: Spec, thesisId = 7n, owner = C) => ({
  fireId: crypto.randomUUID(), thesisId, owner, spec: s, mark: 100, at: new Date(), n: 1,
});
const rowsOf = (db: Db) => db.select().from(orders).orderBy(asc(orders.createdAt));
const kinds = async (db: Db, address = C) =>
  (await db.select().from(activity).where(eq(activity.address, address)).orderBy(asc(activity.id))).map((a) => a.kind);

describe("Executor.onFire", () => {
  test("alert mode places nothing", async () => {
    const { db, ex, venue } = await setup();
    await ex.onFire(fire(spec({ mode: "alert" })));
    expect(venue.seq).toEqual([]);
    expect(await rowsOf(db)).toEqual([]);
    expect(await kinds(db)).toContain("alert_fired");
  });

  test("an owner without an approved agent key gets needs_onboarding and no orders", async () => {
    const { db, ex, venue } = await setup();
    await ex.onFire(fire(spec(), 8n, NOKEY));
    expect(venue.seq).toEqual([]);
    expect(await kinds(db, NOKEY)).toEqual(["needs_onboarding"]);
  });

  test("followers fill in wave 1 before the caller's wave 2; rows, leverage and backstops recorded", async () => {
    const { db, ex, venue } = await setup();
    await ex.onFire(fire(spec()));

    const entries = venue.seq.filter((s) => s.kind === "order" && !("trigger" in s.req!.orderType));
    expect(entries.map((s) => s.account)).toEqual([F1, F2, C]);
    for (const acct of [F1, F2, C]) {
      const mine = venue.seq.filter((s) => s.account === acct);
      expect(mine[0]!.kind).toBe("leverage"); // leverage set before the entry order
    }
    expect(venue.pos(C, "BTC")).toBeCloseTo(9.9, 9); // floor(1000 / 101, 3 dp)
    expect(venue.pos(F1, "BTC")).toBeCloseTo(1.98, 9);
    expect(venue.pos(F2, "BTC")).toBeCloseTo(4.95, 9);
    expect(venue.pos(F3, "BTC")).toBe(0); // no allow-list on a sealed idea → confirm

    const rows = await rowsOf(db);
    const entry = rows.filter((r) => !r.reduceOnly);
    expect(entry.map((r) => [r.account, r.role, r.wave, r.status, r.side])).toEqual([
      [F1, "follower", 1, "filled", "buy"],
      [F2, "follower", 1, "filled", "buy"],
      [C, "caller", 2, "filled", "buy"],
    ]);
    expect(Number(entry[2]!.filledSize)).toBeCloseTo(9.9, 9);
    expect(Number(entry[2]!.avgPx)).toBe(101);
    for (const r of rows) expect(decodeCloid(r.cloid!)).toMatchObject({ thesisId: 7n, fireSeq: 1, leg: 0 });
    expect(new Set(rows.map((r) => r.cloid)).size).toBe(rows.length);

    const stops = rows.filter((r) => r.reduceOnly);
    expect(stops.map((r) => [r.account, r.status, r.side])).toEqual([
      [F1, "acked", "sell"], [F2, "acked", "sell"], [C, "acked", "sell"],
    ]);
    const trig = venue.seq.find((s) => s.req && "trigger" in s.req.orderType)!.req!;
    expect(trig.orderType).toEqual({ trigger: { triggerPx: 90, isMarket: true, tpsl: "sl" } }); // 100 − 2×5
    expect(await kinds(db, F3)).toContain("copy_confirm_required");
    expect(await kinds(db)).toContain("entered");
    expect(ex.openIdeas()).toEqual([7n]);
  });

  test("policy refusals are recorded as rejected orders with the reason, never sent", async () => {
    const { db, ex, venue } = await setup({ callerLimits: { maxUsd: 100, maxLev: 10 } });
    await ex.onFire(fire(spec()));
    const callerRows = (await rowsOf(db)).filter((r) => r.account === C);
    expect(callerRows.map((r) => [r.status, r.error])).toEqual([["rejected", "over_user_limit"]]);
    expect(venue.seq.some((s) => s.account === C && s.kind === "order")).toBe(false);
    expect(await kinds(db)).toContain("leg_failed");
  });

  test("users with no limits fail closed", async () => {
    const { db, ex } = await setup({ callerLimits: {} });
    await ex.onFire(fire(spec()));
    const callerRows = (await rowsOf(db)).filter((r) => r.account === C);
    expect(callerRows.map((r) => r.error)).toEqual(["missing_context"]);
  });

  test("a failed later leg unwinds the filled legs (onPartial unwind)", async () => {
    const { db, ex, venue } = await setup();
    venue.reject = (_a, coin, r) => (coin === "ETH" && !r.reduceOnly ? "Insufficient margin to place order" : null);
    ex.onMark("ETH", 50, new Date());
    const twoLeg = spec();
    twoLeg.entry.then.push({ venue: "hl", action: "open", coin: "ETH", side: "long", lev: 3, size: { usd: 500 } });
    await ex.onFire(fire(twoLeg));
    for (const a of [C, F1, F2]) expect(venue.pos(a, "BTC")).toBe(0);
    const closes = (await rowsOf(db)).filter((r) => r.reduceOnly && r.coin === "BTC");
    expect(closes.map((r) => [r.account, r.status])).toEqual([[F1, "filled"], [F2, "filled"], [C, "filled"]]);
    expect(await kinds(db)).toContain("unwinding");
    expect(ex.openIdeas()).toEqual([]);
  });

  test("onPartial keep leaves filled legs open", async () => {
    const { ex, venue } = await setup();
    venue.reject = (_a, coin) => (coin === "ETH" ? "Insufficient margin" : null);
    ex.onMark("ETH", 50, new Date());
    const twoLeg = spec();
    twoLeg.entry.legs = { atomic: false, onPartial: "keep" };
    twoLeg.entry.then.push({ venue: "hl", action: "open", coin: "ETH", side: "long", lev: 3, size: { usd: 500 } });
    await ex.onFire(fire(twoLeg));
    expect(venue.pos(C, "BTC")).toBeCloseTo(9.9, 9);
    expect(ex.openIdeas()).toEqual([7n]);
  });
});

describe("exits and stop", () => {
  const closeSeq = (venue: FakeVenue) =>
    venue.seq.filter((s) => s.kind === "order" && s.req!.reduceOnly && !("trigger" in s.req!.orderType)).map((s) => s.account);

  test("stop hit: followers close first, then the caller; backstops cancelled; onExit fired", async () => {
    const { db, ex, venue, exits } = await setup();
    await ex.onFire(fire(spec()));
    ex.onMark("BTC", 96, new Date()); // above the 95 stop
    await ex.idle();
    expect(exits).toEqual([]);
    ex.onMark("BTC", 94, new Date());
    await ex.idle();
    expect(closeSeq(venue)).toEqual([F1, F2, C]);
    for (const a of [C, F1, F2]) expect(venue.pos(a, "BTC")).toBe(0);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ thesisId: 7n, reason: "stop" });
    expect(exits[0]!.pnl!).toBeCloseTo((94 * 0.99 - 101) * 9.9, 6);
    const stops = (await rowsOf(db)).filter((r) => r.reduceOnly && r.px === "81");
    expect(stops.map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(venue.resting.size).toBe(0);
    expect(ex.openIdeas()).toEqual([]);
  });

  test("take hit closes with a profit", async () => {
    const { ex, venue, exits } = await setup();
    await ex.onFire(fire(spec()));
    ex.onMark("BTC", 111, new Date());
    await ex.idle();
    expect(closeSeq(venue)).toEqual([F1, F2, C]);
    expect(exits[0]).toMatchObject({ reason: "take" });
    expect(exits[0]!.pnl!).toBeCloseTo((111 * 0.99 - 101) * 9.9, 6);
  });

  test("short ideas exit when the mark rises through the stop", async () => {
    const { ex, venue, exits } = await setup();
    const short = spec();
    short.entry.then = [{ venue: "hl", action: "open", coin: "BTC", side: "short", lev: 3, size: { usd: 1000 } }];
    await ex.onFire(fire(short));
    expect(venue.pos(C, "BTC")).toBeLessThan(0);
    ex.onMark("BTC", 104, new Date());
    await ex.idle();
    expect(exits).toEqual([]);
    ex.onMark("BTC", 106, new Date());
    await ex.idle();
    expect(exits[0]).toMatchObject({ reason: "stop" });
    expect(venue.pos(C, "BTC")).toBe(0);
  });

  test("stop() closes caller and copies, cancels resting orders, and reports flat", async () => {
    const { db, ex, venue, exits } = await setup();
    await ex.onFire(fire(spec()));
    await ex.stop(7n, C);
    expect(closeSeq(venue)).toEqual([F1, F2, C]);
    for (const a of [C, F1, F2]) expect(venue.pos(a, "BTC")).toBe(0);
    expect(venue.resting.size).toBe(0);
    expect(exits[0]).toMatchObject({ reason: "stopped" });
    const [stopped] = (await db.select().from(activity).where(eq(activity.kind, "stopped")));
    expect(stopped!.payload).toMatchObject({ flat: true, remaining: [] });
  });

  test("stop() never claims flat while a close is unconfirmed", async () => {
    const { db, ex, venue, exits } = await setup();
    await ex.onFire(fire(spec()));
    venue.reject = (a, _c, r) => (a === C && r.reduceOnly && !("trigger" in r.orderType) ? "Order could not immediately match" : null);
    await ex.stop(7n, C);
    expect(venue.pos(C, "BTC")).toBeCloseTo(9.9, 9);
    expect(venue.pos(F1, "BTC")).toBe(0);
    expect(exits).toEqual([]);
    const [stopped] = (await db.select().from(activity).where(eq(activity.kind, "stopped")));
    expect(stopped!.payload).toMatchObject({ flat: false, remaining: [{ account: C, coin: "BTC" }] });
    expect(venue.resting.size).toBe(1); // the caller's backstop keeps guarding
    expect(ex.openIdeas()).toEqual([7n]);
  });

  test("stop() by someone other than the owner is refused", async () => {
    const { db, ex, venue } = await setup();
    await ex.onFire(fire(spec()));
    const before = venue.seq.length;
    await ex.stop(7n, F1);
    expect(venue.seq.length).toBe(before);
    expect(await kinds(db, F1)).toContain("stop_refused");
  });

  test("refuses to run outside testnet", async () => {
    const { db, venue } = await setup();
    const prev = process.env.HL_NETWORK;
    process.env.HL_NETWORK = "mainnet";
    try {
      expect(() => new Executor({ db, exchangeFor: venue.exchangeFor, info: venue.info, sealKey })).toThrow(/testnet/);
    } finally {
      if (prev === undefined) delete process.env.HL_NETWORK; else process.env.HL_NETWORK = prev;
    }
    const ex = new Executor({
      db, info: venue.info, sealKey,
      exchangeFor: (pk) => ({ ...venue.exchangeFor(pk), network: { name: "mainnet" } }),
    });
    await ex.onFire(fire(spec()));
    expect(venue.seq.filter((s) => s.kind === "order")).toEqual([]);
    expect((await rowsOf(db)).every((r) => r.status === "failed" && /testnet/.test(r.error!))).toBe(true);
  });
});

describe("agent request / confirm", () => {
  test("round trip: sealed key, typed data, builders, approval and revocation", async () => {
    const db = await createTestDb();
    const venue = new FakeVenue();
    await db.insert(users).values({ address: C, limits: {} });
    const env = { HL_PERPS_BUILDER: "0x00000000000000000000000000000000000000b1" };
    const req = await handleAgentRequest(db, manager, { owner: C.toUpperCase().replace("0X", "0x"), now: 1_700_000_000_000, env });
    expect(req.version).toBe(1);
    expect(req.agentName).toBe(`proviso-00000000-v1 valid_until ${req.validUntil}`);
    expect(req.approveAgent).toMatchObject({ type: "approveAgent", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", nonce: 1_700_000_000_000 });
    expect(req.approveAgentTypedData.message).toEqual({
      hyperliquidChain: "Testnet", agentAddress: req.agentAddress, agentName: req.agentName, nonce: 1_700_000_000_000,
    });
    expect(req.approveAgentTypedData.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(req.approveBuilderFee.map((b) => [b.kind, b.maxFeeRate, b.action.nonce])).toEqual([["perps", "0.05%", 1_700_000_000_001]]);
    expect(req.approveBuilderFee[0]!.typedData.message).toMatchObject({ builder: env.HL_PERPS_BUILDER, maxFeeRate: "0.05%" });
    expect((await handleAgentRequest(db, manager, { owner: C, env: {} })).approveBuilderFee).toEqual([]);

    const [row] = await db.select().from(agentKeys).where(eq(agentKeys.version, 1));
    expect(row!.approvedAt).toBeNull();
    expect(row!.agentAddr).toBe(req.agentAddress);
    expect(await currentAgentKey(db, C, new Date(1_700_000_000_000))).toBeNull(); // not approved yet

    expect(await confirmAgent(db, venue.info, C, 1)).toBe(false); // HL doesn't list it yet
    venue.agents.set(C, [{ name: "proviso-00000000-v1", address: req.agentAddress, validUntil: req.validUntil }]);
    expect(await confirmAgent(db, venue.info, C, 1)).toBe(true);
    const k1 = await currentAgentKey(db, C, new Date(1_700_000_000_000));
    expect(k1!.agent).toBe(req.agentAddress);
    expect(addressOf(manager.unseal(k1!))).toBe(req.agentAddress); // sealed bytes survive the db

    // v2 was requested above; approving it revokes v1
    const v2 = (await db.select().from(agentKeys).where(eq(agentKeys.version, 2)))[0]!;
    venue.agents.set(C, [{ name: "v2", address: v2.agentAddr as Hex, validUntil: v2.validUntil.getTime() }]);
    expect(await confirmAgent(db, venue.info, C, 2)).toBe(true);
    const [v1row] = await db.select().from(agentKeys).where(eq(agentKeys.version, 1));
    expect(v1row!.revokedAt).not.toBeNull();
    expect((await currentAgentKey(db, C, new Date()))!.version).toBe(2);
    await expect(handleAgentRequest(db, manager, { owner: C, version: 2 })).rejects.toThrow(/already used/);
    await expect(handleAgentRequest(db, manager, { owner: NOKEY })).rejects.toThrow(/unknown user/);
  });
});

test("a second fire for an idea that is still entering is refused", async () => {
  const { db, ex, venue } = await setup();
  const s = spec();
  await Promise.all([ex.onFire(fire(s)), ex.onFire(fire(s))]);
  expect(venue.seq.filter((x) => x.kind === "order" && x.account === C && !x.req!.reduceOnly)).toHaveLength(1);
  expect(await kinds(db)).toContain("fire_refused");
});
