// Proviso Paper (expansion #5): a paper call fires like any other, but its trades are simulated on
// Hyperliquid's real order books instead of placed. No key, no deposit, no money moves. Fill model
// "paper-v1", published so anyone can check a paper record:
//  - Entries and exits walk the live L2 book (asks to buy, bids to sell), only within 2% of the mark
//    (the same band live orders are held to); what the book can't fill inside the band isn't filled.
//  - Only resting liquidity counts: the book is read twice, half a second apart, and each level counts
//    at the smaller of its two sizes (size that flashes in for one snapshot is ignored).
//  - Fees: Hyperliquid's base taker fee (0.045%; HIP-3 markets in growth mode 0.009%) plus Proviso's
//    0.05% builder fee, on every fill.
//  - A market the venue delists or halts settles at its last mark (reason "settled_by_venue", no fee).
//  - Funding: hourly at the venue's rate on the position's value (longs pay positive funding).
//  - Liquidation at the mark when losses and funding leave less than maintenance margin (half the
//    initial margin at the market's max leverage); the position's margin is lost.
//  - Stop and target from the trigger mark, like live; outside a market's session only liquidation
//    is checked (session guards).
// Fills go to `orders` with venue "paper", so FILL stamps (fillModel "paper-v1") are written by the
// same trigger as live fills, and positions are rebuilt from those rows after a restart.
import { fires, orders, theses, type Db } from "@proviso/db";
import { durationMs, marketSession, sessionTradable, type Spec } from "@proviso/dsl";
import type { L2Book } from "@proviso/hl";
import { and, asc, eq, inArray } from "drizzle-orm";
import { exitLevels, exitProgress, nextExit, type ExitLevels, type ExitProgress } from "../faircopy/planner";
import type { ExecutorPort, FireInput } from "../runtime/ports";

export const FILL_MODEL = "paper-v1";
export const PAPER_TAKER_FEE = 0.00045;
/** HIP-3 growth-mode taker fee (xyz and other builder-deployed dexes). */
export const PAPER_HIP3_TAKER_FEE = 0.00009;
export const PAPER_BUILDER_FEE = 0.0005;
/** Fee rate per fill on `coin`: venue taker plus Proviso builder. */
export const paperFeeRate = (coin: string) => (coin.includes(":") ? PAPER_HIP3_TAKER_FEE : PAPER_TAKER_FEE) + PAPER_BUILDER_FEE;

/** Each level of `now` at the smaller of its sizes in both snapshots; levels missing from `before` don't count. */
export function stableBook(now: L2Book, before: L2Book): L2Book {
  const side = (i: 0 | 1) => {
    const prev = new Map(before.levels[i].map((l) => [l.px, Number(l.sz)]));
    return now.levels[i].flatMap((l) => (prev.has(l.px) ? [{ ...l, sz: String(Math.min(Number(l.sz), prev.get(l.px)!)) }] : []));
  };
  return { ...now, levels: [side(0), side(1)] };
}
export const PAPER_PRICE_BAND = 0.02;

type Side = "long" | "short";
type Leg = { coin: string; side: Side; sz: number; entryPx: number; lev: number; maxLev: number };
type PaperIdea = {
  thesisId: bigint;
  owner: string;
  fireId: string;
  legs: Leg[];
  levels: ExitLevels;
  feesUsd: number;
  fundingUsd: number;
  /** P&L already realized by partial targets (before fees). */
  realizedUsd: number;
  spec: Spec;
  refPx: number;
  progress: ExitProgress;
  busy: boolean;
};
export type PaperExit = { thesisId: bigint; at: Date; reason: string; pnlUsd: number; feesUsd: number; fundingUsd: number };

/** Walks one side of the book for `usd` of notional within `band` of `mark`: size filled and its average price. */
export function walkBook(book: L2Book, isBuy: boolean, usd: number, mark: number, band = PAPER_PRICE_BAND) {
  const levels = book.levels[isBuy ? 1 : 0];
  const limit = isBuy ? mark * (1 + band) : mark * (1 - band);
  let sz = 0, cost = 0;
  for (const l of levels) {
    const px = Number(l.px), avail = Number(l.sz);
    if (!(px > 0 && avail > 0) || (isBuy ? px > limit : px < limit)) break;
    const take = Math.min(avail, (usd - cost) / px);
    sz += take;
    cost += take * px;
    if (cost >= usd - 1e-9) break;
  }
  return { sz, avgPx: sz > 0 ? cost / sz : 0 };
}

