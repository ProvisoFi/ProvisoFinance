// Deterministic strategy replay: frames feed a MemoryMarketView and the same ThesisMachine the
// live evaluator runs. No clock, no randomness: the same frames always give the same result.
import { Spec, type SpecInput } from "@proviso/dsl";
import { DEFAULT_CONFIG, evalLeaf, hlPrice, leafKeys, leaves, UNKNOWN, type EvalConfig } from "../evaluator/conditions.ts";
import { ThesisMachine, stampFlags, type Flag } from "../evaluator/machine.ts";
import { MemoryMarketView, updateKey, type MemoryViewOptions, type Update } from "../evaluator/state.ts";
import { TESTER_VERSION } from "./testId.ts";

/** A batch of updates that share one timestamp. Frames must be strictly ascending in `t`. */
export type Frame = { t: number; updates: Update[] };

export type ReplayOptions = {
  spec: Spec | SpecInput;
  frames: readonly Frame[];
  /** Frames before this only warm up the view (e.g. `change` history). Default: first frame. */
  stampedAt?: number;
  /** Modelled slippage per fill, basis points against the mark. */
  slippageBps: number;
  /** Taker fee per fill, basis points of notional. Default 0. */
  feeBps?: number;
  /** Accrue hourly funding on open positions. Default false. */
  funding?: boolean;
  linkedHandles?: readonly string[];
  config?: EvalConfig;
  view?: MemoryViewOptions;
};

export type Fill = { trade: number; at: number; coin: string; side: "buy" | "sell"; mark: number; px: number; qty: number };
export type ExitReason = "stop" | "take" | "liquidation" | "end";
export type Trade = {
  n: number;
  coin: string;
  side: "long" | "short";
  lev: number;
  sizeUsd: number;
  firedAt: number;
  refMark: number;
  entryPx: number;
  stopPx: number;
  takePx: number;
  exitAt: number;
  exitPx: number;
  exitReason: ExitReason;
  feesUsd: number;
  fundingUsd: number;
  pnlUsd: number;
  /** pnlUsd / notional * 100. */
  returnPct: number;
};
export type Coverage = {
  path: string;
  input: string;
  sources: string[];
  /** False when no frame carries every source this input needs: it is never guessed, only unknown. */
  supported: boolean;
  knownFrames: number;
  unknownFrames: number;
};
export type ReplayResult = {
  testerVersion: string;
  stampedAt: number;
  expiresAt: number;
  stampFlags: Flag[];
  fires: { at: number; coin: string; mark: number }[];
  expiredAt: number | null;
  fills: Fill[];
  trades: Trade[];
  totalPnlUsd: number;
  /** Largest peak-to-trough fall of realized + mark-to-market equity, USD (>= 0). */
  maxDrawdownUsd: number;
  coverage: Coverage[];
  /** Actions the tester does not simulate (only HL perp `open` is). */
  unsimulated: { path: string; reason: string }[];
  assumptions: string[];
};

type Open = {
  t: Omit<Trade, "exitAt" | "exitPx" | "exitReason" | "pnlUsd" | "returnPct">;
  qty: number;
  liqPx: number;
  lastAt: number;
};

