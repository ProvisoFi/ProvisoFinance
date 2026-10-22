// idea.confirmSelfSeal against the real migrations and a mocked Robinhood Chain RPC: only a
// successful direct seal() of exactly the caller's stamp, mined while the request was open, is recorded, once.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { thesisSealAbi } from "@proviso/chain";
import { activity, stampRequests, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, numberToHex, type Address, type Hex } from "viem";
import { appRouter } from "../index";

const SEAL = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
const OWNER = "0x" + "a1".repeat(20);
const OTHER = "0x" + "b2".repeat(20);
const ENTRY = ("0x" + "aa".repeat(32)) as Hex;
const EXIT = ("0x" + "bb".repeat(32)) as Hex;
const EXPIRES = 2_000_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const DEADLINE = BigInt(NOW + 600);
const BLOCK_TS = NOW + 5;
const TX = ("0x" + "11".repeat(32)) as Hex;
const BLOCK = ("0x" + "22".repeat(32)) as Hex;

type Ev = { id: bigint; owner: string; entry: Hex; exit: Hex; isSealed: boolean; expiresAt: bigint; address: string };
const good: Ev = { id: 7n, owner: OWNER, entry: ENTRY, exit: EXIT, isSealed: true, expiresAt: EXPIRES, address: SEAL };
const STAMP = { owner: OWNER as Address, entryHash: ENTRY, exitHash: EXIT, isSealed: true, expiresAt: EXPIRES, nonce: 1n, deadline: DEADLINE };
// stamp: overrides for the seal() calldata; input: other calldata; ts: the block's time.
let chain: { status: string; to: string; ev: Ev; stamp?: Partial<typeof STAMP>; input?: Hex; ts?: number } | null;

const log = (e: Ev) => ({
  address: e.address,
  topics: encodeEventTopics({ abi: thesisSealAbi, eventName: "Sealed", args: { id: e.id, owner: e.owner as Address } }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint64" }], [e.entry, e.exit, e.isSealed, e.expiresAt]),
  blockHash: BLOCK, blockNumber: "0x10", transactionHash: TX, transactionIndex: "0x0", logIndex: "0x0", removed: false,
});
const rpc = (method: string) => {
  if (method === "eth_getTransactionReceipt")
    return chain && {
      transactionHash: TX, transactionIndex: "0x0", blockHash: BLOCK, blockNumber: "0x10", from: OWNER, to: chain.to,
      cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logs: [log(chain.ev)],
      logsBloom: "0x" + "00".repeat(256), status: chain.status, type: "0x2",
    };
  if (method === "eth_getTransactionByHash")
    return chain && {
      hash: TX, blockHash: BLOCK, blockNumber: "0x10", transactionIndex: "0x0", from: OWNER, to: chain.to, nonce: "0x0", gas: "0x1",
      value: "0x0", type: "0x2", chainId: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", accessList: [], v: "0x0", r: BLOCK, s: BLOCK, yParity: "0x0",
      input: chain.input ?? encodeFunctionData({ abi: thesisSealAbi, functionName: "seal", args: [{ ...STAMP, ...chain.stamp }, "0x01"] }),
    };
  if (method === "eth_getBlockByHash")
    return { hash: BLOCK, number: "0x10", timestamp: numberToHex(chain?.ts ?? BLOCK_TS), parentHash: BLOCK, transactions: [], gasLimit: "0x1", gasUsed: "0x1", miner: OWNER, difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), nonce: "0x0000000000000000", size: "0x1", stateRoot: BLOCK, receiptsRoot: BLOCK, transactionsRoot: BLOCK, sha3Uncles: BLOCK, uncles: [], mixHash: BLOCK };
  throw new Error(`unexpected ${method}`);
};

