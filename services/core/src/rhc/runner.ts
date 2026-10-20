// Robinhood Chain swaps (R4) for live ideas: at the fire, Fair Copy waves (allow-listed followers
// first, then the caller) buy with each account's sealed session key; the bought tokens are held
// as the idea's spot position and sold back on stop / take / a stop request, after which the exit
// is reported (reveal + EXIT stamp). Every attempt is an orders row (venue rhc) plus activity.
// Orders: size = tokenIn base units, filled_size = tokenOut base units received, avg_px = USD per
// non-USDG token.
import { swapKeyPolicyFromJson, type SwapKeyPolicy } from "@proviso/chain";
import { activity, feedWanted, follows, orders, swapKeys, theses, users, type Db } from "@proviso/db";
import type { Spec } from "@proviso/dsl";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { erc20Abi, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { exitHit, exitLevels, type AllowEntry, type ExitLevels, type SizeRule } from "../faircopy/planner";
import { resolveMarket, sendSwap, type ExecutorDeps, type RhcMarket, type RhcSwapAction, type SwapPlan } from "./executor";
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
};

/** Asks ops for a fresh test-feed price (on-demand mode); harmless for real feeds. */
export const wantFeed = (db: Db, oracle: Address) =>
  db.insert(feedWanted).values({ feed: oracle.toLowerCase() }).onConflictDoUpdate({ target: feedWanted.feed, set: { wantedAt: new Date() } });

export type SwapFire = { owner: string; thesisId: bigint; fireId: string; actions: readonly RhcSwapAction[]; spec: Spec };

type Role = "caller" | "follower";
type Key = { account: Address; wallet: WalletClient; policy: SwapKeyPolicy };
type Holding = Key & { role: Role; bought: bigint; spent: bigint; proceeds: bigint; open: boolean };
type SpotLeg = { action: RhcSwapAction; market: RhcMarket; holdings: Holding[] };
type SpotIdea = { thesisId: bigint; owner: string; fireId: string; spec: Spec; levels: ExitLevels; legs: SpotLeg[]; busy: boolean };

