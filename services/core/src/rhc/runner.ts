// Robinhood Chain swaps (R4) for live ideas: at the fire, Fair Copy waves (allow-listed followers
// first, then the caller) buy with each account's sealed session key; the bought tokens are held
// as the idea's spot position and sold back on stop / take / a stop request, after which the exit
// is reported (reveal + EXIT stamp). Every attempt is an orders row (venue rhc) plus activity.
// Orders: size = tokenIn base units, filled_size = tokenOut base units received, avg_px = USD per
// non-USDG token.
import { network, swapKeyPolicyFromJson, type SwapKeyPolicy } from "@proviso/chain";
import { activity, allowEntries, feedWanted, follows, orders, swapKeys, theses, users, type Db } from "@proviso/db";
import type { Spec } from "@proviso/dsl";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { erc20Abi, parseEventLogs, type Address, type Hex, type NonceManager, type PublicClient, type WalletClient } from "viem";
import { fireFollows, usersIn } from "../executor/executor";
import { exitHit, exitLevels, type AllowEntry, type ExitLevels, type SizeRule } from "../faircopy/planner";
import { isNonceError, isNonceTooLow, resolveMarket, sendSwap, type ExecutorDeps, type RhcMarket, type RhcSwapAction, type SwapPlan } from "./executor";
import { SessionKeyManager, type SealedSessionKey } from "./policy";

export type SwapExit = { thesisId: bigint; at: Date; reason: "stop" | "take" | "stopped"; pnl?: number };

export type SwapRunnerDeps = {
  db: Db;
  /** 32-byte session-key seal key (derived in the enclave). */
  sealKey: Uint8Array;
  publicClient: PublicClient;
  walletFor(sessionPrivKey: Hex): WalletClient;
  swapKeyPolicy: Address;
  poolManager: Address;
  markets: readonly RhcMarket[];
  /** The adapter's maxOracleAge (default MAX_ORACLE_AGE_S, testnet's 60 s). */
  maxOracleAgeS?: number;
  /** A runner-owned exit closed the idea: reveal the exit part and stamp it. */
  onExit?: (e: SwapExit) => void;
  /** True while the Hyperliquid executor holds this idea (mixed ideas): it then owns the exit. */
  hlOwns?: (thesisId: bigint) => boolean;
  now?: () => Date;
  /** Wait before the one retry on a stale oracle (ops pushes the test feed on demand). */
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string, e?: unknown) => void;
  /** Plans and sends one swap (default: sendSwap); tests stub it. */
  send?: typeof sendSwap;
  /** How long the caller's entry or exit waits for the follower wave before trading anyway (L-1). */
  followerExitWaitMs?: number;
};

/** An exit waits this long for an entry or late copy in progress on the idea, then gives up (logged). */
const EXIT_WAIT_MS = 120_000;
const FOLLOWER_EXIT_WAIT_MS = 20_000;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Asks ops to keep a test feed fresh (on-demand mode). `urgent`: a swap is about to run, so it gets
 * pushed on the adapter's 60 s clock for the next 2 minutes. A no-op on mainnet (Chainlink feeds).
 */
export const wantFeed = async (db: Db, oracle: Address, urgent = false) => {
  if (network() === "mainnet") return;
  const set = { wantedAt: new Date(), ...(urgent && { urgentUntil: new Date(Date.now() + 120_000) }) };
  return db.insert(feedWanted).values({ feed: oracle.toLowerCase(), ...set }).onConflictDoUpdate({ target: feedWanted.feed, set });
};

export type SwapFire = { owner: string; thesisId: bigint; fireId: string; actions: readonly RhcSwapAction[]; spec: Spec };

type Role = "caller" | "follower";
/** `owner`: the Proviso account (notifications, follows); `account`: the swap wallet that holds the tokens. */
type Key = { owner: string; account: Address; wallet: WalletClient; policy: SwapKeyPolicy };
type Holding = Key & { role: Role; bought: bigint; spent: bigint; proceeds: bigint; open: boolean };
type SpotLeg = { action: RhcSwapAction; market: RhcMarket; holdings: Holding[] };
type SpotIdea = {
  thesisId: bigint; owner: string; fireId: string; spec: Spec; levels: ExitLevels; legs: SpotLeg[]; busy: boolean;
  /** The exit in flight, if any: later exit requests join it instead of being dropped. */
  exiting?: Promise<void>;
};

