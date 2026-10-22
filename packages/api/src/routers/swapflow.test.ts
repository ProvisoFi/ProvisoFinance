// swapKey prepare → register (relayed) → revoke against the real migrations and a stubbed Robinhood
// Chain RPC, plus the status states and the swap-wallet hand-over between accounts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { KERNEL_V33_IMPLEMENTATION, legacySwapKeyPolicies, swapWalletProofMessage } from "@proviso/chain";
import { swapKeys, users, type Db } from "@proviso/db";
import { eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { addr, as, RPC_URL, sent, setEnv, stubFetch, testDb } from "../api.testkit";

const wallet = privateKeyToAccount(generatePrivateKey()); // sign-in wallet = swap wallet
const OWNER = wallet.address.toLowerCase();
const owner2 = privateKeyToAccount(generatePrivateKey());
const OWNER2 = owner2.address.toLowerCase();
const shared = privateKeyToAccount(generatePrivateKey()); // a swap wallet two accounts try to use
const SHARED = shared.address.toLowerCase();
const STALE = addr(0x5e);
const SESSION = addr(0xd3);
const DAY = 86_400_000;

let db: Db;
let restoreFetch: () => void;
let restoreEnv: () => void;
let moduleInstalled = false; // what isModuleInstalled answers

beforeAll(async () => {
  restoreEnv = setEnv({ CHAIN_NETWORK: "testnet", RHC_RPC_URL: RPC_URL, SWAP_ADAPTER_ADDRESS: addr(0xd1), SWAP_KEY_POLICY_ADDRESS: addr(0xd2) });
  restoreFetch = stubFetch({
    rpc: (method) => {
      if (method === "eth_getCode") return "0x"; // a plain EOA: delegation + install needed
      if (method === "eth_getTransactionCount") return "0x3";
      if (method === "eth_call") return "0x" + "00".repeat(31) + (moduleInstalled ? "01" : "00");
      throw new Error(`unexpected ${method}`);
    },
  });
  db = await testDb();
  await db.insert(users).values([OWNER, OWNER2, STALE].map((address) => ({ address })));
});
afterAll(() => {
  restoreFetch();
  restoreEnv();
});

const me = () => as(db, OWNER).swapKey;
const clearLimits = () => db.execute(sql`delete from public.rate_limits`);
const row = async (address = OWNER) => (await db.select().from(swapKeys).where(eq(swapKeys.address, address)))[0];
const enclaveMadeKey = (address: string, account: string) =>
  db.insert(swapKeys).values({ address, account, keyAddr: SESSION, sealed: {}, expiresAt: new Date(Date.now() + 29 * DAY) });

test("prepare asks the enclave once, then builds the setup; register checks every signature and queues it", async () => {
  expect(await me().status()).toEqual({ state: "none", legacy: false });
  expect(await me().prepare()).toEqual({ pending: true });
  expect(await me().prepare()).toEqual({ pending: true }); // polling doesn't queue a second key
  expect(await sent(db, "agent")).toEqual([{ owner: OWNER, kind: "swap", account: OWNER }]);

  await enclaveMadeKey(OWNER, OWNER);
  expect(await me().status()).toMatchObject({ state: "unsigned", sessionKey: SESSION });
  const prep = await me().prepare();
  if (prep.pending) throw new Error("expected a setup");
  const { setup, typedData } = prep;
  expect(setup.install?.authorization).toEqual({ address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 3 });
  expect((await row())!.setup).not.toBeNull();

  const authorization = await wallet.signAuthorization({ address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 3 });
  const auth = { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity! };
  const good = {
    authorization: auth,
    userOp: await wallet.signMessage({ message: { raw: setup.install!.userOpHash } }),
    adapter: (await Promise.all(typedData.adapter.map((t) => wallet.signTypedData(t as never)))) as Hex[],
    policy: await wallet.signTypedData(typedData.policy as never),
  };
  const stranger = privateKeyToAccount(generatePrivateKey());
  const strangerAuth = await stranger.signAuthorization({ address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 3 });
  for (const [what, bad] of [
    ["adapter policy", { adapter: good.adapter.slice(1) }],
    ["adapter policy", { adapter: [good.policy, ...good.adapter.slice(1)] }],
    ["swap-key policy", { policy: good.adapter[0]! }],
    ["account setup", { userOp: undefined }],
    ["account setup", { userOp: good.policy }],
    ["delegation", { authorization: undefined }],
    ["delegation", { authorization: { ...auth, nonce: 4 } }],
    ["delegation", { authorization: { ...auth, chainId: 4663 } }],
    ["delegation", { authorization: { ...auth, address: addr(0xee) } }],
    ["delegation", { authorization: { ...auth, r: strangerAuth.r, s: strangerAuth.s, yParity: strangerAuth.yParity! } }],
  ] as const) {
    await clearLimits();
    await expect(me().register({ ...good, ...bad } as never)).rejects.toMatchObject({ code: "BAD_REQUEST", message: `The ${what} signature isn't from your swap wallet.` });
  }
  expect(await sent(db, "swap_setup")).toEqual([]);

  await clearLimits();
  expect(await me().register(good)).toEqual({ queued: true });
  expect(await sent(db, "swap_setup")).toEqual([{ address: OWNER }]);
  expect(((await row())!.setup as { signatures: unknown }).signatures).toEqual({ ...good });
  expect(await me().status()).toMatchObject({ state: "relaying" });
  await db.update(swapKeys).set({ setup: { ...((await row())!.setup as object), failed: "relayer_budget" } }).where(eq(swapKeys.address, OWNER));
  expect(await me().status()).toMatchObject({ state: "failed", reason: "relayer_budget" });
});

test("a ready setup isn't re-keyed; revoke signs one op per module and stops the key", async () => {
  await db.update(swapKeys).set({ registeredAt: new Date() }).where(eq(swapKeys.address, OWNER));
  expect(await me().status()).toMatchObject({ state: "ready", account: OWNER, sessionKey: SESSION, legacy: false });
  await expect(me().prepare()).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(me().prepareRevoke({ legacyOnly: true })).rejects.toThrow("no older swap permission"); // testnet has none

  const { ops, legacyOnly } = await me().prepareRevoke();
  expect(legacyOnly).toBe(false);
  expect(ops.map((o) => o.module)).toEqual([addr(0xd2) as Hex]);
  const other = privateKeyToAccount(generatePrivateKey());
  await expect(me().revoke({ signatures: [await other.signMessage({ message: { raw: ops[0]!.userOpHash } })] })).rejects.toThrow("isn't from your swap wallet");
  await expect(me().revoke({ signatures: ["0x00", "0x00"] })).rejects.toThrow("Sign every step");
  const sig = await wallet.signMessage({ message: { raw: ops[0]!.userOpHash } });
  // A tampered stored op (hash no longer matches its userOp) is refused too.
  const stored = (await row())!.setup as { revoke: { ops: { userOp: { nonce: string } }[] } };
  const tampered = structuredClone(stored);
  tampered.revoke.ops[0]!.userOp.nonce = "99";
  await db.update(swapKeys).set({ setup: tampered }).where(eq(swapKeys.address, OWNER));
  await expect(me().revoke({ signatures: [sig] })).rejects.toThrow("isn't from your swap wallet");
  await db.update(swapKeys).set({ setup: stored }).where(eq(swapKeys.address, OWNER));

  await clearLimits();
  expect(await me().revoke({ signatures: [sig] })).toEqual({ revoked: true });
  expect((await row())!.revokedAt).toBeInstanceOf(Date);
  expect((await sent(db, "swap_setup")).at(-1)).toEqual({ address: OWNER, revoke: true });
  expect(await me().status()).toEqual({ state: "none", legacy: false });
});

test("a swap wallet proven by its signature replaces another account's stale attempt, but not a live setup", async () => {
  const proof = await shared.signMessage({ message: swapWalletProofMessage(SHARED, OWNER2) });
  await enclaveMadeKey(STALE, SHARED); // an earlier, never-registered attempt from another account
  expect(await as(db, OWNER2).swapKey.prepare({ account: SHARED, proof })).toEqual({ pending: true });
  expect(await row(STALE)).toBeUndefined();
  expect((await sent(db, "agent")).at(-1)).toEqual({ owner: OWNER2, kind: "swap", account: SHARED });

  await enclaveMadeKey(STALE, SHARED);
  await db.update(swapKeys).set({ registeredAt: new Date() }).where(eq(swapKeys.address, STALE));
  await expect(as(db, OWNER2).swapKey.prepare({ account: SHARED, proof })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("another Proviso account") });
  expect((await row(STALE))!.registeredAt).not.toBeNull();
});

test("mainnet: a retired SwapKeyPolicy still installed is reported and can be removed alone", async () => {
  const restore = setEnv({ CHAIN_NETWORK: "mainnet", SWAP_ADAPTER_ADDRESS: undefined, SWAP_KEY_POLICY_ADDRESS: undefined });
  try {
    const legacy = legacySwapKeyPolicies();
    expect(legacy.length).toBeGreaterThan(0);
    // OWNER's key was revoked above; the old module is still on the wallet.
    moduleInstalled = true;
    expect(await me().status()).toEqual({ state: "none", legacy: true });
    await clearLimits();
    const { ops, legacyOnly } = await me().prepareRevoke({ legacyOnly: true });
    expect(legacyOnly).toBe(true);
    expect(ops.map((o) => o.module)).toEqual(legacy);
    expect(await me().revoke({ signatures: [await wallet.signMessage({ message: { raw: ops[0]!.userOpHash } })] })).toEqual({ revoked: true });
    moduleInstalled = false;
    expect(await me().status()).toEqual({ state: "none", legacy: false });
    await expect(me().prepareRevoke({ legacyOnly: true })).rejects.toThrow("no older swap permission");
  } finally {
    moduleInstalled = false;
    restore();
  }
});
