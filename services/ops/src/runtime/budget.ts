// Per-UTC-day caps on the relayer ETH spent for user-triggered work, one pool per kind so abuse of
// one never blocks the other: "stamp" (seal stamps) and "setup" (swap setup/revoke relays and
// session-key gas). Inside a pool one address may use at most `shareEth` a day. A floor
// (3 x RELAYER_MIN_ETH) keeps gas for reveals, roots and epochs, which are never gated here.
// Revokes are exits: they record their spend but never ask allowed().
// Spend lives in rate_limits (key relayer_<pool>_gwei[:address], one window per UTC day,
// hits = gwei) so a restart doesn't reset it.
import { swapKeys, type Db } from "@proviso/db";
import { and, eq, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { erc20Abi, formatEther, formatUnits, getAddress, parseEther, type Address, type TransactionReceipt } from "viem";
import type { Clients } from "./chain";

export const rateLimits = pgTable(
  "rate_limits",
  { key: text().notNull(), windowStart: timestamp("window_start", { withTimezone: true }).notNull(), hits: integer().notNull() },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
const DAY_MS = 86_400_000;
const GWEI = 10n ** 9n;

/** Per-key counters with one window per UTC day; a key's older windows are pruned on add. */
export function dayCounter(db: Db, now: () => number = Date.now) {
  const today = () => new Date(Math.floor(now() / DAY_MS) * DAY_MS);
  return {
    today,
    async get(key: string) {
      const [r] = await db.select({ hits: rateLimits.hits }).from(rateLimits).where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, today())));
      return r?.hits ?? 0;
    },
    async add(key: string, n: number) {
      const windowStart = today();
      await db
        .insert(rateLimits)
        .values({ key, windowStart, hits: n })
        .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { hits: sql`${rateLimits.hits} + ${n}` } });
      await db.delete(rateLimits).where(and(eq(rateLimits.key, key), lt(rateLimits.windowStart, windowStart)));
    },
  };
}

export type Pool = "stamp" | "setup";
/** Day cap per pool, and the most one address may use of it. */
export const POOLS: Record<Pool, { capEth: string; shareEth: string }> = {
  stamp: { capEth: "0.003", shareEth: "0.0003" }, // 10% of the pool
  setup: { capEth: "0.005", shareEth: "0.001" }, // about 3 session-key fundings
};

/** `who`: the address the work is for; its share is checked and charged alongside the pool. */
export type Budget = { allowed(who: string): Promise<boolean>; spend(wei: bigint, who: string): Promise<void> };

/** What a mined tx cost the relayer. */
export const txCost = (r: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">) => r.gasUsed * r.effectiveGasPrice;

export function relayerBudget(
  db: Db,
  c: Clients,
  o: { pool: Pool; capEth?: string; shareEth?: string; minEth?: string; now?: () => number; log?: (m: string) => void },
): Budget {
  const cap = parseEther(o.capEth || POOLS[o.pool].capEth);
  const share = parseEther(o.shareEth || POOLS[o.pool].shareEth);
  const reserve = 3n * parseEther(o.minEth || "0.003"); // balance-watch's alert line, times 3
  const day = dayCounter(db, o.now);
  const key = `relayer_${o.pool}_gwei`;
  const spent = async (k: string) => BigInt(await day.get(k)) * GWEI;
  return {
    // ponytail: check-then-spend, so concurrent relays can overshoot a cap by one job each.
    async allowed(who) {
      const mine = `${key}:${who.toLowerCase()}`;
      const [wei, used, own] = await Promise.all([c.public.getBalance({ address: c.account.address }), spent(key), spent(mine)]);
      const ok = wei >= reserve && used < cap && own < share;
      if (!ok) o.log?.(`ops: ${o.pool} relay for ${who} refused (balance ${wei} wei, reserve ${reserve}; pool ${used} of ${cap}; address ${own} of ${share})`);
      return ok;
    },
    async spend(wei, who) {
      if (wei <= 0n) return;
      const gwei = Number((wei + GWEI - 1n) / GWEI); // integer column: fine up to ~2.1 ETH a day
      await day.add(key, gwei);
      await day.add(`${key}:${who.toLowerCase()}`, gwei);
      // Past days of every address in this pool (sybils that never come back).
      await db.delete(rateLimits).where(and(like(rateLimits.key, `relayer_${o.pool}_%`), lt(rateLimits.windowStart, day.today())));
    },
  };
}

/**
 * Mainnet cost rule for sponsored seals: the owner, or its live registered swap wallet, holds at least
 * `minUsdg` USDG or `minWei` ETH. Returns the refusal message, or null when the seal may be sponsored.
 * A swap wallet serves one live account at a time (swap_keys_account_live), so sybils can't share one.
 */
export function sponsorRule(db: Db, c: Clients, o: { usdg: Address; minUsdg: bigint; minWei: bigint; label: string }) {
  const why = `Sponsored seals need at least ${formatUnits(o.minUsdg, 6)} USDG or ${formatEther(o.minWei)} ETH in your wallet on ${o.label} — or send the seal from your own wallet.`;
  return async (owner: string): Promise<string | null> => {
    const [k] = await db
      .select({ account: swapKeys.account })
      .from(swapKeys)
      .where(and(eq(swapKeys.address, owner.toLowerCase()), isNotNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt)));
    for (const a of [owner, ...(k ? [k.account] : [])].map((x) => getAddress(x))) {
      const [usdg, wei] = await Promise.all([
        c.public.readContract({ address: o.usdg, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
        c.public.getBalance({ address: a }),
      ]);
      if (usdg >= o.minUsdg || wei >= o.minWei) return null;
    }
    return why;
  };
}
