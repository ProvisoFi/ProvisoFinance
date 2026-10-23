"use client";
// The call page's self-check: runs every proof in the visitor's browser on page load (see verify-call.ts).
import { chainConfig, deployment } from "@proviso/chain";
import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { ApiProvider, useTRPCClient } from "@/lib/backend/api";
import { verifyCall, type CallFacts, type Check } from "@/lib/proviso/verify-call";

const MARK: Record<Check["state"], string> = { pass: "✓", fail: "✕", wait: "…", skip: "–" };

function Checks({ call }: { call: CallFacts }) {
  const api = useTRPCClient();
  const [checks, setChecks] = useState<Check[]>([]);
  const [done, setDone] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setChecks([]);
    setDone(false);
    const d = deployment();
    if (!d.thesisSeal || !d.stampRoots) return;
    void verifyCall(
      call,
      {
        chain: createPublicClient({ chain: chainConfig().chain, transport: http() }) as never,
        thesisSeal: d.thesisSeal,
        stampRoots: d.stampRoots,
        proof: (seq) => api.records.proof.query({ thesisId: call.id, seq }) as never,
        enclave: async () => {
          const { verifyAttestation } = await import("@proviso/seal"); // the TDX verifier loads only here
          await verifyAttestation(await api.idea.attestation.query());
        },
      },
      (c) => live && setChecks((x) => [...x, c]),
    ).then(() => live && setDone(true));
    return () => {
      live = false;
    };
  }, [api, call, run]);
  const failed = checks.some((c) => c.state === "fail");
  return (
    <section className="call-checks" aria-live="polite" aria-label="Checks run in your browser">
      <header>
        <span className="call-eyebrow">CHECKED IN YOUR BROWSER</span>
        <strong className={failed ? "is-fail" : done ? "is-pass" : undefined}>
          {!done ? "Checking…" : failed ? "A check failed" : "Every check passed"}
        </strong>
      </header>
      <ol>
        {checks.map((c) => (
          <li key={c.id} className={`is-${c.state}`}>
            <span aria-hidden>{MARK[c.state]}</span>
            <div>
              <b>{c.label}</b>
              <p>{c.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="call-checks-note">
        Proviso&apos;s server only points to the evidence. Your browser reads Robinhood Chain directly and does the math itself.{" "}
        {done && (
          <button type="button" onClick={() => setRun((n) => n + 1)}>
            Run again
          </button>
        )}
      </p>
    </section>
  );
}

export function CallChecks({ call }: { call: CallFacts }) {
  return (
    <ApiProvider>
      <Checks call={call} />
    </ApiProvider>
  );
}
