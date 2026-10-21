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
  seq: { account: string; kind: "order" | "leverage" | "cancel"; req?: OrderRequest; builder?: unknown }[] = [];
  builderFees = new Map<string, number>();
  feeCalls = 0;
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
      placeOrders: async (reqs, opts) => reqs.map((r) => this.place(account, r, opts?.builder)),
    };
  };
  private place(account: string, r: OrderRequest, builder?: unknown): OrderStatus {
    this.seq.push({ account, kind: "order", req: r, builder });
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
    maxBuilderFee: async (user: Hex) => { this.feeCalls++; return this.builderFees.get(user) ?? 0; },
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

async function setup(opts: { callerLimits?: object; env?: Record<string, string> } = {}) {
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
  const make = () => new Executor({
    db, exchangeFor: venue.exchangeFor, info: venue.info, sealKey, env: opts.env ?? {}, onExit: (e) => exits.push(e),
  });
  return { db, venue, ex: make(), exits, restart: make };
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
    const trigs = venue.seq.filter((s) => s.req && "trigger" in s.req.orderType).map((s) => (s.req!.orderType as { trigger: { triggerPx: number } }).trigger);
    expect(trigs).toHaveLength(3);
    for (const t of trigs) expect(t).toMatchObject({ isMarket: true, tpsl: "sl", triggerPx: trigs[0]!.triggerPx }); // one level per leg
    expect(Number(trigs[0]!.triggerPx)).toBeGreaterThanOrEqual(100 - 2.6 * 5); // 100 − (1.8…2.6)×5
    expect(Number(trigs[0]!.triggerPx)).toBeLessThanOrEqual(100 - 1.8 * 5);
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
    const stops = (await rowsOf(db)).filter((r) => r.reduceOnly && Number(r.px) < 85); // backstops: ≤ (100 − 1.8×5)×0.9
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

describe("restart recovery", () => {
  const closesOf = (venue: FakeVenue) =>
    venue.seq.filter((x) => x.kind === "order" && x.req!.reduceOnly && !("trigger" in x.req!.orderType)).map((x) => x.account);

  test("restores a mid-position idea and exits it on a later stop hit", async () => {
    const { db, venue, ex, restart, exits } = await setup();
    const s = spec();
    await ex.onFire(fire(s));
    const ex2 = restart();
    expect(ex2.openIdeas()).toEqual([]);
    expect(await ex2.restore((id) => (id === 7n ? s : undefined))).toEqual({ restored: [7n], skipped: [] });
    expect(ex2.openIdeas()).toEqual([7n]);
    ex2.onMark("BTC", 96, new Date());
    await ex2.idle();
    expect(exits).toEqual([]);
    ex2.onMark("BTC", 94, new Date());
    await ex2.idle();
    expect(closesOf(venue)).toEqual([F1, F2, C]);
    for (const a of [C, F1, F2]) expect(venue.pos(a, "BTC")).toBe(0);
    expect(exits[0]).toMatchObject({ thesisId: 7n, reason: "stop" });
    expect(exits[0]!.pnl!).toBeCloseTo((94 * 0.99 - 101) * 9.9, 6);
    expect(venue.resting.size).toBe(0); // restored backstops were cancelled
    expect(await kinds(db)).toContain("restored");
  });

  test("cloids stay unique after restore, and new nonces start above the stored ones", async () => {
    const { db, ex, restart } = await setup();
    const s = spec();
    await ex.onFire(fire(s));
    const before = await rowsOf(db);
    const maxBefore = Math.max(...before.map((r) => decodeCloid(r.cloid!).nonce));
    const ex2 = restart();
    await ex2.restore(() => s);
    await ex2.stop(7n, C);
    const after = await rowsOf(db);
    const fresh = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(fresh.length).toBe(3);
    expect(new Set(after.map((r) => r.cloid)).size).toBe(after.length);
    expect(Math.min(...fresh.map((r) => decodeCloid(r.cloid!).nonce))).toBeGreaterThan(maxBefore);
    expect(ex2.openIdeas()).toEqual([]);
  });

  test("a new fire reusing a stored fireSeq does not collide", async () => {
    const { db, ex } = await setup();
    await ex.onFire(fire(spec()));
    await ex.stop(7n, C);
    await ex.onFire(fire(spec())); // n = 1 again
    const rows = await rowsOf(db);
    expect(new Set(rows.map((r) => r.cloid)).size).toBe(rows.length);
    expect(ex.openIdeas()).toEqual([7n]);
  });

  test("positions the venue closed while down are marked flat with closed_by_venue", async () => {
    const { db, venue, ex, restart } = await setup();
    const s = spec();
    await ex.onFire(fire(s));
    venue.positions.get(F1)!.set("BTC", 0); // F1 backstop triggered while the executor was down
    const ex2 = restart();
    expect((await ex2.restore(() => s)).restored).toEqual([7n]);
    expect(await kinds(db, F1)).toContain("closed_by_venue");
    await ex2.stop(7n, C);
    expect(closesOf(venue)).toEqual([F2, C]);
    for (const a of [C, F2]) expect(venue.pos(a, "BTC")).toBe(0);
  });

  test("everything closed on the venue restores nothing", async () => {
    const { db, venue, ex, restart } = await setup();
    const s = spec();
    await ex.onFire(fire(s));
    for (const a of [C, F1, F2]) venue.positions.get(a)!.set("BTC", 0);
    const ex2 = restart();
    expect((await ex2.restore(() => s)).restored).toEqual([]);
    expect(await kinds(db)).toContain("restored_flat");
    expect(venue.resting.size).toBe(0);
  });

  test("ideas without a spec are logged and skipped, never guessed", async () => {
    const { db, ex, restart } = await setup();
    await ex.onFire(fire(spec()));
    const ex2 = restart();
    expect(await ex2.restore(() => undefined)).toEqual({ restored: [], skipped: [{ thesisId: 7n, reason: "spec_unavailable" }] });
    expect(ex2.openIdeas()).toEqual([]);
    expect(await kinds(db)).toContain("restore_skipped");
  });

  test("ideas closed before the restart are not restored", async () => {
    const { ex, restart } = await setup();
    const s = spec();
    await ex.onFire(fire(s));
    await ex.stop(7n, C);
    expect(await restart().restore(() => s)).toEqual({ restored: [], skipped: [] });
  });
});

describe("builder fees", () => {
  const B = "0x00000000000000000000000000000000000000b1";

  test("attached only for accounts that approved the fee; others warned once", async () => {
    const { db, venue, ex } = await setup({ env: { HL_PERPS_BUILDER: B } });
    venue.builderFees.set(F1, 50);
    venue.builderFees.set(F2, 10); // approved, but below our fee
    await ex.onFire(fire(spec()));
    await ex.stop(7n, C);
    const sent = venue.seq.filter((x) => x.kind === "order");
    for (const o of sent) expect(o.builder).toEqual(o.account === F1 ? { b: B, f: 50 } : undefined);
    expect(sent.filter((o) => o.account === F1)).toHaveLength(3); // entry, backstop, close
    for (const a of [F2, C]) expect((await kinds(db, a)).filter((k) => k === "builder_not_approved")).toHaveLength(1);
    expect(await kinds(db, F1)).not.toContain("builder_not_approved");
    expect(venue.feeCalls).toBe(3); // one lookup per account within the minute
    expect((await rowsOf(db)).every((r) => r.status !== "rejected")).toBe(true); // the signer saw the same orders
  });

  test("no builder configured: no builder and no lookups", async () => {
    const { venue, ex } = await setup();
    venue.builderFees.set(F1, 50);
    await ex.onFire(fire(spec()));
    expect(venue.seq.filter((x) => x.kind === "order").every((o) => o.builder === undefined)).toBe(true);
    expect(venue.feeCalls).toBe(0);
  });
});

describe("one-tap confirms", () => {
  const followOf = async (db: Db, follower: string) =>
    (await db.select().from(follows).where(eq(follows.follower, follower)))[0]!.id;
  const entriesOf = (venue: FakeVenue, account: string) =>
    venue.seq.filter((x) => x.kind === "order" && x.account === account && !x.req!.reduceOnly);
  const refusals = async (db: Db, address: string) =>
    (await db.select().from(activity).where(eq(activity.address, address)))
      .filter((a) => a.kind === "copy_confirm_refused").map((a) => (a.payload as { reason: string }).reason);

  test("a confirm within the window places one late follower order, backstopped and exited", async () => {
    const { db, venue, ex } = await setup();
    const f = fire(spec());
    await ex.onFire(f);
    expect(await kinds(db, F3)).toContain("copy_confirm_required");
    expect(venue.pos(F3, "BTC")).toBe(0);
    const followId = await followOf(db, F3);
    expect(await ex.confirmCopy({ followId, fireId: f.fireId, address: F3.toUpperCase().replace("0X", "0x"), at: new Date() })).toBe("placed");
    expect(venue.pos(F3, "BTC")).toBeCloseTo(1.98, 9); // floor(200 / 101, 3 dp)
    const rows = await rowsOf(db);
    expect(rows.filter((r) => r.account === F3).map((r) => [r.role, r.wave, r.reduceOnly, r.status])).toEqual([
      ["follower", 1, false, "filled"],
      ["follower", 1, true, "acked"], // its own backstop
    ]);
    expect(new Set(rows.map((r) => r.cloid)).size).toBe(rows.length);
    expect(await kinds(db, F3)).toContain("copy_confirmed");
    ex.onMark("BTC", 94, new Date());
    await ex.idle();
    const closes = venue.seq.filter((x) => x.kind === "order" && x.req!.reduceOnly && !("trigger" in x.req!.orderType)).map((x) => x.account);
    expect(closes).toEqual([F1, F2, F3, C]);
    expect(venue.pos(F3, "BTC")).toBe(0);
    expect(venue.resting.size).toBe(0);
  });

  test("pressing twice places one order, also across a restart", async () => {
    const { db, venue, ex, restart } = await setup();
    const s = spec();
    const f = fire(s);
    await ex.onFire(f);
    const press = (e: Executor) => e.confirmCopy({ followId: "", fireId: f.fireId, address: F3, at: Date.now() });
    const followId = await followOf(db, F3);
    const tap = (e: Executor) => e.confirmCopy({ followId, fireId: f.fireId, address: F3, at: Date.now() });
    expect((await Promise.all([tap(ex), tap(ex)])).sort()).toEqual(["duplicate", "placed"]);
    expect(await tap(ex)).toBe("duplicate");
    const ex2 = restart();
    await ex2.restore(() => s);
    expect(await tap(ex2)).toBe("duplicate");
    expect(entriesOf(venue, F3)).toHaveLength(1);
    expect(await press(ex)).toBe("refused"); // malformed follow id
  });

  test("a late press expires; a longer window from env accepts it", async () => {
    const late = async (env?: Record<string, string>) => {
      const { db, venue, ex } = await setup({ env });
      const f = { ...fire(spec()), at: new Date(Date.now() - 121_000) };
      await ex.onFire(f);
      const r = await ex.confirmCopy({ followId: await followOf(db, F3), fireId: f.fireId, address: F3 });
      return { r, db, venue };
    };
    const a = await late();
    expect(a.r).toBe("expired");
    expect(await kinds(a.db, F3)).toContain("copy_confirm_expired");
    expect(entriesOf(a.venue, F3)).toEqual([]);
    expect((await late({ COPY_CONFIRM_WINDOW_SEC: "300" })).r).toBe("placed");
  });

  test("a confirm from another address is refused", async () => {
    const { db, venue, ex } = await setup();
    const f = fire(spec());
    await ex.onFire(f);
    expect(await ex.confirmCopy({ followId: await followOf(db, F3), fireId: f.fireId, address: F1 })).toBe("refused");
    expect(await refusals(db, F1)).toEqual(["not_follower"]);
    expect(entriesOf(venue, F3)).toEqual([]);
    expect(entriesOf(venue, F1)).toHaveLength(1); // only its own auto copy
  });

  test("a closed caller position refuses the copy", async () => {
    const { db, venue, ex } = await setup();
    const f = fire(spec());
    await ex.onFire(f);
    await ex.stop(7n, C);
    expect(await ex.confirmCopy({ followId: await followOf(db, F3), fireId: f.fireId, address: F3 })).toBe("refused");
    expect(await refusals(db, F3)).toEqual(["caller_position_closed"]);
    expect(entriesOf(venue, F3)).toEqual([]);
  });

  test("pollConfirms reads the confirm queue and deletes handled messages", async () => {
    const { db, venue, ex } = await setup();
    const f = fire(spec());
    await ex.onFire(f);
    const followId = await followOf(db, F3);
    const msg = { followId, fireId: f.fireId, address: F3, at: new Date().toISOString() };
    const box = [{ msgId: 1n, readCt: 1, message: msg }, { msgId: 2n, readCt: 1, message: msg }];
    const deleted: bigint[] = [];
    const queue = {
      read: async <T,>(q: string) => { expect(q).toBe("confirm"); return box.splice(0) as unknown as { msgId: bigint; readCt: number; message: T }[]; },
      delete: async (_q: string, id: bigint) => { deleted.push(id); },
    };
    expect(await ex.pollConfirms(queue)).toBe(2);
    expect(deleted).toEqual([1n, 2n]);
    expect(entriesOf(venue, F3)).toHaveLength(1);
    expect(await ex.pollConfirms(queue)).toBe(0);
  });
});

describe("ideas with Robinhood Chain swaps", () => {
  const swap = { venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "TSLA", size: { usd: 10 }, maxSlipPct: 1 } as const;
  async function withSwaps() {
    const s = await setup();
    const calls: string[] = [];
    const swaps = {
      run: async (f: { actions: readonly unknown[] }) => void calls.push(`run:${f.actions.length}`),
      close: async (_id: bigint, reason: string) => void calls.push(`close:${reason}`),
      stop: async () => (calls.push("stop"), true),
      holds: () => false,
      confirm: async () => "refused" as const,
    };
    const exits: ExitEvent[] = [];
    const ex = new Executor({ db: s.db, exchangeFor: s.venue.exchangeFor, info: s.venue.info, sealKey, env: {}, swaps, onExit: (e) => exits.push(e) });
    return { ...s, ex, calls, exits };
  }

  test("mixed idea: swaps run first, the HL leg sizes its exit from its own mark, and its exit sells the swap legs", async () => {
    const { ex, venue, calls, exits } = await withSwaps();
    const mixed = spec({ entry: { ...spec().entry, then: [swap, spec().entry.then[0]!] }, limits: { maxUsd: 2000, maxLev: 3 } });
    ex.onMark("BTC", 100, new Date());
    await ex.onFire({ ...fire(mixed), mark: 380 }); // the trigger mark is the swap's TSLA price
    expect(calls).toEqual(["run:1"]);
    expect(venue.pos(C, "BTC")).toBeGreaterThan(0);
    ex.onMark("BTC", 96, new Date()); // above a -5% stop from BTC 100 (it would be far below one from 380)
    await ex.idle();
    expect(exits).toEqual([]);
    ex.onMark("BTC", 94, new Date());
    await ex.idle();
    expect(calls).toEqual(["run:1", "close:stop"]);
    expect(exits).toMatchObject([{ thesisId: 7n, reason: "stop" }]);
  });

  test("swap-only idea: no Hyperliquid orders; a stop request goes to the swap runner", async () => {
    const { ex, venue, calls } = await withSwaps();
    await ex.onFire(fire(spec({ entry: { ...spec().entry, then: [swap] } })));
    expect(venue.seq.filter((s) => s.kind === "order")).toEqual([]);
    await ex.stop(7n, C);
    expect(calls).toEqual(["run:1", "stop"]);
  });

  test("without a swap runner, ideas with swaps are refused", async () => {
    const { db, ex } = await setup();
    await ex.onFire(fire(spec({ entry: { ...spec().entry, then: [swap] } })));
    expect(await kinds(db)).toContain("fire_refused");
  });
});
