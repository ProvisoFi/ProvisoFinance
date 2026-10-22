// The relayer's day pools for user-triggered work (PGlite, fake chain): they persist across restarts,
// reset at UTC midnight, refuse below the reserve, cap each address's share, and stay separate, so
// swap-setup abuse never blocks seals. Revokes are exits and are never refused.
import { expect, test } from "bun:test";
import { kernelDelegationCode, revokePolicyUserOp, swapKeyPolicyFromJson, swapKeyPolicyHash, toJsonSafe } from "@proviso/chain";
import { activity, stampRequests, swapKeys, users } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import { parseEther, type Address } from "viem";
import { FinalRelayError, relayStamp, type Relay } from "../stamper";
import { fundedAge, relayerBudget, sponsorRule } from "./budget";
import type { Clients } from "./chain";
import { swapSetupHandler } from "./swaps";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const OWNER = addr(0xa1);
const OTHER = addr(0xa4);
const ACCOUNT = addr(0xa2);
const KEY = addr(0xa3);
const RELAYER = addr(0xf1);
const USDG = addr(0xf2);
const DAY = 86_400_000;
const policyFor = (account: string) => ({ account, sessionKey: account.toLowerCase() === ACCOUNT ? KEY : addr(Number(account) + 0x1000), adapter: account, tokens: [], maxPerTx: [], maxPerDay: [], poolIds: [], expiresAt: "9999999999", nonce: "1" });
type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** A chain where the policy is already set and nothing reverts; records every ETH transfer. */
function fakeChain(o: { relayerWei: bigint; keyWei?: bigint; usdg?: bigint }) {
  const sent: bigint[] = [];
  const s = { installed: true, handleOps: 0 };
  const c = {
    account: { address: RELAYER },
    public: {
      getBalance: async ({ address }: { address: string }) => (address === RELAYER ? o.relayerWei : (o.keyWei ?? 0n)),
      getCode: async () => kernelDelegationCode,
      readContract: async ({ functionName, args }: { functionName: string; args: string[] }) =>
        functionName === "activePolicy" ? swapKeyPolicyHash(swapKeyPolicyFromJson(policyFor(args[0]!))) : functionName === "balanceOf" ? (o.usdg ?? 10n ** 6n) : s.installed,
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 21_000n, effectiveGasPrice: 10n ** 9n }),
    },
    wallet: {
      sendTransaction: async ({ value }: { value: bigint }) => (sent.push(value), "0x01"),
      writeContract: async () => ((s.installed = false), s.handleOps++, "0x02"), // only the revoke's handleOps is expected
    },
  } as unknown as Clients;
  return { c, sent, s };
}

async function addSetup(db: TestDb, owner: string, account: string, row: Partial<typeof swapKeys.$inferInsert> = {}) {
  await db.insert(users).values({ address: owner }).onConflictDoNothing();
  const policy = policyFor(account);
  const values = { account, keyAddr: policy.sessionKey, sealed: {}, setup: { adapterPolicies: [], policy, signatures: { adapter: [], policy: "0x01" } }, expiresAt: new Date(Date.now() + DAY), registeredAt: null, revokedAt: null, ...row };
  await db.insert(swapKeys).values({ address: owner, ...values }).onConflictDoUpdate({ target: swapKeys.address, set: values });
}
const revokeRow = { registeredAt: new Date(), revokedAt: new Date(), setup: { revoke: { userOp: toJsonSafe(revokePolicyUserOp({ account: ACCOUNT, swapKeyPolicy: ACCOUNT, nonce: 0n })), signature: "0x01" } } };
const kinds = async (db: TestDb, address = OWNER) =>
  (await db.select({ address: activity.address, kind: activity.kind, payload: activity.payload }).from(activity)).filter((a) => a.address === address).map(({ kind, payload }) => ({ kind, payload }));
const meta = { readCt: 1 } as never; // first attempt: refusals must not wait for retries
const handler = (db: TestDb, c: Clients, budget = relayerBudget(db, c, { pool: "setup" })) =>
  swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT, budget, usdg: USDG, minUsdg: 10n ** 6n }, () => {});

