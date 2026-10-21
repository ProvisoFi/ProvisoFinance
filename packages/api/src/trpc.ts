import { initTRPC, TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import superjson from "superjson";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // Anything not thrown as a TRPCError (viem, postgres, fetch...) gets a generic message: upstream
  // errors can carry RPC URLs, keys or SQL. Intentional TRPCErrors keep theirs.
  errorFormatter: ({ shape, error }) =>
    error.code === "INTERNAL_SERVER_ERROR" && error.cause !== undefined
      ? { ...shape, message: "Something went wrong on our side. Try again.", data: { ...shape.data, stack: undefined } }
      : shape,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.auth) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in with your wallet first." });
  return next({ ctx: { ...ctx, auth: ctx.auth } });
});

const HOUR = 3600;
const DAY = 86_400;
// Per-address budgets. Stamps and swap register/revoke are relayed by the shared relayer (gas, and
// funding for each session key); the rest spend AI Gateway credits, enclave work or upstream APIs.
export const LIMITS = {
  draft: { max: 20, windowS: HOUR }, // rule writer
  test: { max: 30, windowS: HOUR }, // 90-day replays in the enclave
  stamp: { max: 20, windowS: DAY }, // relayed seal txs
  agentKey: { max: 10, windowS: HOUR }, // enclave-made Hyperliquid agent keys
  hlApprovals: { max: 10, windowS: HOUR }, // relayed to Hyperliquid from the server's IP
  swapPrepare: { max: 120, windowS: HOUR }, // polled about once a second while the enclave makes the key
  swapRegister: { max: 5, windowS: DAY }, // relayed delegation + install + session-key funding
  swapRevoke: { max: 5, windowS: DAY }, // relayed uninstall
  routeQuote: { max: 60, windowS: HOUR }, // Relay API quotes
  follow: { max: 30, windowS: HOUR }, // new follows (each one is work on the caller's every fire)
} as const;

// ponytail: fixed windows allow up to 2x a budget across a window edge; sliding windows if that matters.
export const limitedProcedure = (name: keyof typeof LIMITS) =>
  authedProcedure.use(async ({ ctx, next }) => {
    const { max, windowS } = LIMITS[name];
    const key = `${name}:${ctx.auth.address}`;
    const [row] = (await ctx.db.execute(sql`select public.rate_limit_hit(${key}, ${max}::int, ${windowS}::int) as ok`)) as unknown as { ok: boolean }[];
    if (!row?.ok)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many requests: this is limited to ${max} per ${windowS === DAY ? "day" : "hour"}. Try again later.` });
    return next();
  });
