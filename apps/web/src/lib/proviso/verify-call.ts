// Self-checking proof (expansion §6 #8): a call page checks its own evidence in the visitor's browser.
// Proviso's server only hands over pointers (tx hashes, stamp proofs); every verdict comes from
// Robinhood Chain and from math run here:
//  1. Seal: the ThesisSeal record exists for this id and owner, and its seal tx's block time.
//  2. Sealed before it fired: the first FIRE stamp is later than that block.
//  3. Reveals: the revealed rule and salt (read from the reveal tx itself) hash to the sealed commitment.
//  4. Stamps: each stamp's data matches its hash, its Merkle proof reaches the hour root, and that
//     root is the one posted on-chain in StampRoots.
//  5. Enclave: the evaluator's Intel TDX quote verifies and runs allow-listed code.
import { canonicalize } from "@proviso/dsl";
// leaf.ts is browser-safe (viem + merkle-tree only).
import { verifyProof } from "@proviso/ops/stamps/leaf";
import { thesisSealAbi, stampRootsAbi } from "@proviso/chain";
import { decodeEventLog, decodeFunctionData, encodePacked, keccak256, type Address, type Hex } from "viem";

export type CheckState = "pass" | "fail" | "wait" | "skip";
export type Check = { id: "seal" | "order" | "reveal" | "stamps" | "enclave"; label: string; state: CheckState; detail: string };

export type CallFacts = {
  id: string;
  owner: string;
  sealTx: string | null;
  revealTx: string | null;
  exitRevealTx: string | null;
  stamps: { seq: number; kind: string }[];
};

export type StampProof = {
  thesisId: string;
  seq: number;
  kind: number;
  kindName: string;
  data: unknown;
  dataHash: string;
  leafHash: string;
  proof: string[];
  root: string;
  hourStart: number;
  leafCount: number;
};

/** What the checks read: a Robinhood Chain client, the two contracts, stamp proofs, and the enclave check. */
export type VerifyDeps = {
  chain: {
    readContract(a: { address: Address; abi: unknown; functionName: string; args: unknown[] }): Promise<unknown>;
    getTransaction(a: { hash: Hex }): Promise<{ input: Hex; to: Address | null }>;
    getTransactionReceipt(a: { hash: Hex }): Promise<{ status: string; blockNumber: bigint; logs: { address: Address; topics: Hex[]; data: Hex }[] }>;
    getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  };
  thesisSeal: Address;
  stampRoots: Address;
  proof: (seq: number) => Promise<StampProof>;
  /** Verifies the live enclave attestation; throws with the reason if it doesn't. */
  enclave: () => Promise<void>;
};

const short = (h: string) => `${h.slice(0, 10)}…`;
const when = (s: number) => new Date(s * 1000).toUTCString().replace(" GMT", " UTC");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const why = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

type OnChain = { owner: Address; entryHash: Hex; exitHash: Hex };

