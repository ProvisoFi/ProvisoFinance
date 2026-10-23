"use client";
// Dry Run: try a rule on the last 90 days and on live prices before trusting it. No wallet, key or
// deposit; nothing is stored on the server. Save keeps it as a paper draft; Make it real opens it live.
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { isPreIpo } from "@proviso/dsl";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { dollars, formatCondition, newThesis, toSpec, type Thesis } from "@/lib/proviso/domain";
import { Icon } from "@/views/proviso/shared";
import { useWorkspace } from "./provider";
import { Note, PageTitle, Panel, Tag } from "./ui";

const MARKETS: [string, string][] = [
  ["GOLD", "xyz:GOLD"],
  ["OIL", "xyz:CL"],
  ["NVDA", "xyz:NVDA"],
  ["S&P 500", "xyz:SP500"],
  ["SILVER", "xyz:SILVER"],
  ["SK HYNIX", "xyz:SKHX"],
  ["PRE-IPO · JIO", "xyz:JIO"],
  ["BTC", "BTC"],
];
const MAX_LEV = 5;
const levCap = (coin: string) => (isPreIpo(coin) ? 2 : MAX_LEV);

type Stats = { mark: number | null; weekHigh: number | null; weekLow: number | null; change24hPct: number | null; days: number };
type Result = {
  days: number;
  fires: number;
  trades: number;
  sizeUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  score: number;
  feesUsd: number;
  fundingUsd: number;
  winRate: number | null;
  curve: { t: number; returnPct: number }[];
  noData: string[];
  fillModel: string;
};

const px = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 10 ? n.toFixed(2) : n.toPrecision(4));
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Starter ideas for a market, their numbers filled from its last week. */
function ideas(coin: string, s: Stats | undefined): { name: string; text: string; thesis: Thesis }[] {
  const base = (title: string, patch: Partial<Thesis>): Thesis => ({
    ...newThesis(),
    title,
    market: coin,
    side: "long",
    leverage: Math.min(2, levCap(coin)),
    allocation: 1000,
    stop: 3,
    take: 6,
    intent: "paper",
    fire: "once",
    expiryDays: 30,
    cooldownMinutes: 60,
    ...patch,
  });
  const out = [
    { name: "Dip buy", text: "Falls 3% in a day: buy the dip", thesis: base("Dip buy", { conditions: [{ id: "c1", signal: "change", op: "<=", value: -3 }], take: 5 }) },
    { name: "Spike fade", text: "Jumps 4% in a day: fade it", thesis: base("Spike fade", { side: "short", conditions: [{ id: "c1", signal: "change", op: ">=", value: 4 }], take: 5 }) },
    { name: "Paid to wait", text: "Funding turns negative: go long and get paid", thesis: base("Paid to wait", { conditions: [{ id: "c1", signal: "funding", op: "<", value: 0 }], stop: 4 }) },
  ];
  if (s?.weekHigh)
    out.unshift({
      name: "Weekly-high breakout",
      text: `Breaks this week's high ($${px(s.weekHigh)}): ride it`,
      thesis: base("Weekly-high breakout", { conditions: [{ id: "c1", signal: "price", op: ">", value: Number(s.weekHigh.toFixed(2)) }] }),
    });
  return out;
}

/** The return line: cumulative realized return after each closed trade. */
function Curve({ points }: { points: { t: number; returnPct: number }[] }) {
  if (points.length < 1) return <div className="w-dry-curve empty">No closed trades to draw.</div>;
  const ys = [0, ...points.map((p) => p.returnPct)];
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const d = ys.map((y, i) => `${i ? "L" : "M"}${((i / (ys.length - 1 || 1)) * 300).toFixed(1)},${(90 - ((y - lo) / span) * 80).toFixed(1)}`).join(" ");
  const zero = 90 - ((0 - lo) / span) * 80;
  return (
    <svg className="w-dry-curve" viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Return after each closed trade">
      <line x1="0" x2="300" y1={zero} y2={zero} className="zero" />
      <path d={d} />
    </svg>
  );
}

