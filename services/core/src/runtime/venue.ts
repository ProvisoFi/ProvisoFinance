// Venue health guard: Hyperliquid's health from a cheap probe and from real call failures. While the
// venue is degraded the evaluator reads Hyperliquid markets as unknown, so no rule fires into an
// outage; an edge that turns true meanwhile fires once the venue is healthy again (never on the outage).
//
// No dead-man cancel: Hyperliquid's scheduleCancel cancels every open order, including the native
// backstop stops that protect positions while core is down, and it allows only a few triggers a day.

export type VenueState = { down: boolean; reason: string | null; since: number | null };

export class VenueHealth {
  private fails = 0;
  private oks = 0;
  private s: VenueState = { down: false, reason: null, since: null };

  constructor(
    private readonly o: {
      onChange: (s: VenueState) => void;
      now?: () => number;
      /** Consecutive failures before degraded, successes before healthy again, and a probe that counts as failed. */
      failAfter?: number;
      recoverAfter?: number;
      slowMs?: number;
    },
  ) {}

  get state(): VenueState {
    return this.s;
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** A call that reached Hyperliquid and got an answer (an order rejection counts: the venue answered). */
  ok() {
    this.fails = 0;
    if (this.s.down && ++this.oks >= (this.o.recoverAfter ?? 3)) this.set({ down: false, reason: null, since: this.now() });
  }

  /** A call that didn't get an answer: network error, timeout, or a 5xx. */
  fail(reason: string) {
    this.oks = 0;
    if (!this.s.down && ++this.fails >= (this.o.failAfter ?? 3)) this.set({ down: true, reason, since: this.now() });
  }

  /** Times `call`; a throw or a reply slower than `slowMs` (default 5 s) is a failure. */
  async probe(call: () => Promise<unknown>) {
    const t = this.now();
    try {
      await call();
      const ms = this.now() - t;
      if (ms > (this.o.slowMs ?? 5_000)) this.fail(`slow: ${ms} ms`);
      else this.ok();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private set(s: VenueState) {
    this.s = s;
    this.fails = 0;
    this.oks = 0;
    this.o.onChange(s);
  }
}

/** A failed call worth counting against the venue: no answer at all, or a server error. Order rejections are answers. */
export const venueFault = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status >= 500 : !(e instanceof Error && e.name === "HlError");
};
