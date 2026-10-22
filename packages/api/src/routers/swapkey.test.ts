// swapKey.register selfPaid against the real migrations and a mocked Robinhood Chain RPC: a setup the
// user's wallet sent itself (the relayer refused it) is recorded only when every step is live on-chain.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildSwapSetup, chainConfig, kernelAbi, kernelDelegationCode, poolId, provisoSwapAdapterAbi, swapConfig, swapKeyPolicyAbi, swapKeyPolicyHash, swapSetupTypedData, toJsonSafe, type SwapSetup } from "@proviso/chain";
import { activity, swapKeys, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq, sql } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionResult, numberToHex, parseEther, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appRouter } from "../index";

const ADAPTER = "0x00000000000000000000000000000000000000d1" as Address;
const POLICY = "0x00000000000000000000000000000000000000d2" as Address;
const SESSION = "0x00000000000000000000000000000000000000d3" as Address;
const wallet = privateKeyToAccount(generatePrivateKey()); // the swap wallet, also the sign-in wallet
const OWNER = wallet.address.toLowerCase();
const abi = [...kernelAbi, ...provisoSwapAdapterAbi, ...swapKeyPolicyAbi];

// What the chain shows for the swap wallet; each test sets the steps it has done.
let chain = { delegated: false, installed: false, adapterSet: false, policyActive: false, keyWei: 0n };
let setup: SwapSetup;

const rpc = (method: string, params: any[]) => {
  if (method === "eth_getCode") return chain.delegated ? kernelDelegationCode : "0x";
  if (method === "eth_getBalance") return numberToHex(params[0].toLowerCase() === SESSION.toLowerCase() ? chain.keyWei : 0n);
  if (method === "eth_call") {
    const { functionName, args } = decodeFunctionData({ abi, data: params[0].input ?? params[0].data });
    const out = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as never);
    if (functionName === "isModuleInstalled") return out(chain.installed);
    if (functionName === "activePolicy") return out(chain.policyActive ? swapKeyPolicyHash(setup.policy) : zeroHash);
    if (functionName === "policyOf") {
      const p = setup.adapterPolicies.find((a) => poolId(a) === args![1])!;
      return out({ ...p, nonce: chain.adapterSet ? p.nonce : 0n });
    }
  }
  throw new Error(`unexpected ${method}`);
};

const realFetch = globalThis.fetch;
let db: Db;
beforeAll(async () => {
  process.env.CHAIN_NETWORK = "testnet";
  process.env.SWAP_ADAPTER_ADDRESS = ADAPTER;
  process.env.SWAP_KEY_POLICY_ADDRESS = POLICY;
  process.env.RHC_RPC_URL = "http://rpc.invalid";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: rpc(method, params) }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const pg = await createTestDb();
  // PGlite's execute returns { rows }; the API's postgres-js client returns the rows array.
  db = new Proxy(pg, {
    get: (t, k) => (k === "execute" ? async (q: unknown) => ((await t.execute(q as never)) as unknown as { rows: unknown[] }).rows : Reflect.get(t, k)),
  }) as Db;
  await db.insert(users).values({ address: OWNER });
  // What prepare stored for a fresh wallet: delegation + install, every policy, a new session key.
  const fresh = { getCode: async () => undefined, getTransactionCount: async () => 0, readContract: async ({ functionName }: { functionName: string }) => (functionName === "isModuleInstalled" ? false : 0n) };
  setup = await buildSwapSetup(fresh as never, {
    chainId: chainConfig().chain.id, account: wallet.address, sessionKey: SESSION, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 29 * 86_400),
    swapAdapter: ADAPTER, swapKeyPolicy: POLICY, markets: swapConfig().markets, caps: swapConfig().caps,
  });
  // The relayer refused it (pool spent for the day), so the row carries the refusal.
  await db.insert(swapKeys).values({ address: OWNER, account: OWNER, keyAddr: SESSION.toLowerCase(), sealed: {}, setup: { ...(toJsonSafe(setup) as object), failed: "relayer_budget" }, expiresAt: new Date(Date.now() + 29 * 86_400_000) });
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function signatures() {
  const td = swapSetupTypedData(setup, { swapAdapter: ADAPTER, swapKeyPolicy: POLICY });
  return {
    userOp: await wallet.signMessage({ message: { raw: setup.install!.userOpHash } }),
    adapter: await Promise.all(td.adapter.map((t) => wallet.signTypedData(t as never))) as Hex[],
    policy: await wallet.signTypedData(td.policy as never),
    selfPaid: true,
  };
}
// Clears the 5-a-day register limit between calls.
const register = async (input: Awaited<ReturnType<typeof signatures>>) => (await db.execute(sql`delete from public.rate_limits`), appRouter.createCaller({ db, auth: { uid: OWNER, address: OWNER } }).swapKey.register(input));
const row = async () => (await db.select().from(swapKeys).where(eq(swapKeys.address, OWNER)))[0]!;

test("a half-done self-paid setup is refused and nothing is recorded", async () => {
  const sigs = await signatures();
  const done = { delegated: true, installed: true, adapterSet: true, policyActive: true, keyWei: parseEther("0.0003") };
  for (const missing of [{ delegated: false, installed: false }, { installed: false }, { adapterSet: false }, { policyActive: false }, { keyWei: parseEther("0.00009") }]) {
    chain = { ...done, ...missing };
    await expect(register(sigs)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }
  expect((await row()).registeredAt).toBeNull();
  // Signatures are still checked: the policy must be signed by the swap wallet.
  chain = done;
  const other = privateKeyToAccount(generatePrivateKey());
  const forged = await other.signTypedData(swapSetupTypedData(setup, { swapAdapter: ADAPTER, swapKeyPolicy: POLICY }).policy as never);
  await expect(register({ ...sigs, policy: forged })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await row()).registeredAt).toBeNull();
});

test("with the sponsored pool spent, a setup the user sent itself registers once all of it is on-chain", async () => {
  chain = { delegated: true, installed: true, adapterSet: true, policyActive: true, keyWei: parseEther("0.0003") };
  const sigs = await signatures();
  expect(await register(sigs)).toEqual({ queued: false });
  const r = await row();
  expect(r.registeredAt).not.toBeNull();
  expect(r.policySig).toBe(sigs.policy);
  expect(r.signedPolicy).toEqual((toJsonSafe(setup) as { policy: unknown }).policy);
  expect((await db.select().from(activity)).filter((a) => a.kind === "swaps_ready")).toHaveLength(1);
  await expect(register(sigs)).rejects.toMatchObject({ code: "BAD_REQUEST" }); // already registered
});
