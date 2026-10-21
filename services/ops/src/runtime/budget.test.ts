// The relayer's day cap for user-triggered work (PGlite, fake chain): it persists across restarts,
// resets at UTC midnight, refuses below the reserve, and stops swap setup/revoke relays.
import { expect, test } from "bun:test";
import { kernelDelegationCode, swapKeyPolicyFromJson, swapKeyPolicyHash } from "@proviso/chain";
import { activity, swapKeys, users } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { parseEther } from "viem";
import { relayerBudget } from "./budget";
import type { Clients } from "./chain";
import { swapSetupHandler } from "./swaps";

const OWNER = "0x00000000000000000000000000000000000000a1";
const ACCOUNT = "0x00000000000000000000000000000000000000a2";
const KEY = "0x00000000000000000000000000000000000000a3";
const RELAYER = "0x00000000000000000000000000000000000000f1";
const DAY = 86_400_000;
const POLICY = { account: ACCOUNT, sessionKey: KEY, adapter: ACCOUNT, tokens: [], maxPerTx: [], maxPerDay: [], poolIds: [], expiresAt: "9999999999", nonce: "1" };

/** A chain where the policy is already set and nothing reverts; records every ETH transfer. */
function fakeChain(o: { relayerWei: bigint; keyWei?: bigint }) {
  const sent: bigint[] = [];
  const c = {
    account: { address: RELAYER },
    public: {
      getBalance: async ({ address }: { address: string }) => (address === RELAYER ? o.relayerWei : (o.keyWei ?? 0n)),
      getCode: async () => kernelDelegationCode,
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "activePolicy" ? swapKeyPolicyHash(swapKeyPolicyFromJson(POLICY)) : true,
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 21_000n, effectiveGasPrice: 10n ** 9n }),
    },
    wallet: {
      sendTransaction: async ({ value }: { value: bigint }) => (sent.push(value), "0x01"),
      writeContract: async () => Promise.reject(new Error("no tx expected")),
    },
  } as unknown as Clients;
  return { c, sent };
}

async function setupDb(row: Partial<typeof swapKeys.$inferInsert> = {}) {
  const db = await createTestDb();
  await db.insert(users).values({ address: OWNER });
  await db.insert(swapKeys).values({
    address: OWNER,
    account: ACCOUNT,
    keyAddr: KEY,
    sealed: {},
    setup: { adapterPolicies: [], policy: POLICY, signatures: { adapter: [], policy: "0x01" } },
    expiresAt: new Date(Date.now() + DAY),
    ...row,
  });
  return db;
}
const kinds = async (db: Awaited<ReturnType<typeof createTestDb>>) => db.select({ kind: activity.kind, payload: activity.payload }).from(activity);
const meta = { readCt: 1 } as never; // first attempt: refusals must not wait for retries

test("the day's spend survives a restart, resets at UTC midnight, and the reserve refuses on its own", async () => {
  const db = await createTestDb();
  const { c } = fakeChain({ relayerWei: parseEther("1") });
  let now = Date.UTC(2026, 9, 22, 23, 0);
  const budget = () => relayerBudget(db, c, { capEth: "0.001", minEth: "0.003", now: () => now });
  expect(await budget().allowed()).toBe(true);
  await budget().spend(parseEther("0.0006"));
  expect(await budget().allowed()).toBe(true);
  await budget().spend(parseEther("0.0004")); // a fresh instance (restart) adds to the same day
  expect(await budget().allowed()).toBe(false);
  now += 2 * 3_600_000; // next UTC day
  expect(await budget().allowed()).toBe(true);

  const low = fakeChain({ relayerWei: parseEther("0.0089") }).c; // under 3 x 0.003
  expect(await relayerBudget(db, low, { minEth: "0.003", now: () => now }).allowed()).toBe(false);
});

test("swap setup is refused once the day's budget is spent, on the first attempt", async () => {
  const db = await setupDb();
  const { c, sent } = fakeChain({ relayerWei: parseEther("1") });
  const budget = relayerBudget(db, c, { capEth: "0.001" });
  await budget.spend(parseEther("0.001"));
  await swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT, budget }, () => {})({ address: OWNER }, meta);
  expect(await kinds(db)).toEqual([{ kind: "swap_setup_failed", payload: { reason: "relayer_budget" } }]);
  expect(sent).toEqual([]);
});

test("swap revoke relay is refused below the reserve", async () => {
  const db = await setupDb({ registeredAt: new Date(), revokedAt: new Date(), setup: { revoke: { userOp: {}, signature: "0x01" } } });
  const { c } = fakeChain({ relayerWei: parseEther("0.001") });
  const budget = relayerBudget(db, c, { minEth: "0.003" });
  await swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT, budget }, () => {})({ address: OWNER, revoke: true }, meta);
  expect(await kinds(db)).toEqual([{ kind: "swaps_revoke_failed", payload: { reason: "relayer_budget", sessionKey: KEY } }]);
});

test("session gas is sent (and charged) only when the session key isn't funded already", async () => {
  for (const [keyWei, want] of [[0n, [parseEther("0.0003")]], [parseEther("0.0003"), []]] as const) {
    const db = await setupDb();
    const { c, sent } = fakeChain({ relayerWei: parseEther("1"), keyWei });
    const budget = relayerBudget(db, c);
    await swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT, budget })({ address: OWNER }, meta);
    expect((await kinds(db)).map((a) => a.kind)).toEqual(["swaps_ready"]);
    expect(sent).toEqual([...want]);
    // Charged: 21k gas at 1 gwei plus the gas money, so exactly a 0.000321 ETH cap is used up.
    expect(await relayerBudget(db, c, { capEth: "0.000321" }).allowed()).toBe(want.length === 0);
  }
});
