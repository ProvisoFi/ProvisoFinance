// Refusal matrix for every state-changing procedure: signed-out callers, someone else's rows, and
// malformed or out-of-range input. Real migrations (PGlite); every network call is blocked.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { agentKeys, follows, pushSubscriptions, swapKeys, telegramLinks, theses, users, type Db } from "@proviso/db";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { addr, as, sent, setEnv, stubFetch, testDb } from "../api.testkit";
import { appRouter } from "../index";

const ME = addr(1);
const OTHER = addr(2);
const CALLER = addr(3);
const H32 = "0x" + "11".repeat(32);
const UUID = "0b8b8e8e-1111-4c1c-9c1c-000000000001";
let db: Db;
let restoreFetch: () => void;
let restoreEnv: () => void;

const thesis = (id: bigint, owner: string, state: string) => ({
  id, owner, state, mode: "live", encSpec: Buffer.alloc(80, 1), entryHash: H32, exitHash: H32,
  signedAt: new Date(), stampedAt: new Date(), sealTx: H32, expiresAt: new Date(Date.now() + 86_400_000),
});

beforeAll(async () => {
  restoreFetch = stubFetch({}); // nothing here may touch the network
  restoreEnv = setEnv({ CHAIN_NETWORK: "testnet", TELEGRAM_BOT_USERNAME: undefined, WRITER_MODEL: undefined });
  db = await testDb();
  await db.insert(users).values([ME, OTHER, CALLER].map((address) => ({ address })));
  await db.insert(theses).values([thesis(1n, OTHER, "live"), thesis(2n, ME, "retired"), thesis(3n, CALLER, "expired"), thesis(4n, CALLER, "live")]);
});
afterAll(() => {
  restoreFetch();
  restoreEnv();
});

const me = () => as(db, ME);

