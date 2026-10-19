"use client";
// The account's server-side limits (what market.validate and the signer read) next to the
// limits saved in this browser. Signed-out users only ever have the local ones.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { dollars, type RiskLimits } from "@/lib/proviso/domain";
import { AccountNote } from "./account-note";
import { DefinitionList, Note, Panel, Tag } from "./ui";

const keys = ["maxAllocation", "maxLeverage", "dailyLoss", "maxSlippage"] as const;
const same = (a: RiskLimits, b: RiskLimits | null | undefined) => !!b && keys.every((k) => a[k] === b[k]);

export function useAccountLimits() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const signedIn = account.status === "signed-in";
  const server = useQuery({ ...trpc.account.get.queryOptions(), enabled: signedIn });
  const [sync, setSync] = useState<{ state: "saving" | "saved" | "error"; text: string } | null>(null);
  const apply = async (limits: RiskLimits) => {
    if (!signedIn) return;
    setSync({ state: "saving", text: "Saving the limits to your account…" });
    try {
      await api.account.setLimits.mutate(limits);
      setSync({ state: "saved", text: "Your account limits are saved on the server." });
    } catch (e) {
      setSync({ state: "error", text: `Account limits not saved: ${e instanceof Error ? e.message : "unknown error"}` });
    }
    await qc.invalidateQueries({ queryKey: trpc.account.get.queryKey() });
  };
  return { signedIn, server, sync, apply };
}

export function AccountLimitsPanel({ local, account }: { local: RiskLimits; account: ReturnType<typeof useAccountLimits> }) {
  const status = useAccount().status;
  if (status === "unavailable") return null;
  const { signedIn, server, sync, apply } = account;
  const limits = server.data?.limits;
  return (
    <Panel label="ACCOUNT LIMITS / SERVER" icon="limits">
      {!signedIn && <AccountNote action="enforce these limits on your account" />}
      {signedIn && server.isPending && <Note>Loading your account limits…</Note>}
      {signedIn && server.error && <Note>Your account limits could not be loaded: {server.error.message}</Note>}
      {signedIn && server.data && (
        <>
          {limits ? (
            <DefinitionList
              items={[
                ["Maximum allocation", dollars(limits.maxAllocation)],
                ["Maximum leverage", `${limits.maxLeverage}×`],
                ["Daily loss limit", dollars(limits.dailyLoss)],
                ["Maximum slippage", `${limits.maxSlippage}%`],
              ]}
            />
          ) : (
            <Note>No limits are set on your account yet.</Note>
          )}
          {same(local, limits) ? (
            <Tag solid>Matches this browser</Tag>
          ) : (
            <>
              <Note>The limits saved in this browser differ from your account&apos;s.</Note>
              <button className="w-button secondary" disabled={sync?.state === "saving"} onClick={() => apply(local)}>
                Apply to account
              </button>
            </>
          )}
        </>
      )}
      {signedIn && sync && <Note>{sync.text}</Note>}
    </Panel>
  );
}