export function DryRun() {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const router = useRouter();
  const { saveDraft } = useWorkspace();
  const [coin, setCoin] = useState("xyz:GOLD");
  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "try" | "draft">("");
  const [error, setError] = useState("");
  const [run, setRun] = useState<{ rule: string; result: Result; spec: ReturnType<typeof toSpec> } | null>(null);
  const stats = useQuery(trpc.dryRun.market.queryOptions({ coin }, { staleTime: 600_000 }));
  const now = useQuery({ ...trpc.dryRun.now.queryOptions({ spec: run?.spec as never }), enabled: !!run, refetchInterval: 15_000 });

  const pick = (t: Thesis) => {
    setThesis(t);
    setRun(null);
    setError("");
  };
  const edit = (patch: Partial<Thesis>) => thesis && pick({ ...thesis, ...patch });

  const tryIt = async (t = thesis) => {
    if (!t) return;
    setBusy("try");
    setError("");
    try {
      const spec = toSpec(t);
      const r = await api.dryRun.try.mutate({ spec });
      setRun({ ...r, spec });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The Dry Run failed.");
    } finally {
      setBusy("");
    }
  };

  const write = async () => {
    setBusy("draft");
    setError("");
    try {
      const d = await api.dryRun.draft.mutate({ text }, { signal: AbortSignal.timeout(130_000) });
      if (d.unsupported.length) throw new Error(`Not supported yet: ${d.unsupported.join("; ")}`);
      const first = d.spec.entry.then.find((a) => a.venue === "hl");
      const t: Thesis = { ...newThesis(), title: text.slice(0, 60), market: first?.coin ?? coin, intent: "paper", spec: d.spec };
      pick(t);
      await tryIt(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rule writer is unavailable.");
    } finally {
      setBusy("");
    }
  };

  /** Saves the rule as a draft (paper or live) and opens it in the composer to seal. */
  const keep = (intent: "paper" | "live") => {
    if (!thesis) return;
    const id = crypto.randomUUID();
    const draft: Thesis = { ...thesis, id, intent, ...(thesis.spec && { spec: { ...thesis.spec, mode: intent } }) };
    if (saveDraft(draft)) router.push(`/dashboard/compose/?draft=${id}`);
  };

  const s = stats.data;
  const r = run?.result;
  const cap = thesis ? levCap(thesis.market) : MAX_LEV;
  return (
    <>
      <PageTitle
        index="DRY RUN"
        title="Try the call before you trust it."
        description="Pick a market and an idea. See what it would have done over the last 90 days, and whether it would fire right now. No wallet, no deposit."
      />
      <div className="w-dry">
        <Panel light label="1 / MARKET" icon="signal">
          <div className="w-dry-chips" role="group" aria-label="Market">
            {MARKETS.map(([label, c]) => (
              <button key={c} type="button" aria-pressed={c === coin} onClick={() => { setCoin(c); setThesis(null); setRun(null); }}>
                {label}
              </button>
            ))}
          </div>
          <p className="w-note">
            {stats.isLoading
              ? "Loading the last 90 days…"
              : s?.mark != null
                ? `Last $${px(s.mark)} · 24h ${s.change24hPct == null ? "—" : pct(s.change24hPct)} · week $${px(s.weekLow!)} – $${px(s.weekHigh!)} · ${s.days} days of history`
                : "No history for this market right now."}
          </p>

          <span className="w-label">2 / AN IDEA</span>
          <div className="w-templates-grid">
            {ideas(coin, s).map((i) => (
              <button key={i.name} type="button" className="w-template" aria-pressed={thesis?.title === i.name && !thesis.spec} onClick={() => pick(i.thesis)}>
                <strong>{i.name}</strong>
                <span>{i.text}</span>
              </button>
            ))}
          </div>
          <label className="w-label" htmlFor="dry-text">OR SAY IT IN YOUR WORDS</label>
          <textarea id="dry-text" className="w-dry-text" value={text} maxLength={2000} placeholder="Buy gold if it breaks $4,300 with 2x, stop 3%, take 6%" onChange={(e) => setText(e.target.value)} />
          <button type="button" className="w-button secondary" disabled={text.trim().length < 3 || !!busy} onClick={write}>
            {busy === "draft" ? "Writing the rule…" : "Write it as a rule"} <Icon name="arrow" size={16} />
          </button>

          {thesis && (
            <>
              <span className="w-label">3 / THE RULE</span>
              {thesis.spec ? (
                <p className="w-note">Written from your words: the read-back below shows exactly what runs.</p>
              ) : (
                <>
                  <dl className="w-dry-rule">
                    <dt>WHEN</dt>
                    <dd>{thesis.conditions.map((c) => formatCondition(c, thesis.market)).join(thesis.match === "all" ? " and " : " or ")}</dd>
                    <dt>THEN</dt>
                    <dd>
                      {thesis.side === "long" ? "Buy" : "Short"} {dollars(thesis.allocation)} of {thesis.market} at {thesis.leverage}×
                    </dd>
                    <dt>EXIT</dt>
                    <dd>Stop −{thesis.stop}%, take +{thesis.take}%</dd>
                  </dl>
                  <div className="w-form-grid">
                    <label className="w-field">
                      Side
                      <select value={thesis.side} onChange={(e) => edit({ side: e.target.value as Thesis["side"] })}>
                        <option value="long">Long</option>
                        <option value="short">Short</option>
                      </select>
                    </label>
                    <label className="w-field">
                      Leverage · up to {cap}×
                      <input type="number" min="1" max={cap} value={thesis.leverage} onChange={(e) => edit({ leverage: Math.max(1, Math.min(cap, Number(e.target.value) || 1)) })} />
                    </label>
                    <label className="w-field">
                      Size · USD
                      <input type="number" min="10" max="100000" value={thesis.allocation} onChange={(e) => edit({ allocation: Number(e.target.value) })} />
                    </label>
                    <label className="w-field">
                      Stop · %
                      <input type="number" min="0.5" max="50" step="0.5" value={thesis.stop} onChange={(e) => edit({ stop: Number(e.target.value) })} />
                    </label>
                    <label className="w-field">
                      Take · %
                      <input type="number" min="0.5" max="200" step="0.5" value={thesis.take} onChange={(e) => edit({ take: Number(e.target.value) })} />
                    </label>
                  </div>
                </>
              )}
              <button type="button" className="w-button" disabled={!!busy} onClick={() => tryIt()}>
                {busy === "try" ? "Replaying 90 days…" : "Try it"} <Icon name="arrow" size={16} />
              </button>
            </>
          )}
          {error && (
            <p className="w-errors" role="alert">
              {error}
            </p>
          )}
        </Panel>

        <div className="w-replay-visual w-dry-result">
          <div className="w-chart-top">
            <span className="w-label">LAST {r?.days ?? 90} DAYS / IF YOU HAD SEALED IT</span>
            <Tag solid={!!r}>PAPER</Tag>
          </div>
          {r && run ? (
            <>
              <p className="w-dry-readback">{run.rule}</p>
              <div className="w-dry-big">
                <div>
                  <strong className={r.returnPct >= 0 ? "up" : "down"}>{pct(r.returnPct)}</strong>
                  <small>Return on {dollars(r.sizeUsd)}</small>
                </div>
                <div>
                  <strong>−{r.maxDrawdownPct.toFixed(2)}%</strong>
                  <small>Worst drawdown</small>
                </div>
              </div>
              <Curve points={r.curve} />
              <div className="w-mini-metrics">
                <div>
                  <strong>{r.fires}</strong>
                  <small>Times it fired</small>
                </div>
                <div>
                  <strong>{r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}</strong>
                  <small>Closed in profit</small>
                </div>
                <div>
                  <strong>{r.score.toFixed(2)}</strong>
                  <small>Score (return ÷ drawdown)</small>
                </div>
              </div>
              <p className="w-note">
                Fees {dollars(r.feesUsd)} · funding {r.fundingUsd >= 0 ? "earned" : "paid"} {dollars(Math.abs(r.fundingUsd))} · re-armed a day after each fire.
                {r.noData.length > 0 && ` No history for: ${r.noData.join(", ")} (those parts never fire here).`}
              </p>
              <div className={`w-dry-live ${now.data?.state ?? "unknown"}`} role="status" aria-live="polite">
                <span className="w-label">LIVE NOW</span>
                <strong>
                  {now.isLoading
                    ? "Checking live prices…"
                    : now.data?.state === "would_fire"
                      ? "It would fire right now."
                      : now.data?.state === "waiting"
                        ? "Waiting: not true right now."
                        : "Can't tell right now (market closed or no data)."}
                </strong>
                <small>Checked every 15 seconds while this page is open.</small>
              </div>
              <div className="w-form-footer">
                <button type="button" className="w-button" onClick={() => keep("paper")}>
                  Save as a paper call <Icon name="arrow" size={16} />
                </button>
                <button type="button" className="w-button secondary" onClick={() => keep("live")}>
                  Make it real <Icon name="diagonal" size={16} />
                </button>
              </div>
            </>
          ) : (
            <div className="w-empty-chart">
              <span>+ RETURN</span>
              <div className="chart-baseline" />
              <p>
                Your 90-day result appears here.
                <br />
                <small>Pick an idea and press Try it.</small>
              </p>
            </div>
          )}
          <Note>
            Simulated on Hyperliquid&apos;s hourly history ({r?.fillModel ?? "paper-v1 replay"}). Past results don&apos;t predict future ones. Saving
            keeps the rule in this browser; it&apos;s sealed only when you seal it.
          </Note>
        </div>
      </div>
    </>
  );
}
