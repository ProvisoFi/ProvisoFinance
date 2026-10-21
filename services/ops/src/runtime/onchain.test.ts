// Chain consumers end to end: PGlite (real schema) + the real contract bytecode on a local anvil.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anvil, randomNonce, stampRootsAbi, stampTypedData, thesisSealAbi, type Stamp } from "@proviso/chain";
import { stampRootsBytecode, thesisSealBytecode } from "@proviso/chain/bytecode";
import { activity, reveals, stampRequests, stampRoots, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { splitCommitments, type Commitments } from "@proviso/dsl";
import { and, eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, http, toHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HOUR_MS } from "../stamps/leaf";
import { stampRootsPost, type Clients } from "./chain";
import { appendLeaf } from "../stamps/store";
import { revealHandler, stampHandler, stampRootHandler } from "./consumers";

const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const has = existsSync(bin);
const port = 10545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const relayer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const chain = { ...anvil, rpcUrls: { default: { http: [rpc] } } };

let proc: ReturnType<typeof Bun.spawn> | undefined;
let db: Db;
let c: Clients;
let seal: Address;
let roots: Address;
let commits: Commitments;

async function deploy(abi: never, bytecode: `0x${string}`, args?: unknown[]) {
  const hash = await c.wallet.deployContract({ abi, bytecode, args, account: relayer, chain } as never);
  return (await c.public.waitForTransactionReceipt({ hash })).contractAddress as Address;
}

async function stampRequest(over: Partial<Stamp> = {}) {
  const now = BigInt((await c.public.getBlock()).timestamp);
  const stamp: Stamp = {
    owner: owner.address,
    entryHash: commits.entryHash,
    exitHash: commits.exitHash,
    sealed: true,
    expiresAt: now + 7n * 86400n,
    nonce: randomNonce(),
    deadline: now + 600n,
    ...over,
  };
  const sig = await owner.signTypedData(stampTypedData(chain.id, seal, stamp));
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
  return row!.id;
}

beforeAll(async () => {
  if (!has) return;
  proc = Bun.spawn([bin, "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  c = { public: pub, wallet: createWalletClient({ chain, transport: http(rpc), account: relayer, pollingInterval: 50 }), account: relayer };
  seal = await deploy(thesisSealAbi as never, thesisSealBytecode, [relayer.address]); // relayer reveals
  roots = await deploy(stampRootsAbi as never, stampRootsBytecode, [relayer.address]);
  db = await createTestDb();
  await db.insert(users).values({ address: owner.address.toLowerCase() });
  commits = splitCommitments({
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
  }, { owner: owner.address });
  await stampHandler(db, c, seal)({ id: await stampRequest() }); // thesis 1
}, 30_000);
afterAll(() => proc?.kill());

const reveal = (part: "entry" | "exit") =>
  db.select().from(reveals).where(and(eq(reveals.thesisId, 1n), eq(reveals.part, part))).then((r) => r[0]);

describe.skipIf(!has)("on anvil", () => {
  test("stamp consumer: a final relay rejection is done, not retried", async () => {
    const now = BigInt((await c.public.getBlock()).timestamp);
    const id = await stampRequest({ deadline: now - 1n, nonce: randomNonce() });
    const logs: string[] = [];
    await stampHandler(db, c, seal, (m) => logs.push(m))({ id }); // resolves
    expect(logs[0]).toContain("DeadlinePassed");
  });

  test("reveal entry and exit through the handler, then AlreadyRevealed counts as success", async () => {
    const handle = revealHandler(db, c, seal);
    expect((await reveal("entry"))!.revealedAt).toBeNull();

    await handle({ thesisId: "1", part: "entry", kind: "MANUAL_NO_TRADE", canonical: toHex(commits.canonicalEntry), salt: commits.saltE });
    const entry = (await reveal("entry"))!;
    expect(entry.kind).toBe("MANUAL_NO_TRADE");
    expect(entry.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.revealedAt).toBeInstanceOf(Date);
    expect((await c.public.readContract({ address: seal, abi: thesisSealAbi, functionName: "theses", args: [1n] }))[4]).toBe(true);

    // exit row doesn't exist yet; canonical given as the JSON text itself
    expect(await reveal("exit")).toBeUndefined();
    await handle({ thesisId: 1, part: "exit", canonical: new TextDecoder().decode(commits.canonicalExit), salt: commits.saltX });
    const exit = (await reveal("exit"))!;
    expect(exit.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(exit.kind).toBeNull();

    const acts = await db.select().from(activity).where(eq(activity.kind, "revealed"));
    expect(acts.map((a) => (a.payload as { part: string }).part)).toEqual(["entry", "exit"]);

    // Redelivery: the db already says revealed, so nothing is sent or recorded.
    await handle({ thesisId: "1", part: "entry", kind: "MANUAL_NO_TRADE", canonical: toHex(commits.canonicalEntry), salt: commits.saltE });
    expect(await db.select().from(activity).where(eq(activity.kind, "revealed"))).toHaveLength(2);

    // Revealed on-chain but the db lost it: the AlreadyRevealed revert is success, tx recovered from logs.
    await db.update(reveals).set({ revealedAt: null, tx: null }).where(and(eq(reveals.thesisId, 1n), eq(reveals.part, "entry")));
    await handle({ thesisId: "1", part: "entry", kind: "MANUAL_NO_TRADE", canonical: toHex(commits.canonicalEntry), salt: commits.saltE });
    expect((await reveal("entry"))!.tx).toBe(entry.tx);

    // Queued as FIRED but the chain already holds another kind: the chain's kind is recorded, with a warning.
    await db.update(reveals).set({ revealedAt: null, tx: null }).where(and(eq(reveals.thesisId, 1n), eq(reveals.part, "entry")));
    const logs: string[] = [];
    await revealHandler(db, c, seal, (l) => logs.push(l))({ thesisId: "1", part: "entry", kind: "FIRED", canonical: toHex(commits.canonicalEntry), salt: commits.saltE });
    expect((await reveal("entry"))!.kind).toBe("MANUAL_NO_TRADE");
    expect(logs[0]).toContain("on-chain as MANUAL_NO_TRADE, not FIRED");
  }, 30_000);

  test("reveal errors that aren't AlreadyRevealed are retried", async () => {
    const handle = revealHandler(db, c, seal);
    await expect(handle({ thesisId: "1", part: "entry", canonical: "0x00", salt: commits.saltE })).rejects.toThrow("kind");
    await expect(handle({ thesisId: "99", part: "exit", canonical: "0x00", salt: commits.saltX })).rejects.toThrow("Unknown thesis");
  });

  test("stamp_root posts the hour's root to StampRoots; AlreadyPosted resolves to the original tx", async () => {
    const nowSec = Number((await c.public.getBlock()).timestamp);
    const hourStart = new Date(Math.floor((nowSec * 1000) / HOUR_MS) * HOUR_MS - HOUR_MS);
    for (const [i, kind] of (["FIRE", "FILL", "EXIT"] as const).entries()) {
      const at = new Date(hourStart.getTime() + i * 60_000);
      await appendLeaf(db, { thesisId: 1n, kind, data: { i }, at, now: at }); // filed as if inserted last hour
    }

    const handle = stampRootHandler(db, stampRootsPost(c, roots));
    await handle({ hour_start: hourStart.toISOString() });
    const [row] = await db.select().from(stampRoots).where(eq(stampRoots.hourStart, hourStart));
    expect(row).toMatchObject({ leafCount: 3 });
    expect(row!.tx).toMatch(/^0x[0-9a-f]{64}$/);
    const [onchainRoot, count] = await c.public.readContract({
      address: roots,
      abi: stampRootsAbi,
      functionName: "roots",
      args: [BigInt(hourStart.getTime() / 1000)],
    });
    expect(onchainRoot).toBe(row!.root as `0x${string}`);
    expect(count).toBe(3);

    await db.update(stampRoots).set({ tx: null }).where(eq(stampRoots.hourStart, hourStart));
    await handle({ hour_start: hourStart.getTime() / 1000 }); // unix-seconds form too
    const [again] = await db.select().from(stampRoots).where(eq(stampRoots.hourStart, hourStart));
    expect(again!.tx).toBe(row!.tx);
  }, 30_000);
});
