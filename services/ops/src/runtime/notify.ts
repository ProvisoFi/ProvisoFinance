// notify queue: Web Push to every subscription of the address, plus Telegram if linked.
// Best effort: a failed channel is logged, not retried, so other channels aren't sent twice.
import { isPushEndpoint, pushSubscriptions, telegramLinks, type Db } from "@proviso/db";
import { eq } from "drizzle-orm";
import { Api } from "grammy";
import { sendNotification } from "web-push";
import { confirmKeyboard, type ConfirmRef } from "./telegram";

export type NotifyMsg = { address: string; title: string; body: string; url?: string; confirm?: ConfirmRef }; // confirm: one-tap copy button (Telegram)
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };

export type Senders = {
  push?: (sub: Sub, payload: string) => Promise<unknown>; // rejects with { statusCode } on HTTP errors
  telegram?: (chatId: bigint, text: string, confirm?: ConfirmRef) => Promise<unknown>;
};

/** Channels whose env is set; the rest are skipped. */
export function sendersFromEnv(env = process.env): Senders {
  const s: Senders = {};
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
  if (pub && priv && subject) {
    const vapidDetails = { subject, publicKey: pub, privateKey: priv };
    s.push = (sub, payload) => sendNotification(sub, payload, { vapidDetails });
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    const api = new Api(env.TELEGRAM_BOT_TOKEN);
    s.telegram = (chatId, text, confirm) =>
      api.sendMessage(Number(chatId), text, confirm ? { reply_markup: confirmKeyboard(confirm) } : undefined);
  }
  return s;
}

const GONE = new Set([404, 410]);

/** `notify` queue: sends to every Web Push subscription of the address and to its linked Telegram chat. Failed channels are logged, not retried; gone (404/410) or unknown push endpoints are deleted. */
export const notifyHandler =
  (db: Db, senders: Senders, log = console.error) =>
  async (m: NotifyMsg) => {
    const address = m.address.toLowerCase();
    if (senders.push) {
      const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url });
      const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.address, address));
      for (const sub of subs) {
        try {
          if (!isPushEndpoint(sub.endpoint)) {
            // Only known push services are ever called; drop anything else that got stored.
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
            continue;
          }
          await senders.push({ endpoint: sub.endpoint, keys: sub.keys as Sub["keys"] }, payload);
        } catch (e) {
          if (GONE.has((e as { statusCode?: number }).statusCode ?? 0))
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
          else log(`ops: push to ${address} failed`, e);
        }
      }
    }
    if (senders.telegram) {
      const [link] = await db.select().from(telegramLinks).where(eq(telegramLinks.address, address));
      if (link) {
        const text = [m.title, m.body, m.url].filter(Boolean).join("\n");
        await senders.telegram(link.chatId, text, m.confirm).catch((e) => log(`ops: telegram to ${address} failed`, e));
      }
    }
  };
