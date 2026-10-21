// End to end against the real ThesisSeal bytecode on a local anvil: the browser-side
// commitments (@proviso/dsl) and EIP-712 stamp must be accepted by the contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitCommitments, type SpecInput } from "@proviso/dsl";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { thesisSealAbi } from "./abi.ts";
import { thesisSealBytecode } from "./bytecode.ts";
import { anvil } from "./chains.ts";
import { randomNonce, REVEAL_KIND, stampTuple, stampTypedData, type Stamp } from "./stamp.ts";

const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const port = 8545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
// anvil's well-known dev keys: #0 relays (pays gas) and is the revealer, #1 owns the idea, #2 copies it.
const relayer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const copier = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const spec: SpecInput = {
  v: 1,
  entry: {
    when: { all: [{ funding: { coin: "HYPE", op: "<", value: 0 } }, { price: { coin: "HYPE", op: ">", value: 40 } }] },
    then: [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 3, size: { usd: 500 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -6 }, take: { pct: 15 }, ref: "trigger_mark" },
  limits: { maxUsd: 500, maxLev: 3 },
  mode: "live",
  expires: "30d",
};

let proc: ReturnType<typeof Bun.spawn> | undefined;
const chain = { ...anvil, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account: relayer });

beforeAll(async () => {
  if (!existsSync(bin)) return;
  proc = Bun.spawn([bin, "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
});
afterAll(() => proc?.kill());

test.skipIf(!existsSync(bin))("seal and reveal a DSL commitment on ThesisSeal", async () => {
  const hash = await wallet.deployContract({ abi: thesisSealAbi, bytecode: thesisSealBytecode, args: [relayer.address] });
  const address = (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;

  const c = splitCommitments(spec, { owner: owner.address });
  const now = BigInt((await pub.getBlock()).timestamp);
  const stamp: Stamp = {
    owner: owner.address,
    entryHash: c.entryHash,
    exitHash: c.exitHash,
    sealed: true,
    expiresAt: now + 30n * 86400n,
    nonce: randomNonce(),
    deadline: now + 600n,
  };
  const sig = await owner.signTypedData(stampTypedData(chain.id, address, stamp));

  // Anyone may relay: the relayer, not the owner, sends the transaction.
  const sealTx = await wallet.writeContract({ address, abi: thesisSealAbi, functionName: "seal", args: [stampTuple(stamp), sig] });
  const [sealed] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: (await pub.waitForTransactionReceipt({ hash: sealTx })).logs });
  expect(sealed.args.owner).toBe(owner.address);
  const id = sealed.args.id;

  // The same signature can't be replayed (nonce used).
  await expect(
    wallet.writeContract({ address, abi: thesisSealAbi, functionName: "seal", args: [stampTuple(stamp), sig] }),
  ).rejects.toThrow();

  const revealE = await wallet.writeContract({
    address,
    abi: thesisSealAbi,
    functionName: "revealEntry",
    args: [id, toHex(c.canonicalEntry), c.saltE, REVEAL_KIND.MANUAL_NO_TRADE],
  });
  const [entry] = parseEventLogs({ abi: thesisSealAbi, eventName: "EntryRevealed", logs: (await pub.waitForTransactionReceipt({ hash: revealE })).logs });
  expect(entry.args.canonicalEntry).toBe(toHex(c.canonicalEntry));

  const revealX = await wallet.writeContract({
    address,
    abi: thesisSealAbi,
    functionName: "revealExit",
    args: [id, toHex(c.canonicalExit), c.saltX],
  });
  expect((await pub.waitForTransactionReceipt({ hash: revealX })).status).toBe("success");

  // A wrong salt is refused by the contract.
  const other = splitCommitments(spec, { owner: owner.address });
  const stamp2 = { ...stamp, entryHash: other.entryHash, exitHash: other.exitHash, nonce: randomNonce() };
  const sig2 = await owner.signTypedData(stampTypedData(chain.id, address, stamp2));
  const tx2 = await wallet.writeContract({ address, abi: thesisSealAbi, functionName: "seal", args: [stampTuple(stamp2), sig2] });
  const [s2] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: (await pub.waitForTransactionReceipt({ hash: tx2 })).logs });
  await expect(
    wallet.writeContract({
      address,
      abi: thesisSealAbi,
      functionName: "revealEntry",
      args: [s2.args.id, toHex(other.canonicalEntry), c.saltE, REVEAL_KIND.MANUAL_NO_TRADE],
    }),
  ).rejects.toThrow();

  // A copier seals the owner's hashes under its own key; the owner's public preimage doesn't verify.
  const copy = { ...stamp, owner: copier.address, nonce: randomNonce() };
  const sig3 = await copier.signTypedData(stampTypedData(chain.id, address, copy));
  const tx3 = await wallet.writeContract({ address, abi: thesisSealAbi, functionName: "seal", args: [stampTuple(copy), sig3] });
  const [s3] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: (await pub.waitForTransactionReceipt({ hash: tx3 })).logs });
  await expect(
    wallet.writeContract({ address, abi: thesisSealAbi, functionName: "revealExit", args: [s3.args.id, toHex(c.canonicalExit), c.saltX] }),
  ).rejects.toThrow(/HashMismatch/);
}, 30_000);