/** Replays a spec over recorded frames with the live ThesisMachine and simulates its HL perp opens (slippage and fees in bps), returning fires, trades, PnL, drawdown and per-leaf coverage. Deterministic; throws on no frames, frames not strictly ascending, or negative slippage. */
export function replay(opts: ReplayOptions): ReplayResult {
  const spec = Spec.parse(opts.spec);
  const cfg = opts.config ?? DEFAULT_CONFIG;
  const { frames } = opts;
  if (!frames.length) throw new Error("replay needs at least one frame");
  for (let i = 0; i < frames.length; i++)
    if (!Number.isFinite(frames[i].t) || (i > 0 && !(frames[i].t > frames[i - 1].t)))
      throw new Error(`frames must be strictly ascending (frame ${i})`);
  if (!(opts.slippageBps >= 0)) throw new Error("slippageBps must be >= 0");

  const slip = opts.slippageBps / 10_000;
  const fee = (opts.feeBps ?? 0) / 10_000;
  const stampedAt = opts.stampedAt ?? frames[0].t;
  const view = new MemoryMarketView(opts.view);
  const machine = new ThesisMachine({ id: "test", spec, stampedAt, linkedHandles: opts.linkedHandles, config: cfg });

  const seen = new Set(frames.flatMap((f) => f.updates.map(updateKey)));
  const leafList = leaves(spec.entry.when);
  const coverage: Coverage[] = leafList.map(({ path, leaf }) => {
    const sources = leafKeys(leaf);
    return { path, input: Object.keys(leaf)[0], sources, supported: sources.every((k) => seen.has(k)), knownFrames: 0, unknownFrames: 0 };
  });
  const unsimulated = spec.entry.then.flatMap((a, i) =>
    a.venue === "hl" && a.action === "open" ? [] : [{ path: `entry.then[${i}]`, reason: `${a.venue} ${a.action} is not simulated` }],
  );

  const result: ReplayResult = {
    testerVersion: TESTER_VERSION,
    stampedAt,
    expiresAt: machine.expiresAt,
    stampFlags: [],
    fires: [],
    expiredAt: null,
    fills: [],
    trades: [],
    totalPnlUsd: 0,
    maxDrawdownUsd: 0,
    coverage,
    unsimulated,
    assumptions: [
      `Fills at the HL mark ±${opts.slippageBps} bps slippage; fee ${opts.feeBps ?? 0} bps per fill.`,
      "size.usd is position notional; quantity = notional / entry price.",
      "Stop and take levels are relative to the trigger mark (other legs: their own mark at the fire) and are checked against the mark path only; a level crossed between frames fills at the next observed mark, not at the level.",
      "Loss per trade is capped at its margin (notional / lev); maintenance margin and liquidation fees are not modelled.",
      opts.funding
        ? "Funding accrues on open positions at the latest fresh hourly rate × elapsed time × notional at mark."
        : "Funding is not accrued.",
      "Inputs without data in the frames evaluate as unknown and never fire (see coverage).",
      "Positions still open at the last frame close at its mark (reason: end).",
    ],
  };

  const open: Open[] = [];
  let realized = 0;
  let peak = 0;
  let started = false;

  const close = (p: Open, at: number, mark: number, reason: ExitReason) => {
    const long = p.t.side === "long";
    const exitPx = reason === "liquidation" ? p.liqPx : long ? mark * (1 - slip) : mark * (1 + slip);
    const margin = p.t.sizeUsd / p.t.lev;
    const gross = Math.max(-margin, p.qty * (long ? exitPx - p.t.entryPx : p.t.entryPx - exitPx));
    const feesUsd = p.t.feesUsd + p.qty * exitPx * fee;
    const pnlUsd = gross - feesUsd + p.t.fundingUsd;
    result.fills.push({ trade: p.t.n, at, coin: p.t.coin, side: long ? "sell" : "buy", mark, px: exitPx, qty: p.qty });
    result.trades.push({ ...p.t, feesUsd, exitAt: at, exitPx, exitReason: reason, pnlUsd, returnPct: (pnlUsd / p.t.sizeUsd) * 100 });
    realized += pnlUsd;
  };

  let tradeN = 0;
  for (const frame of frames) {
    const now = frame.t;
    for (const u of frame.updates) view.apply(u);
    if (now < stampedAt) continue;
    if (!started) {
      started = true;
      result.stampFlags = stampFlags(spec, view, now, opts.linkedHandles, cfg);
    }

    // Exits and funding on positions opened in earlier frames.
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i];
      const mark = view.hlMark(p.t.coin)?.value;
      if (mark === undefined) continue;
      const long = p.t.side === "long";
      if (opts.funding) {
        const rate = view.hlFunding(p.t.coin);
        if (rate && now - rate.at <= cfg.maxAgeMs.hl) {
          const pay = p.qty * mark * (rate.value / 100) * ((now - p.lastAt) / 3_600_000);
          p.t.fundingUsd += long ? -pay : pay;
        }
      }
      p.lastAt = now;
      const below = (lvl: number) => (long ? mark <= lvl : mark >= lvl);
      const stopFirst = long ? p.t.stopPx >= p.liqPx : p.t.stopPx <= p.liqPx;
      let reason: ExitReason | undefined;
      if (below(p.liqPx) && !(below(p.t.stopPx) && stopFirst)) reason = "liquidation";
      else if (below(p.t.stopPx)) reason = "stop";
      else if (long ? mark >= p.t.takePx : mark <= p.t.takePx) reason = "take";
      if (reason) {
        close(p, now, mark, reason);
        open.splice(i, 1);
      }
    }

    if (!machine.done) {
      leafList.forEach(({ leaf }, i) => {
        if (evalLeaf(leaf, view, now, cfg) === UNKNOWN) coverage[i].unknownFrames++;
        else coverage[i].knownFrames++;
      });
      for (const e of machine.step(view, now)) {
        if (e.kind === "expire") {
          result.expiredAt = e.at;
          continue;
        }
        result.fires.push({ at: e.at, coin: e.coin, mark: e.mark });
        tradeN++;
        spec.entry.then.forEach((a, i) => {
          if (a.venue !== "hl" || a.action !== "open") return;
          const ref = a.coin === e.coin ? e.mark : hlPrice(a.coin, view, now, cfg);
          if (ref === UNKNOWN) {
            unsimulated.push({ path: `entry.then[${i}]`, reason: `no checked ${a.coin} mark at fire ${tradeN}` });
            return;
          }
          const long = a.side === "long";
          const entryPx = long ? ref * (1 + slip) : ref * (1 - slip);
          const qty = a.size.usd / entryPx;
          const sign = long ? 1 : -1;
          const t: Open["t"] = {
            n: tradeN,
            coin: a.coin,
            side: a.side,
            lev: a.lev,
            sizeUsd: a.size.usd,
            firedAt: now,
            refMark: ref,
            entryPx,
            stopPx: ref * (1 + (sign * spec.exit.stop.pct) / 100),
            takePx: ref * (1 + (sign * spec.exit.take.pct) / 100),
            feesUsd: a.size.usd * fee,
            fundingUsd: 0,
          };
          open.push({ t, qty, liqPx: entryPx * (1 - sign / a.lev), lastAt: now });
          result.fills.push({ trade: tradeN, at: now, coin: a.coin, side: long ? "buy" : "sell", mark: ref, px: entryPx, qty });
        });
      }
    }

    let equity = realized;
    for (const p of open) {
      const mark = view.hlMark(p.t.coin)?.value ?? p.t.entryPx;
      const long = p.t.side === "long";
      equity += Math.max(-p.t.sizeUsd / p.t.lev, p.qty * (long ? mark - p.t.entryPx : p.t.entryPx - mark)) - p.t.feesUsd + p.t.fundingUsd;
    }
    peak = Math.max(peak, equity);
    result.maxDrawdownUsd = Math.max(result.maxDrawdownUsd, peak - equity);
  }

  const last = frames[frames.length - 1].t;
  for (const p of open) close(p, last, view.hlMark(p.t.coin)?.value ?? p.t.entryPx, "end");
  result.maxDrawdownUsd = Math.max(result.maxDrawdownUsd, peak - realized);
  result.trades.sort((a, b) => a.n - b.n || a.firedAt - b.firedAt);
  result.totalPnlUsd = result.trades.reduce((s, t) => s + t.pnlUsd, 0);
  return result;
}
