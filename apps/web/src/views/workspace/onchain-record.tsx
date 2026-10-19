"use client";
// The signed-in caller's public record, built from stamps and reveals (testnet).
import { useQuery } from "@tanstack/react-query";
import { robinhoodTestnet } from "@proviso/chain";
import { useAccount } from "@/lib/backend/account";
import { useTRPC } from "@/lib/backend/api";
import { Empty, Note, Panel, Tag } from "./ui";

const tx = (hash: string | null | undefined) =>
  hash ? (
    <a href={`${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">
      {hash.slice(0, 10)}…
    </a>
  ) : (
    "—"
  );

export function OnChainRecord() {
  const account = useAccount();
  const trpc = useTRPC();
  const record = useQuery({
    ...trpc.records.get.queryOptions({ caller: account.address ?? "0x0000000000000000000000000000000000000000" }),
    enabled: account.status === "signed-in" && !!account.address,
  });
  if (account.status !== "signed-in") return null;

  return (
    <Panel label="ON-CHAIN RECORD / ROBINHOOD CHAIN TESTNET" icon="records">
      {record.isPending && <Note>Loading your sealed ideas…</Note>}
      {record.error && <Note>The record could not be loaded: {record.error.message}</Note>}
      {record.data && record.data.ideas.length === 0 && (
        <Empty icon="records" title="No sealed ideas yet." body="Seal a saved thesis from the composer to start your record." />
      )}
      {record.data?.ideas.map((i) => (
        <div key={i.id} className="w-record-row">
          <strong>Thesis #{i.id}</strong> <Tag>{i.state}</Tag> <Tag>{i.mode}</Tag>
          {i.flags.map((f) => (
            <Tag key={f}>{f.replaceAll("_", " ")}</Tag>
          ))}
          <p>
            Signed {new Date(i.signedAt).toLocaleString()} · stamped {new Date(i.stampedAt).toLocaleString()} · expires{" "}
            {new Date(i.expiresAt).toLocaleDateString()} · seal {tx(i.sealTx)}
          </p>
          <p>
            Entry:{" "}
            {i.entryReveal?.revealedAt ? (
              <>
                revealed ({i.entryReveal.kind}) {tx(i.entryReveal.tx)}
              </>
            ) : i.entryReveal?.overdue ? (
              "unrevealed after expiry"
            ) : (
              "sealed"
            )}
            {" · "}Exit: {i.exitReveal?.revealedAt ? "revealed" : "sealed"}
            {" · "}Fires: {i.fires.length} · Stamps: {i.stampCount}
            {i.sequenceGaps.length > 0 && ` · missing stamps #${i.sequenceGaps.join(", #")}`}
            {i.callerToFollowerRatio != null && ` · follower/caller size ${i.callerToFollowerRatio.toFixed(2)}`}
          </p>
        </div>
      ))}
    </Panel>
  );
}