test("every mutation refuses a signed-out caller before reading its input", async () => {
  const procs = (appRouter._def as unknown as { procedures: Record<string, { _def: { type: string } }> }).procedures;
  const mutations = Object.keys(procs).filter((p) => procs[p]!._def.type === "mutation");
  // A new mutation fails here until it is added to this matrix (and given its own refusal test below).
  expect(mutations.sort()).toEqual([
    "account.setLimits", "follow.create", "follow.stop", "hl.prepareAgent", "hl.submitApprovals",
    "idea.confirmSelfSeal", "idea.draft", "idea.retired", "idea.stamp", "idea.stop", "idea.test",
    "notify.subscribePush", "notify.telegramLink", "notify.unlinkTelegram", "notify.unsubscribePush", "route.quote",
    "swapKey.prepare", "swapKey.prepareRevoke", "swapKey.register", "swapKey.revoke",
  ]);
  const anon = as(db, null) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
  for (const path of mutations) {
    const [r, p] = path.split(".") as [string, string];
    await expect(anon[r]![p]!({}), path).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
  expect(await sent(db, "agent")).toEqual([]);
});

test("account.setLimits: out-of-range limits are rejected and nothing is stored", async () => {
  const ok = { maxAllocation: 100, maxLeverage: 2, dailyLoss: 10, maxSlippage: 1 };
  for (const bad of [{ maxAllocation: -1 }, { maxAllocation: 2_000_000 }, { maxLeverage: 0 }, { maxLeverage: 1.5 }, { dailyLoss: 0 }, { maxSlippage: 3 }])
    await expect(me().account.setLimits({ ...ok, ...bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await db.select().from(users).where(eq(users.address, ME)))[0]!.limits).toEqual({});
});

test("follow.create: malformed input, someone else's idea and a non-live idea are rejected", async () => {
  const base = { caller: CALLER, sizeRule: { kind: "fixed" as const, usd: 10 }, limits: { maxUsd: 100, maxLev: 2 } };
  for (const bad of [
    { caller: "0x123" },
    { thesisId: "1e3" },
    { sizeRule: { kind: "ratio" as const, ratio: 11 } },
    { sizeRule: { kind: "fixed" as const, usd: 0 } },
    { limits: { maxUsd: 100, maxLev: 11 } },
    { sealedAllowlist: { coins: [], sides: ["long" as const], maxUsd: 1, maxLev: 1 } },
  ])
    await expect(me().follow.create({ ...base, ...bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Idea 1 is OTHER's, not CALLER's; idea 3 is CALLER's but expired.
  await expect(me().follow.create({ ...base, thesisId: "1" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "That idea isn't on this caller's record." });
  await expect(me().follow.create({ ...base, thesisId: "999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(me().follow.create({ ...base, thesisId: "3" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Only live ideas can be followed." });
  expect(await db.select().from(follows)).toEqual([]);
});

test("follow.stop: someone else's follow is NOT_FOUND and stays active; a malformed id is rejected", async () => {
  const [f] = await db.insert(follows).values({ follower: OTHER, caller: CALLER, sizeRule: {}, limits: {} }).returning();
  await expect(me().follow.stop({ id: f!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(me().follow.stop({ id: "not-a-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await db.select().from(follows).where(eq(follows.id, f!.id)))[0]!.active).toBe(true);
  await db.delete(follows);
});

test("hl.prepareAgent: over the hourly budget nothing is asked of the enclave", async () => {
  for (let i = 0; i < 10; i++) await db.execute(sql`select public.rate_limit_hit(${`agentKey:${ME}`}, 10, 3600)`);
  await expect(me().hl.prepareAgent()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  expect(await sent(db, "agent")).toEqual([]);
});

test("hl.submitApprovals: another user's key, a different agent, bad versions and too many builders are rejected", async () => {
  const agent = addr(0xa9);
  await db.insert(agentKeys).values({ address: OTHER, version: 1, agentAddr: agent, name: "p", validUntil: new Date(), sealedPriv: Buffer.alloc(1) });
  await db.insert(agentKeys).values({ address: ME, version: 2, agentAddr: addr(0xaa), name: "p", validUntil: new Date(), sealedPriv: Buffer.alloc(1) });
  const signature = { r: "0x1", s: "0x2", v: 27 };
  const call = (version: number, agentAddress: string, builders: unknown[] = []) =>
    me().hl.submitApprovals({ version, agent: { action: { agentAddress }, signature }, builders: builders as never });
  await expect(call(1, agent)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That approval isn't for your current agent key." }); // OTHER's key
  await expect(call(2, agent)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That approval isn't for your current agent key." }); // not my agent
  await expect(call(0, agent)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(1.5, agent)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(2, addr(0xaa), [1, 2, 3].map(() => ({ action: {}, signature })))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await db.select().from(agentKeys)).every((k) => k.approvedAt === null)).toBe(true);
});

test("idea.draft: too short or too long ideas never reach the writer", async () => {
  await expect(me().idea.draft({ text: "hi" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().idea.draft({ text: "x".repeat(2001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("idea.confirmSelfSeal: malformed ids and tx hashes are rejected", async () => {
  await expect(me().idea.confirmSelfSeal({ requestId: "nope", txHash: H32 as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().idea.confirmSelfSeal({ requestId: UUID, txHash: "0x1234" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().idea.confirmSelfSeal({ requestId: UUID, txHash: H32 as never })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("idea.stop: someone else's idea is NOT_FOUND, a finished one is refused, and nothing is queued", async () => {
  await expect(me().idea.stop({ id: "1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(me().idea.stop({ id: "999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(me().idea.stop({ id: "2" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This idea is already retired." });
  await expect(me().idea.stop({ id: "-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await sent(db, "stop")).toEqual([]);
});

test("idea.test: out-of-range days, slippage or an oversized spec are rejected", async () => {
  for (const bad of [{ days: 0 }, { days: 91 }, { slippageBps: -1 }, { slippageBps: 201 }, { encSpec: "A".repeat(90_000) }])
    await expect(me().idea.test({ encSpec: "AAAA", ...bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await sent(db, "test")).toEqual([]);
});

test("idea.retired: someone else's idea is NOT_FOUND before any chain read; a malformed tx is rejected", async () => {
  await expect(me().idea.retired({ id: "1", tx: H32 as never })).rejects.toMatchObject({ code: "NOT_FOUND" }); // fetch is blocked: no RPC was needed
  await expect(me().idea.retired({ id: "2", tx: "0xzz" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await db.select().from(theses).where(eq(theses.id, 1n)))[0]!.state).toBe("live");
});

test("notify.subscribePush: non-URLs, unknown push services and oversized keys are rejected", async () => {
  const keys = { p256dh: "k", auth: "a" };
  await expect(me().notify.subscribePush({ endpoint: "not a url", keys })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().notify.subscribePush({ endpoint: "http://fcm.googleapis.com/x", keys })).rejects.toThrow("supported Web Push");
  await expect(me().notify.subscribePush({ endpoint: "https://fcm.googleapis.com:444/x", keys })).rejects.toThrow("supported Web Push");
  await expect(me().notify.subscribePush({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "k".repeat(201), auth: "a" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await db.select().from(pushSubscriptions)).toEqual([]);
});

test("notify.unsubscribePush and unlinkTelegram never touch someone else's rows", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/other";
  await db.insert(pushSubscriptions).values({ endpoint, address: OTHER, keys: {} });
  await db.insert(telegramLinks).values({ address: OTHER, chatId: 42n });
  expect(await me().notify.unsubscribePush({ endpoint })).toEqual({ unsubscribed: true });
  expect(await me().notify.unlinkTelegram()).toEqual({ unlinked: true });
  expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
  expect(await db.select().from(telegramLinks)).toHaveLength(1);
  await expect(me().notify.unsubscribePush({ endpoint: "x".repeat(1001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("notify.telegramLink: refused while the bot isn't configured", async () => {
  await expect(me().notify.telegramLink()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

test("route.quote: unknown direction and out-of-range amounts are rejected before the relayer", async () => {
  await expect(me().route.quote({ direction: "steal" as never, amountUsd: 20 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().route.quote({ direction: "fund", amountUsd: 4.99 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().route.quote({ direction: "exit", amountUsd: 1_000_001 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("swapKey.prepare: a swap wallet that doesn't prove it's yours, a bad address, or a local chain is refused", async () => {
  const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const stranger = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
  const account = wallet.address.toLowerCase();
  await expect(me().swapKey.prepare({ account })).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Signed by someone else, or by the wallet but for another account.
  const { swapWalletProofMessage } = await import("@proviso/chain");
  await expect(me().swapKey.prepare({ account, proof: await stranger.signMessage({ message: swapWalletProofMessage(account, ME) }) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(me().swapKey.prepare({ account, proof: await wallet.signMessage({ message: swapWalletProofMessage(account, OTHER) }) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(me().swapKey.prepare({ account: "0xnope" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const restore = setEnv({ CHAIN_NETWORK: "local" });
  try {
    await expect(me().swapKey.prepare()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  } finally {
    restore();
  }
  expect(await sent(db, "agent")).toEqual([]);
});

test("swapKey.register / prepareRevoke / revoke: someone else's setup is never used", async () => {
  await db.insert(swapKeys).values({ address: OTHER, account: OTHER, keyAddr: addr(0xd3), sealed: {}, setup: { revoke: { ops: [{}] } }, registeredAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
  await expect(me().swapKey.register({ adapter: [], policy: "0x00" })).rejects.toThrow("Start the swap setup again");
  await expect(me().swapKey.prepareRevoke()).rejects.toThrow("no active swap key");
  await expect(me().swapKey.revoke({ signatures: ["0x00"] })).rejects.toThrow("Start the revoke again");
  await expect(me().swapKey.revoke({ signatures: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().swapKey.revoke({ signatures: Array(9).fill("0x00") })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(me().swapKey.register({ adapter: Array(9).fill("0x00"), policy: "0x00" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // My own unregistered key isn't revocable either.
  await db.insert(swapKeys).values({ address: ME, account: ME, keyAddr: addr(0xd4), sealed: {}, expiresAt: new Date(Date.now() + 86_400_000) });
  await expect(me().swapKey.prepareRevoke()).rejects.toThrow("no active swap key");
  const [o] = await db.select().from(swapKeys).where(eq(swapKeys.address, OTHER));
  expect(o!.revokedAt).toBeNull();
  expect(await sent(db, "swap_setup")).toEqual([]);
});
