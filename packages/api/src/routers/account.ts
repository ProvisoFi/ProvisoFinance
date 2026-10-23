import { users } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authedProcedure, limitedProcedure, router } from "../trpc";

/** 3–24 letters, digits, _ . -, starting and ending with a letter or digit (same as the DB check). */
export const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,22}[A-Za-z0-9]$/;
const RESERVED = ["admin", "administrator", "official", "support", "team", "staff", "moderator", "mod", "system", "root", "security", "help", "verified"];

/** Why a display name is refused, or null when it may be used. Names are unverified, so none may pose as Proviso or an address. */
export function displayNameProblem(name: string): string | null {
  if (!DISPLAY_NAME.test(name)) return "Use 3–24 letters, digits, _ . or -, starting and ending with a letter or digit.";
  const lower = name.toLowerCase();
  if (lower.includes("proviso") || RESERVED.includes(lower)) return "That name is reserved.";
  if (lower.endsWith("-ai") || lower.endsWith("_ai") || lower.endsWith(".ai")) return "Names ending in AI are kept for Proviso Arena's AI entrants.";
  if (/^0x[0-9a-f]{3,}/.test(lower)) return "A name can't look like a wallet address.";
  return null;
}
const isUniqueViolation = (e: unknown) => {
  for (let c = e as { code?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) if (c.code === "23505") return true;
  return false;
};

// Same bounds the workspace enforces locally (RiskLimits in apps/web domain.ts).
export const limitsSchema = z.object({
  maxAllocation: z.number().positive().max(1_000_000),
  maxLeverage: z.number().int().min(1).max(10),
  dailyLoss: z.number().positive().max(1_000_000),
  maxSlippage: z.number().positive().max(2),
});

/** The signed-in caller's account: address, risk limits, builder-fee approval time. */
export const accountRouter = router({
  /** The caller's account; `limits` is null if the stored value is unset or fails `limitsSchema`. */
  get: authedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select().from(users).where(eq(users.address, ctx.auth.address));
    return {
      address: row.address,
      limits: limitsSchema.safeParse(row.limits).data ?? null,
      hlBuildersApprovedAt: row.hlBuildersApprovedAt,
      displayName: row.displayName,
      announceSince: row.announceSince,
      createdAt: row.createdAt,
    };
  }),
  /**
   * Opts in or out of call announcements (the X / Telegram bot). Off by default. Switching on
   * records the moment, so only calls sealed after it are ever posted; switching off stops posts at once.
   */
  setAnnounce: limitedProcedure("announce")
    .input(z.object({ on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db.select({ since: users.announceSince }).from(users).where(eq(users.address, ctx.auth.address));
      const since = input.on ? (row?.since ?? new Date()) : null; // switching on again keeps the first moment
      await ctx.db.update(users).set({ announceSince: since }).where(eq(users.address, ctx.auth.address));
      return { announceSince: since };
    }),
  /** Sets or clears (null) the caller's public profile name; refuses invalid, reserved or taken names (CONFLICT). */
  setDisplayName: limitedProcedure("displayName")
    .input(z.object({ name: z.string().trim().max(24).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const name = input.name || null;
      if (name) {
        const problem = displayNameProblem(name);
        if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
      }
      await ctx.db
        .update(users)
        .set({ displayName: name })
        .where(eq(users.address, ctx.auth.address))
        .catch((e) => {
          if (!isUniqueViolation(e)) throw e;
          throw new TRPCError({ code: "CONFLICT", message: "That name is taken." });
        });
      return { displayName: name };
    }),
  /** Replaces the caller's risk limits (bounds in `limitsSchema`) and returns them. */
  setLimits: authedProcedure.input(limitsSchema).mutation(async ({ ctx, input }) => {
    await ctx.db.update(users).set({ limits: input }).where(eq(users.address, ctx.auth.address));
    return input;
  }),
});