test("a pool's spend survives a restart, resets at UTC midnight, caps each address, and the reserve refuses on its own", async () => {
  const db = await createTestDb();
  const { c } = fakeChain({ relayerWei: parseEther("1") });
  let now = Date.UTC(2026, 9, 22, 23, 0);
  const budget = () => relayerBudget(db, c, { pool: "stamp", capEth: "0.001", shareEth: "0.0006", minEth: "0.003", now: () => now });
  expect(await budget().allowed(OWNER)).toBe(true);
  await budget().spend(parseEther("0.0006"), OWNER);
  expect(await budget().allowed(OWNER)).toBe(false); // its share is used up
  expect(await budget().allowed(ACCOUNT)).toBe(true);
  await budget().spend(parseEther("0.0004"), ACCOUNT); // a fresh instance (restart) adds to the same day
  expect(await budget().allowed(KEY)).toBe(false); // the pool is used up
  expect(await relayerBudget(db, c, { pool: "setup", now: () => now }).allowed(KEY)).toBe(true); // the other pool isn't
  now += 2 * 3_600_000; // next UTC day
  expect(await budget().allowed(OWNER)).toBe(true);

  const low = fakeChain({ relayerWei: parseEther("0.0089") }).c; // under 3 x 0.003
  expect(await relayerBudget(db, low, { pool: "stamp", minEth: "0.003", now: () => now }).allowed(OWNER)).toBe(false);
});

test("20 sybil setups exhaust only the setup pool; another address can still seal", async () => {
  const db = await createTestDb();
  const { c, sent } = fakeChain({ relayerWei: parseEther("1") });
  for (let i = 0; i < 20; i++) {
    await addSetup(db, addr(0x1000 + i), addr(0x2000 + i));
    await handler(db, c)({ address: addr(0x1000 + i) }, meta);
  }
  // Each setup charges 21k gas at 1 gwei + 0.0003 ETH session gas: 0.005 ETH covers 16 of them.
  expect(sent.length).toBe(16);
  expect(await kinds(db, addr(0x1000 + 19))).toEqual([{ kind: "swap_setup_failed", payload: { reason: "relayer_budget" } }]);
  expect(await relayerBudget(db, c, { pool: "stamp" }).allowed(OWNER)).toBe(true);
});

test("one owner gets 2 sponsored setups a day; the 3rd is refused before any tx", async () => {
  const db = await createTestDb();
  const { c, sent } = fakeChain({ relayerWei: parseEther("1") });
  const unlimited = relayerBudget(db, c, { pool: "setup", shareEth: "1" }); // the count, not the ETH share, refuses here
  for (let i = 0; i < 3; i++) {
    await addSetup(db, OWNER, addr(0x2000 + i)); // a fresh swap wallet each time (no 7-day rule)
    await handler(db, c, unlimited)({ address: OWNER }, meta);
  }
  expect(sent.length).toBe(2);
  expect((await kinds(db)).at(-1)).toEqual({ kind: "swap_setup_failed", payload: { reason: "at most 2 sponsored swap setups a day per account; try again tomorrow" } });
});

test("a setup from a swap wallet holding under 1 USDG is refused with the reason and sends no gas", async () => {
  const db = await createTestDb();
  await addSetup(db, OWNER, ACCOUNT);
  const { c, sent } = fakeChain({ relayerWei: parseEther("1"), usdg: 999_999n });
  await handler(db, c)({ address: OWNER }, meta);
  expect(await kinds(db)).toEqual([{ kind: "swap_setup_failed", payload: { reason: "fund your swap wallet with at least 1 USDG first" } }]);
  expect(sent).toEqual([]);
});

test("a swap wallet's session key is funded once per 7 days, and a revoke doesn't reset that", async () => {
  const db = await createTestDb();
  const { c, sent } = fakeChain({ relayerWei: parseEther("1") });
  const h = handler(db, c);
  const recent = { reason: "this swap wallet's session key was funded in the last 7 days; try again after 7 days" };
  await addSetup(db, OWNER, ACCOUNT);
  await h({ address: OWNER }, meta);
  await addSetup(db, OWNER, ACCOUNT); // a new (unrevoked) key on the same wallet
  await h({ address: OWNER }, meta);
  expect(sent.length).toBe(1);
  expect((await kinds(db)).at(-1)!.payload).toEqual(recent);
  await addSetup(db, OWNER, ACCOUNT, revokeRow);
  await h({ address: OWNER, revoke: true }, meta);
  expect((await kinds(db)).at(-1)!.kind).toBe("swaps_revoked"); // the revoke itself went through
  await addSetup(db, OWNER, ACCOUNT); // re-setup after the revoke
  await h({ address: OWNER }, meta);
  await db.delete(swapKeys).where(eq(swapKeys.address, OWNER)); // prepare drops this unregistered row on a rebind
  await addSetup(db, OTHER, ACCOUNT); // the same wallet bound to another account
  await h({ address: OTHER }, meta);
  expect(sent.length).toBe(1);
  expect((await kinds(db)).at(-1)!.payload).toEqual(recent);
  expect((await kinds(db, OTHER)).at(-1)!.payload).toEqual(recent);
});

