import { pushSubscriptions, telegramCodes, telegramLinks } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authedProcedure, router } from "../trpc";

const CODE_TTL_MS = 15 * 60_000;

export const notifyRouter = router({
  status: authedProcedure.query(async ({ ctx }) => {
    const [tg] = await ctx.db.select({ linkedAt: telegramLinks.linkedAt }).from(telegramLinks).where(eq(telegramLinks.address, ctx.auth.address));
    const push = await ctx.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions).where(eq(pushSubscriptions.address, ctx.auth.address));
    return { telegram: !!tg, pushDevices: push.length, vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null };
  }),

  subscribePush: authedProcedure
    .input(z.object({ endpoint: z.url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }))
    .mutation(async ({ ctx, input }) => {
      if (!input.endpoint.startsWith("https://")) throw new TRPCError({ code: "BAD_REQUEST", message: "Push endpoints must be https." });
      await ctx.db
        .insert(pushSubscriptions)
        .values({ endpoint: input.endpoint, address: ctx.auth.address, keys: input.keys })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { address: ctx.auth.address, keys: input.keys } });
      return { subscribed: true };
    }),

  unsubscribePush: authedProcedure.input(z.object({ endpoint: z.string().max(1000) })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, input.endpoint), eq(pushSubscriptions.address, ctx.auth.address)));
    return { unsubscribed: true };
  }),

  // One-time code for `/start <code>` in the Proviso bot; expires in 15 minutes.
  telegramLink: authedProcedure.mutation(async ({ ctx }) => {
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Telegram bot isn't set up yet." });
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
    await ctx.db.insert(telegramCodes).values({ code, address: ctx.auth.address, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    return { url: `https://t.me/${bot}?start=${code}`, expiresInMinutes: CODE_TTL_MS / 60_000 };
  }),

  unlinkTelegram: authedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(telegramLinks).where(eq(telegramLinks.address, ctx.auth.address));
    return { unlinked: true };
  }),
});
