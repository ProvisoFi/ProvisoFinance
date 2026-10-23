"use client";
// Optional public profile name (shown on /c/<address>/, call cards and share cards, always with the address).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Icon } from "@/views/proviso/shared";
import { Note } from "./ui";

/** Set, change or clear the signed-in caller's display name. */
export function DisplayNameEditor() {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const account = useQuery(trpc.account.get.queryOptions());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const current = account.data?.displayName ?? null;
  useEffect(() => setName(current ?? ""), [current]);

  const save = async (value: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.account.setDisplayName.mutate({ name: value });
      await qc.invalidateQueries({ queryKey: trpc.account.get.queryKey() });
      setMsg({ ok: true, text: r.displayName ? `Your record now shows "${r.displayName}".` : "Name removed: your record shows your address." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "The name was not saved." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-display-name">
      <label className="w-field">
        Public name (optional)
        <input
          value={name}
          maxLength={24}
          placeholder="e.g. QuietTrader"
          onChange={(e) => {
            setName(e.target.value);
            setMsg(null);
          }}
        />
      </label>
      <div className="w-display-name-actions">
        <button className="w-button" disabled={busy || !name.trim() || name.trim() === current} onClick={() => save(name.trim())}>
          Save name <Icon name="check" size={15} />
        </button>
        {current && (
          <button className="w-button secondary" disabled={busy} onClick={() => save(null)}>
            Remove
          </button>
        )}
      </div>
      {msg && <Note>{msg.text}</Note>}
      <Note>
        3–24 letters, digits, _ . or -. Names aren&apos;t verified: your address stays your identity and is always shown next to the
        name.
      </Note>
    </div>
  );
}
