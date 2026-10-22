import { allowEntries, follows, theses, users } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { authedProcedure, limitedProcedure, router } from "../trpc";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());
const SizeRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), usd: z.number().positive().max(1_000_000) }),
  z.object({ kind: z.literal("ratio"), ratio: z.number().positive().max(10) }),
]);
const FollowLimits = z.object({ maxUsd: z.number().positive().max(1_000_000), maxLev: z.int().min(1).max(10) });
// A sealed idea copies automatically only inside this allow-list; otherwise it is one-tap confirm.
const SealedAllowlist = z.object({
  coins: z.array(z.string().min(1).max(32)).min(1).max(50),
  sides: z.array(z.enum(["long", "short"])).min(1),
  maxUsd: z.number().positive(),
  maxLev: z.int().min(1).max(10),
});
/** Active follows one address may hold. */
export const MAX_ACTIVE_FOLLOWS = 50;
const isUniqueViolation = (e: unknown) => {
  for (let c = e as { code?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) if (c.code === "23505") return true;
  return false;
};

/** Copy-follows: the signed-in caller follows another caller, or one of their live ideas. */
export const followRouter = router({
  /**
   * Follows `caller` (or just `thesisId`, which must be that caller's live idea) with a size rule and limits.
   * Refuses following yourself, unknown callers, duplicates (CONFLICT) and more than MAX_ACTIVE_FOLLOWS active follows.
   */
  create: limitedProcedure("follow")
    .input(
      z.object({
        caller: address,
        thesisId: z.string().regex(/^\d+$/).optional(),
        sizeRule: SizeRule,
        limits: FollowLimits,
        sealedAllowlist: SealedAllowlist.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.caller === ctx.auth.address) throw new TRPCError({ code: "BAD_REQUEST", message: "You can't follow yourself." });
      const [caller] = await ctx.db.select({ a: users.address }).from(users).where(eq(users.address, input.caller));
      if (!caller) throw new TRPCError({ code: "NOT_FOUND", message: "That caller has no Proviso record." });
      if (input.thesisId) {
        const [t] = await ctx.db.select({ owner: theses.owner, state: theses.state }).from(theses).where(eq(theses.id, BigInt(input.thesisId)));
        if (!t || t.owner !== input.caller) throw new TRPCError({ code: "NOT_FOUND", message: "That idea isn't on this caller's record." });
        if (t.state !== "live") throw new TRPCError({ code: "BAD_REQUEST", message: "Only live ideas can be followed." });
      }
      const [held] = await ctx.db.select({ n: count() }).from(follows).where(and(eq(follows.follower, ctx.auth.address), eq(follows.active, true)));
      if ((held?.n ?? 0) >= MAX_ACTIVE_FOLLOWS)
        throw new TRPCError({ code: "BAD_REQUEST", message: `You can follow up to ${MAX_ACTIVE_FOLLOWS} callers and ideas at once. Stop one first.` });
      const [row] = await ctx.db
        .insert(follows)
        .values({
          follower: ctx.auth.address,
          caller: input.caller,
          thesisId: input.thesisId ? BigInt(input.thesisId) : null,
          sizeRule: input.sizeRule,
          limits: input.limits,
          sealedAllowlist: allowEntries(input.sealedAllowlist), // stored as entries, the shape core reads (P-M1)
        })
        .returning({ id: follows.id })
        .catch((e) => {
          if (!isUniqueViolation(e)) throw e;
          throw new TRPCError({ code: "CONFLICT", message: input.thesisId ? "You already follow this idea." : "You already follow this caller." });
        });
      return { id: row.id };
    }),

  /** All of the caller's follows, active and stopped. */
  mine: authedProcedure.query(({ ctx }) => ctx.db.select().from(follows).where(eq(follows.follower, ctx.auth.address))),

  /** Deactivates one of the caller's follows; NOT_FOUND if it isn't theirs. */
  stop: authedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const out = await ctx.db
      .update(follows)
      .set({ active: false })
      .where(and(eq(follows.id, input.id), eq(follows.follower, ctx.auth.address)))
      .returning({ id: follows.id });
    if (!out.length) throw new TRPCError({ code: "NOT_FOUND" });
    return { stopped: true };
  }),
});
