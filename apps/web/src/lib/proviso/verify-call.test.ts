import { expect, test } from "bun:test";
import { thesisSealAbi } from "@proviso/chain";
import { canonicalize } from "@proviso/dsl";
import { buildHourRoot, KIND, type LeafValues } from "@proviso/ops/stamps/leaf";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodePacked, keccak256, type Address, type Hex } from "viem";
import { verifyCall, type CallFacts, type Check, type StampProof, type VerifyDeps } from "./verify-call";

const SEAL = "0x7dc7977552dcec00875e38b2cca2744919145ee3" as Address;
const ROOTS = "0xa81c8ff3cb92e15c939cb9ad644970725fd78206" as Address;
const OWNER = "0x5c1d3f8a0b6e2d4479a13b0c9e8f7d6a5b4c3e21" as Address; // random, not a real user
const SEALED_AT = 1_792_700_000;
const canonical = ("0x" + Buffer.from('{"entry":{"when":"x"}}').toString("hex")) as Hex;
const salt = ("0x" + "11".repeat(32)) as Hex;
const entryHash = keccak256(encodePacked(["address", "bytes", "bytes32"], [OWNER, canonical, salt]));
const exitHash = ("0x" + "22".repeat(32)) as Hex;
const HOUR = Math.floor((SEALED_AT + 7200) / 3600) * 3600;

/** A sealed, fired, revealed call #7 with one FIRE stamp, as Robinhood Chain and the API would show it. */
function world(o: { fireAt?: number; badSalt?: boolean; rootPosted?: boolean; wrongRoot?: boolean; enclave?: () => Promise<void> } = {}) {
  const data = { fireId: "f1", at: new Date((o.fireAt ?? SEALED_AT + 7300) * 1000).toISOString(), mark: 100, n: 1, market: "hl:BTC" };
  const values: LeafValues = [7n, 1, KIND.FIRE, keccak256(canonicalize(data))];
  const { root, tree } = buildHourRoot([values, [8n, 1, KIND.FIRE, ("0x" + "33".repeat(32)) as Hex]]);
  const proof: StampProof = { thesisId: "7", seq: 1, kind: KIND.FIRE, kindName: "FIRE", data, dataHash: values[3], leafHash: "0x", proof: tree.getProof(values) as string[], root, hourStart: HOUR, leafCount: 2 };
  const sealedLog = {
    address: SEAL,
    topics: encodeEventTopics({ abi: thesisSealAbi, eventName: "Sealed", args: { id: 7n, owner: OWNER } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint64" }], [entryHash, exitHash, true, 1_792_800_000n]),
  };
  const deps: VerifyDeps = {
    chain: {
      readContract: async ({ functionName }) =>
        functionName === "theses"
          ? [OWNER, 1_792_800_000n, 0n, true, true, false, entryHash, exitHash]
          : o.rootPosted === false
            ? ["0x" + "00".repeat(32), 0, 0n]
            : [o.wrongRoot ? "0x" + "44".repeat(32) : root, 2, BigInt(HOUR + 3700)],
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 123n, logs: [sealedLog] }),
      getBlock: async () => ({ timestamp: BigInt(SEALED_AT) }),
      getTransaction: async () => ({
        to: SEAL,
        input: encodeFunctionData({ abi: thesisSealAbi, functionName: "revealEntry", args: [7n, canonical, o.badSalt ? (("0x" + "99".repeat(32)) as Hex) : salt, 0] }),
      }),
    },
    thesisSeal: SEAL,
    stampRoots: ROOTS,
    proof: async () => proof,
    enclave: o.enclave ?? (async () => {}),
  };
  const call: CallFacts = { id: "7", owner: OWNER.toLowerCase(), sealTx: "0xseal", revealTx: "0xreveal", exitRevealTx: null, stamps: [{ seq: 1, kind: "FIRE" }] };
  return { deps, call };
}

const run = async (w: ReturnType<typeof world>) => {
  const seen: Check[] = [];
  const out = await verifyCall(w.call, w.deps, (c) => seen.push(c));
  expect(seen).toEqual(out);
  return Object.fromEntries(out.map((c) => [c.id, c.state]));
};

test("a sealed, fired and revealed call passes every check, run from chain data and math only", async () => {
  expect(await run(world())).toEqual({ seal: "pass", reveal: "pass", order: "pass", stamps: "pass", enclave: "pass" });
});

test("each kind of tampering fails its own check", async () => {
  expect((await run(world({ badSalt: true }))).reveal).toBe("fail"); // revealed rule doesn't hash to the seal
  expect((await run(world({ fireAt: SEALED_AT - 60 }))).order).toBe("fail"); // fired before it was sealed
  expect((await run(world({ wrongRoot: true }))).stamps).toBe("fail"); // the on-chain root differs
  expect((await run(world({ rootPosted: false }))).stamps).toBe("wait"); // root not posted yet
  expect((await run(world({ enclave: async () => Promise.reject(new Error("compose hash not allow-listed")) }))).enclave).toBe("fail");
  const w = world();
  w.call.owner = "0x" + "ab".repeat(20);
  expect((await run(w)).seal).toBe("fail"); // the chain says someone else owns it
});

test("an unrevealed call with no stamps says so instead of passing", async () => {
  const w = world();
  w.call = { ...w.call, revealTx: null, stamps: [] };
  expect(await run(w)).toEqual({ seal: "pass", reveal: "skip", stamps: "skip", enclave: "pass" });
});
