"use client";
// Signed-in overview of what the server knows: sealed ideas, the Hyperliquid testnet agent,
// notification channels and the network. Each line loads and fails on its own.
import { useQuery } from "@tanstack/react-query";
import { robinhoodTestnet } from "@proviso/chain";
import { useAccount } from "@/lib/backend/account";
import { useTRPC } from "@/lib/backend/api";
import { DefinitionList, Panel } from "./ui";

type Q<T> = { isPending: boolean; error: { message: string } | null; data: T | undefined };
const show = <T,>(q: Q<T>, text: (d: T) => string) =>
  q.error ? `Not loaded: ${q.error.message}` : q.isPending || q.data === undefined ? "Loading…" : text(q.data);

export function LiveStatus() {
  const signedIn = useAccount().status === "signed-in";
  const trpc = useTRPC();
  const ideas = useQuery({ ...trpc.idea.mine.queryOptions(), enabled: signedIn });
  const hl = useQuery({ ...trpc.hl.status.queryOptions(), enabled: signedIn });
  const notify = useQuery({ ...trpc.notify.status.queryOptions(), enabled: signedIn });
  if (!signedIn) return null;

  return (
    <Panel label="LIVE / TESTNET ACCOUNT" icon="network">
      <DefinitionList
        items={[
          [
            "Sealed ideas",
            show(ideas, (list) => {
              if (!list.length) return "None yet";
              const counts = new Map<string, number>();
              for (const i of list) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
              return [...counts].map(([state, n]) => `${n} ${state}`).join(" · ");
            }),
          ],
          [
            "Hyperliquid agent",
            show(hl, (s) => {
              const now = new Date();
              const active = s.keys.find((k) => k.approvedAt && !k.revokedAt && new Date(k.validUntil) > now);
              if (active) return `v${active.version} approved until ${new Date(active.validUntil).toLocaleDateString()}`;
              return s.keys.some((k) => !k.approvedAt && !k.revokedAt) ? "Awaiting your approval" : "Not connected";
            }),
          ],
          [
            "Notifications",
            show(notify, (n) =>
              [n.pushDevices ? `Push on ${n.pushDevices} device(s)` : "Push off", n.telegram ? "Telegram linked" : "Telegram not linked"].join(" · "),
            ),
          ],
          ["Network", `${robinhoodTestnet.name} (${robinhoodTestnet.id}) · Hyperliquid ${hl.data?.network ?? "testnet"}`],
        ]}
      />
    </Panel>
  );
}
