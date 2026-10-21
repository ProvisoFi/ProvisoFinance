"use client";
// Runs a 90-day replay inside the evaluator enclave: the draft is sealed to the attested
// enclave key here, so the server never sees it in plaintext.
import { newSalt, Spec } from "@proviso/dsl";
import { sealSpec, verifyAttestation } from "@proviso/seal";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPCClient } from "@/lib/backend/api";
import { toSpec, type Thesis } from "@/lib/proviso/domain";
import { Icon } from "@/views/proviso/shared";
import { Note } from "./ui";

type Result = {
  fires?: unknown[];
  totalPnlUsd?: number;
  maxDrawdownUsd?: number;
  coverage?: { input: string; supported: boolean }[];
  unsimulated?: string[];
  error?: string;
};

const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const usd = (n?: number) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));

export function RunReplay({ draft, slippageBps, onFallback }: { draft: Thesis; slippageBps: number; onFallback: () => void }) {
  const account = useAccount();
  const api = useTRPCClient();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [out, setOut] = useState<{ testId: string; result: Result } | null>(null);

  if (account.status !== "signed-in")
    return (
      <button className="w-button" onClick={onFallback}>
        Run replay <Icon name="play" size={14} />
      </button>
    );

  const run = async () => {
    setState("running");
    setMessage("Sealing the rule to the tester enclave…");
    setOut(null);
    try {
      const spec = Spec.parse(toSpec(draft));
      const key = await verifyAttestation(await api.idea.attestation.query());
      const [saltE, saltX] = [newSalt(), newSalt()];
      const { requestId } = await api.idea.test.mutate({
        encSpec: b64(sealSpec(key, { v: 1, spec, saltE, saltX })),
        days: 90,
        slippageBps,
      });
      setMessage("Replaying 90 days of recorded market data…");
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const r = await api.idea.testResult.query({ requestId });
        if (r.status === "done" && "testId" in r) {
          setOut({ testId: r.testId, result: (r.result ?? {}) as Result });
          setState("done");
          return;
        }
        if (r.status === "failed") throw new Error(((r as { result?: Result }).result?.error) ?? "The replay failed.");
      }
      throw new Error("The tester is still busy; try again shortly.");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "The replay was not completed.");
    }
  };

  const unsupported = out?.result.coverage?.filter((c) => !c.supported).map((c) => c.input) ?? [];
  return (
    <div aria-live="polite">
      <button className="w-button" disabled={state === "running"} onClick={run}>
        Run replay <Icon name="play" size={14} />
      </button>
      {state !== "idle" && state !== "done" && <Note>{message}</Note>}
      {out && (
        <Note>
          {out.result.fires?.length ?? 0} firing events · net P&L {usd(out.result.totalPnlUsd)} · max drawdown{" "}
          {usd(out.result.maxDrawdownUsd)} · test ID {out.testId.slice(0, 16)}…
          {unsupported.length > 0 && ` · not covered by the data: ${unsupported.join(", ")}`}
        </Note>
      )}
    </div>
  );
}
