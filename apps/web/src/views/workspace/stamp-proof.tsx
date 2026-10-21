"use client";
// Verifies the signed-in caller's evidence stamps in the browser: the event data against its
// hash, the Merkle proof against the hour root, and that root against StampRoots on
// Robinhood Chain testnet. The server's answer is never taken as the result on its own.
import { useQuery } from "@tanstack/react-query";
import { chainConfig, deployment, stampRootsAbi } from "@proviso/chain";
import { canonicalize } from "@proviso/dsl";
// leaf.ts is browser-safe (viem + merkle-tree only).
import { verifyProof } from "@proviso/ops/stamps/leaf";
import { useState } from "react";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Empty, Note, Tag } from "./ui";

const chain = createPublicClient({ chain: chainConfig().chain, transport: http() });
const short = (h: string) => `${h.slice(0, 10)}…`;

type Outcome = "busy" | "verified" | "not-posted" | "mismatch" | "error";
type Check = { outcome: Outcome; lines: string[] };
const outcomeTag: Record<Exclude<Outcome, "busy">, string> = {
  verified: "Verified on-chain",
  "not-posted": "Root not posted yet",
  mismatch: "Mismatch",
  error: "Not checked",
};

// seqs are 1..max; records.get reports the count and the missing numbers.
const seqsOf = (count: number, gaps: number[]) =>
  Array.from({ length: count + gaps.length }, (_, i) => i + 1).filter((s) => !gaps.includes(s));

export function StampProofs() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const record = useQuery({
    ...trpc.records.get.queryOptions({ caller: account.address ?? "0x0000000000000000000000000000000000000000" }),
    enabled: account.status === "signed-in" && !!account.address,
  });

  const verify = async (thesisId: string, seq: number) => {
    const key = `${thesisId}:${seq}`;
    const lines: string[] = [];
    const set = (outcome: Outcome, line?: string) => {
      if (line) lines.push(line);
      setChecks((c) => ({ ...c, [key]: { outcome, lines: [...lines] } }));
    };
    try {
      set("busy", "Fetching the proof…");
      const p = await api.records.proof.query({ thesisId, seq });
      lines.length = 0;
      const dataOk = keccak256(canonicalize(p.data)) === p.dataHash;
      set("busy", dataOk ? `${p.kindName} event data matches its hash.` : "The event data does not match its hash.");
      const proofOk = verifyProof(p, p.root as Hex);
      set(
        "busy",
        proofOk
          ? `The proof links stamp #${seq} to hour root ${short(p.root)} (${p.leafCount} leaves).`
          : "The proof does not link this stamp to the hour root the server returned.",
      );
      if (!dataOk || !proofOk) return set("mismatch");
      const address = deployment().stampRoots;
      if (!address) throw new Error("No StampRoots address for this network.");
      set("busy", `Reading StampRoots on ${chainConfig().label}…`);
      const [root, , postedAt] = await chain.readContract({
        address,
        abi: stampRootsAbi,
        functionName: "roots",
        args: [BigInt(p.hourStart)],
      });
      lines.pop();
      const hour = new Date(p.hourStart * 1000).toLocaleString();
      if (postedAt === 0n)
        return set("not-posted", `The root for the hour starting ${hour} isn't on-chain yet. Roots are posted after each hour closes.`);
      if (root.toLowerCase() !== p.root.toLowerCase() || !verifyProof(p, root))
        return set("mismatch", `The on-chain root ${short(root)} for ${hour} differs from the proof's root ${short(p.root)}.`);
      set("verified", `The on-chain root for ${hour} matches (posted ${new Date(Number(postedAt) * 1000).toLocaleString()}).`);
    } catch (e) {
      set("error", e instanceof Error ? e.message : "The proof could not be checked.");
    }
  };

  if (record.isPending) return <Note>Loading your sealed ideas…</Note>;
  if (record.error) return <Note>Your stamps could not be loaded: {record.error.message}</Note>;
  if (!record.data.ideas.length)
    return <Empty icon="proof" title="No sealed ideas yet." body="Seal a saved thesis from the composer. Its evidence stamps appear here." />;

  return (
    <div className="w-live-list">
      {record.data.ideas.map((i) => {
        const seqs = seqsOf(i.stampCount, i.sequenceGaps);
        return (
          <div key={i.id}>
            <strong>Thesis #{i.id}</strong> <Tag>{i.state}</Tag>
            {!seqs.length && <Note>No stamps yet. A stamp is added when the idea fires, fills, exits or expires.</Note>}
            {i.sequenceGaps.length > 0 && <Note>Missing stamps: #{i.sequenceGaps.join(", #")}</Note>}
            {seqs.map((seq) => {
              const c = checks[`${i.id}:${seq}`];
              return (
                <div key={seq} aria-live="polite">
                  <span className="w-label">STAMP #{seq}</span>{" "}
                  <button className="w-text-link" disabled={c?.outcome === "busy"} onClick={() => verify(i.id, seq)}>
                    {c ? "Verify again" : "Verify"}
                  </button>{" "}
                  {c && c.outcome !== "busy" && <Tag solid={c.outcome === "verified"}>{outcomeTag[c.outcome]}</Tag>}
                  {c?.lines.map((l) => (
                    <Note key={l}>{l}</Note>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
