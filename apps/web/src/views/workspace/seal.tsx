"use client";
import { chainConfig, network } from "@proviso/chain";
import { Spec } from "@proviso/dsl";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPCClient } from "@/lib/backend/api";
import { sealIdea, SponsorRefused, type SealResult, type SealStep } from "@/lib/backend/sealer";
import { toSpec, type Thesis } from "@/lib/proviso/domain";
import { Icon } from "@/views/proviso/shared";
import { ShareCall } from "./share-call";
import { Note } from "./ui";

const stepText: Record<SealStep, string> = {
  attesting: "Checking the evaluator enclave's attestation…",
  signing: "Waiting for your stamp signature…",
  backup: "Waiting for your backup-key signature…",
  submitting: "Submitting the signed stamp…",
  relaying: `Relaying to ${chainConfig().label}…`,
  "self-sealing": "Waiting for your seal transaction…",
  sealed: `Sealed on ${chainConfig().label}.`,
};

// Seals a saved draft: commitments and signatures are made here in the browser; the server
// only ever receives hashes, the owner's signature and the spec encrypted to the enclave.
export function SealPanel({ thesis, saved }: { thesis: Thesis; saved: boolean }) {
  const account = useAccount();
  const api = useTRPCClient();
  const [step, setStep] = useState<SealStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SealResult | null>(null);
  const [selfSeal, setSelfSeal] = useState<(() => Promise<SealResult>) | null>(null);

  if (account.status === "unavailable") return null;
  if (account.status !== "signed-in")
    return <Note>Sign in with your wallet to seal this thesis on {chainConfig().label}.</Note>;

  const parsed = Spec.safeParse(toSpec(thesis));
  const busy = step !== null && step !== "sealed" && !error;

  // `retry`: offered again when this attempt fails (a self-sent seal the wallet couldn't pay for, say).
  const attempt = async (go: () => Promise<SealResult>, retry: (() => Promise<SealResult>) | null = null) => {
    setError(null);
    setResult(null);
    setSelfSeal(null);
    try {
      setResult(await go());
    } catch (e) {
      setSelfSeal(() => (e instanceof SponsorRefused ? e.selfSeal : retry));
      setError(e instanceof Error ? e.message : "Sealing was not completed.");
    }
  };
  const run = () =>
    attempt(async () => {
      const provider = await account.provider();
      if (!provider || !account.address || !parsed.success) throw new Error("Wallet or rule is not ready.");
      return sealIdea({ spec: parsed.data, provider, address: account.address, api, onStep: setStep });
    });

  return (
    <div className="w-seal" aria-live="polite">
      <button className="w-button" disabled={!saved || busy || !parsed.success} onClick={run}>
        Seal on {network() === "mainnet" ? "Robinhood Chain" : "testnet"} <Icon name="check" size={17} />
      </button>
      {!saved && <Note>Save the thesis before sealing it.</Note>}
      {step && !error && <Note>{stepText[step]}</Note>}
      {result && (
        <>
          <Note>
            Thesis #{result.thesisId} is sealed. Keep the downloaded backup file: with your wallet it is the only
            way to recover this rule.
          </Note>
          <ShareCall id={result.thesisId} state={parsed.success && parsed.data.mode === "alert" ? "alert" : "live"} />
        </>
      )}
      {error && <Note>Not sealed: {error}</Note>}
      {selfSeal && error && (
        <button className="w-button" onClick={() => attempt(selfSeal, selfSeal)}>
          Send the seal from my wallet (you pay the gas, about 0.000003 ETH)
        </button>
      )}
    </div>
  );
}
