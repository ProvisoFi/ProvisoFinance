"use client";
import { Spec } from "@proviso/dsl";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPCClient } from "@/lib/backend/api";
import { sealIdea, type SealResult, type SealStep } from "@/lib/backend/sealer";
import { toSpec, type Thesis } from "@/lib/proviso/domain";
import { Icon } from "@/views/proviso/shared";
import { Note } from "./ui";

const stepText: Record<SealStep, string> = {
  attesting: "Checking the evaluator enclave's attestation…",
  signing: "Waiting for your stamp signature…",
  backup: "Waiting for your backup-key signature…",
  submitting: "Submitting the signed stamp…",
  relaying: "Relaying to Robinhood Chain testnet…",
  sealed: "Sealed on Robinhood Chain testnet.",
};

// Seals a saved draft: commitments and signatures are made here in the browser; the server
// only ever receives hashes, the owner's signature and the spec encrypted to the enclave.
export function SealPanel({ thesis, saved }: { thesis: Thesis; saved: boolean }) {
  const account = useAccount();
  const api = useTRPCClient();
  const [step, setStep] = useState<SealStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SealResult | null>(null);

  if (account.status === "unavailable") return null;
  if (account.status !== "signed-in")
    return <Note>Sign in with your wallet to seal this thesis on Robinhood Chain testnet.</Note>;

  const parsed = Spec.safeParse(toSpec(thesis));
  const busy = step !== null && step !== "sealed" && !error;

  const run = async () => {
    setError(null);
    setResult(null);
    try {
      const provider = await account.provider();
      if (!provider || !account.address || !parsed.success) throw new Error("Wallet or rule is not ready.");
      setResult(await sealIdea({ spec: parsed.data, provider, address: account.address, api, onStep: setStep }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sealing was not completed.");
    }
  };

  return (
    <div className="w-seal" aria-live="polite">
      <button className="w-button" disabled={!saved || busy || !parsed.success} onClick={run}>
        Seal on testnet <Icon name="check" size={17} />
      </button>
      {!saved && <Note>Save the thesis before sealing it.</Note>}
      {step && !error && <Note>{stepText[step]}</Note>}
      {result && (
        <Note>
          Thesis #{result.thesisId} is sealed. Keep the downloaded backup file: with your wallet it is the only
          way to recover this rule.
        </Note>
      )}
      {error && <Note>Not sealed: {error}</Note>}
    </div>
  );
}
