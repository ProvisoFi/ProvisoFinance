// Mainnet alerts to the operator (RELAYER_ALERT_ADDRESS, through the notify queue like the relayer
// balance watch). An ongoing condition alerts once when it starts and once when it clears; a
// one-off event (a large claim) alerts each time. Condition state is in memory, so a restart
// re-alerts a condition still open.
//
// CallerShare: Claimed / EpochPosted logs by small block ranges from a cursor in ops_watch.
//   - a claim above ALERT_CLAIM_USDG, or claims above ALERT_CLAIMS_24H_USDG in a rolling 24 h;
//   - a claim for an epoch ops has no row for, or whose on-chain root isn't ops' root (and an
//     EpochPosted with a root ops didn't compute);
//   - the contract's USDG below what its posted epochs still owe.
// Feeds, per swapConfig() market: the Chainlink answer <= 0 or the stock token oraclePaused()
// (any time); in the NYSE regular session, no update for ALERT_FEED_MAX_AGE_S (counted from the
// open at the earliest) or the pool more than 2% off the feed.
import { epochs, type Db } from "@proviso/db";
import { callerShareAbi, chainConfig, feedRoundAbi, poolPriceUsd, swapConfig, type SwapMarket } from "@proviso/chain";
import { eq } from "drizzle-orm";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { erc20Abi, formatUnits, parseAbi, type Address } from "viem";
import type { Clients } from "./chain";
import type { NotifyMsg } from "./notify";

export const opsWatch = pgTable("ops_watch", { key: text().primaryKey(), value: jsonb().$type<unknown>().notNull() });

const CLAIM_TICK_MS = 60_000;
const FEED_TICK_MS = 5 * 60_000;
export const LOG_RANGE = 2_000n; // blocks per getLogs call
const MAX_RANGES_PER_TICK = 50;
const DAY_S = 86_400;
const FEED_DECIMALS = 8; // Chainlink stock proxies on Robinhood Chain
const MAX_GAP_BPS = 200; // pool vs feed

export type Alerter = ReturnType<typeof alerter>;

export function alerter(notify: (m: NotifyMsg) => Promise<unknown>, alertAddress: string, log?: (m: string) => void) {
  const open = new Set<string>();
  const send = (title: string, body: string) => (log?.(`ops: alert: ${title}: ${body}`), notify({ address: alertAddress.toLowerCase(), title, body }));
  return {
    event: send,
    /** `problem` set: alert if `key` wasn't already open. Null: one "recovered" if it was. */
    async condition(key: string, problem: string | null) {
      if (!!problem === open.has(key)) return;
      await send(problem ? key : `${key}: recovered`, problem ?? `${key} is back to normal on ${chainConfig().label}.`);
      problem ? open.add(key) : open.delete(key);
    },
  };
}

/** Minutes since the NYSE regular-session open (9:30–16:00 New York, Mon–Fri), or null outside it. Holidays not handled. */
export function sessionMinutes(t: Date): number | null {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  const m = Number(p.hour) * 60 + Number(p.minute) - 570;
  return p.weekday === "Sat" || p.weekday === "Sun" || m < 0 || m >= 390 ? null : m;
}