/** Drops the session key's cached nonce (viem nonceManager) so the next send asks the RPC. */
function resetNonce(w: WalletClient) {
  const a = w.account as { address: Address; nonceManager?: NonceManager } | undefined;
  if (a?.nonceManager && w.chain) a.nonceManager.reset({ address: a.address, chainId: w.chain.id });
}

const MIN_COPY_USD = 1;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tokenOf = (m: RhcMarket, sym: string) => (m.symbols[0] === sym ? m.key.currency0 : m.key.currency1);
const decOf = (m: RhcMarket, sym: string) => (m.symbols[0] === sym ? m.decimals[0] : m.decimals[1]);
const units = (x: bigint, dec: number) => Number(x) / 10 ** dec;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Copy size for one swap action: size rule, then allow-list entry (if any), follow and user limits. */
function copySize(f: { sizeRule: unknown; limits: unknown }, user: Record<string, unknown>, allow: AllowEntry[] | null) {
  const rule = f.sizeRule as SizeRule;
  const fl = (f.limits ?? {}) as Record<string, unknown>;
  return (a: RhcSwapAction): number | undefined => {
    const entry = allow?.find((e) => e.coin === a.tokenOut && e.side !== "short");
    if (allow && !entry) return undefined;
    const want = rule.kind === "fixed" ? rule.usd : rule.ratio * a.size.usd;
    const caps = [want, entry?.maxUsd, num(fl.maxUsd), num(user.maxUsd), num(user.maxAllocation)].filter((x): x is number => x !== undefined);
    const usd = Math.floor(Math.min(...caps) * 100) / 100;
    return usd >= MIN_COPY_USD ? usd : undefined;
  };
}

/** Runs the Robinhood Chain swap legs of fired ideas on each account's session key: followers first, then the caller. Tracks the spot positions and exits them on prices, expiry or a Stop. */
export class SwapRunner {
  private readonly manager: SessionKeyManager;
  private readonly exec: ExecutorDeps;
  private readonly open = new Map<string, SpotIdea>();
  private readonly pending = new Set<Promise<void>>();
  /** Per session key: the tail of its swap queue. */
  private readonly keyQueue = new Map<string, Promise<unknown>>();
  constructor(private readonly d: SwapRunnerDeps) {
    this.manager = new SessionKeyManager(d.sealKey);
    this.exec = { publicClient: d.publicClient, swapKeyPolicy: d.swapKeyPolicy, poolManager: d.poolManager, markets: d.markets, maxOracleAgeS: d.maxOracleAgeS };
  }

  private now() {
    return (this.d.now ?? (() => new Date()))();
  }
  private log(address: string, kind: string, payload: Record<string, unknown>) {
    return this.d.db.insert(activity).values({ address, kind, payload });
  }