test("revoke is never refused: not with the setup pool spent, not below the reserve; its gas is still recorded", async () => {
  for (const relayerWei of [parseEther("1"), parseEther("0.001")]) {
    const db = await createTestDb();
    await addSetup(db, OWNER, ACCOUNT, revokeRow);
    const { c, s } = fakeChain({ relayerWei });
    const budget = relayerBudget(db, c, { pool: "setup", capEth: "0.001", shareEth: "1" });
    await budget.spend(parseEther("0.001"), ACCOUNT);
    await handler(db, c, budget)({ address: OWNER, revoke: true }, meta);
    expect(await kinds(db)).toEqual([{ kind: "swaps_revoked", payload: { sessionKey: KEY } }]);
    expect(s.handleOps).toBe(1);
    // Charged 21k gas at 1 gwei to the owner: a 0.000021 ETH share is now used up.
    expect(await relayerBudget(db, fakeChain({ relayerWei: parseEther("1") }).c, { pool: "setup", shareEth: "0.000021" }).allowed(OWNER)).toBe(false);
  }
});

test("session gas is sent (and charged) only when the session key isn't funded already", async () => {
  for (const [keyWei, want] of [[0n, [parseEther("0.0003")]], [parseEther("0.0003"), []]] as const) {
    const db = await createTestDb();
    await addSetup(db, OWNER, ACCOUNT);
    const { c, sent } = fakeChain({ relayerWei: parseEther("1"), keyWei });
    await handler(db, c)({ address: OWNER }, meta);
    expect((await kinds(db)).map((a) => a.kind)).toEqual(["swaps_ready"]);
    expect(sent).toEqual([...want]);
    // Charged: 21k gas at 1 gwei plus the gas money, so exactly a 0.000321 ETH cap is used up.
    expect(await relayerBudget(db, c, { pool: "setup", capEth: "0.000321" }).allowed(ACCOUNT)).toBe(want.length === 0);
  }
});

/** A chain where each address holds what `held` says (USDG base units, wei); the relayer holds 1 ETH. */
function holders(held: Record<string, { usdg?: bigint; wei?: bigint }>) {
  const of = (a: string) => held[a.toLowerCase()] ?? {};
  return {
    account: { address: RELAYER },
    public: {
      getBalance: async ({ address }: { address: string }) => (address === RELAYER ? parseEther("1") : (of(address).wei ?? 0n)),
      readContract: async ({ args }: { args: string[] }) => of(args[0]!).usdg ?? 0n,
    },
  } as unknown as Clients;
}
const rule = (db: TestDb, c: Clients) => sponsorRule(db, c, { usdg: USDG, minUsdg: 10n ** 6n, minWei: parseEther("0.0002"), label: "Robinhood Chain" });
const UNFUNDED = "Sponsored seals need at least 1 USDG or 0.0002 ETH in your wallet on Robinhood Chain — or send the seal from your own wallet.";

test("a sponsored seal needs 1 USDG or 0.0002 ETH in the owner's wallet or its live swap wallet", async () => {
  const db = await createTestDb();
  await db.insert(users).values({ address: OWNER });
  expect(await rule(db, holders({}))(OWNER)).toBe(UNFUNDED);
  expect(await rule(db, holders({ [OWNER]: { usdg: 999_999n, wei: parseEther("0.00019") } }))(OWNER)).toBe(UNFUNDED);
  expect(await rule(db, holders({ [OWNER]: { usdg: 10n ** 6n } }))(OWNER)).toBeNull();
  expect(await rule(db, holders({ [OWNER]: { wei: parseEther("0.0002") } }))(OWNER)).toBeNull();
  const viaSwapWallet = holders({ [ACCOUNT]: { usdg: 10n ** 6n } });
  await addSetup(db, OWNER, ACCOUNT); // not registered yet: doesn't count
  expect(await rule(db, viaSwapWallet)(OWNER)).toBe(UNFUNDED);
  await addSetup(db, OWNER, ACCOUNT, { registeredAt: new Date() });
  expect(await rule(db, viaSwapWallet)(OWNER)).toBeNull();
  await addSetup(db, OWNER, ACCOUNT, { registeredAt: new Date(), revokedAt: new Date() }); // revoked: free for another account, so it doesn't count
  expect(await rule(db, viaSwapWallet)(OWNER)).toBe(UNFUNDED);
});

