// `epoch` queue (weekly pg_cron, Mondays 00:10 UTC): fund and post the previous week's caller shares.
import { epochs, type Db } from "@proviso/db";
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
};

export const epochHandler = (db: Db, c: Clients, cfg: EpochConfig) => async (m: EpochMsg) => {
  const epoch = BigInt(m.epoch);
  const start = new Date(m.start);
  const end = new Date(m.end);
  if (!(start < end)) throw new Error(`Bad epoch window ${m.start} – ${m.end}`);
  const post = callerSharePost(c, cfg.callerShare);
  const log = cfg.log ?? console.log;

  // A stored epoch is finished or re-posted with its stored total, whatever the balance is now.
  const [stored] = await db.select({ epoch: epochs.epoch }).from(epochs).where(eq(epochs.epoch, epoch));
  if (stored) return void (await runEpoch(db, { epoch, start, end, pool: 0n, cap: 0n, post }));

  const balance = await c.public.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [c.account.address] });
  const pool = balance < cfg.poolUsdg ? balance : cfg.poolUsdg;
  if (pool === 0n) return log(`ops: epoch ${epoch} skipped: no pool (relayer USDG ${balance}, EPOCH_POOL_USDG ${cfg.poolUsdg})`);
  const r = await runEpoch(db, { epoch, start, end, pool, cap: cfg.capUsdg ?? pool, post });
  log(`ops: epoch ${epoch} ${r.status}${"total" in r ? `, ${r.total} USDG base units` : ""}`);
};