  /** Thesis ids holding an open spot position. */
  openIdeas(): bigint[] {
    return [...this.open.values()].map((i) => i.thesisId);
  }
  /** Resolves once every exit started by onPrice has finished. */
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** A Proviso account's usable session key (by owner, or by swap wallet), or null (not set up, revoked or expired). */
  private async keyFor(owner: string, by: "owner" | "account" = "owner"): Promise<Key | null> {
    const col = by === "owner" ? swapKeys.address : swapKeys.account;
    const [row] = await this.d.db
      .select()
      .from(swapKeys)
      .where(and(eq(col, owner.toLowerCase()), isNotNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt), gt(swapKeys.expiresAt, this.now())));
    if (!row?.signedPolicy) return null;
    const policy = swapKeyPolicyFromJson(row.signedPolicy as Record<string, unknown>);
    return { owner: row.address, account: policy.account, policy, wallet: this.d.walletFor(this.manager.unseal(row.sealed as SealedSessionKey)) };
  }

  // ------------------------------------------------------------ fire

  /** Enters a fired idea's swap actions for the caller and its followers. Refused when the thesis already has an open entry (`fire_refused`), or logs `needs_swap_setup` when the caller has no usable session key; unknown markets are refused per action. */
  async run(f: SwapFire) {
    const owner = f.owner.toLowerCase();
    const tid = f.thesisId;
    const base = { thesisId: tid.toString(), fireId: f.fireId };
    if (this.open.has(tid.toString())) return void (await this.log(owner, "fire_refused", { ...base, reason: "already_open" }));
    const caller = await this.keyFor(owner);
    if (!caller) return void (await this.log(owner, "needs_swap_setup", base));
    const { auto: copiers, confirm: askers } = await this.followers(owner, tid, base);

    const idea: SpotIdea = { thesisId: tid, owner, fireId: f.fireId, spec: f.spec, levels: { stopPx: 0, takePx: null }, legs: [], busy: true };
    // Registered (busy) for the whole entry, so a Stop pressed meanwhile joins it and sells once the
    // entry is in, instead of finding nothing and being dropped.
    this.open.set(tid.toString(), idea);
    try {
      for (const action of f.actions) {
        const pair = { tokenIn: action.tokenIn, tokenOut: action.tokenOut, usd: action.size.usd };
        const market = resolveMarket(this.d.markets, action.tokenIn, action.tokenOut)?.market;
        if (!market) {
          await this.log(owner, "swap_refused", { ...base, ...pair, reason: "unknown_market" });
          continue;
        }
        await wantFeed(this.d.db, market.oracle, true);
        const leg: SpotLeg = { action, market, holdings: [] };
        const buy = async (k: Key, role: Role, wave: 1 | 2, usd: number) => {
          const a = usd === action.size.usd ? action : { ...action, size: { usd } };
          const r = await this.trade({ key: k, role, wave, action: a, market, fireId: f.fireId, thesisId: tid, side: "buy" });
          if (r.ok) leg.holdings.push({ ...k, role, bought: r.out, spent: r.in, proceeds: 0n, open: true });
          await this.log(k.owner, r.ok ? "swap_done" : "swap_refused", { ...base, ...pair, usd, ...(r.ok ? { tx: r.hash } : { reason: r.reason }), ...(role === "follower" && { copying: owner }) });
        };
        // Wave 1: every follower on its own session key, settled before the caller's swap, but a follower
        // whose own key is backed up can't hold the caller's entry beyond the wait (L-1).
        const followers = Promise.all(copiers.flatMap((c) => (c.usd(action) ? [buy(c.key, "follower", 1, c.usd(action)!)] : [])));
        await this.waitAtMost(followers);
        await buy(caller, "caller", 2, action.size.usd);
        await followers; // their holdings are in the leg before anything can exit it
        if (leg.holdings.length) idea.legs.push(leg);
        // Followers without an allow-list get a one-tap confirm once the caller holds the swap.
        if (leg.holdings.some((h) => h.role === "caller"))
          for (const c of askers) {
            const usd = c.usd(action);
            if (usd) await this.log(c.follower, "copy_confirm_required", { ...base, leg: idea.legs.length - 1, coin: action.tokenOut, side: "buy", notionalUsd: usd, caller: owner, venue: "rhc" });
          }
      }
      const first = idea.legs[0]?.holdings.find((h) => h.role === "caller");
      if (first) {
        const l = idea.legs[0]!;
        const px = units(first.spent, decOf(l.market, l.action.tokenIn)) / units(first.bought, decOf(l.market, l.action.tokenOut));
        idea.levels = exitLevels(f.spec.exit, px, "long");
        await this.log(owner, "swap_entered", { ...base, refPx: px, ...idea.levels });
      }
    } finally {
      idea.busy = false;
      if (!idea.legs.length) this.open.delete(tid.toString()); // nothing was bought (or the entry threw)
    }
  }

  /**
   * Followers with a usable session key. Allow-listed ones copy automatically (`auto`, in wave 1);
   * the rest are asked for a one-tap confirm after the caller's swap (`confirm`). Sizes follow the
   * size rule, capped by the allow-list entry (auto), the follow's and the user's limits.
   */
  private async followers(owner: string, tid: bigint, base: Record<string, string>) {
    const rows = await fireFollows(this.d.db, owner, tid, "rhc", this.now());
    type Copier = { follower: string; key: Key; usd: (a: RhcSwapAction) => number | undefined };
    const auto: Copier[] = [];
    const confirm: Copier[] = [];
    if (!rows.length) return { auto, confirm };
    const limits = new Map((await usersIn(this.d.db, rows.map((r) => r.follower))).map((u) => [u.address, u.limits as Record<string, unknown>]));
    for (const r of rows) {
      const key = await this.keyFor(r.follower);
      if (!key) {
        await this.log(r.follower, "needs_swap_setup", { ...base, copying: owner });
        continue;
      }
      const allow = allowEntries(r.sealedAllowlist);
      const usd = copySize(r, limits.get(r.follower) ?? {}, allow);
      (allow ? auto : confirm).push({ follower: r.follower, key, usd });
    }
    return { auto, confirm };
  }

  /**
   * A follower pressed "Confirm copy" for this fire: buy their share of each swap leg now and add
   * it to the idea, so it exits with the caller. Same checks as the executor's HL confirms
   * (follow, fire, window) happen before this is called.
   */
  async confirm(c: { address: string; follow: typeof follows.$inferSelect; fireId: string }): Promise<"placed" | "refused" | "failed"> {
    const ref = { followId: c.follow.id, fireId: c.fireId };
    const idea = [...this.open.values()].find((i) => i.fireId === c.fireId);
    const refuse = async (reason: string) => (await this.log(c.address, "copy_confirm_refused", { ...ref, reason }), "refused" as const);
    if (!idea || !idea.legs.some((l) => l.holdings.some((h) => h.role === "caller" && h.open))) return refuse("caller_position_closed");
    if (idea.busy || idea.exiting) return refuse("idea_busy");
    if (idea.legs.some((l) => l.holdings.some((h) => same(h.owner, c.address)))) return refuse("already_copied");
    const key = await this.keyFor(c.address);
    if (!key) return void (await this.log(c.address, "needs_swap_setup", { ...ref, copying: idea.owner })), "refused";
    const [u] = await this.d.db.select().from(users).where(eq(users.address, c.address));
    const usdFor = copySize(c.follow, (u?.limits ?? {}) as Record<string, unknown>, null);
    const base = { thesisId: idea.thesisId.toString(), fireId: c.fireId };
    // Wait out the follower's own swaps before taking the idea, so a backed-up follower key can't hold
    // the caller's exit for its whole queue (L-1); then re-check, since an exit may have started meanwhile.
    await this.keyQueue.get(key.policy.sessionKey.toLowerCase());
    if (idea.busy || idea.exiting || this.open.get(idea.thesisId.toString()) !== idea) return refuse("idea_busy");
    if (idea.legs.some((l) => l.holdings.some((h) => same(h.owner, c.address)))) return refuse("already_copied"); // a second press that waited too
    idea.busy = true; // no exit runs while the late copy goes in
    try {
      let placed = 0;
      for (const leg of idea.legs) {
        const usd = usdFor(leg.action);
        if (!usd) continue;
        const r = await this.trade({ key, role: "follower", wave: 1, action: { ...leg.action, size: { usd } }, market: leg.market, fireId: c.fireId, thesisId: idea.thesisId, side: "buy" });
        if (r.ok) {
          leg.holdings.push({ ...key, role: "follower", bought: r.out, spent: r.in, proceeds: 0n, open: true });
          placed++;
        }
        await this.log(c.address, r.ok ? "swap_done" : "swap_refused", { ...base, tokenIn: leg.action.tokenIn, tokenOut: leg.action.tokenOut, usd, copying: idea.owner, ...(r.ok ? { tx: r.hash } : { reason: r.reason }) });
      }
      await this.log(c.address, placed ? "copy_confirmed" : "copy_confirm_failed", { ...base, ...ref, venue: "rhc" });
      return placed ? "placed" : "failed";
    } finally {
      idea.busy = false;
    }
  }

  /** Whether this runner holds an open position for the thesis (copy confirms route here). */
  holds(thesisId: bigint) {
    return this.open.has(thesisId.toString());
  }

  // ------------------------------------------------------------ one swap

  /**
   * One swap at a time per session key (send through receipt), so two ideas of one owner firing in
   * the same tick don't race for its nonce. Different keys still run in parallel.
   */
  private trade(t: Parameters<SwapRunner["tradeNow"]>[0]) {
    const k = t.key.policy.sessionKey.toLowerCase();
    const run = (this.keyQueue.get(k) ?? Promise.resolve()).then(() => this.tradeNow(t));
    const tail = run.catch(() => {});
    this.keyQueue.set(k, tail);
    void tail.then(() => this.keyQueue.get(k) === tail && this.keyQueue.delete(k));
    return run;
  }

  /** Sends one swap (one retry on a stale oracle), records it, returns what moved or why not. */
  private async tradeNow(t: {
    key: Key;
    role: Role;
    wave: 1 | 2;
    action: RhcSwapAction;
    market: RhcMarket;
    fireId: string;
    thesisId: bigint;
    side: "buy" | "sell";
    amountIn?: bigint;
  }): Promise<{ ok: true; in: bigint; out: bigint; hash: Hex } | { ok: false; reason: string }> {
    const coin = t.side === "buy" ? t.action.tokenOut : t.action.tokenIn;
    const [order] = await this.d.db
      .insert(orders)
      .values({ fireId: t.fireId, thesisId: t.thesisId, account: t.key.account.toLowerCase(), role: t.role, wave: t.wave, venue: "rhc", coin, side: t.side, size: "0", reduceOnly: t.side === "sell" })
      .returning({ id: orders.id });
    const settle = (status: "filled" | "rejected" | "failed", set: Partial<typeof orders.$inferInsert>) =>
      this.d.db.update(orders).set({ status, updatedAt: new Date(), ...set }).where(eq(orders.id, order!.id));

    await wantFeed(this.d.db, t.market.oracle, true); // exits too: their feed may be on the idle clock
    const job = { action: t.action, policy: t.key.policy, wallet: t.key.wallet, amountIn: t.amountIn };
    let sent = await this.send(job);
    if (!sent.plan.ok && sent.plan.reason === "stale_oracle") {
      // The first swap after an idle period can beat the on-demand feed push by a few seconds.
      await (this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(this.d.retryMs ?? 12_000);
      sent = await this.send(job);
    }
    if (!sent.plan.ok) {
      await settle("rejected", { error: `${sent.plan.reason}${sent.plan.detail ? `: ${sent.plan.detail}` : ""}` });
      return { ok: false, reason: sent.plan.reason };
    }
    const amountIn = sent.plan.amountIn;
    try {
      const r = await this.d.publicClient.waitForTransactionReceipt({ hash: sent.hash! });
      if (r.status !== "success") throw new Error("reverted on-chain");
      const outToken = tokenOf(t.market, t.action.tokenOut);
      const out = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: r.logs })
        .filter((l) => same(l.address, outToken) && same(l.args.to, t.key.account))
        .reduce((s, l) => s + l.args.value, 0n);
      const usdIn = units(amountIn, decOf(t.market, t.action.tokenIn));
      const usdOut = units(out, decOf(t.market, t.action.tokenOut));
      const px = t.side === "buy" ? usdIn / usdOut : usdOut / usdIn;
      await settle("filled", { size: amountIn.toString(), filledSize: out.toString(), avgPx: Number.isFinite(px) ? String(px) : null, venueOrderId: sent.hash });
      return { ok: true, in: amountIn, out, hash: sent.hash! };
    } catch (e) {
      resetNonce(t.key.wallet); // a dropped tx must not leave a gap for the next one
      await settle("failed", { size: amountIn.toString(), venueOrderId: sent.hash ?? null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return { ok: false, reason: "failed" };
    }
  }

  /** Plans and sends; a lost nonce race resets the key's nonce and re-plans (fresh quote) once. */
  private async send(job: Parameters<typeof sendSwap>[1], retry = true): Promise<{ plan: SwapPlan; hash?: Hex }> {
    try {
      return await (this.d.send ?? sendSwap)(this.exec, job);
    } catch (e) {
      resetNonce(job.wallet); // a failed send may have consumed a nonce locally
      const nonce = isNonceError(e);
      // Retry only when the nonce went to a mined tx; "replacement underpriced" means a tx of ours is
      // still pending at that nonce and may land, so a re-send could buy twice (L-2).
      const again = retry && isNonceTooLow(e);
      this.d.log?.(again ? "swaps: nonce conflict, retrying once" : "swaps: send failed", e);
      if (again) return this.send(job, false);
      return { plan: { ok: false, reason: nonce ? "nonce_conflict" : "send_failed", detail: e instanceof Error ? e.message.slice(0, 200) : String(e) } };
    }
  }

  // ------------------------------------------------------------ exits

  /** RHC price updates (USD per token): a runner-owned idea exits when its stop or take is hit. */
  onPrice(coin: string, usd: number, at = this.now()) {
    if (!(usd > 0)) return;
    for (const idea of this.open.values()) {
      const l = idea.legs[0];
      if (idea.exiting || !l || l.action.tokenOut !== coin || this.d.hlOwns?.(idea.thesisId)) continue;
      const hit = exitHit(idea.levels, "long", usd);
      if (hit) {
        const p = this.exit(idea, hit, at, true).finally(() => this.pending.delete(p));
        this.pending.add(p);
      }
    }
  }

  /** The Hyperliquid executor is exiting a mixed idea: sell its swap legs too (it reports the exit). */
  async close(thesisId: bigint, reason: SwapExit["reason"]) {
    const idea = this.open.get(thesisId.toString());
    if (idea) await this.exit(idea, reason, this.now(), false);
  }

  /** Waits for `p`, or for the follower-wave limit, whichever comes first. */
  private async waitAtMost(p: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, this.d.followerExitWaitMs ?? FOLLOWER_EXIT_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /**
   * A stop request for an idea only this runner holds. Returns whether it held one; throws while the
   * position is still open, so the stop message is retried instead of claiming a sale that didn't happen (L-1).
   */
  async stop(thesisId: bigint): Promise<boolean> {
    await this.idle();
    const tid = thesisId.toString();
    const idea = this.open.get(tid);
    if (!idea) return false;
    await this.exit(idea, "stopped", this.now(), true); // joins an exit already in flight
    if (this.open.get(tid) === idea) await this.exit(idea, "stopped", this.now(), true);
    if (this.open.get(tid) === idea) throw new Error(`swaps: stop for thesis ${tid} left the position open`);
    return true;
  }

  /** Sells every open holding back to its input token, followers first, then the caller. One exit at a time per idea. */
  private exit(idea: SpotIdea, reason: SwapExit["reason"], at: Date, report: boolean): Promise<void> {
    if (!idea.exiting) idea.exiting = this.exitNow(idea, reason, at, report).finally(() => (idea.exiting = undefined));
    return idea.exiting;
  }

  private async exitNow(idea: SpotIdea, reason: SwapExit["reason"], at: Date, report: boolean) {
    const tid = idea.thesisId.toString();
    // An entry or late copy in progress finishes first, so its holding is sold too (L-1: no silent no-op).
    for (let waited = 0; idea.busy; waited += 100) {
      if (waited >= EXIT_WAIT_MS) return void (await this.log(idea.owner, "exit_waiting", { thesisId: tid, reason, venue: "rhc" }));
      await wait(100);
    }
    if (this.open.get(tid) !== idea) return;
    idea.busy = true;
    try {
      for (const leg of idea.legs) {
        const a = leg.action;
        const back: RhcSwapAction = { ...a, tokenIn: a.tokenOut, tokenOut: a.tokenIn };
        const sell = async (h: Holding, wave: 1 | 2) => {
          const r = await this.trade({ key: h, role: h.role, wave, action: back, market: leg.market, fireId: idea.fireId, thesisId: idea.thesisId, side: "sell", amountIn: h.bought });
          if (r.ok) Object.assign(h, { open: false, proceeds: r.out });
          else await this.log(h.owner, "swap_refused", { thesisId: tid, fireId: idea.fireId, tokenIn: back.tokenIn, tokenOut: back.tokenOut, reason: r.reason, exit: reason });
        };
        // Followers sell first, but a follower whose own key is backed up can't hold the caller's exit (L-1).
        const followers = Promise.all(leg.holdings.filter((h) => h.open && h.role === "follower").map((h) => sell(h, 1)));
        await this.waitAtMost(followers);
        for (const h of leg.holdings.filter((h) => h.open && h.role === "caller")) await sell(h, 2);
        await followers;
      }
      const left = idea.legs.flatMap((l) => l.holdings.filter((h) => h.open));
      if (left.length) {
        await this.log(idea.owner, "exit_incomplete", { thesisId: tid, reason, remaining: left.length, venue: "rhc" });
        return;
      }
      this.open.delete(tid);
      const pnl = idea.legs.reduce((s, l) => {
        const c = l.holdings.find((h) => h.role === "caller");
        const dec = decOf(l.market, l.action.tokenIn);
        return c ? s + units(c.proceeds, dec) - units(c.spent, dec) : s;
      }, 0);
      await this.log(idea.owner, "exit", { thesisId: tid, reason, pnl, venue: "rhc" });
      if (report) this.d.onExit?.({ thesisId: idea.thesisId, at, reason, pnl });
    } finally {
      idea.busy = false;
    }
  }

  // ------------------------------------------------------------ restart recovery

  /** Rebuilds open spot positions from filled buys without a matching filled sell. Repeat ideas stay `live` after firing (TU-01). */
  async restore(specFor: (thesisId: bigint) => Spec | undefined) {
    const live = await this.d.db.select({ id: theses.id, owner: theses.owner }).from(theses).where(inArray(theses.state, ["fired", "live", "retired"]));
    const restored: bigint[] = [];
    for (const t of live) {
      if (this.open.has(t.id.toString())) continue;
      const rows = (await this.d.db.select().from(orders).where(and(eq(orders.thesisId, t.id), eq(orders.venue, "rhc"), eq(orders.status, "filled"))).orderBy(asc(orders.createdAt)));
      const buys = rows.filter((r) => r.side === "buy");
      if (!buys.length) continue;
      const fireId = buys[buys.length - 1]!.fireId!;
      const spec = specFor(t.id);
      if (!spec) {
        await this.log(t.owner, "restore_skipped", { thesisId: t.id.toString(), reason: "spec_unavailable", venue: "rhc" });
        continue;
      }
      const idea: SpotIdea = { thesisId: t.id, owner: t.owner, fireId, spec, levels: { stopPx: 0, takePx: null }, legs: [], busy: false };
      for (const action of spec.entry.then.flatMap((a) => (a.venue === "rhc" ? [a] : []))) {
        const market = resolveMarket(this.d.markets, action.tokenIn, action.tokenOut)?.market;
        if (!market) continue;
        const leg: SpotLeg = { action, market, holdings: [] };
        for (const b of buys.filter((r) => r.fireId === fireId && r.coin === action.tokenOut)) {
          const sold = rows.some((r) => r.side === "sell" && r.fireId === fireId && r.account === b.account && r.coin === action.tokenOut);
          if (sold) continue;
          const key = await this.keyFor(b.account, "account"); // orders record the swap wallet
          if (!key) {
            await this.log(b.role === "caller" ? t.owner : b.account, "restore_no_key", { thesisId: t.id.toString(), venue: "rhc" });
            continue;
          }
          leg.holdings.push({ ...key, role: b.role as Role, bought: BigInt(b.filledSize), spent: BigInt(b.size), proceeds: 0n, open: true });
          if (b.role === "caller" && idea.legs.length === 0 && b.avgPx) idea.levels = exitLevels(spec.exit, Number(b.avgPx), "long");
        }
        if (leg.holdings.length) idea.legs.push(leg);
      }
      if (idea.legs.length && idea.levels.stopPx > 0) {
        this.open.set(t.id.toString(), idea);
        restored.push(t.id);
      }
    }
    return restored;
  }
}

/**
 * Creates (or replaces) the owner's sealed session key for its swap wallet (`account`, default the
 * owner itself); the policies get signed afterwards.
 */
export async function handleSwapKeyRequest(db: Db, manager: SessionKeyManager, owner: string, o: { chainId: number; days: number; account?: string; now?: Date }) {
  const address = owner.toLowerCase();
  const account = (o.account ?? owner).toLowerCase();
  const now = o.now ?? new Date();
  const expiresAt = new Date(now.getTime() + o.days * 86_400_000);
  const sealed = manager.create(account, { chainId: o.chainId, expiresAt: Math.floor(expiresAt.getTime() / 1000) });
  const row = { account, keyAddr: sealed.sessionKey, sealed, setup: null, signedPolicy: null, policySig: null, expiresAt, registeredAt: null, revokedAt: null, createdAt: now };
  await db.insert(swapKeys).values({ address, ...row }).onConflictDoUpdate({ target: swapKeys.address, set: row });
  return sealed.sessionKey;
}
