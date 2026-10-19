// Telegram bot (long polling): /start <code> links a chat, /stop unlinks, /status lists live
// idea ids and states (never rule contents), and one-tap copy confirms go to the `confirm` queue.
import { follows, telegramCodes, telegramLinks, theses, type Db } from "@proviso/db";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Bot } from "grammy";

export type ConfirmRef = { followId: string; thesisId: string | number; fireId: string };
export type ConfirmMsg = { followId: string; fireId: string; address: string; at: string };

// callback_data is capped at 64 bytes: two UUIDs as raw bytes in base64url fit (2 + 43 chars).
const PREFIX = "c:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function confirmData(followId: string, fireId: string): string {
  if (!UUID.test(followId) || !UUID.test(fireId)) throw new Error("followId and fireId must be UUIDs");
  return PREFIX + Buffer.from((followId + fireId).replaceAll("-", ""), "hex").toString("base64url");
}
export function parseConfirmData(data: string): { followId: string; fireId: string } | null {
  if (!data.startsWith(PREFIX)) return null;
  const hex = Buffer.from(data.slice(PREFIX.length), "base64url").toString("hex");
  return hex.length === 64 ? { followId: toUuid(hex.slice(0, 32)), fireId: toUuid(hex.slice(32)) } : null;
}

/** Inline keyboard for a notify message that carries `confirm`. */
export const confirmKeyboard = (c: ConfirmRef) => ({
  inline_keyboard: [[{ text: `Confirm copy of idea #${c.thesisId}`, callback_data: confirmData(c.followId, c.fireId) }]],
});

/** The bits of grammy's Context the handlers use, so tests can pass plain objects. */
export type BotCtx = {
  chat?: { id: number };
  match?: string | RegExpMatchArray;
  callbackQuery?: { data?: string };
  reply(text: string): Promise<unknown>;
  answerCallbackQuery(text?: string): Promise<unknown>;
};

const LIVE = ["live", "alert"];

export function telegramHandlers(db: Db, { sendConfirm, now = () => new Date() }: { sendConfirm: (m: ConfirmMsg) => Promise<unknown>; now?: () => Date }) {
  const linkedAddress = async (chatId: number) =>
    (await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, BigInt(chatId))))[0]?.address;

  return {
    async start(ctx: BotCtx) {
      const code = typeof ctx.match === "string" ? ctx.match.trim() : "";
      if (!ctx.chat) return;
      if (!code) return void (await ctx.reply("Open the Telegram link in your Proviso settings to connect this chat."));
      const chatId = BigInt(ctx.chat.id);
      const linked = await db.transaction(async (tx) => {
        // Deleting with the expiry check makes the code single-use even under concurrent /starts.
        const [c] = await tx
          .delete(telegramCodes)
          .where(and(eq(telegramCodes.code, code), gt(telegramCodes.expiresAt, now())))
          .returning({ address: telegramCodes.address });
        if (!c) return false;
        await tx.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId)); // this chat was linked elsewhere
        await tx
          .insert(telegramLinks)
          .values({ address: c.address, chatId, linkedAt: now() })
          .onConflictDoUpdate({ target: telegramLinks.address, set: { chatId, linkedAt: now() } });
        return true;
      });
      await ctx.reply(linked ? "Linked" : "That link code is invalid or expired. Get a new one in Proviso settings.");
    },

    async stop(ctx: BotCtx) {
      if (!ctx.chat) return;
      const gone = await db.delete(telegramLinks).where(eq(telegramLinks.chatId, BigInt(ctx.chat.id))).returning();
      await ctx.reply(gone.length ? "Unlinked. You won't get messages here any more." : "This chat isn't linked.");
    },

    async status(ctx: BotCtx) {
      if (!ctx.chat) return;
      const address = await linkedAddress(ctx.chat.id);
      if (!address) return void (await ctx.reply("This chat isn't linked. Use the link in Proviso settings."));
      const live = await db
        .select({ id: theses.id, state: theses.state }) // ids and states only, never rule contents
        .from(theses)
        .where(and(eq(theses.owner, address), inArray(theses.state, LIVE)))
        .orderBy(asc(theses.id));
      await ctx.reply(live.length ? ["Live ideas:", ...live.map((t) => `#${t.id} ${t.state}`)].join("\n") : "No live ideas.");
    },

    /** Confirm button: only the linked follower of that follow can confirm. Core dedupes by (followId, fireId). */
    async callback(ctx: BotCtx) {
      const ref = parseConfirmData(ctx.callbackQuery?.data ?? "");
      const address = ref && ctx.chat ? await linkedAddress(ctx.chat.id) : undefined;
      if (!ref || !address) return void (await ctx.answerCallbackQuery("This button is no longer valid."));
      const [f] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(and(eq(follows.id, ref.followId), eq(follows.follower, address)));
      if (!f) return void (await ctx.answerCallbackQuery("This confirm isn't for the linked account."));
      await sendConfirm({ ...ref, address, at: now().toISOString() });
      await ctx.answerCallbackQuery("Confirmed");
    },
  };
}

/** Long-polling bot until `signal` aborts. */
export function startTelegramBot(
  db: Db,
  token: string,
  sendConfirm: (m: ConfirmMsg) => Promise<unknown>,
  signal: AbortSignal,
  log: (m: string, e?: unknown) => void = console.error,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const bot = new Bot(token);
  const h = telegramHandlers(db, { sendConfirm });
  bot.command("start", (ctx) => h.start(ctx));
  bot.command("stop", (ctx) => h.stop(ctx));
  bot.command("status", (ctx) => h.status(ctx));
  bot.on("callback_query:data", (ctx) => h.callback(ctx));
  bot.catch((e) => log("ops: telegram update failed", e.error));
  signal.addEventListener("abort", () => void bot.stop(), { once: true });
  return bot.start({ allowed_updates: ["message", "callback_query"] }).catch((e) => log("ops: telegram bot stopped", e));
}