test("49 unfunded sybils x 20 stamps are refused before any relay; a funded owner still gets a sponsored seal", async () => {
  const db = await createTestDb();
  const c = holders({ [OWNER]: { usdg: 10n ** 6n } });
  let relayed = 0;
  const relay = { public: { simulateContract: async () => (relayed++, Promise.reject(new Error("relay not expected"))) }, wallet: {}, address: USDG } as unknown as Relay;
  const budget = relayerBudget(db, c, { pool: "stamp" });
  const stamp = { owner: OWNER, entryHash: "0x01", exitHash: "0x02", sealed: true, expiresAt: "1", nonce: "1", deadline: "1", mode: "live" };
  const sybils = Array.from({ length: 49 }, (_, i) => addr(0x5000 + i));
  await db.insert(users).values([...sybils, OWNER].map((address) => ({ address })));
  const ids = await db
    .insert(stampRequests)
    .values(sybils.flatMap((owner) => Array.from({ length: 20 }, () => ({ owner, encSpec: Buffer.alloc(1), stamp, ownerSig: "0x01", signedAt: new Date() }))))
    .returning({ id: stampRequests.id });
  for (const { id } of ids) await expect(relayStamp(db, relay, id, budget, rule(db, c))).rejects.toBeInstanceOf(FinalRelayError);
  expect(relayed).toBe(0);
  const failed = await db.select({ status: stampRequests.status, error: stampRequests.error }).from(stampRequests);
  expect(failed.every((r) => r.status === "failed" && r.error === UNFUNDED)).toBe(true);
  // Nothing was spent, so the funded owner passes both lines and reaches the relay.
  const [mine] = await db.insert(stampRequests).values({ owner: OWNER, encSpec: Buffer.alloc(1), stamp, ownerSig: "0x01", signedAt: new Date() }).returning({ id: stampRequests.id });
  await expect(relayStamp(db, relay, mine!.id, budget, rule(db, c))).rejects.toThrow("relay not expected");
  expect(relayed).toBe(1);
}, 60_000);

/** The PoC's chain: one 1-USDG balance that sits in `at.holder`; nothing else is funded. */
function rotating(at: { holder: string }) {
  const sent: bigint[] = [];
  const c = {
    account: { address: RELAYER },
    public: {
      getBalance: async ({ address }: { address: string }) => (address === RELAYER ? parseEther("1") : 0n),
      getBlockNumber: async () => 1n,
      getCode: async () => kernelDelegationCode,
      readContract: async ({ functionName, args }: { functionName: string; args: string[] }) =>
        functionName === "activePolicy" ? swapKeyPolicyHash(swapKeyPolicyFromJson(policyFor(args[0]!))) : functionName === "balanceOf" ? (args[0]!.toLowerCase() === at.holder ? 10n ** 6n : 0n) : true,
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 21_000n, effectiveGasPrice: 10n ** 9n }),
    },
    wallet: { sendTransaction: async ({ value }: { value: bigint }) => (sent.push(value), "0x01") },
  } as unknown as Clients;
  return { c, sent };
}
const HOUR = 3_600_000;
const YOUNG = "Sponsored gas needs a wallet funded for at least an hour — or pay the gas yourself.";
const aged = (db: TestDb, c: Clients, now: () => number) => fundedAge(db, c, { usdg: USDG, minUsdg: 10n ** 6n, minWei: parseEther("0.0002"), minAgeS: 3600, now });