const realFetch = globalThis.fetch;
let db: Db;
beforeAll(async () => {
  process.env.CHAIN_NETWORK = "testnet";
  process.env.THESIS_SEAL_ADDRESS = SEAL;
  process.env.RHC_RPC_URL = "http://rpc.invalid";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { id, method } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: rpc(method) }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const pg = await createTestDb();
  // PGlite's execute returns { rows }; the API's postgres-js client returns the rows array.
  db = new Proxy(pg, {
    get: (t, k) => (k === "execute" ? async (q: unknown) => ((await t.execute(q as never)) as unknown as { rows: unknown[] }).rows : Reflect.get(t, k)),
  }) as Db;
  await db.insert(users).values([{ address: OWNER }, { address: OTHER }]);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function request(status = "failed", nonce = "1") {
  const [r] = await db
    .insert(stampRequests)
    .values({
      owner: OWNER,
      encSpec: Buffer.alloc(80, 1),
      stamp: { owner: OWNER, entryHash: ENTRY, exitHash: EXIT, sealed: true, expiresAt: String(EXPIRES), nonce, deadline: String(DEADLINE), mode: "live" },
      ownerSig: "0x01",
      signedAt: new Date(),
      status,
      error: "Sponsored seals are paused for today",
    })
    .returning({ id: stampRequests.id });
  return r!.id;
}
const confirm = (requestId: string, as = OWNER) => appRouter.createCaller({ db, auth: { uid: as, address: as } }).idea.confirmSelfSeal({ requestId, txHash: TX });

test("refuses a tx that isn't exactly this stamp's seal on ThesisSeal", async () => {
  const id = await request();
  const bad = "That transaction didn't seal this stamp.";
  for (const c of [
    { status: "0x0", to: SEAL, ev: good }, // reverted
    { status: "0x1", to: OTHER, ev: good }, // not a direct call: sealed through another contract
    { status: "0x1", to: SEAL, ev: { ...good, address: OTHER } }, // the event from another contract
    { status: "0x1", to: SEAL, ev: { ...good, owner: OTHER } }, // someone else's stamp
    { status: "0x1", to: SEAL, ev: { ...good, entry: EXIT } }, // other hashes
    { status: "0x1", to: SEAL, ev: { ...good, exit: ENTRY } },
    { status: "0x1", to: SEAL, ev: { ...good, expiresAt: EXPIRES + 1n } },
    { status: "0x1", to: SEAL, ev: { ...good, isSealed: false } },
    { status: "0x1", to: SEAL, ev: good, stamp: { nonce: 2n } }, // the event matches, but the call sealed another nonce
    { status: "0x1", to: SEAL, ev: good, stamp: { deadline: DEADLINE + 1n } }, // ...or another deadline
    { status: "0x1", to: SEAL, ev: good, input: encodeFunctionData({ abi: thesisSealAbi, functionName: "retire", args: [7n] }) }, // not a seal() call
  ]) {
    chain = c;
    await expect(confirm(id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: bad });
  }
  chain = null;
  await expect(confirm(id)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  chain = { status: "0x1", to: SEAL, ev: good };
  await expect(confirm(id, OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" }); // not the caller's request
  expect(await db.select().from(theses)).toEqual([]);
});

test("refuses a seal mined before the request or after its deadline", async () => {
  const id = await request();
  for (const ts of [NOW - 20 * 86_400, NOW - 200, Number(DEADLINE) + 1]) {
    chain = { status: "0x1", to: SEAL, ev: good, ts };
    await expect(confirm(id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That seal wasn't mined while this stamp was open." });
  }
  expect(await db.select().from(theses)).toEqual([]);
});

// Regression for the audit PoC: a hidden seal mined 20 days ago (its own nonce and deadline) imported
// through a fresh request with the same hashes and expiry. It used to record stamped-at 20 days before signed-at.
test("refuses to import an old seal through a fresh request with the same hashes", async () => {
  const id = await request("failed", "999");
  const old = NOW - 20 * 86_400;
  chain = { status: "0x1", to: SEAL, ev: good, stamp: { nonce: 1n, deadline: BigInt(old + 600) }, ts: old };
  await expect(confirm(id)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That transaction didn't seal this stamp." });
  expect(await db.select().from(theses)).toEqual([]);
});

test("records the owner's own seal once, stamped at its block time; a replay changes nothing", async () => {
  const id = await request();
  chain = { status: "0x1", to: SEAL, ev: good };
  expect(await confirm(id)).toEqual({ thesisId: "7" });
  const [t] = await db.select().from(theses).where(eq(theses.id, 7n));
  expect(t).toMatchObject({ owner: OWNER, sealTx: TX, entryHash: ENTRY, state: "live", stampedAt: new Date(BLOCK_TS * 1000), expiresAt: new Date(Number(EXPIRES) * 1000) });
  const [r] = await db.select().from(stampRequests).where(eq(stampRequests.id, id));
  expect(r).toMatchObject({ status: "sealed", thesisId: 7n, error: null });

  await expect(confirm(id)).rejects.toMatchObject({ code: "CONFLICT" }); // the same request again
  await expect(confirm(await request("pending"))).rejects.toMatchObject({ code: "CONFLICT", message: "That seal is already recorded." }); // the same tx for a twin request
  expect((await db.select().from(activity)).filter((a) => a.kind === "sealed")).toHaveLength(1);
});