/** Same walk to close `sz` units: how much closes inside the band, and at what average price. */
export function walkClose(book: L2Book, isBuy: boolean, sz: number, mark: number, band = PAPER_PRICE_BAND) {
  const levels = book.levels[isBuy ? 1 : 0];
  const limit = isBuy ? mark * (1 + band) : mark * (1 - band);
  let done = 0, cost = 0;
  for (const l of levels) {
    const px = Number(l.px), avail = Number(l.sz);
    if (!(px > 0 && avail > 0) || (isBuy ? px > limit : px < limit)) break;
    const take = Math.min(avail, sz - done);
    done += take;
    cost += take * px;
    if (done >= sz - 1e-12) break;
  }
  return { sz: done, avgPx: done > 0 ? cost / done : 0 };
}

const dir = (s: Side) => (s === "long" ? 1 : -1);

/** True once losses and funding leave the leg under maintenance margin (half of initial margin at max leverage). */
export function liquidated(leg: Leg, mark: number, fundingUsd = 0) {
  const margin = (leg.sz * leg.entryPx) / leg.lev;
  const maintenance = (leg.sz * mark) / (2 * leg.maxLev);
  const unrealized = (mark - leg.entryPx) * leg.sz * dir(leg.side);
  return margin + unrealized - fundingUsd <= maintenance;
}

export class PaperEngine implements ExecutorPort {
  private readonly open = new Map<string, PaperIdea>();
  private readonly marks = new Map<string, number>();

  constructor(
    private readonly d: {
      db: Db;
      info: { l2Book(coin: string): Promise<L2Book> };
      /** Max leverage per coin (for maintenance margin); 10 when unknown. */
      maxLeverage?: (coin: string) => number | undefined;
      onExit?: (e: PaperExit) => void;
      log?: (owner: string, kind: string, payload: Record<string, unknown>) => Promise<void> | void;
      now?: () => Date;
      /** Gap between the two book snapshots (ms); tests pass 0. */
      stableMs?: number;
    },
  ) {}

  /** The book as paper fills see it: two snapshots `stableMs` apart, resting size only. */
  private async book(coin: string): Promise<L2Book> {
    const before = await this.d.info.l2Book(coin);
    await new Promise((r) => setTimeout(r, this.d.stableMs ?? 500));
    return stableBook(await this.d.info.l2Book(coin), before);
  }

  openIdeas(): bigint[] {
    return [...this.open.values()].map((i) => i.thesisId);
  }

  private async log(owner: string, kind: string, payload: Record<string, unknown>) {
    await this.d.log?.(owner, kind, payload);
  }

