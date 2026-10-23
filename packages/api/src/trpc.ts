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
/** Procedure that requires a signed-in wallet (UNAUTHORIZED otherwise); `ctx.auth` is non-null inside. */
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
  selfSeal: { max: 20, windowS: HOUR }, // owner-sent seal txs checked against the chain
  agentKey: { max: 10, windowS: HOUR }, // enclave-made Hyperliquid agent keys
  hlApprovals: { max: 10, windowS: HOUR }, // relayed to Hyperliquid from the server's IP
  swapPrepare: { max: 120, windowS: HOUR }, // polled about once a second while the enclave makes the key
  swapRegister: { max: 5, windowS: DAY }, // relayed delegation + install + session-key funding
  swapRevoke: { max: 5, windowS: DAY }, // relayed uninstall
  routeQuote: { max: 60, windowS: HOUR }, // Relay API quotes
  follow: { max: 30, windowS: HOUR }, // new follows (each one is work on the caller's every fire)
  displayName: { max: 30, windowS: DAY }, // profile name attempts (refused ones count too)
  arenaEnter: { max: 10, windowS: DAY }, // Proviso Arena entries
  dryRun: { max: 60, windowS: HOUR }, // Dry Run replays (public: per IP)
  dryRunNow: { max: 600, windowS: HOUR }, // Dry Run live checks, polled while the page is open (per IP)
  dryRunDraft: { max: 10, windowS: HOUR }, // Dry Run rule writer (public: per IP, spends AI credits)
  dryRunDraftAll: { max: 300, windowS: HOUR }, // the same writer for everyone signed out together: caps AI spend if IPs rotate
} as const;

// ponytail: fixed windows allow up to 2x a budget across a window edge; sliding windows if that matters.
/**
 * Authed procedure under the `LIMITS[name]` per-address budget, counted in Postgres by
 * `public.rate_limit_hit`; over budget throws TOO_MANY_REQUESTS.
 */
export const limitedProcedure = (name: keyof typeof LIMITS) =>
  authedProcedure.use(async ({ ctx, next }) => {
    const { max, windowS } = LIMITS[name];
    const key = `${name}:${ctx.auth.address}`;
    const [row] = (await ctx.db.execute(sql`select public.rate_limit_hit(${key}, ${max}::int, ${windowS}::int) as ok`)) as unknown as { ok: boolean }[];
    if (!row?.ok)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many requests: this is limited to ${max} per ${windowS === DAY ? "day" : "hour"}. Try again later.` });
    return next();
  });

/**
 * Public procedure under the `LIMITS[name]` budget per caller: the signed-in address, else the IP
 * the proxy reports. For Dry Run, which works without a wallet.
 */
export const publicLimitedProcedure = (name: keyof typeof LIMITS) =>
  publicProcedure.use(async ({ ctx, next }) => {
    const { max, windowS } = LIMITS[name];
    const key = `${name}:${ctx.auth?.address ?? `ip:${ctx.ip ?? "unknown"}`}`;
    const [row] = (await ctx.db.execute(sql`select public.rate_limit_hit(${key}, ${max}::int, ${windowS}::int) as ok`)) as unknown as { ok: boolean }[];
    if (!row?.ok)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many requests: this is limited to ${max} per ${windowS === DAY ? "day" : "hour"}. Try again later.` });
    // Spends shared money (the AI writer): one budget for every signed-out caller too.
    if (name === "dryRunDraft" && !ctx.auth) {
      const all = LIMITS.dryRunDraftAll;
      const [g] = (await ctx.db.execute(sql`select public.rate_limit_hit(${"dryRunDraft:all"}, ${all.max}::int, ${all.windowS}::int) as ok`)) as unknown as { ok: boolean }[];
      if (!g?.ok) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "The rule writer is busy right now. Try again in a while, or pick a starter idea." });
    }
    return next();
  });
