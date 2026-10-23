// Follower P&L (expansion #6.3): what followers actually made copying a caller, next to what the
// caller made on the same calls. Built only from FILL stamp leaves (public, provable, no accounts):
// every Hyperliquid fill, caller and follower, entry and exit. Price P&L on closed size, before fees.

/** The FILL leaf fields this reads (see the orders_fill_stamp trigger). */
export type FillLeaf = { orderId: string; role: string; venue: string; coin: string; side: string; reduceOnly: boolean; filled: string; avgPx: string | null };

/** One side's result on one or more calls: P&L on the closed size, and the entry value of that size. */
export type Leg = { pnlUsd: number; closedUsd: number };
export type CopyCall = { follower: Leg; caller: Leg };

const add = (a: Leg, b: Leg): Leg => ({ pnlUsd: a.pnlUsd + b.pnlUsd, closedUsd: a.closedUsd + b.closedUsd });
const ZERO: Leg = { pnlUsd: 0, closedUsd: 0 };

/** Per role and coin: pooled entry price, P&L on the size closed so far (exact once fully closed). */
function legOf(fills: FillLeaf[]): Leg {
  const byCoin = new Map<string, FillLeaf[]>();
  for (const f of fills) byCoin.set(f.coin, [...(byCoin.get(f.coin) ?? []), f]);
  let out = ZERO;
  for (const list of byCoin.values()) {
    const sum = (xs: FillLeaf[]) => xs.reduce((s, f) => ({ qty: s.qty + Number(f.filled), usd: s.usd + Number(f.filled) * Number(f.avgPx) }), { qty: 0, usd: 0 });
    const entries = list.filter((f) => !f.reduceOnly), exits = list.filter((f) => f.reduceOnly);
    const e = sum(entries), x = sum(exits);
    if (!(e.qty > 0) || !(x.qty > 0)) continue;
    const dir = entries[0]!.side === "buy" || entries[0]!.side === "long" ? 1 : -1;
    const closed = Math.min(e.qty, x.qty);
    const entryPx = e.usd / e.qty, exitPx = x.usd / x.qty;
    out = add(out, { pnlUsd: dir * (exitPx - entryPx) * closed, closedUsd: entryPx * closed });
  }
  return out;
}

/**
 * Per call: followers' and caller's results from its FILL leaves. A fill stamps again as it grows,
 * so each order counts once at its largest size. Calls without a closed follower fill are left out.
 */
export function copyCalls(leaves: { thesisId: string; data: FillLeaf }[]): Map<string, CopyCall> {
  const orders = new Map<string, { thesisId: string; f: FillLeaf }>();
  for (const l of leaves) {
    const d = l.data;
    if (d.venue !== "hl" || !(Number(d.filled) > 0) || !(Number(d.avgPx) > 0)) continue;
    const prev = orders.get(d.orderId);
    if (!prev || Number(d.filled) > Number(prev.f.filled)) orders.set(d.orderId, { thesisId: l.thesisId, f: d });
  }
  const byThesis = new Map<string, FillLeaf[]>();
  for (const { thesisId, f } of orders.values()) byThesis.set(thesisId, [...(byThesis.get(thesisId) ?? []), f]);
  const out = new Map<string, CopyCall>();
  for (const [id, fills] of byThesis) {
    const follower = legOf(fills.filter((f) => f.role === "follower"));
    if (!(follower.closedUsd > 0)) continue;
    out.set(id, { follower, caller: legOf(fills.filter((f) => f.role === "caller")) });
  }
  return out;
}

export type CopySummary = {
  /** Calls with closed follower fills. */
  copiedCalls: number;
  followerPnlUsd: number;
  /** Follower P&L over the entry value of the size they closed, in percent. */
  followerReturnPct: number;
  /** The caller's return on the same calls, same method; null if the caller has no closed fill on them. */
  callerReturnPct: number | null;
};

/** A caller's copied calls summed: what followers made, next to what the caller made on the same calls. */
export function copySummary(calls: Iterable<CopyCall>): CopySummary | null {
  let n = 0, f = ZERO, c = ZERO;
  for (const x of calls) {
    n++;
    f = add(f, x.follower);
    c = add(c, x.caller);
  }
  if (!n) return null;
  return {
    copiedCalls: n,
    followerPnlUsd: f.pnlUsd,
    followerReturnPct: (f.pnlUsd / f.closedUsd) * 100,
    callerReturnPct: c.closedUsd > 0 ? (c.pnlUsd / c.closedUsd) * 100 : null,
  };
}
