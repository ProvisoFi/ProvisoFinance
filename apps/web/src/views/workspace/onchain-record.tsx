"use client";
// The signed-in caller's public record, built from stamps and reveals (testnet).
import Link from "next/link";
import { paperNudge } from "@/lib/proviso/call";
import { DisplayNameEditor } from "./display-name";
import { Icon } from "@/views/proviso/shared";
import { ShareCall } from "./share-call";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chainConfig, thesisSealAbi } from "@proviso/chain";
import { useState, type ReactNode } from "react";
import { createPublicClient, createWalletClient, custom, getAddress, http, type Address } from "viem";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Empty, Note, Panel, Tag } from "./ui";

/** Why an idea can't be retired (ThesisSeal.retire: not retired, entry not revealed, not expired). */
const notRetirable = (state: string) =>
  state === "fired" || state === "closed"
    ? "Fired: its entry is already public, so it can't be retired."
    : state === "retired"
      ? "Already retired."
      : state === "expired"
        ? "Expired."
        : state === "stopped"
          ? "Stopped."
          : null;

const tx = (hash: string | null | undefined) =>
  hash ? (
    <a href={`${chainConfig().chain.blockExplorers?.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">
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
    setMsg("Confirm the retire transaction in your wallet…");
    try {
      const provider = await account.provider();
      if (!provider || !account.address) throw new Error("Wallet is not ready.");
      const { address } = await api.idea.sealTarget.query();
      const chain = chainConfig().chain;
      const wallet = createWalletClient({ account: getAddress(account.address), chain, transport: custom(provider) });
      await wallet.switchChain({ id: chain.id }).catch(async () => {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      });
      const tx = await wallet.writeContract({ address: address as Address, abi: thesisSealAbi, functionName: "retire", args: [BigInt(id)] });
      setMsg("Waiting for the chain…");
      await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash: tx });
      await api.idea.retired.mutate({ id, tx });
      setMsg("Retired.");
      await qc.invalidateQueries({ queryKey: trpc.records.get.queryKey() });
    } catch (e) {
      setMsg(e instanceof Error ? `Not retired: ${e.message}` : "Not retired.");
    }
  };
  return (
    <>
      <button className="w-button secondary" onClick={retire}>
        Retire thesis #{id}
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

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  return (
    <Panel label={`ON-CHAIN RECORD / ${chainConfig().label.toUpperCase()}`} icon="records">
      <Note>
        Ideas sealed by {short(account.address!)}. Ideas sealed with another sign-in (email or MetaMask) show when you sign in
        with it.
      </Note>
      <a className="w-text-link" href={`/c/${account.address!.toLowerCase()}/`} target="_blank" rel="noopener noreferrer">
        Your public record <Icon name="diagonal" size={14} />
      </a>
      <DisplayNameEditor />
      {record.isPending && <Note>Loading your sealed ideas…</Note>}
      {record.error && <Note>The record could not be loaded: {record.error.message}</Note>}
      {record.data && record.data.ideas.length === 0 && (
        <Empty icon="records" title="No sealed ideas yet." body="Seal a saved thesis from the composer to start your record." />
      )}
      <div className="w-onchain-list">
        {record.data?.ideas.map((i) => {
          const why = notRetirable(i.state);
          const rows: [string, ReactNode][] = [
            ["Signed", new Date(i.signedAt).toLocaleString()],
            ["Stamped", new Date(i.stampedAt).toLocaleString()],
            ["Expires", new Date(i.expiresAt).toLocaleDateString()],
            ["Seal tx", tx(i.sealTx)],
            [
              "Entry",
              i.entryReveal?.revealedAt ? (
                <>
                  revealed ({i.entryReveal.kind}) {tx(i.entryReveal.tx)}
                </>
              ) : i.entryReveal?.overdue ? (
                "unrevealed after expiry"
              ) : (
                "sealed"
              ),
            ],
            ["Exit", i.exitReveal?.revealedAt ? "revealed" : "sealed"],
            ["Fires / stamps", `${i.fires.length} / ${i.stampCount}${i.sequenceGaps.length ? ` (missing #${i.sequenceGaps.join(", #")})` : ""}`],
            ...(i.callerToFollowerRatio != null ? ([["Follower / caller size", i.callerToFollowerRatio.toFixed(2)]] as [string, ReactNode][]) : []),
          ];
          return (
            <article key={i.id} className="w-onchain-card">
              <header>
                <strong>Thesis #{i.id}</strong>
                <span className="w-onchain-tags">
                  <Tag solid>{i.state}</Tag> <Tag>{i.mode}</Tag>
                  {i.flags.map((f) => (
                    <Tag key={f}>{f.replaceAll("_", " ")}</Tag>
                  ))}
                </span>
              </header>
              <dl className="w-onchain-facts">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {paperNudge(i) && (
                <p className="w-dry-nudge">
                  {paperNudge(i)} <Link href="/dashboard/dry-run/">Open Dry Run</Link>
                </p>
              )}
              <footer>
                {why ? <Note>{why}</Note> : <RetireButton id={i.id} />}
                <ShareCall id={i.id} state={i.state} mode={i.mode} />
              </footer>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}