const MIN_COPY_USD = 1;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tokenOf = (m: RhcMarket, sym: string) => (m.symbols[0] === sym ? m.key.currency0 : m.key.currency1);
const decOf = (m: RhcMarket, sym: string) => (m.symbols[0] === sym ? m.decimals[0] : m.decimals[1]);
const units = (x: bigint, dec: number) => Number(x) / 10 ** dec;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export class SwapRunner {
  private readonly manager: SessionKeyManager;
  private readonly exec: ExecutorDeps;
  private readonly open = new Map<string, SpotIdea>();
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly d: SwapRunnerDeps) {
    this.manager = new SessionKeyManager(d.sealKey);
    this.exec = { publicClient: d.publicClient, swapKeyPolicy: d.swapKeyPolicy, poolManager: d.poolManager, markets: d.markets };
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

  /** The account's usable session key, or null (not set up, revoked or expired). */
  private async keyFor(address: string): Promise<Key | null> {
    const [row] = await this.d.db
      .select()
      .from(swapKeys)
      .where(and(eq(swapKeys.address, address.toLowerCase()), isNotNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt), gt(swapKeys.expiresAt, this.now())));
    if (!row?.signedPolicy) return null;
    const policy = swapKeyPolicyFromJson(row.signedPolicy as Record<string, unknown>);
    return { account: policy.account, policy, wallet: this.d.walletFor(this.manager.unseal(row.sealed as SealedSessionKey)) };
  }

  // ------------------------------------------------------------ fire

  async run(f: SwapFire) {
    const owner = f.owner.toLowerCase();
    const tid = f.thesisId;
    const base = { thesisId: tid.toString(), fireId: f.fireId };
    if (this.open.has(tid.toString())) return void (await this.log(owner, "fire_refused", { ...base, reason: "already_open" }));
    const caller = await this.keyFor(owner);
    if (!caller) return void (await this.log(owner, "needs_swap_setup", base));
    const copiers = await this.followers(owner, tid, base);

    const idea: SpotIdea = { thesisId: tid, owner, fireId: f.fireId, spec: f.spec, levels: { stopPx: 0, takePx: null }, legs: [], busy: true };
    for (const action of f.actions) {
      const pair = { tokenIn: action.tokenIn, tokenOut: action.tokenOut, usd: action.size.usd };
      const market = resolveMarket(this.d.markets, action.tokenIn, action.tokenOut)?.market;
      if (!market) {
        await this.log(owner, "swap_refused", { ...base, ...pair, reason: "unknown_market" });
        continue;
      }
      await wantFeed(this.d.db, market.oracle);
      const leg: SpotLeg = { action, market, holdings: [] };
      const buy = async (k: Key, role: Role, wave: 1 | 2, usd: number) => {
        const a = usd === action.size.usd ? action : { ...action, size: { usd } };
        const r = await this.trade({ key: k, role, wave, action: a, market, fireId: f.fireId, thesisId: tid, side: "buy" });
        if (r.ok) leg.holdings.push({ ...k, role, bought: r.out, spent: r.in, proceeds: 0n, open: true });
        await this.log(k.account.toLowerCase(), r.ok ? "swap_done" : "swap_refused", { ...base, ...pair, usd, ...(r.ok ? { tx: r.hash } : { reason: r.reason }), ...(role === "follower" && { copying: owner }) });
      };
      // Wave 1: every follower on its own session key, all settled before the caller's swap.
      await Promise.all(copiers.flatMap((c) => (c.usd(action) ? [buy(c.key, "follower", 1, c.usd(action)!)] : [])));
      await buy(caller, "caller", 2, action.size.usd);
      if (leg.holdings.length) idea.legs.push(leg);
    }
    const first = idea.legs[0]?.holdings.find((h) => h.role === "caller");
    if (first) {
      const l = idea.legs[0]!;
      const px = units(first.spent, decOf(l.market, l.action.tokenIn)) / units(first.bought, decOf(l.market, l.action.tokenOut));
      idea.levels = exitLevels(f.spec.exit, px, "long");
      await this.log(owner, "swap_entered", { ...base, refPx: px, ...idea.levels });
    }
    idea.busy = false;
    if (idea.legs.length) this.open.set(tid.toString(), idea);
  }

  /** Allow-listed followers with a usable session key, each with its per-action size. */
  private async followers(owner: string, tid: bigint, base: Record<string, string>) {
    const rows = await this.d.db
      .select()
      .from(follows)
      .where(and(eq(follows.caller, owner), eq(follows.active, true), or(isNull(follows.thesisId), eq(follows.thesisId, tid))));
    if (!rows.length) return [];
    const limits = new Map((await this.d.db.select().from(users).where(inArray(users.address, rows.map((r) => r.follower)))).map((u) => [u.address, u.limits as Record<string, unknown>]));
    const out: { key: Key; usd: (a: RhcSwapAction) => number | undefined }[] = [];
    for (const r of rows) {
      const allow = Array.isArray(r.sealedAllowlist) ? (r.sealedAllowlist as AllowEntry[]) : [];
      if (!allow.length) {
        // ponytail: sealed spot ideas only auto-copy through an allow-list; no one-tap swap confirms yet.
        await this.log(r.follower, "copy_skipped", { ...base, reason: "swap_needs_allowlist", caller: owner });
        continue;
      }
      const key = await this.keyFor(r.follower);
      if (!key) {
        await this.log(r.follower, "needs_swap_setup", { ...base, copying: owner });
        continue;
      }
      const rule = r.sizeRule as SizeRule;
      const fl = r.limits as Record<string, unknown>;
      const ul = limits.get(r.follower) ?? {};
      out.push({
        key,
        usd: (a) => {
          const entry = allow.find((e) => e.coin === a.tokenOut && e.side !== "short");
          if (!entry) return undefined;
          const want = rule.kind === "fixed" ? rule.usd : rule.ratio * a.size.usd;
          const caps = [want, entry.maxUsd, num(fl?.maxUsd), num(ul.maxUsd), num(ul.maxAllocation)].filter((x): x is number => x !== undefined);
          const usd = Math.floor(Math.min(...caps) * 100) / 100;
          return usd >= MIN_COPY_USD ? usd : undefined;
        },
      });
    }
    return out;
  }

  // ------------------------------------------------------------ one swap

  /** Sends one swap (one retry on a stale oracle), records it, returns what moved or why not. */
  private async trade(t: {
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

    const job = { action: t.action, policy: t.key.policy, wallet: t.key.wallet, amountIn: t.amountIn };
    let sent = await this.send(job);
    if (!sent.plan.ok && sent.plan.reason === "stale_oracle") {
      // The first swap after an idle period can beat the on-demand feed push by a few seconds.
      await (this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(this.d.retryMs ?? 8_000);
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
      await settle("failed", { size: amountIn.toString(), venueOrderId: sent.hash ?? null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return { ok: false, reason: "failed" };
    }
  }

  private async send(job: Parameters<typeof sendSwap>[1]): Promise<{ plan: SwapPlan; hash?: Hex }> {
    try {
      return await (this.d.send ?? sendSwap)(this.exec, job);
    } catch (e) {
      this.d.log?.("swaps: send failed", e);
      return { plan: { ok: false, reason: "simulation_reverted", detail: e instanceof Error ? e.message.slice(0, 200) : String(e) } };
    }
  }

  // ------------------------------------------------------------ exits

  /** RHC price updates (USD per token): a runner-owned idea exits when its stop or take is hit. */
  onPrice(coin: string, usd: number, at = this.now()) {
    if (!(usd > 0)) return;
    for (const idea of this.open.values()) {
      const l = idea.legs[0];
      if (idea.busy || !l || l.action.tokenOut !== coin || this.d.hlOwns?.(idea.thesisId)) continue;
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

  /** A stop request for an idea only this runner holds. Returns whether it held one. */
  async stop(thesisId: bigint): Promise<boolean> {
    await this.idle();
    const idea = this.open.get(thesisId.toString());
    if (!idea) return false;
    await this.exit(idea, "stopped", this.now(), true);
    return true;
  }

  /** Sells every open holding back to its input token, followers first, then the caller. */
  private async exit(idea: SpotIdea, reason: SwapExit["reason"], at: Date, report: boolean) {
    if (idea.busy) return;
    idea.busy = true;
    try {
      const tid = idea.thesisId.toString();
      for (const leg of idea.legs) {
        const a = leg.action;
        const back: RhcSwapAction = { ...a, tokenIn: a.tokenOut, tokenOut: a.tokenIn };
        const sell = async (h: Holding, wave: 1 | 2) => {
          const r = await this.trade({ key: h, role: h.role, wave, action: back, market: leg.market, fireId: idea.fireId, thesisId: idea.thesisId, side: "sell", amountIn: h.bought });
          if (r.ok) Object.assign(h, { open: false, proceeds: r.out });
          else await this.log(h.account.toLowerCase(), "swap_refused", { thesisId: tid, fireId: idea.fireId, tokenIn: back.tokenIn, tokenOut: back.tokenOut, reason: r.reason, exit: reason });
        };
        await Promise.all(leg.holdings.filter((h) => h.open && h.role === "follower").map((h) => sell(h, 1)));
        for (const h of leg.holdings.filter((h) => h.open && h.role === "caller")) await sell(h, 2);
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

  /** Rebuilds open spot positions from filled buys without a matching filled sell. */
  async restore(specFor: (thesisId: bigint) => Spec | undefined) {
    const live = await this.d.db.select({ id: theses.id, owner: theses.owner }).from(theses).where(inArray(theses.state, ["fired", "retired"]));
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
          const key = await this.keyFor(b.account);
          if (!key) {
            await this.log(b.account, "restore_no_key", { thesisId: t.id.toString(), venue: "rhc" });
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

/** Creates (or replaces) the owner's sealed session key; the policies get signed afterwards. */
export async function handleSwapKeyRequest(db: Db, manager: SessionKeyManager, owner: string, o: { chainId: number; days: number; now?: Date }) {
  const address = owner.toLowerCase();
  const now = o.now ?? new Date();
  const expiresAt = new Date(now.getTime() + o.days * 86_400_000);
  const sealed = manager.create(address, { chainId: o.chainId, expiresAt: Math.floor(expiresAt.getTime() / 1000) });
  const row = { keyAddr: sealed.sessionKey, sealed, setup: null, signedPolicy: null, policySig: null, expiresAt, registeredAt: null, revokedAt: null, createdAt: now };
  await db.insert(swapKeys).values({ address, ...row }).onConflictDoUpdate({ target: swapKeys.address, set: row });
  return sealed.sessionKey;
}
