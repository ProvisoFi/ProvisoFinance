// Market inputs the evaluator reads. Every getter returns the value with the source's own
// timestamp (`at`, ms) so conditions can fail closed on stale data. Pure: no clock, no I/O.

export type Stamped<T> = { value: T; at: number };
export type Session = "pre" | "regular" | "post" | "closed";
export type CorporateActionKind = "split" | "reverse_split" | "dividend" | "merger" | "spinoff";
export type CorporateAction = { kind: CorporateActionKind; at: number };
export type Post = { id: string; at: number; text: string };

export interface MarketView {
  /** Hyperliquid perp mark, USD. */
  hlMark(coin: string): Stamped<number> | undefined;
  /** Hyperliquid oracle price: the mark's second source. */
  hlOracle(coin: string): Stamped<number> | undefined;
  /** Hourly funding rate in percent (0.01 = 0.01%/h). */
  hlFunding(coin: string): Stamped<number> | undefined;
  /** Open interest, USD notional. */
  hlOi(coin: string): Stamped<number> | undefined;
  hlVolume24h(coin: string): Stamped<number> | undefined;
  hlHalted(coin: string): Stamped<boolean> | undefined;
  /** Venue health guard: true while Hyperliquid is degraded (runtime/venue.ts). Optional: replays have none. */
  venueDown?(venue: "hl"): Stamped<boolean> | undefined;
  /** Latest recorded mark at or before `t` (for `change`). */
  hlMarkAt(coin: string, t: number): Stamped<number> | undefined;
  /** Robinhood Chain pool price of a Stock Token, USD. */
  rhcPool(coin: string): Stamped<number> | undefined;
  /** The pool price's second source: Chainlink, or a second pool. */
  rhcRef(coin: string): Stamped<number> | undefined;
  rhcDepth(coin: string): Stamped<number> | undefined;
  /** True while the US market is closed (the "closed session" flag on Stock Token prices). */
  rhcClosed(coin: string): Stamped<boolean> | undefined;
  session(): Stamped<Session> | undefined;
  fearGreed(): Stamped<number> | undefined;
  /** Earnings dates (ms). `at` = when the calendar was last fetched. */
  earnings(coin: string): Stamped<number[]> | undefined;
  corporateActions(coin: string): Stamped<CorporateAction[]> | undefined;
  /** Recent posts by an X account. `at` = last successful poll. */
  posts(account: string): Stamped<Post[]> | undefined;
}

/** One source update. Optional fields left out keep their previous value (and its timestamp). */
export type Update =
  | {
      src: "hl";
      coin: string;
      at: number;
      mark?: number;
      oracle?: number;
      funding?: number;
      oi?: number;
      volume24h?: number;
      halted?: boolean;
    }
  | { src: "rhc"; coin: string; at: number; pool?: number; ref?: number; depth?: number; closed?: boolean }
  | { src: "session"; at: number; value: Session }
  | { src: "fg"; at: number; value: number }
  | { src: "venue"; venue: "hl"; at: number; down: boolean }
  | { src: "earnings"; coin: string; at: number; dates: number[] }
  | { src: "corp"; coin: string; at: number; actions: CorporateAction[] }
  /** Posts are merged by id; send only new ones or the whole recent page. */
  | { src: "posts"; account: string; at: number; posts: Post[] };

/** Index key of the input an update touches; conditions report the same keys (see readKeys). */
export function updateKey(u: Update): string {
  switch (u.src) {
    case "hl":
    case "rhc":
    case "earnings":
    case "corp":
      return `${u.src}:${u.coin}`;
    case "posts":
      return `posts:${u.account.toLowerCase()}`;
    default:
      return u.src;
  }
}

/** Fixed-capacity ring of (t, value), ascending t, at most one sample per `resolutionMs`. */
export class Ring {
  private ts: Float64Array;
  private vs: Float64Array;
  private start = 0;
  private len = 0;
  constructor(
    readonly capacity: number,
    readonly resolutionMs: number,
  ) {
    this.ts = new Float64Array(capacity);
    this.vs = new Float64Array(capacity);
  }
  private idx(i: number) {
    return (this.start + i) % this.capacity;
  }
  /** Appends a sample, overwriting the oldest when full. Ignored when out of order or within `resolutionMs` of the last one. */
  push(t: number, v: number) {
    if (this.len && t - this.ts[this.idx(this.len - 1)] < this.resolutionMs) return; // out of order or too close
    if (this.len < this.capacity) {
      this.ts[this.idx(this.len)] = t;
      this.vs[this.idx(this.len)] = v;
      this.len++;
    } else {
      this.ts[this.start] = t;
      this.vs[this.start] = v;
      this.start = (this.start + 1) % this.capacity;
    }
  }
  /** Latest sample with ts <= t. */
  at(t: number): Stamped<number> | undefined {
    let lo = 0;
    let hi = this.len - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[this.idx(mid)] <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return undefined;
    const i = this.idx(found);
    return { value: this.vs[i], at: this.ts[i] };
  }
  get size() {
    return this.len;
  }
}

