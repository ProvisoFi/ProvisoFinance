"use client";
// Where lifecycle updates are delivered: this browser (Web Push) and/or Telegram.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Note, Panel, Tag } from "./ui";

const toKey = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export function NotificationSettings() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const status = useQuery({ ...trpc.notify.status.queryOptions(), enabled: account.status === "signed-in" });
  const [message, setMessage] = useState<string | null>(null);
  if (account.status !== "signed-in") return null;
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.notify.status.queryKey() });

  const enablePush = async () => {
    setMessage(null);
    try {
      const key = status.data?.vapidPublicKey;
      if (!key || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push isn't available in this browser.");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were not allowed.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) }));
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api.notify.subscribePush.mutate({ endpoint: json.endpoint, keys: json.keys });
      setMessage("This browser will receive updates.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Push was not enabled.");
    }
  };

  const linkTelegram = async () => {
    setMessage(null);
    try {
      const { url, expiresInMinutes } = await api.notify.telegramLink.mutate();
      window.open(url, "_blank", "noopener");
      setMessage(`Press Start in Telegram within ${expiresInMinutes} minutes to finish linking.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Telegram was not linked.");
    }
  };

  return (
    <Panel label="NOTIFICATIONS" icon="activity">
      <p>
        {status.data?.pushDevices ? <Tag solid>Push on {status.data.pushDevices} device(s)</Tag> : <Tag>Push off</Tag>}{" "}
        {status.data?.telegram ? <Tag solid>Telegram linked</Tag> : <Tag>Telegram not linked</Tag>}
      </p>
      <div className="w-review-actions">
        <button className="w-button secondary" onClick={enablePush} disabled={!status.data?.vapidPublicKey}>
          Enable browser notifications
        </button>
        {status.data?.telegram ? (
          <button className="w-button secondary" onClick={async () => (await api.notify.unlinkTelegram.mutate(), refresh())}>
            Unlink Telegram
          </button>
        ) : (
          <button className="w-button secondary" onClick={linkTelegram}>
            Link Telegram
          </button>
        )}
      </div>
      {message && <Note>{message}</Note>}
      <Note>Notifications say what happened (sealed, fired, revealed, stopped), never what a sealed rule contains.</Note>
    </Panel>
  );
}
