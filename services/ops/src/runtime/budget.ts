// Per-UTC-day caps on the relayer ETH spent for user-triggered work, one pool per kind so abuse of
// one never blocks the other: "stamp" (seal stamps) and "setup" (swap setup/revoke relays and
// session-key gas). Inside a pool one address may use at most `shareEth` a day. A floor
// (3 x RELAYER_MIN_ETH) keeps gas for reveals, roots and epochs, which are never gated here.
// Revokes are exits: they record their spend but never ask allowed().
// Spend lives in rate_limits (key relayer_<pool>_gwei[:address], one window per UTC day,
// hits = gwei) so a restart doesn't reset it. On mainnet sponsorship also needs a wallet funded for
// SPONSOR_MIN_AGE_S (fundedAge, table sponsor_funding); refused users pay the gas themselves.
import { swapKeys, users, type Db } from "@proviso/db";
import { and, eq, gt, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp, union } from "drizzle-orm/pg-core";
import { erc20Abi, formatEther, formatUnits, getAddress, parseEther, type Address, type TransactionReceipt } from "viem";
import { opsWatch } from "./alerts";
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

/** Ops' own record of when it first saw a wallet hold the sponsorship floor (the RPC keeps no history). */
export const sponsorFunding = pgTable("sponsor_funding", {
  address: text().primaryKey(),
  since: timestamp("first_seen_funded_at", { withTimezone: true }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(), // last seen funded
});
const RECHECK_MS = 5 * 60_000;
const SWEEP = 200; // candidate wallets (users, swap wallets) observed per re-check, round-robin
const PARALLEL = 5; // wallets read at once (2 calls each)
const CURSOR = "sponsor_funding_cursor"; // ops_watch key: the last candidate address swept
const span = (s: number) => (s % 3600 ? `${Math.ceil(s / 60)} minutes` : s === 3600 ? "an hour" : `${s / 3600} hours`);

export type FundedAge = ReturnType<typeof fundedAge>;

/**
 * Funded-age rule: sponsored gas needs a wallet that holds `minUsdg` USDG or `minWei` ETH and has been
 * seen holding it, without a dip, for `minAgeS`. The clock starts on the first attempt that sees it
 * funded (by an attempt, or by the re-check sweeping every user and swap wallet so long-held
 * balances are already old on first use) and is cleared whenever it is seen below. The re-check
 * every ~5 minutes reads every running clock plus the next SWEEP candidates at one block, so one
 * balance can't sit in several wallets at once. Handing one balance along N wallets now needs it
 * parked in each for `minAgeS` first.
 * ponytail: a balance moved away and back between two re-checks isn't seen; shorten RECHECK_MS if that matters.
 * ponytail: every running clock is read on every pass (PARALLEL at a time); Multicall3 if funded wallets reach thousands.
 */
export function fundedAge(db: Db, c: Clients, o: { usdg: Address; minUsdg: bigint; minWei: bigint; minAgeS: number; now?: () => number; log?: (m: string) => void }) {
  const now = o.now ?? Date.now;
  const funded = async (a: string, blockNumber?: bigint) => {
    const address = getAddress(a);
    const [usdg, wei] = await Promise.all([
      c.public.readContract({ address: o.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber }),
      c.public.getBalance({ address, blockNumber }),
    ]);
    return usdg >= o.minUsdg || wei >= o.minWei;
  };
  const clear = (a: string) => db.delete(sponsorFunding).where(eq(sponsorFunding.address, a.toLowerCase()));
  async function recheck() {
    const [cur] = await db.select().from(opsWatch).where(eq(opsWatch.key, CURSOR));
    const all = union(db.select({ a: users.address }).from(users), db.select({ a: sql<string>`lower(${swapKeys.account})`.as("a") }).from(swapKeys)).as("c");
    const next = (await db.select({ a: all.a }).from(all).where(gt(all.a, (cur?.value as string | undefined) ?? "")).orderBy(all.a).limit(SWEEP)).map((r) => r.a);
    const clocks = (await db.select({ address: sponsorFunding.address }).from(sponsorFunding)).map((r) => r.address);
    const wallets = [...new Set([...clocks, ...next])];
    if (wallets.length) {
      const blockNumber = await c.public.getBlockNumber();
      const t = new Date(now());
      for (let i = 0; i < wallets.length; i += PARALLEL)
        await Promise.all(
          wallets.slice(i, i + PARALLEL).map(async (a) =>
            (await funded(a, blockNumber))
              ? db.insert(sponsorFunding).values({ address: a, since: t, seenAt: t }).onConflictDoUpdate({ target: sponsorFunding.address, set: { seenAt: t } })
              : clear(a),
          ),
        );
    }
    const value = next.length < SWEEP ? "" : next.at(-1)!; // a short page means the sweep wrapped
    await db.insert(opsWatch).values({ key: CURSOR, value }).onConflictDoUpdate({ target: opsWatch.key, set: { value } });
  }
  return {
    young: `Sponsored gas needs a wallet funded for at least ${span(o.minAgeS)} — or pay the gas yourself.`,
    /** Reads each wallet now and moves its clock: "funded" once one has held the floor for minAgeS. */
    async check(wallets: string[]): Promise<"funded" | "young" | "unfunded"> {
      let best: "young" | "unfunded" = "unfunded";
      for (const w of wallets) {
        if (!(await funded(w))) {
          await clear(w);
          continue;
        }
        const t = new Date(now());
        const [r] = await db
          .insert(sponsorFunding)
          .values({ address: w.toLowerCase(), since: t, seenAt: t })
          .onConflictDoUpdate({ target: sponsorFunding.address, set: { seenAt: t } })
          .returning({ since: sponsorFunding.since });
        if (now() - r!.since.getTime() >= o.minAgeS * 1000) return "funded";
        best = "young";
      }
      return best;
    },
    recheck,
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        await recheck().catch((e) => o.log?.(`ops: sponsor funding re-check failed: ${e instanceof Error ? e.message : e}`));
        await new Promise<void>((r) => {
          const t = setTimeout(r, RECHECK_MS * (0.5 + Math.random())); // jittered: no schedule to time a hand-off to
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
    },
  };
}

/**
 * Mainnet cost rule for sponsored seals: the owner, or its live registered swap wallet, holds at least
 * `minUsdg` USDG or `minWei` ETH, and has for `minAgeS` (fundedAge). Returns the refusal message, or
 * null when the seal may be sponsored.
 * A swap wallet serves one live account at a time (swap_keys_account_live), so sybils can't share one.
 */
export function sponsorRule(db: Db, c: Clients, o: { usdg: Address; minUsdg: bigint; minWei: bigint; label: string; minAgeS?: number; now?: () => number }) {
  const why = `Sponsored seals need at least ${formatUnits(o.minUsdg, 6)} USDG or ${formatEther(o.minWei)} ETH in your wallet on ${o.label} — or send the seal from your own wallet.`;
  const age = fundedAge(db, c, { ...o, minAgeS: o.minAgeS ?? 0 });
  return async (owner: string): Promise<string | null> => {
    const [k] = await db
      .select({ account: swapKeys.account })
      .from(swapKeys)
      .where(and(eq(swapKeys.address, owner.toLowerCase()), isNotNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt)));
    const f = await age.check([owner, ...(k ? [k.account] : [])]);
    return f === "funded" ? null : f === "young" ? age.young : why;
  };
}
