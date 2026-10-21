// Global per-UTC-day cap on the relayer ETH spent for user-triggered work (swap setup/revoke relays,
// seal stamps). Sybil sign-ins each get per-address limits in the API; this caps their sum, and
// keeps a floor so reveals, roots and epochs (never gated here) still have gas.
// The day's spend lives in rate_limits (key relayer_user_gwei, one window per UTC day, hits = gwei)
// so a restart doesn't reset it.
import type { Db } from "@proviso/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { parseEther, type TransactionReceipt } from "viem";
import type { Clients } from "./chain";

const rateLimits = pgTable(
  "rate_limits",
  { key: text().notNull(), windowStart: timestamp("window_start", { withTimezone: true }).notNull(), hits: integer().notNull() },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
const KEY = "relayer_user_gwei";
const DAY_MS = 86_400_000;
const GWEI = 10n ** 9n;

export type Budget = { allowed(): Promise<boolean>; spend(wei: bigint): Promise<void> };

/** What a mined tx cost the relayer. */
export const txCost = (r: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">) => r.gasUsed * r.effectiveGasPrice;

export function relayerBudget(db: Db, c: Clients, o: { capEth?: string; minEth?: string; now?: () => number; log?: (m: string) => void } = {}): Budget {
  const cap = parseEther(o.capEth || "0.005");
  const reserve = 3n * parseEther(o.minEth || "0.003"); // balance-watch's alert line, times 3
  const today = () => new Date(Math.floor((o.now ?? Date.now)() / DAY_MS) * DAY_MS);
  const spent = async () => {
    const [r] = await db.select({ hits: rateLimits.hits }).from(rateLimits).where(and(eq(rateLimits.key, KEY), eq(rateLimits.windowStart, today())));
    return BigInt(r?.hits ?? 0) * GWEI;
  };
  return {
    // ponytail: check-then-spend, so concurrent relays can overshoot the cap by one job each.
    async allowed() {
      const [wei, used] = await Promise.all([c.public.getBalance({ address: c.account.address }), spent()]);
      const ok = wei >= reserve && used < cap;
      if (!ok) o.log?.(`ops: user-triggered relay refused (balance ${wei} wei, reserve ${reserve}; today ${used} of ${cap})`);
      return ok;
    },
    async spend(wei) {
      if (wei <= 0n) return;
      const gwei = Number((wei + GWEI - 1n) / GWEI); // integer column: fine up to ~2.1 ETH a day
      const windowStart = today();
      await db
        .insert(rateLimits)
        .values({ key: KEY, windowStart, hits: gwei })
        .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { hits: sql`${rateLimits.hits} + ${gwei}` } });
      await db.delete(rateLimits).where(and(eq(rateLimits.key, KEY), lt(rateLimits.windowStart, windowStart)));
    },
  };
}
