"use client";
// Opt-in for call announcements on X and Telegram (expansion section 6 #2). Off unless switched on.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Note } from "./ui";

export function AnnounceSwitch() {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const account = useQuery(trpc.account.get.queryOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const since = account.data?.announceSince ? new Date(account.data.announceSince) : null;

  const set = async (on: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api.account.setAnnounce.mutate({ on });
      await qc.invalidateQueries({ queryKey: trpc.account.get.queryKey() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The setting was not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-announce">
      <label className="w-announce-row">
        <input type="checkbox" checked={!!since} disabled={busy || !account.data} onChange={(e) => set(e.target.checked)} />
        <span>
          <strong>Announce my calls on X and Telegram</strong>
          <small>
            {since
              ? `On since ${since.toLocaleString()}. Calls you seal from then on are announced.`
              : "Off. Nothing about your calls is posted."}
          </small>
        </span>
      </label>
      <Note>
        When on, Proviso&apos;s bot posts that you sealed a call, with the condition hidden, and replies with the revealed rule, the fill and
        its proof link once it fires. Only calls sealed after you switch this on are posted. Paper calls are
        marked paper. Every post says &quot;not financial advice&quot;. Switch it off any time: nothing more is posted.
      </Note>
      {error && <Note>{error}</Note>}
    </div>
  );
}
