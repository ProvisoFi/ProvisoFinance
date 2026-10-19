"use client";
// The signed-in caller's public record, built from stamps and reveals (testnet).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { robinhoodTestnet, thesisSealAbi } from "@proviso/chain";
import { useState } from "react";
import { createPublicClient, createWalletClient, custom, getAddress, http, type Address } from "viem";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Empty, Note, Panel, Tag } from "./ui";

const tx = (hash: string | null | undefined) =>
  hash ? (
    <a href={`${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">
      {hash.slice(0, 10)}…
    </a>
  ) : (
    "—"
  );

// Retiring is the owner's own on-chain call (their wallet pays the testnet gas); the entry is
// then revealed within 24 hours and the record shows it as retired.
function RetireButton({ id }: { id: string }) {
  const account = useAccount();
  const api = useTRPCClient();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const retire = async () => {
    if (!confirm(`Retire thesis #${id}? It stops for good and its entry is revealed within 24 hours.`)) return;
    setMsg("Confirm the retire transaction in your wallet�");
    try {
      const provider = await account.provider();
      if (!provider || !account.address) throw new Error("Wallet is not ready.");
      const { address } = await api.idea.sealTarget.query();
      const wallet = createWalletClient({ account: getAddress(account.address), chain: robinhoodTestnet, transport: custom(provider) });
      await wallet.switchChain({ id: robinhoodTestnet.id }).catch(async () => {
        await wallet.addChain({ chain: robinhoodTestnet });
        await wallet.switchChain({ id: robinhoodTestnet.id });
      });
      const tx = await wallet.writeContract({ address: address as Address, abi: thesisSealAbi, functionName: "retire", args: [BigInt(id)] });
      setMsg("Waiting for the chain�");
      await createPublicClient({ chain: robinhoodTestnet, transport: http() }).waitForTransactionReceipt({ hash: tx });
      await api.idea.retired.mutate({ id, tx });
      setMsg("Retired.");
      await qc.invalidateQueries({ queryKey: trpc.records.get.queryKey() });
    } catch (e) {
      setMsg(e instanceof Error ? `Not retired: ${e.message}` : "Not retired.");
    }
  };
  return (
    <>
      <button className="w-text-link" onClick={retire}>
        Retire
      </button>
      {msg && <Note>{msg}</Note>}
    </>
  );
}

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
          {(i.state === "live" || i.state === "alert") && <RetireButton id={i.id} />}
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
