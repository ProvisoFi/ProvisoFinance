// idea.confirmSelfSeal against the real migrations and a mocked Robinhood Chain RPC: only a
// successful tx to ThesisSeal whose Sealed event is exactly the caller's stamp is recorded, once.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { thesisSealAbi } from "@proviso/chain";
import { activity, stampRequests, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, numberToHex, type Address, type Hex } from "viem";
import { appRouter } from "../index";

const SEAL = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
const OWNER = "0x" + "a1".repeat(20);
const OTHER = "0x" + "b2".repeat(20);
const ENTRY = ("0x" + "aa".repeat(32)) as Hex;
const EXIT = ("0x" + "bb".repeat(32)) as Hex;
const EXPIRES = 2_000_000_000n;
const BLOCK_TS = 1_800_000_000;
const TX = ("0x" + "11".repeat(32)) as Hex;
const BLOCK = ("0x" + "22".repeat(32)) as Hex;

type Ev = { id: bigint; owner: string; entry: Hex; exit: Hex; isSealed: boolean; expiresAt: bigint; address: string };
const good: Ev = { id: 7n, owner: OWNER, entry: ENTRY, exit: EXIT, isSealed: true, expiresAt: EXPIRES, address: SEAL };
let chain: { status: string; to: string; ev: Ev } | null;

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
  if (method === "eth_getBlockByHash")
    return { hash: BLOCK, number: "0x10", timestamp: numberToHex(BLOCK_TS), parentHash: BLOCK, transactions: [], gasLimit: "0x1", gasUsed: "0x1", miner: OWNER, difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), nonce: "0x0000000000000000", size: "0x1", stateRoot: BLOCK, receiptsRoot: BLOCK, transactionsRoot: BLOCK, sha3Uncles: BLOCK, uncles: [], mixHash: BLOCK };
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

async function request(status = "failed") {
  const [r] = await db
    .insert(stampRequests)
    .values({
      owner: OWNER,
      encSpec: Buffer.alloc(80, 1),
      stamp: { owner: OWNER, entryHash: ENTRY, exitHash: EXIT, sealed: true, expiresAt: String(EXPIRES), nonce: "1", deadline: "1", mode: "live" },
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
    { status: "0x1", to: OTHER, ev: good }, // another contract called
    { status: "0x1", to: SEAL, ev: { ...good, address: OTHER } }, // the event from another contract
    { status: "0x1", to: SEAL, ev: { ...good, owner: OTHER } }, // someone else's stamp
    { status: "0x1", to: SEAL, ev: { ...good, entry: EXIT } }, // other hashes
    { status: "0x1", to: SEAL, ev: { ...good, exit: ENTRY } },
    { status: "0x1", to: SEAL, ev: { ...good, expiresAt: EXPIRES + 1n } },
    { status: "0x1", to: SEAL, ev: { ...good, isSealed: false } },
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
