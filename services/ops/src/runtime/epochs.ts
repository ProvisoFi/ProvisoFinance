// `epoch` queue (weekly pg_cron, Mondays 00:10 UTC): fund and post the previous week's caller shares.
import { epochs, type Db } from "@proviso/db";
import { InfoClient } from "@proviso/hl";
import { eq } from "drizzle-orm";
import { erc20Abi, type Address } from "viem";
import { callerSharePost, type Clients } from "./chain";
import { runEpoch } from "./epoch";

export type EpochMsg = { epoch: number | string; start: string; end: string }; // epoch = ISO year+week, e.g. 202643

export type EpochConfig = {
  callerShare: Address;
  usdg: Address;
  poolUsdg: bigint; // EPOCH_POOL_USDG, base units; the pool is min(this, relayer balance)
  capUsdg?: bigint; // EPOCH_CAP_USDG; defaults to the pool
  log?: (m: string) => void;
  info?: Pick<InfoClient, "post">; // Hyperliquid reads (HL_NETWORK); a fake in tests
};

/** `epoch` queue: computes, funds and posts one week's caller shares. A stored epoch is finished with its stored total; a new one uses a pool of min(EPOCH_POOL_USDG, relayer USDG) and is skipped when that is zero. Throws on a bad window. */
export const epochHandler = (db: Db, c: Clients, cfg: EpochConfig) => async (m: EpochMsg) => {
  const epoch = BigInt(m.epoch);
  const start = new Date(m.start);
  const end = new Date(m.end);
  if (!(start < end)) throw new Error(`Bad epoch window ${m.start} – ${m.end}`);
  const post = callerSharePost(c, cfg.callerShare);
  const log = cfg.log ?? console.log;
  const info = cfg.info ?? new InfoClient();

  // A stored epoch is finished or re-posted with its stored total, whatever the balance is now.
  const [stored] = await db.select({ epoch: epochs.epoch }).from(epochs).where(eq(epochs.epoch, epoch));
  if (stored) return void (await runEpoch(db, { epoch, start, end, pool: 0n, cap: 0n, post, info }));

  const balance = await c.public.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [c.account.address] });
  const pool = balance < cfg.poolUsdg ? balance : cfg.poolUsdg;
  if (pool === 0n) return log(`ops: epoch ${epoch} skipped: no pool (relayer USDG ${balance}, EPOCH_POOL_USDG ${cfg.poolUsdg})`);
  const r = await runEpoch(db, { epoch, start, end, pool, cap: cfg.capUsdg ?? pool, post, info });
  log(`ops: epoch ${epoch} ${r.status}${"total" in r ? `, ${r.total} USDG base units` : ""}`);
};
