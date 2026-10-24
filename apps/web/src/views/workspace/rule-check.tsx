"use client";
// The rule check before sealing (expansion section 6 #9): runs once per version of the rule in the
// read-back step. It checks the rule itself, never whether to trade.
import { useEffect, useState } from "react";
import { useTRPCClient } from "@/lib/backend/api";
import { toSpec, type Thesis } from "@/lib/proviso/domain";
import { Note, Tag } from "./ui";

type Result = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["dryRun"]["check"]["mutate"]>>;
const SOURCE = { math: "MATH", replay: "90-DAY REPLAY", ai: "AI REVIEW" } as const;

export function RuleCheck({ thesis }: { thesis: Thesis }) {
  const api = useTRPCClient();
  const key = JSON.stringify(toSpec(thesis));
  const [state, setState] = useState<{ key: string; result?: Result; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    setState({ key });
    api.dryRun.check
      .mutate({ spec: JSON.parse(key) }, { signal: AbortSignal.timeout(60_000) })
      .then((result) => live && setState({ key, result }))
      .catch((e) => live && setState({ key, error: e instanceof Error ? e.message : "The check couldn't run." }));
    return () => {
      live = false;
    };
  }, [api, key]);

  const r = state?.key === key ? state.result : undefined;
  const warns = r?.findings.filter((f) => f.level === "warn").length ?? 0;
  return (
    <section className="w-rule-check" aria-live="polite" aria-label="Rule check">
      <div className="w-rule-check-head">
        <span className="w-label">RULE CHECK BEFORE SEALING</span>
        {r && <Tag solid={warns === 0}>{warns ? `${warns} to fix` : r.findings.length ? "Notes only" : "No issues found"}</Tag>}
      </div>
      {!r && !state?.error && <Note>Checking the rule: its numbers, the last 90 days and its wording…</Note>}
      {state?.error && <Note>The check couldn&apos;t run: {state.error}</Note>}
      {r && (
        <>
          {r.findings.length > 0 && (
            <ul>
              {r.findings.map((f, i) => (
                <li key={i} className={`is-${f.level}`}>
                  <span aria-hidden>{f.level === "warn" ? "!" : "i"}</span>
                  <div>
                    <b>{f.title}</b> <small>{SOURCE[f.source]}</small>
                    <p>{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="w-rule-check-foot">
            {r.replay
              ? `Replayed over ${r.replay.days} days: fired ${r.replay.fires} time${r.replay.fires === 1 ? "" : "s"}. `
              : r.replayNote
                ? `Not replayed: ${r.replayNote}. `
                : ""}
            {r.aiChecked ? "Wording reviewed by AI." : "AI review unavailable right now; the math and replay checks still ran."} It checks the rule
            only, never whether to trade. Nothing is stored.
          </p>
        </>
      )}
    </section>
  );
}