  /** Simulates the entry of a fired paper call: one fill per Hyperliquid open action, walked on the live book. */
  async onFire(e: FireInput): Promise<void> {
    if (e.spec.mode !== "paper") return;
    const k = e.thesisId.toString();
    if (this.open.has(k)) return void (await this.log(e.owner, "paper_refused", { thesisId: k, reason: "already_open" }));
    const opens = e.spec.entry.then.filter((a): a is Extract<Spec["entry"]["then"][number], { action: "open" }> => a.venue === "hl" && a.action === "open");
    const legs: Leg[] = [];
    let feesUsd = 0;
    for (const a of opens) {
      try {
        const book = await this.book(a.coin);
        const mark = this.marks.get(a.coin) ?? (a === opens[0] ? e.mark : midOf(book));
        const f = walkBook(book, a.side === "long", a.size.usd, mark);
        await this.record(e, a.coin, a.side === "long" ? "long" : "short", f.sz, f.avgPx, false, a.size.usd);
        if (!(f.sz > 0)) continue;
        feesUsd += f.sz * f.avgPx * paperFeeRate(a.coin);
        legs.push({ coin: a.coin, side: a.side, sz: f.sz, entryPx: f.avgPx, lev: a.lev, maxLev: this.d.maxLeverage?.(a.coin) ?? 10 });
      } catch (err) {
        await this.log(e.owner, "paper_fill_failed", { thesisId: k, coin: a.coin, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!legs.length) return void (await this.log(e.owner, "paper_no_position", { thesisId: k }));
    this.open.set(k, {
      thesisId: e.thesisId,
      owner: e.owner,
      fireId: e.fireId,
      legs,
      levels: exitLevels(e.spec.exit, e.mark, legs[0]!.side),
      feesUsd,
      fundingUsd: 0,
      realizedUsd: 0,
      spec: e.spec,
      refPx: e.mark,
      progress: exitProgress(e.mark, e.at.getTime()),
      busy: false,
    });
    await this.log(e.owner, "paper_entered", { thesisId: k, legs: legs.length, feesUsd, fillModel: FILL_MODEL });
  }

  /** Marks drive paper exits: liquidation always, stop and target only while the market is in session. */
  onMark(coin: string, mark: number, at: Date): void {
    if (!(mark > 0)) return;
    this.marks.set(coin, mark);
    for (const idea of this.open.values()) {
      if (idea.busy) continue;
      const legMark = (l: Leg) => (l.coin === coin ? mark : this.marks.get(l.coin));
      if (idea.legs.some((l) => l.coin === coin && liquidated(l, mark, idea.fundingUsd / idea.legs.length))) {
        void this.close(idea, "liquidated", at);
        continue;
      }
      const first = idea.legs[0]!;
      if (first.coin !== coin || !sessionTradable(marketSession(coin, at)) || !idea.legs.every((l) => legMark(l) !== undefined)) continue;
      const step = nextExit(idea.spec.exit, idea.levels, first.side, idea.refPx, mark, idea.progress, at.getTime());
      if (step?.kind === "partial") void this.partial(idea, step.index, step.share);
      else if (step) void this.close(idea, step.kind, at);
    }
  }

  /** Time exits (TU-32) for paper calls whose market sends no marks; run every half minute. */
  checkTimeExits(at = this.d.now?.() ?? new Date()) {
    for (const idea of this.open.values()) {
      const first = idea.legs[0];
      if (idea.busy || !first || !idea.spec.exit.maxHold || !sessionTradable(marketSession(first.coin, at))) continue;
      if (at.getTime() - idea.progress.firedAt >= durationMs(idea.spec.exit.maxHold)) void this.close(idea, "time", at);
    }
  }

  /** A partial target: closes its share of every leg on the book and books its P&L; the rest stays open. */
  private async partial(idea: PaperIdea, index: number, share: number) {
    if (idea.busy) return;
    idea.busy = true;
    try {
      for (const l of idea.legs) {
        const mark = this.marks.get(l.coin) ?? l.entryPx;
        const sz = l.sz * Math.min(1, share);
        const book = await this.book(l.coin);
        const c = walkClose(book, l.side !== "long", sz, mark);
        const edge = mark * (1 - dir(l.side) * PAPER_PRICE_BAND);
        const avgPx = (c.sz * c.avgPx + (sz - c.sz) * edge) / sz;
        idea.realizedUsd += (avgPx - l.entryPx) * sz * dir(l.side);
        idea.feesUsd += sz * avgPx * paperFeeRate(l.coin);
        l.sz -= sz;
        await this.record({ fireId: idea.fireId, thesisId: idea.thesisId, owner: idea.owner }, l.coin, l.side === "long" ? "sell" : "buy", sz, avgPx, true);
      }
      idea.progress.taken = index + 1;
      idea.progress.closed += idea.spec.exit.partials![index]!.fraction;
      await this.log(idea.owner, "paper_partial_exit", { thesisId: idea.thesisId.toString(), index, closed: idea.progress.closed });
    } catch (err) {
      await this.log(idea.owner, "paper_exit_failed", { thesisId: idea.thesisId.toString(), reason: "partial", error: err instanceof Error ? err.message : String(err) });
    } finally {
      idea.busy = false;
    }
  }

  /** Hourly funding on every open paper leg, at `rate` (per hour, as a fraction) and the current mark. */
  accrueFunding(rateOf: (coin: string) => number | undefined) {
    for (const idea of this.open.values())
      for (const l of idea.legs) {
        const rate = rateOf(l.coin), mark = this.marks.get(l.coin) ?? l.entryPx;
        if (rate !== undefined && Number.isFinite(rate)) idea.fundingUsd += rate * l.sz * mark * dir(l.side);
      }
  }

  /** Settles every open paper call on a market the venue has delisted or halted, at its last mark. */
  settleDelisted(delisted: (coin: string) => boolean, at = this.d.now?.() ?? new Date()) {
    for (const idea of this.open.values()) if (idea.legs.some((l) => delisted(l.coin))) void this.close(idea, "settled_by_venue", at);
  }

  /** The owner's Stop on a paper call: closes it on the book. False if it isn't an open paper call. */
  async stopPaper(thesisId: bigint, owner: string): Promise<boolean> {
    const idea = this.open.get(thesisId.toString());
    if (!idea || idea.owner !== owner.toLowerCase()) return false;
    await this.close(idea, "stopped", this.d.now?.() ?? new Date());
    return true;
  }

  async stop(thesisId: bigint, owner: string): Promise<void> {
    await this.stopPaper(thesisId, owner);
  }

  private async close(idea: PaperIdea, reason: string, at: Date) {
    if (idea.busy) return;
    idea.busy = true;
    const k = idea.thesisId.toString();
    try {
      let pnl = 0, fees = idea.feesUsd;
      for (const l of idea.legs) {
        const mark = this.marks.get(l.coin) ?? l.entryPx;
        if (reason === "liquidated" || reason === "settled_by_venue") {
          // Isolated margin: a liquidated leg loses its margin; the venue closes it at the mark (no fee).
          const gone = reason === "liquidated" && liquidated(l, mark, idea.fundingUsd / idea.legs.length);
          pnl += gone ? -(l.sz * l.entryPx) / l.lev : (mark - l.entryPx) * l.sz * dir(l.side);
          await this.record({ fireId: idea.fireId, thesisId: idea.thesisId, owner: idea.owner }, l.coin, l.side === "long" ? "sell" : "buy", l.sz, mark, true);
          continue;
        }
        const book = await this.book(l.coin);
        const c = walkClose(book, l.side !== "long", l.sz, mark);
        // What the book can't take inside the band closes at the band's edge: paper never leaves a position stuck.
        const rest = l.sz - c.sz, edge = mark * (1 - dir(l.side) * PAPER_PRICE_BAND);
        const avgPx = (c.sz * c.avgPx + rest * edge) / l.sz;
        pnl += (avgPx - l.entryPx) * l.sz * dir(l.side);
        fees += l.sz * avgPx * paperFeeRate(l.coin);
        await this.record({ fireId: idea.fireId, thesisId: idea.thesisId, owner: idea.owner }, l.coin, l.side === "long" ? "sell" : "buy", l.sz, avgPx, true);
      }
      const pnlUsd = idea.realizedUsd + pnl - fees - idea.fundingUsd;
      this.open.delete(k);
      await this.log(idea.owner, "paper_exit", { thesisId: k, reason, pnlUsd, feesUsd: fees, fundingUsd: idea.fundingUsd, fillModel: FILL_MODEL });
      this.d.onExit?.({ thesisId: idea.thesisId, at, reason, pnlUsd, feesUsd: fees, fundingUsd: idea.fundingUsd });
    } catch (err) {
      await this.log(idea.owner, "paper_exit_failed", { thesisId: k, reason, error: err instanceof Error ? err.message : String(err) });
    } finally {
      idea.busy = false;
    }
  }

  /** One `orders` row per simulated fill (venue "paper"); the FILL stamp comes from the orders trigger. */
  private async record(
    e: { fireId: string; thesisId: bigint; owner: string },
    coin: string,
    side: "long" | "short" | "buy" | "sell",
    sz: number,
    px: number,
    reduceOnly: boolean,
    usd?: number,
  ) {
    const wanted = usd !== undefined && px > 0 ? usd / px : sz;
    await this.d.db.insert(orders).values({
      fireId: e.fireId,
      thesisId: e.thesisId,
      account: e.owner,
      role: "caller",
      wave: 0,
      venue: "paper",
      coin,
      side,
      size: String(wanted),
      px: px > 0 ? String(px) : null,
      reduceOnly,
      status: sz <= 0 ? "rejected" : usd !== undefined && sz * px < usd * 0.999 ? "partial" : "filled",
      filledSize: String(sz),
      avgPx: sz > 0 ? String(px) : null,
      error: sz <= 0 ? "No liquidity inside 2% of the mark" : null,
    });
  }

  /** After a restart: rebuilds open paper positions from their `orders` rows (fees recomputed; funding accrued so far is not). */
  async restore(specFor: (thesisId: bigint) => Spec | undefined): Promise<bigint[]> {
    const rows = await this.d.db
      .select({ o: orders, state: theses.state, owner: theses.owner })
      .from(orders)
      .innerJoin(theses, eq(orders.thesisId, theses.id))
      .where(and(eq(orders.venue, "paper"), inArray(theses.state, ["fired", "alert", "retired"])))
      .orderBy(asc(orders.createdAt));
    const byThesis = new Map<string, typeof rows>();
    for (const r of rows) byThesis.set(r.o.thesisId.toString(), [...(byThesis.get(r.o.thesisId.toString()) ?? []), r]);
    const out: bigint[] = [];
    for (const [k, list] of byThesis) {
      const tid = BigInt(k);
      const spec = specFor(tid);
      if (!spec || spec.mode !== "paper" || this.open.has(k)) continue;
      const lastFire = list.at(-1)!.o.fireId;
      const mine = list.filter((r) => r.o.fireId === lastFire);
      const opens = mine.filter((r) => !r.o.reduceOnly && Number(r.o.filledSize) > 0);
      if (!opens.length || !lastFire) continue;
      const [f] = await this.d.db.select().from(fires).where(eq(fires.id, lastFire));
      const specLegs = spec.entry.then.filter((a) => a.venue === "hl" && a.action === "open") as { coin: string; lev: number }[];
      let realizedUsd = 0;
      let feesUsd = 0;
      let opened0 = 0;
      let closed0 = 0;
      const legs: Leg[] = [];
      for (const r of opens) {
        const side: Side = r.o.side === "short" ? "short" : "long";
        const sz = Number(r.o.filledSize);
        const entryPx = Number(r.o.avgPx);
        feesUsd += sz * entryPx * paperFeeRate(r.o.coin);
        // Closes of this leg so far: partial targets, or the final close.
        let left = sz;
        for (const c of mine.filter((x) => x.o.reduceOnly && x.o.coin === r.o.coin && Number(x.o.filledSize) > 0)) {
          const csz = Number(c.o.filledSize);
          const cpx = Number(c.o.avgPx);
          left -= csz;
          realizedUsd += (cpx - entryPx) * csz * dir(side);
          feesUsd += csz * cpx * paperFeeRate(r.o.coin);
        }
        if (r === opens[0]) {
          opened0 = sz;
          closed0 = sz - left;
        }
        if (left > sz * 1e-9)
          legs.push({ coin: r.o.coin, side, sz: left, entryPx, lev: specLegs.find((a) => a.coin === r.o.coin)?.lev ?? 1, maxLev: this.d.maxLeverage?.(r.o.coin) ?? 10 });
      }
      if (!legs.length) continue; // already closed
      const refPx = Number(f?.refMark ?? legs[0]!.entryPx);
      // ponytail: the trailing peak restarts at the trigger mark after a restart.
      const progress = exitProgress(refPx, (f?.firedAt ?? new Date()).getTime());
      progress.closed = opened0 > 0 ? closed0 / opened0 : 0;
      let cum = 0;
      progress.taken = (spec.exit.partials ?? []).filter((p) => (cum += p.fraction) <= progress.closed + 1e-6).length;
      this.open.set(k, {
        thesisId: tid,
        owner: list[0]!.owner,
        fireId: lastFire,
        legs,
        levels: exitLevels(spec.exit, refPx, legs[0]!.side),
        feesUsd,
        fundingUsd: 0,
        realizedUsd,
        spec,
        refPx,
        progress,
        busy: false,
      });
      out.push(tid);
    }
    return out;
  }
}

const midOf = (b: L2Book) => {
  const bid = Number(b.levels[0][0]?.px), ask = Number(b.levels[1][0]?.px);
  return bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || 0;
};