test("one 1-USDG balance handed along 16 fresh swap wallets within an hour gets no sponsored setup; a wallet funded for an hour does", async () => {
  const db = await createTestDb();
  const at = { holder: "" };
  const { c, sent } = rotating(at);
  let now = Date.now();
  const funding = aged(db, c, () => now);
  const h = swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT, budget: relayerBudget(db, c, { pool: "setup" }), usdg: USDG, minUsdg: 10n ** 6n, funding }, () => {});
  for (let i = 0; i < 16; i++) {
    const [owner, wallet] = [addr(0x1000 + i), addr(0x3000 + i)];
    await addSetup(db, owner, wallet);
    at.holder = wallet.toLowerCase(); // the balance moves on before each setup
    await h({ address: owner }, meta);
    expect(await kinds(db, owner)).toEqual([{ kind: "swap_setup_failed", payload: { reason: YOUNG } }]);
    // The refusal stays on the row, so the browser offers to send the setup itself.
    expect(((await db.select().from(swapKeys).where(eq(swapKeys.address, owner)))[0]!.setup as { failed?: string }).failed).toBe(YOUNG);
    now += 3 * 60_000;
    await funding.recheck(); // the balance sits in one wallet only: every other clock is cleared
  }
  expect(sent).toEqual([]);
  // Coming back an hour later doesn't help a wallet whose balance moved on.
  now += HOUR;
  await addSetup(db, addr(0x1000), addr(0x3000));
  await h({ address: addr(0x1000) }, meta);
  expect(sent).toEqual([]);

  // A real user who keeps 1 USDG in their swap wallet: refused once (its clock starts), sponsored after an hour.
  const victim = addr(0xbeef);
  await addSetup(db, victim, addr(0x9000));
  at.holder = addr(0x9000);
  await h({ address: victim }, meta);
  for (let m = 0; m < 12; m++) (now += 5 * 60_000), await funding.recheck();
  await addSetup(db, victim, addr(0x9000));
  await h({ address: victim }, meta);
  expect(sent).toEqual([parseEther("0.0003")]);
  expect((await kinds(db, victim)).map((a) => a.kind)).toEqual(["swap_setup_failed", "swaps_ready"]);
}, 120_000);

test("a dip below the floor resets a wallet's clock; a sponsored seal needs an hour funded too", async () => {
  const db = await createTestDb();
  const at = { holder: OWNER.toLowerCase() };
  const { c } = rotating(at);
  let now = Date.now();
  const funding = aged(db, c, () => now);
  expect(await funding.check([OWNER])).toBe("young");
  now += 50 * 60_000;
  at.holder = "";
  await funding.recheck(); // seen below the floor
  at.holder = OWNER.toLowerCase();
  now += 20 * 60_000; // 70 minutes after the first sighting
  expect(await funding.check([OWNER])).toBe("young"); // the clock restarted
  now += HOUR;
  await funding.recheck();
  expect(await funding.check([OWNER])).toBe("funded");

  // Seals: the same rule through sponsorRule.
  await db.insert(users).values({ address: OTHER });
  let t = Date.now();
  const seal = sponsorRule(db, c, { usdg: USDG, minUsdg: 10n ** 6n, minWei: parseEther("0.0002"), label: "Robinhood Chain", minAgeS: 3600, now: () => t });
  at.holder = OTHER.toLowerCase();
  expect(await seal(OTHER)).toBe(YOUNG);
  t += HOUR;
  expect(await seal(OTHER)).toBeNull();
  at.holder = "";
  expect(await seal(OTHER)).toBe(UNFUNDED);
});

test("the background sweep starts clocks before anyone asks: a long-held wallet is sponsored on first use, a fresh one still waits", async () => {
  const db = await createTestDb();
  const held = new Set<string>();
  const read = new Set<string>();
  const c = {
    public: {
      getBlockNumber: async () => 1n,
      getBalance: async () => 0n,
      readContract: async ({ args }: { args: string[] }) => (read.add(args[0]!.toLowerCase()), held.has(args[0]!.toLowerCase()) ? 10n ** 6n : 0n),
    },
  } as unknown as Clients;
  let now = Date.now();
  const funding = aged(db, c, () => now);
  await db.insert(users).values(Array.from({ length: 450 }, (_, i) => ({ address: addr(0x5000 + i) })));
  const [owner, wallet] = [addr(0xc1), addr(0xc2)];
  await addSetup(db, owner, wallet, { revokedAt: new Date() }); // swap wallets are swept live or not
  held.add(wallet.toLowerCase());

  // 452 candidates at 200 a pass: three passes read every one, the fourth starts over.
  for (let i = 0; i < 3; i++) await funding.recheck();
  expect(read.size).toBe(452);
  read.clear();
  await funding.recheck();
  expect(read.has(addr(0x5000))).toBe(true);
  expect(read.has(wallet.toLowerCase())).toBe(true); // a running clock is read on every pass

  // Never asked before, but seen funded by the sweep an hour ago.
  now += HOUR;
  expect(await funding.check([owner, wallet])).toBe("funded");

  // Funded minutes ago: the sweep sees it, but its clock starts there.
  const fresh = addr(0x5001);
  held.add(fresh.toLowerCase());
  for (let i = 0; i < 3; i++) (now += 5 * 60_000), await funding.recheck();
  expect(await funding.check([fresh])).toBe("young");

  // A dip below the floor resets the long-held wallet too.
  held.delete(wallet.toLowerCase());
  await funding.recheck();
  held.add(wallet.toLowerCase());
  expect(await funding.check([wallet])).toBe("young");
}, 60_000);
