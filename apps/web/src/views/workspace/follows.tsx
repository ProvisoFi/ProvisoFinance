"use client";
// Server-side follows (Hyperliquid): who you copy, how much, and the sealed allow-list
// that lets a sealed idea copy without a confirmation tap. Errors are the API's own words.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { dollars } from "@/lib/proviso/domain";
import { Icon } from "@/views/proviso/shared";
import { AccountNote } from "./account-note";
import { HL } from "./hl-connect";
import { DefinitionList, Empty, Note, Panel, Tag } from "./ui";

type Side = "long" | "short";
const blank = {
  caller: "",
  thesisId: "",
  sizeKind: "fixed" as "fixed" | "ratio",
  size: "",
  maxUsd: "",
  maxLev: "",
  allowlist: false,
  coins: [] as string[],
  sides: ["long", "short"] as Side[],
  alMaxUsd: "",
  alMaxLev: "",
};
const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

type SizeRule = { kind: "fixed"; usd: number } | { kind: "ratio"; ratio: number };
type Limits = { maxUsd: number; maxLev: number };
const sizeText = (r: unknown) => {
  const s = r as SizeRule;
  return s?.kind === "fixed" ? `${dollars(s.usd)} per idea` : s?.kind === "ratio" ? `${s.ratio}× the caller's size` : "—";
};

