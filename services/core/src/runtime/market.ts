// Hyperliquid (testnet by default) and Fear & Greed adapters feeding evaluator Updates.
import type { Meta, PerpAssetCtx, WsActiveAssetCtx } from "@proviso/hl";
import type { Update } from "../evaluator/state.ts";
import type { Log } from "./ports.ts";

export type SocketPort = {
  subscribe(sub: { type: "activeAssetCtx"; coin: string }, handler: (d: WsActiveAssetCtx) => void): () => void;
};
export type MetaPort = { metaAndAssetCtxs(): Promise<[Meta, PerpAssetCtx[]]> };

const num = (s: string | null | undefined) => {
  if (s == null) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * Perp asset context -> Update. Units: funding is HL's hourly fraction -> %/h (×100);
 * openInterest is in coins -> USD (× mark); dayNtlVlm is already USD.
 */
export function ctxUpdate(coin: string, ctx: PerpAssetCtx, at: number, halted?: boolean): Update {
  const mark = num(ctx.markPx);
  const funding = num(ctx.funding);
  const oi = num(ctx.openInterest);
  return {
    src: "hl",
    coin,
    at,
    mark,
    oracle: num(ctx.oraclePx),
    funding: funding === undefined ? undefined : funding * 100,
    oi: oi === undefined || mark === undefined ? undefined : oi * mark,
    volume24h: num(ctx.dayNtlVlm),
    halted,
  };
}

export type HlMarketDeps = {
  socket: SocketPort;
  info?: MetaPort;
  /** Evaluator entry point (Evaluator.apply). */
  apply: (u: Update) => void;
  /** Every mark, undebounced (executor stops and takes). */
  onMark?: (coin: string, mark: number, at: Date) => void;
  /** Evaluator updates per coin at most this often; the latest context wins. Default 5 s. */
  debounceMs?: number;
  now?: () => number;
  log?: Log;
};

export class HlMarket {
  private subs = new Map<string, () => void>();
  private lastApplied = new Map<string, number>();
  private pending = new Map<string, PerpAssetCtx>();
  /** Delisted per meta; Hyperliquid has no other halt signal in its public data. */
  private halted = new Map<string, boolean>();
  private readonly now: () => number;
  private readonly debounceMs: number;

  constructor(private readonly d: HlMarketDeps) {
    this.now = d.now ?? Date.now;
    this.debounceMs = d.debounceMs ?? 5_000;
  }

  get coins() {
    return [...this.subs.keys()];
  }

  /** Subscribes to exactly these coins (the ones live ideas read). */
  setCoins(coins: Iterable<string>) {
    const want = new Set(coins);
    for (const [coin, unsub] of this.subs)
      if (!want.has(coin)) {
        unsub();
        this.subs.delete(coin);
        this.pending.delete(coin);
        this.lastApplied.delete(coin);
      }
    for (const coin of want)
      if (!this.subs.has(coin)) this.subs.set(coin, this.d.socket.subscribe({ type: "activeAssetCtx", coin }, (m) => this.onCtx(m)));
  }

  private onCtx(m: WsActiveAssetCtx) {
    if (!this.subs.has(m.coin) || !("funding" in m.ctx)) return; // perps only
    const ctx = m.ctx;
    const now = this.now();
    const mark = num(ctx.markPx);
    if (mark !== undefined) this.d.onMark?.(m.coin, mark, new Date(now));
    if (now - (this.lastApplied.get(m.coin) ?? -Infinity) >= this.debounceMs) this.push(m.coin, ctx, now);
    else this.pending.set(m.coin, ctx);
  }

  private push(coin: string, ctx: PerpAssetCtx, now: number) {
    this.pending.delete(coin);
    this.lastApplied.set(coin, now);
    this.d.apply(ctxUpdate(coin, ctx, now, this.halted.get(coin)));
  }

  /** Applies debounced contexts that are due; call on the runtime clock. */
  flush() {
    const now = this.now();
    for (const [coin, ctx] of this.pending)
      if (now - (this.lastApplied.get(coin) ?? -Infinity) >= this.debounceMs) this.push(coin, ctx, now);
  }

  /** Polls metaAndAssetCtxs: refreshes the delisted flag and backs up the stream for subscribed coins. */
  async refreshMeta() {
    if (!this.d.info) return;
    const [meta, ctxs] = await this.d.info.metaAndAssetCtxs();
    const now = this.now();
    meta.universe.forEach((u, i) => {
      this.halted.set(u.name, u.isDelisted === true);
      const ctx = ctxs[i];
      if (ctx && this.subs.has(u.name)) this.push(u.name, ctx, now);
    });
  }

  close() {
    this.setCoins([]);
  }
}

export const FNG_URL = "https://api.alternative.me/fng/?limit=1";

/** alternative.me response -> Update; `at` is the index's own timestamp. */
export function fearGreedUpdate(body: unknown): Update | undefined {
  const d = (body as { data?: { value?: string; timestamp?: string }[] })?.data?.[0];
  const value = num(d?.value);
  const ts = num(d?.timestamp);
  return value === undefined || ts === undefined ? undefined : { src: "fg", at: ts * 1000, value };
}

export async function pollFearGreed(fetchFn: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = fetch, url = FNG_URL) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Fear & Greed ${res.status}`);
  return fearGreedUpdate(await res.json());
}