function loop(tick: () => Promise<unknown>, ms: number, name: string, log?: (m: string) => void) {
  return async (signal: AbortSignal) => {
    while (!signal.aborted) {
      await tick().catch((e) => log?.(`ops: ${name} failed: ${e instanceof Error ? e.message : e}`));
      await new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
  };
}

type ShareState = { block: string; claims: [at: number, amount: string][] };
const usd = (base: bigint) => `${formatUnits(base, 6)} USDG`;

export function callerShareWatch(
  db: Db,
  c: Clients,
  o: { callerShare: Address; usdg: Address; alert: Alerter; claimMax: bigint; dayMax: bigint; fromBlock: bigint; log?: (m: string) => void; now?: () => number },
) {
  const now = o.now ?? Date.now;
  const key = `caller_share:${o.callerShare.toLowerCase()}`;
  const onchainEpoch = (epoch: bigint) => c.public.readContract({ address: o.callerShare, abi: callerShareAbi, functionName: "epochs", args: [epoch] });

  async function checkRoot(epoch: bigint, root: string, what: string) {
    const [row] = await db.select({ root: epochs.root }).from(epochs).where(eq(epochs.epoch, epoch));
    if (row?.root.toLowerCase() === root.toLowerCase()) return;
    await o.alert.condition(
      `CallerShare epoch ${epoch} root`,
      `${what} for epoch ${epoch} with root ${root}, but ops ${row ? `posted root ${row.root}` : "has no such epoch"}. Someone other than ops may hold the poster key.`,
    );
  }

  async function tick() {
    const [row] = await db.select().from(opsWatch).where(eq(opsWatch.key, key));
    const st = (row?.value as ShareState | undefined) ?? { block: o.fromBlock.toString(), claims: [] };
    const latest = await c.public.getBlockNumber();
    const stamps = new Map<bigint, number>();
    for (let i = 0, from = BigInt(st.block); i < MAX_RANGES_PER_TICK && from <= latest; i++) {
      const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
      const logs = await c.public.getContractEvents({ address: o.callerShare, abi: callerShareAbi, fromBlock: from, toBlock: to });
      for (const l of logs) {
        if (l.eventName === "EpochPosted") await checkRoot(l.args.epoch!, l.args.merkleRoot!, "EpochPosted");
        if (l.eventName !== "Claimed") continue;
        const { epoch, caller, amount } = l.args as { epoch: bigint; caller: Address; amount: bigint };
        if (!stamps.has(l.blockNumber)) stamps.set(l.blockNumber, Number((await c.public.getBlock({ blockNumber: l.blockNumber })).timestamp));
        st.claims.push([stamps.get(l.blockNumber)!, amount.toString()]);
        if (amount > o.claimMax)
          await o.alert.event("Large CallerShare claim", `${caller} claimed ${usd(amount)} from epoch ${epoch} (alert above ${usd(o.claimMax)}), tx ${l.transactionHash}.`);
        const [root] = await onchainEpoch(epoch);
        await checkRoot(epoch, root, "A claim");
      }
      from = to + 1n;
      st.block = from.toString();
      st.claims = st.claims.filter(([at]) => at > now() / 1000 - DAY_S);
      await db.insert(opsWatch).values({ key, value: st }).onConflictDoUpdate({ target: opsWatch.key, set: { value: st } });
    }

    const day = st.claims.filter(([at]) => at > now() / 1000 - DAY_S).reduce((s, [, a]) => s + BigInt(a), 0n);
    await o.alert.condition("CallerShare 24 h claims", day > o.dayMax ? `${usd(day)} claimed in the last 24 h (alert above ${usd(o.dayMax)}).` : null);

    let owed = 0n;
    for (const { epoch } of await db.select({ epoch: epochs.epoch }).from(epochs)) {
      const [, total, claimed] = await onchainEpoch(epoch);
      owed += total - claimed;
    }
    const balance = await c.public.readContract({ address: o.usdg, abi: erc20Abi, functionName: "balanceOf", args: [o.callerShare] });
    await o.alert.condition("CallerShare underfunded", balance < owed ? `CallerShare holds ${usd(balance)} but its epochs still owe ${usd(owed)}.` : null);
  }

  return { tick, run: loop(tick, CLAIM_TICK_MS, "CallerShare watch", o.log) };
}

const stockAbi = parseAbi(["function oraclePaused() view returns (bool)"]);

export function feedWatch(
  c: Clients,
  o: { alert: Alerter; maxAgeS: number; poolManager: Address; markets?: readonly SwapMarket[]; log?: (m: string) => void; now?: () => number },
) {
  const now = o.now ?? Date.now;

  async function check(m: SwapMarket) {
    const sym = m.symbols[m.baseIsCurrency0 ? 0 : 1];
    const stock = m.baseIsCurrency0 ? m.key.currency0 : m.key.currency1;
    const [[, answer, , updatedAt], paused, pool] = await Promise.all([
      c.public.readContract({ address: m.oracle, abi: feedRoundAbi, functionName: "latestRoundData" }),
      c.public.readContract({ address: stock, abi: stockAbi, functionName: "oraclePaused" }),
      poolPriceUsd(c.public, o.poolManager, m),
    ]);
    await o.alert.condition(`${sym} feed answer`, answer <= 0n ? `The ${sym} feed ${m.oracle} answers ${answer}. Swaps on this pool revert.` : null);
    await o.alert.condition(`${sym} oracle paused`, paused ? `The ${sym} token ${stock} reports oraclePaused() (corporate action?). Swaps on this pool revert.` : null);

    const since = sessionMinutes(new Date(now()));
    if (since === null) return; // the feed may sit still outside the session: keep these conditions as they are
    const nowS = Math.floor(now() / 1000);
    const age = nowS - Math.max(Number(updatedAt), nowS - since * 60);
    await o.alert.condition(`${sym} feed stale`, age > o.maxAgeS ? `The ${sym} feed ${m.oracle} last updated ${Math.round((nowS - Number(updatedAt)) / 60)} min ago, in session (alert after ${o.maxAgeS / 60} min).` : null);
    const ref = (Number(answer) / 10 ** FEED_DECIMALS) * (Number(m.multiplier) / 1e18);
    const gapBps = ref > 0 ? (Math.abs(pool - ref) / ref) * 10_000 : 0;
    await o.alert.condition(`${sym} pool vs feed`, gapBps > MAX_GAP_BPS ? `The ${sym} pool trades at $${pool.toFixed(2)}, the feed says $${ref.toFixed(2)} (${(gapBps / 100).toFixed(1)}% apart).` : null);
  }

  async function tick() {
    for (const m of o.markets ?? swapConfig().markets) await check(m).catch((e) => o.log?.(`ops: feed watch ${m.symbols.join("/")} failed: ${e instanceof Error ? e.message : e}`));
  }

  return { tick, run: loop(tick, FEED_TICK_MS, "feed watch", o.log) };
}
