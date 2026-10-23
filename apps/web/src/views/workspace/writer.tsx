"use client";
// The rule writer (TU-10): plain English → an exact Proviso rule, read back as cards, with one-tap
// choices for anything ambiguous and a check of what Proviso can run, before it goes to sealing.
import {
  renderAction,
  renderCondition,
  Spec,
  validate,
  type Ambiguity,
  type SpecInput,
} from "@proviso/dsl";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Icon } from "@/views/proviso/shared";
import { Note } from "./ui";

/** Ideas to try, one per kind of rule the writer handles well. */
const EXAMPLES = [
  "Buy $25 of TSLA when BTC breaks 100k, stop 5%, take 12%.",
  "If HYPE funding turns negative while price holds above $40, long HYPE 3× with $200, stop 6%, take 15%.",
  "When Fear & Greed drops below 20, alert me to long BTC 2× with $150, stop 8%, take 20%, for 2 weeks.",
];

type Draft = { spec: SpecInput; rendering: string; ambiguities: Ambiguity[]; unsupported: string[] };

/** A copy of `obj` with `value` set at `path` (the writer's JSON path into the spec). */
function setAt<T>(obj: T, path: (string | number)[], value: unknown): T {
  const out = structuredClone(obj) as Record<string | number, unknown>;
  let cur = out;
  path.forEach((k, i) => {
    if (i === path.length - 1) cur[k] = value;
    else cur = (cur[k] ??= typeof path[i + 1] === "number" ? [] : {}) as Record<string | number, unknown>;
  });
  return out as T;
}

const pct = (n: number) => `${n > 0 ? "+" : ""}${n}%`;

/** The read-back of a rule as three cards: when, then, exit. Null for a rule that doesn't parse. */
export function ReadBack({ spec }: { spec: SpecInput }) {
  const s = Spec.safeParse(spec);
  if (!s.success) return null;
  const r = s.data;
  return (
    <div className="w-readback">
      <div>
        <span className="w-label">WHEN</span>
        <p>{renderCondition(r.entry.when)}</p>
      </div>
      <div>
        <span className="w-label">THEN {r.mode === "alert" ? "· ALERT ONLY" : "· LIVE"}</span>
        {r.entry.then.map((a, i) => (
          <p key={i}>{renderAction(a)}</p>
        ))}
      </div>
      <div>
        <span className="w-label">EXIT & EXPIRY</span>
        <p>
          Stop {pct(r.exit.stop.pct)}, take {pct(r.exit.take.pct)} · expires in {r.expires}
          {r.fire === "repeat" ? ` · repeats${r.cooldown ? ` (cooldown ${r.cooldown})` : ""}` : " · fires once"}
        </p>
      </div>
    </div>
  );
}

/** The Plain English tab: write, read back, resolve, check, then hand the rule to the composer. */
export function Writer({ onUse }: { onUse: (spec: SpecInput, text: string) => void }) {
  const account = useAccount();
  const api = useTRPCClient();
  const trpc = useTRPC();
  const signedIn = account.status === "signed-in";
  const ctx = useQuery({ ...trpc.market.validationContext.queryOptions(), enabled: signedIn });
  const [text, setText] = useState(EXAMPLES[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [choice, setChoice] = useState<number[]>([]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const write = async () => {
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      // A cut connection must end in an error, not a spinner (the server allows 120 s).
      const d = (await api.idea.draft.mutate({ text }, { signal: AbortSignal.timeout(130_000) })) as Draft;
      setDraft(d);
      setChoice(d.ambiguities.map(() => 0)); // the writer put option 0 into the spec
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /abort/i.test(e.message));
      setError(timedOut ? "The rule writer took too long. Try again, or shorten the idea." : e instanceof Error ? e.message : "The rule writer is unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const spec = draft
    ? draft.ambiguities.reduce((s, a, i) => setAt(s, a.path, a.options[choice[i] ?? 0]!.value), draft.spec)
    : null;
  const check = spec && ctx.data ? validate(spec, ctx.data) : null;
  const ok = !!check?.ok && (draft?.unsupported.length ?? 0) === 0;

  return (
    <div className="w-english w-writer">
      <label className="w-label" htmlFor="idea-text">
        YOUR IDEA, IN YOUR WORDS
      </label>
      <textarea
        id="idea-text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDraft(null);
        }}
        maxLength={2000} // = MAX_IDEA_CHARS in packages/api/src/writer.ts
      />
      <div className="w-writer-examples" aria-label="Example ideas">
        {EXAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => {
              setText(x);
              setDraft(null);
            }}
          >
            {x}
          </button>
        ))}
      </div>
      {!signedIn ? (
        <Note>Sign in to use the rule writer. The rule builder works without signing in.</Note>
      ) : (
        <button className="w-button" disabled={busy || text.trim().length < 3} onClick={write}>
          {busy ? `Reading your idea… ${elapsed}s` : "Write my rule"} <Icon name="arrow" size={17} />
        </button>
      )}
      {busy && <Note>The writer reads your idea and builds the exact rule. This usually takes 15–40 seconds.</Note>}
      {error && (
        <div className="w-errors" role="alert">
          <p>{error}</p>
        </div>
      )}
      {draft && spec && (
        <div className="w-writer-result" aria-live="polite">
          <span className="w-label">READ BACK</span>
          <ReadBack spec={spec} />
          {draft.ambiguities.length > 0 && (
            <div className="w-ambiguities">
              <span className="w-label">YOUR WORDS LEFT A CHOICE · TAP ONE</span>
              {draft.ambiguities.map((a, i) => (
                <div key={i} className="w-ambiguity">
                  <q>{a.phrase}</q>
                  <div>
                    {a.options.map((o, j) => (
                      <button
                        key={j}
                        type="button"
                        aria-pressed={(choice[i] ?? 0) === j}
                        onClick={() => setChoice((c) => c.map((v, k) => (k === i ? j : v)))}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {draft.unsupported.length > 0 && (
            <Note>Proviso can&apos;t express these parts yet, so they were left out: {draft.unsupported.join("; ")}.</Note>
          )}
          <div className="w-writer-checks">
            {!check ? (
              <p>Checking markets and your limits…</p>
            ) : check.ok ? (
              <p className="ok">
                <Icon name="check" size={15} /> Every part is something Proviso can run, within your limits.
              </p>
            ) : (
              check.errors.map((e, i) => (
                <p key={i} className="no">
                  <Icon name="close" size={15} /> {e.message}
                </p>
              ))
            )}
          </div>
          <button className="w-button" disabled={!ok} onClick={() => onUse(spec, text)}>
            Use this rule <Icon name="arrow" size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