type HlState = Partial<Record<"mark" | "oracle" | "funding" | "oi" | "volume24h", Stamped<number>>> & {
  halted?: Stamped<boolean>;
  history?: Ring;
};
type RhcState = Partial<Record<"pool" | "ref" | "depth", Stamped<number>>> & { closed?: Stamped<boolean> };

export type MemoryViewOptions = {
  /** Mark history spacing for `change`. Default 60 s. */
  historyResolutionMs?: number;
  /** Mark history length per coin. Default 31 days at the resolution. */
  historyCapacity?: number;
  /** Posts older than this (relative to the update) are dropped. Default 24 h. */
  postRetentionMs?: number;
};

/** In-memory MarketView fed by `apply`. Used live (one per evaluator) and by the tester. */
export class MemoryMarketView implements MarketView {
  private hl = new Map<string, HlState>();
  private rhc = new Map<string, RhcState>();
  private sessionV?: Stamped<Session>;
  private fg?: Stamped<number>;
  private earn = new Map<string, Stamped<number[]>>();
  private corp = new Map<string, Stamped<CorporateAction[]>>();
  private postsByAcct = new Map<string, Stamped<Post[]>>();
  private readonly res: number;
  private readonly cap: number;
  private readonly postRetention: number;

  constructor(opts: MemoryViewOptions = {}) {
    this.res = opts.historyResolutionMs ?? 60_000;
    this.cap = opts.historyCapacity ?? Math.ceil((31 * 86_400_000) / this.res) + 1;
    this.postRetention = opts.postRetentionMs ?? 86_400_000;
  }

  /** Applies one update and returns its index key. */
  apply(u: Update): string {
    const at = u.at;
    switch (u.src) {
      case "hl": {
        const s = this.hl.get(u.coin) ?? {};
        this.hl.set(u.coin, s);
        for (const k of ["mark", "oracle", "funding", "oi", "volume24h"] as const)
          if (u[k] !== undefined) s[k] = { value: u[k], at };
        if (u.halted !== undefined) s.halted = { value: u.halted, at };
        if (u.mark !== undefined) (s.history ??= new Ring(this.cap, this.res)).push(at, u.mark);
        break;
      }
      case "rhc": {
        const s = this.rhc.get(u.coin) ?? {};
        this.rhc.set(u.coin, s);
        for (const k of ["pool", "ref", "depth"] as const) if (u[k] !== undefined) s[k] = { value: u[k], at };
        if (u.closed !== undefined) s.closed = { value: u.closed, at };
        break;
      }
      case "session":
        this.sessionV = { value: u.value, at };
        break;
      case "fg":
        this.fg = { value: u.value, at };
        break;
      case "venue":
        this.venue.set(u.venue, { value: u.down, at });
        break;
      case "earnings":
        this.earn.set(u.coin, { value: [...u.dates], at });
        break;
      case "corp":
        this.corp.set(u.coin, { value: [...u.actions], at });
        break;
      case "posts": {
        const key = u.account.toLowerCase();
        const byId = new Map((this.postsByAcct.get(key)?.value ?? []).map((p) => [p.id, p]));
        for (const p of u.posts) byId.set(p.id, p);
        const kept = [...byId.values()].filter((p) => at - p.at <= this.postRetention).sort((a, b) => a.at - b.at);
        this.postsByAcct.set(key, { value: kept, at });
        break;
      }
    }
    return updateKey(u);
  }

  hlMark = (c: string) => this.hl.get(c)?.mark;
  hlOracle = (c: string) => this.hl.get(c)?.oracle;
  hlFunding = (c: string) => this.hl.get(c)?.funding;
  hlOi = (c: string) => this.hl.get(c)?.oi;
  hlVolume24h = (c: string) => this.hl.get(c)?.volume24h;
  hlHalted = (c: string) => this.hl.get(c)?.halted;
  private readonly venue = new Map<string, Stamped<boolean>>();
  venueDown = (v: "hl") => this.venue.get(v);
  hlMarkAt = (c: string, t: number) => this.hl.get(c)?.history?.at(t);
  rhcPool = (c: string) => this.rhc.get(c)?.pool;
  rhcRef = (c: string) => this.rhc.get(c)?.ref;
  rhcDepth = (c: string) => this.rhc.get(c)?.depth;
  rhcClosed = (c: string) => this.rhc.get(c)?.closed;
  session = () => this.sessionV;
  fearGreed = () => this.fg;
  earnings = (c: string) => this.earn.get(c);
  corporateActions = (c: string) => this.corp.get(c);
  posts = (a: string) => this.postsByAcct.get(a.toLowerCase());
}
