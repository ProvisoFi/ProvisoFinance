import { routes } from "@proviso/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { relayQuote, relayStatus, routeConfig, TESTNET_UNAVAILABLE } from "../relay";
import { authedProcedure, limitedProcedure, publicProcedure, router } from "../trpc";

const config = () => {
  const cfg = routeConfig();
  if (!cfg) throw new TRPCError({ code: "PRECONDITION_FAILED", message: TESTNET_UNAVAILABLE });
  return cfg;
};

/**
 * Funding routes via Relay. The browser executes the returned steps itself (approve + deposit on Robinhood Chain, or the
 * authorize + sendAsset signatures on Hyperliquid); Proviso never moves funds for the user.
 */
export const routeRouter = router({
  /** Public: whether routes are open on this network, with the reason when not (testnet). */
  availability: publicProcedure.query(() =>
    routeConfig() ? { available: true as const } : { available: false as const, reason: TESTNET_UNAVAILABLE },
  ),

  /**
   * Quotes a $5–$1M fund (RHC USDG → HL USDC) or exit route for the caller, records it as "quoted",
   * and returns Relay's steps for the browser to run. PRECONDITION_FAILED on testnet, BAD_GATEWAY on Relay errors.
   */
  quote: limitedProcedure("routeQuote")
    .input(z.object({ direction: z.enum(["fund", "exit"]), amountUsd: z.number().min(5).max(1_000_000) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = config();
      const q = await relayQuote(cfg, { user: ctx.auth.address, ...input }).catch((e: Error) => {
        throw new TRPCError({ code: "BAD_GATEWAY", message: e.message });
      });
      if (!q.requestId) throw new TRPCError({ code: "BAD_GATEWAY", message: "The relayer returned no request id." });
      await ctx.db
        .insert(routes)
        .values({ id: q.requestId, address: ctx.auth.address, kind: input.direction, amountIn: String(input.amountUsd), status: "quoted" })
        .onConflictDoNothing();
      return {
        requestId: q.requestId,
        steps: q.steps,
        amountOut: q.details?.currencyOut?.amount,
        minimumOut: q.details?.currencyOut?.minimumAmount,
        timeEstimateSec: q.details?.timeEstimate,
        fees: q.fees,
      };
    }),

  /** One of the caller's routes, refreshed from Relay unless already done, refunded or failed; NOT_FOUND if not theirs. */
  status: authedProcedure.input(z.object({ requestId: z.string().max(100) })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(routes).where(and(eq(routes.id, input.requestId), eq(routes.address, ctx.auth.address)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (["done", "refunded", "failed"].includes(row.status)) return row;
    const s = await relayStatus(config(), input.requestId);
    const [updated] = await ctx.db
      .update(routes)
      .set({ status: s.status, srcTx: s.inTx ?? row.srcTx, dstTx: s.status === "done" ? (s.outTx ?? row.dstTx) : row.dstTx, refundTx: s.status === "refunded" ? (s.outTx ?? row.refundTx) : row.refundTx, updatedAt: new Date() })
      .where(eq(routes.id, input.requestId))
      .returning();
    return updated;
  }),

  /** The caller's 50 most recent routes, newest first. */
  mine: authedProcedure.query(({ ctx }) =>
    ctx.db.select().from(routes).where(eq(routes.address, ctx.auth.address)).orderBy(desc(routes.createdAt)).limit(50),
  ),
});
