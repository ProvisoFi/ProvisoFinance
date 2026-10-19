import { beforeAll, expect, test } from "bun:test";
import { chains, stampTypedData, type Stamp } from "@proviso/chain";
import type { Db } from "@proviso/db";
import { privateKeyToAccount } from "viem/accounts";
import { appRouter } from "../index";

const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const seal = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

const inserted: unknown[] = [];
const sent: string[] = [];
const db = {
  insert: () => ({ values: (v: unknown) => (inserted.push(v), { returning: async () => [{ id: "0b8b8e8e-1111-4c1c-9c1c-000000000001" }] }) }),
  execute: async (q: { queryChunks?: unknown[] }) => (sent.push(JSON.stringify(q)), []),
} as unknown as Db;

beforeAll(() => {
  process.env.CHAIN_NETWORK = "testnet";
  process.env.THESIS_SEAL_ADDRESS = seal;
});

const caller = (address = owner.address.toLowerCase()) => appRouter.createCaller({ db, auth: { uid: "u1", address } });

async function signed(over: Partial<Stamp> = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const stamp: Stamp = {
    owner: owner.address,
    entryHash: `0x${"aa".repeat(32)}`,
    exitHash: `0x${"bb".repeat(32)}`,
    sealed: true,
    expiresAt: now + 7n * 86400n,
    nonce: 42n,
    deadline: now + 600n,
    ...over,
  };
  const ownerSig = await owner.signTypedData(stampTypedData(chains.testnet.id, seal, stamp));
  return { stamp, ownerSig, encSpec: Buffer.alloc(200, 1).toString("base64"), mode: "live" as const, signedAt: new Date() };
}

test("a valid owner-signed stamp is stored and queued for the relayer", async () => {
  const input = await signed();
  const out = await caller().idea.stamp(input);
  expect(out.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(inserted).toHaveLength(1);
  expect(sent.at(-1)).toContain("pgmq.send");
});

test("rejects a stamp from another wallet, a bad signature, or a bad expiry", async () => {
  const input = await signed();
  await expect(caller("0x" + "11".repeat(20)).idea.stamp(input)).rejects.toThrow("signed-in wallet");
  await expect(caller().idea.stamp({ ...input, stamp: { ...input.stamp, nonce: 43n } })).rejects.toThrow("signature does not match");
  const now = BigInt(Math.floor(Date.now() / 1000));
  await expect(caller().idea.stamp(await signed({ expiresAt: now + 31n * 86400n }))).rejects.toThrow("30 days");
  await expect(caller().idea.stamp(await signed({ deadline: now + 5n }))).rejects.toThrow("deadline");
  await expect(caller().idea.stamp({ ...input, encSpec: "AAAA" })).rejects.toThrow("Invalid sealed spec");
});

test("unauthenticated calls are refused", async () => {
  await expect(appRouter.createCaller({ db, auth: null }).idea.stamp(await signed())).rejects.toThrow("Sign in");
});