async function sealCheck(c: CallFacts, d: VerifyDeps): Promise<{ check: Check; onChain?: OnChain; sealedAt?: number }> {
  const label = "Sealed on Robinhood Chain";
  const t = (await d.chain.readContract({ address: d.thesisSeal, abi: thesisSealAbi, functionName: "theses", args: [BigInt(c.id)] })) as readonly [Address, bigint, bigint, boolean, boolean, boolean, Hex, Hex];
  const onChain = { owner: t[0], entryHash: t[6], exitHash: t[7] };
  if (/^0x0{40}$/i.test(t[0])) return { check: { id: "seal", label, state: "fail", detail: `ThesisSeal has no call #${c.id}.` } };
  if (!same(t[0], c.owner)) return { check: { id: "seal", label, state: "fail", detail: `ThesisSeal says call #${c.id} belongs to ${short(t[0])}, not ${short(c.owner)}.` } };
  if (!c.sealTx) return { check: { id: "seal", label, state: "pass", detail: `ThesisSeal holds call #${c.id} for ${short(t[0])} (seal transaction not indexed yet).` }, onChain };
  const r = await d.chain.getTransactionReceipt({ hash: c.sealTx as Hex });
  const sealed = r.status === "success" && r.logs.some((l) => {
    if (!same(l.address, d.thesisSeal)) return false;
    try {
      const e = decodeEventLog({ abi: thesisSealAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return e.eventName === "Sealed" && (e.args as { id: bigint }).id === BigInt(c.id);
    } catch {
      return false;
    }
  });
  if (!sealed) return { check: { id: "seal", label, state: "fail", detail: `Transaction ${short(c.sealTx)} didn't seal call #${c.id}.` }, onChain };
  const sealedAt = Number((await d.chain.getBlock({ blockNumber: r.blockNumber })).timestamp);
  return { check: { id: "seal", label, state: "pass", detail: `Sealed in block ${r.blockNumber} at ${when(sealedAt)}, owned by ${short(t[0])}. Its commitment ${short(t[6])} can't change.` }, onChain, sealedAt };
}

/** The canonical part and salt from a reveal transaction, hashed the way ThesisSeal checks them. */
async function revealHashes(tx: string, d: VerifyDeps, owner: Address, id: string) {
  const t = await d.chain.getTransaction({ hash: tx as Hex });
  if (!t.to || !same(t.to, d.thesisSeal)) throw new Error(`Transaction ${short(tx)} isn't a ThesisSeal call.`);
  const f = decodeFunctionData({ abi: thesisSealAbi, data: t.input });
  if (f.functionName !== "revealEntry" && f.functionName !== "revealExit") throw new Error(`Transaction ${short(tx)} isn't a reveal.`);
  const [rid, canonical, salt] = f.args as unknown as [bigint, Hex, Hex];
  if (rid !== BigInt(id)) throw new Error(`Transaction ${short(tx)} reveals call #${rid}, not #${id}.`);
  return { part: f.functionName === "revealEntry" ? "entry" : "exit", hash: keccak256(encodePacked(["address", "bytes", "bytes32"], [owner, canonical, salt])) };
}

async function revealCheck(c: CallFacts, d: VerifyDeps, onChain: OnChain): Promise<Check> {
  const label = "Revealed rule matches the seal";
  const txs = [c.revealTx, c.exitRevealTx].filter((x): x is string => !!x);
  if (!txs.length) return { id: "reveal", label, state: "skip", detail: "Still sealed: the rule is revealed when the call fires, expires or is retired." };
  for (const tx of txs) {
    const r = await revealHashes(tx, d, onChain.owner, c.id);
    const want = r.part === "entry" ? onChain.entryHash : onChain.exitHash;
    if (!same(r.hash, want)) return { id: "reveal", label, state: "fail", detail: `The revealed ${r.part} hashes to ${short(r.hash)}, not the sealed ${short(want)}.` };
  }
  return { id: "reveal", label, state: "pass", detail: `Re-hashed here from the reveal transaction${txs.length > 1 ? "s" : ""}: the revealed rule and salt give exactly the commitment sealed before.` };
}

async function stampChecks(c: CallFacts, d: VerifyDeps, sealedAt: number | undefined): Promise<Check[]> {
  const label = "Evidence stamps on-chain";
  if (!c.stamps.length) return [{ id: "stamps", label, state: "skip", detail: "No stamps yet: one is added when the call fires, fills, exits or expires." }];
  let ok = 0, waiting = 0;
  let firstFire: number | undefined;
  for (const s of c.stamps) {
    const p = await d.proof(s.seq);
    if (keccak256(canonicalize(p.data)) !== p.dataHash || !verifyProof({ ...p, dataHash: p.dataHash as Hex, proof: p.proof as Hex[] }, p.root as Hex))
      return [{ id: "stamps", label, state: "fail", detail: `Stamp #${s.seq} (${s.kind}) doesn't match its own proof.` }];
    const [root, , postedAt] = (await d.chain.readContract({ address: d.stampRoots, abi: stampRootsAbi, functionName: "roots", args: [BigInt(p.hourStart)] })) as readonly [Hex, number, bigint];
    if (postedAt === 0n) waiting++;
    else if (!same(root, p.root)) return [{ id: "stamps", label, state: "fail", detail: `Stamp #${s.seq}'s hour root differs from the one posted on-chain (${short(root)}).` }];
    else ok++;
    const at = Date.parse((p.data as { at?: string })?.at ?? "");
    if (p.kindName === "FIRE" && Number.isFinite(at)) firstFire = Math.min(firstFire ?? Infinity, at / 1000);
  }
  const out: Check[] = [
    {
      id: "stamps",
      label,
      state: waiting && !ok ? "wait" : "pass",
      detail: `${ok} of ${c.stamps.length} stamps proven against roots posted on Robinhood Chain${waiting ? `; ${waiting} wait for their hour's root (posted after each hour closes)` : ""}.`,
    },
  ];
  if (firstFire !== undefined && sealedAt !== undefined)
    out.unshift(
      firstFire >= sealedAt
        ? { id: "order", label: "Sealed before it fired", state: "pass", detail: `Sealed ${when(sealedAt)}; first fired ${when(firstFire)}.` }
        : { id: "order", label: "Sealed before it fired", state: "fail", detail: `The first fire stamp (${when(firstFire)}) is earlier than the seal (${when(sealedAt)}).` },
    );
  return out;
}

/** Runs every check in order, reporting each as it lands. Never throws: a failed read is a "fail" with its reason. */
export async function verifyCall(c: CallFacts, d: VerifyDeps, onCheck: (c: Check) => void): Promise<Check[]> {
  const all: Check[] = [];
  const put = (x: Check) => {
    all.push(x);
    onCheck(x);
  };
  let onChain: OnChain | undefined, sealedAt: number | undefined;
  try {
    const s = await sealCheck(c, d);
    ({ onChain, sealedAt } = s);
    put(s.check);
  } catch (e) {
    put({ id: "seal", label: "Sealed on Robinhood Chain", state: "fail", detail: `Couldn't read Robinhood Chain: ${why(e)}` });
  }
  if (onChain)
    try {
      put(await revealCheck(c, d, onChain));
    } catch (e) {
      put({ id: "reveal", label: "Revealed rule matches the seal", state: "fail", detail: why(e) });
    }
  try {
    for (const x of await stampChecks(c, d, sealedAt)) put(x);
  } catch (e) {
    put({ id: "stamps", label: "Evidence stamps on-chain", state: "fail", detail: `A stamp couldn't be checked: ${why(e)}` });
  }
  try {
    await d.enclave();
    put({ id: "enclave", label: "Enclave runs the published code", state: "pass", detail: "The evaluator's Intel TDX quote verified here, and its code hash is on Proviso's published allow-list." });
  } catch (e) {
    put({ id: "enclave", label: "Enclave runs the published code", state: "fail", detail: why(e) });
  }
  return all;
}
