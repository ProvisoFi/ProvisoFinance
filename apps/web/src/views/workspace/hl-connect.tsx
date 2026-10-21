"use client";
// Hyperliquid onboarding (signed once by the main key): approve the enclave-held trade-only agent
// and the builder fees. Hyperliquid signs on Arbitrum One (mainnet) or Arbitrum Sepolia (testnet):
// the wallet switches to the chain id the server's typed data names.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createWalletClient, custom, getAddress, parseSignature, type TypedDataDefinition } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { network } from "@proviso/chain";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Icon } from "@/views/proviso/shared";
import { Note, Tag } from "./ui";

/** Hyperliquid follows the Robinhood Chain network (NEXT_PUBLIC_CHAIN_NETWORK). */
export const HL = network() === "mainnet" ? "Hyperliquid" : "Hyperliquid testnet";

type Step = "preparing" | "signing" | "submitting" | "done";
const stepText: Record<Step, string> = {
  preparing: "The enclave is generating your trade-only agent key…",
  signing: "Approve the agent (and builder fees) in your wallet…",
  submitting: `Sending the approvals to ${HL}…`,
  done: `${HL} is connected.`,
};

const rsv = (hex: `0x${string}`) => {
  const s = parseSignature(hex);
  return { r: s.r, s: s.s, v: Number(s.v ?? BigInt(27 + (s.yParity ?? 0))) };
};

export function HyperliquidConnect({ fallback }: { fallback: () => void }) {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const signedIn = account.status === "signed-in";
  const status = useQuery({ ...trpc.hl.status.queryOptions(), enabled: signedIn });
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn)
    return (
      <button className="w-button" onClick={fallback}>
        Connect Hyperliquid <Icon name="diagonal" size={16} />
      </button>
    );

  const active = status.data?.keys.find((k) => k.approvedAt && !k.revokedAt && new Date(k.validUntil) > new Date());
  const run = async () => {
    setError(null);
    try {
      setStep("preparing");
      const prep = await api.hl.prepareAgent.mutate();
      const provider = await account.provider();
      if (!provider || !account.address) throw new Error("Wallet is not ready.");
      const signChainId = Number((prep.agent.typedData as { domain: { chainId: number } }).domain.chainId);
      const chain = [arbitrum, arbitrumSepolia].find((c) => c.id === signChainId);
      if (!chain) throw new Error(`Unexpected Hyperliquid signing chain ${signChainId}.`);
      const wallet = createWalletClient({ account: getAddress(account.address), chain, transport: custom(provider) });
      try {
        await wallet.switchChain({ id: chain.id });
      } catch {
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      }
      setStep("signing");
      const sign = (td: unknown) => wallet.signTypedData(td as TypedDataDefinition);
      const agent = { action: prep.agent.action as unknown as Record<string, unknown>, signature: rsv(await sign(prep.agent.typedData)) };
      const builders = [];
      for (const b of prep.builders) builders.push({ action: b.action as unknown as Record<string, unknown>, signature: rsv(await sign(b.typedData)) });
      setStep("submitting");
      await api.hl.submitApprovals.mutate({ version: prep.version, agent, builders });
      setStep("done");
      await qc.invalidateQueries({ queryKey: trpc.hl.status.queryKey() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hyperliquid was not connected.");
    }
  };

  return (
    <div aria-live="polite">
      {active ? (
        <Tag solid>Agent v{active.version} approved · {status.data?.network}</Tag>
      ) : (
        <button className="w-button" disabled={step !== null && step !== "done" && !error} onClick={run}>
          Connect {HL} <Icon name="diagonal" size={16} />
        </button>
      )}
      {step && !error && <Note>{stepText[step]}</Note>}
      {error && <Note>Not connected: {error}</Note>}
    </div>
  );
}
