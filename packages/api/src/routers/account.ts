import { users } from "@proviso/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authedProcedure, router } from "../trpc";

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
      createdAt: row.createdAt,
    };
  }),
  /** Replaces the caller's risk limits (bounds in `limitsSchema`) and returns them. */
  setLimits: authedProcedure.input(limitsSchema).mutation(async ({ ctx, input }) => {
    await ctx.db.update(users).set({ limits: input }).where(eq(users.address, ctx.auth.address));
    return input;
  }),
});