export function FollowCaller() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const signedIn = account.status === "signed-in";
  const perps = useQuery({ ...trpc.market.perps.queryOptions(), enabled: signedIn });
  const mine = useQuery({ ...trpc.follow.mine.queryOptions(), enabled: signedIn });
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (account.status === "unavailable") return null;
  if (!signedIn)
    return (
      <Panel label={`FOLLOW A CALLER / ${HL.toUpperCase()}`} icon="copy">
        <AccountNote action={`follow a caller on ${HL}`} />
      </Panel>
    );

  const update = (patch: Partial<typeof blank>) => {
    setForm({ ...form, ...patch });
    setError(null);
    setMessage(null);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.follow.mine.queryKey() });

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const size = Number(form.size);
      const { id } = await api.follow.create.mutate({
        caller: form.caller.trim(),
        thesisId: form.thesisId.trim() || undefined,
        sizeRule: form.sizeKind === "fixed" ? { kind: "fixed", usd: size } : { kind: "ratio", ratio: size },
        limits: { maxUsd: Number(form.maxUsd), maxLev: Number(form.maxLev) },
        sealedAllowlist: form.allowlist
          ? { coins: form.coins, sides: form.sides, maxUsd: Number(form.alMaxUsd), maxLev: Number(form.alMaxLev) }
          : undefined,
      });
      setMessage(`Following. Follow ${id.slice(0, 8)}… is active.`);
      setForm(blank);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The follow was not created.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    if (!confirm("Stop this follow? New ideas from this caller won't be copied.")) return;
    setError(null);
    setMessage(null);
    try {
      await api.follow.stop.mutate({ id });
      setMessage("Follow stopped.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The follow was not stopped.");
    }
  };

  return (
    <div className="w-columns two-one">
      <Panel light label={`FOLLOW A CALLER / ${HL.toUpperCase()}`} icon="copy">
        <h3>Copy one caller, on your terms.</h3>
        <p>Orders go to your own {HL} account through your trade-only agent, inside these limits.</p>
        <div className="w-form-grid">
          <label className="w-field">
            Caller address
            <input placeholder="0x…" value={form.caller} onChange={(e) => update({ caller: e.target.value })} />
          </label>
          <label className="w-field">
            Thesis ID · optional
            <input
              inputMode="numeric"
              placeholder="All of the caller's ideas"
              value={form.thesisId}
              onChange={(e) => update({ thesisId: e.target.value })}
            />
          </label>
          <label className="w-field">
            Size rule
            <select value={form.sizeKind} onChange={(e) => update({ sizeKind: e.target.value as typeof form.sizeKind })}>
              <option value="fixed">Fixed USD per idea</option>
              <option value="ratio">Ratio of the caller's size</option>
            </select>
          </label>
          <label className="w-field">
            {form.sizeKind === "fixed" ? "Size · USD" : "Ratio · ×"}
            <input type="number" min="0" step="any" value={form.size} onChange={(e) => update({ size: e.target.value })} />
          </label>
          <label className="w-field">
            Maximum per idea · USD
            <input type="number" min="1" value={form.maxUsd} onChange={(e) => update({ maxUsd: e.target.value })} />
          </label>
          <label className="w-field">
            Maximum leverage · ×
            <input type="number" min="1" max="10" step="1" value={form.maxLev} onChange={(e) => update({ maxLev: e.target.value })} />
          </label>
        </div>
        <fieldset className="w-checklist">
          <legend>Sealed ideas</legend>
          <label>
            <input type="checkbox" checked={form.allowlist} onChange={(e) => update({ allowlist: e.target.checked })} />
            Copy sealed ideas automatically inside an allow-list (otherwise each one needs your confirmation)
          </label>
        </fieldset>
        {form.allowlist && (
          <>
            <fieldset className="w-checklist">
              <legend>Allowed markets · Hyperliquid {perps.data?.network ?? "testnet"}</legend>
              {perps.isPending && <span>Loading markets…</span>}
              {perps.error && <span>Markets could not be loaded: {perps.error.message}</span>}
              {perps.data?.perps.length === 0 && <span>No markets listed.</span>}
              {perps.data?.perps.map((p) => (
                <label key={p.coin}>
                  <input
                    type="checkbox"
                    checked={form.coins.includes(p.coin)}
                    onChange={(e) => update({ coins: toggle(form.coins, p.coin, e.target.checked) })}
                  />
                  {p.coin}
                </label>
              ))}
            </fieldset>
            <fieldset className="w-checklist">
              <legend>Allowed directions</legend>
              {(["long", "short"] as const).map((s) => (
                <label key={s}>
                  <input type="checkbox" checked={form.sides.includes(s)} onChange={(e) => update({ sides: toggle(form.sides, s, e.target.checked) })} />
                  {s === "long" ? "Long" : "Short"}
                </label>
              ))}
            </fieldset>
            <div className="w-form-grid">
              <label className="w-field">
                Allow-list maximum · USD
                <input type="number" min="1" value={form.alMaxUsd} onChange={(e) => update({ alMaxUsd: e.target.value })} />
              </label>
              <label className="w-field">
                Allow-list maximum leverage · ×
                <input type="number" min="1" max="10" step="1" value={form.alMaxLev} onChange={(e) => update({ alMaxLev: e.target.value })} />
              </label>
            </div>
          </>
        )}
        {error && (
          <p className="w-errors" role="alert">
            {error}
          </p>
        )}
        <div className="w-form-footer" aria-live="polite">
          <Note>{busy ? "Creating the follow…" : (message ?? "Nothing is copied until the server confirms the follow.")}</Note>
          <button className="w-button" disabled={busy} onClick={submit}>
            Follow caller <Icon name="check" size={16} />
          </button>
        </div>
      </Panel>
      <Panel label="YOUR FOLLOWS" icon="records">
        {mine.isPending && <Note>Loading your follows…</Note>}
        {mine.error && <Note>Your follows could not be loaded: {mine.error.message}</Note>}
        {mine.data?.length === 0 && <Empty icon="copy" title="No follows yet." body="Follow a caller to copy their ideas into your own account." />}
        {mine.data && mine.data.length > 0 && (
          <div className="w-live-list">
            {mine.data.map((f) => {
              const limits = f.limits as Limits;
              return (
                <div key={f.id}>
                  <strong>{`${f.caller.slice(0, 8)}…${f.caller.slice(-4)}`}</strong> {f.active ? <Tag solid>Active</Tag> : <Tag>Stopped</Tag>}
                  <DefinitionList
                    items={[
                      ["Ideas", f.thesisId != null ? `Thesis #${f.thesisId}` : "All"],
                      ["Size", sizeText(f.sizeRule)],
                      ["Limits", `${dollars(limits.maxUsd)} · ${limits.maxLev}×`],
                      ["Sealed ideas", f.sealedAllowlist ? "Allow-list" : "Confirm each"],
                    ]}
                  />
                  {f.active && (
                    <button className="w-text-link" onClick={() => stop(f.id)}>
                      Stop following
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
