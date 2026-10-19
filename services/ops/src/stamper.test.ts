// Stamper end to end: a browser-made stamp request in Postgres (PGlite with the real schema)
// is relayed to the real ThesisSeal bytecode on a local anvil, then recorded.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anvil, randomNonce, stampTypedData, thesisSealAbi, type Stamp } from "@proviso/chain";
import { thesisSealBytecode } from "@proviso/chain/bytecode";
import { reveals, stampRequests, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { splitCommitments } from "@proviso/dsl";
import { eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FinalRelayError, relayStamp, type Relay } from "./stamper";

const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const port = 9545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const relayer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const chain = { ...anvil, rpcUrls: { default: { http: [rpc] } } };

let proc: ReturnType<typeof Bun.spawn> | undefined;
let db: Db;
let relay: Relay;

beforeAll(async () => {
  if (!existsSync(bin)) return;
  proc = Bun.spawn([bin, "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const wallet = createWalletClient({ chain, transport: http(rpc), account: relayer });
  const hash = await wallet.deployContract({ abi: thesisSealAbi, bytecode: thesisSealBytecode });
  const address = (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
  relay = { public: pub, wallet, address };
  db = await createTestDb();
  await db.insert(users).values({ address: owner.address.toLowerCase() });
}, 30_000);
afterAll(() => proc?.kill());

async function request(over: Partial<Stamp> = {}) {
  const c = splitCommitments({
    v: 1,
    entry: {
      when: { price: { coin: "HYPE", op: ">", value: 40 } },
      then: [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 2, size: { usd: 100 } }],
      legs: { atomic: false, onPartial: "unwind" },
    },
    exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" },
    limits: { maxUsd: 100, maxLev: 2 },
    mode: "alert",
    expires: "7d",
  });
  const now = BigInt((await relay.public.getBlock()).timestamp);
  const stamp: Stamp = {
    owner: owner.address,
    entryHash: c.entryHash,
    exitHash: c.exitHash,
    sealed: true,
    expiresAt: now + 7n * 86400n,
    nonce: randomNonce(),
    deadline: now + 600n,
    ...over,
  };
  const sig = await owner.signTypedData(stampTypedData(chain.id, relay.address, stamp));
  const [row] = await db
    .insert(stampRequests)
    .values({
      owner: owner.address.toLowerCase(),
      encSpec: new Uint8Array(100),
      stamp: { ...stamp, expiresAt: String(stamp.expiresAt), nonce: String(stamp.nonce), deadline: String(stamp.deadline), mode: "alert" },
      ownerSig: sig,
      signedAt: new Date(),
    })
    .returning({ id: stampRequests.id });
  return row.id;
}

test.skipIf(!existsSync(bin))("relays a signed stamp and records thesis, reveal deadline and status", async () => {
  const id = await request();
  const thesisId = await relayStamp(db, relay, id);
  expect(thesisId).toBe(1n);
  const [t] = await db.select().from(theses).where(eq(theses.id, 1n));
  expect(t.state).toBe("alert");
  expect(t.stampedAt.getTime()).toBeGreaterThan(0);
  const [r] = await db.select().from(reveals).where(eq(reveals.thesisId, 1n));
  expect(r.dueAt.getTime()).toBe(t.expiresAt.getTime());
  const [req] = await db.select().from(stampRequests).where(eq(stampRequests.id, id));
  expect(req.status).toBe("sealed");
  // Re-delivery of the same queue message is a no-op.
  expect(await relayStamp(db, relay, id)).toBe(1n);
}, 30_000);

test.skipIf(!existsSync(bin))("an expired deadline fails for good instead of retrying", async () => {
  const now = BigInt((await relay.public.getBlock()).timestamp);
  const id = await request({ deadline: now - 1n });
  await expect(relayStamp(db, relay, id)).rejects.toBeInstanceOf(FinalRelayError);
  const [req] = await db.select().from(stampRequests).where(eq(stampRequests.id, id));
  expect(req.status).toBe("failed");
  expect(req.error).toContain("DeadlinePassed");
}, 30_000);
