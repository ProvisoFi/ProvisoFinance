// Runs a live idea's Robinhood Chain swaps at its fire, with the owner's sealed session key.
// Every attempt is an orders row (venue rhc) plus an activity row; nothing here holds funds.
import { swapKeyPolicyFromJson } from "@proviso/chain";
import { activity, feedWanted, orders, swapKeys, type Db } from "@proviso/db";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { resolveMarket, sendSwap, type ExecutorDeps, type RhcMarket, type RhcSwapAction, type SwapPlan } from "./executor";
import { SessionKeyManager, type SealedSessionKey } from "./policy";

export type SwapRunnerDeps = {
  db: Db;
  /** 32-byte session-key seal key (derived in the enclave). */
  sealKey: Uint8Array;
  publicClient: PublicClient;
  walletFor(sessionPrivKey: Hex): WalletClient;
  swapKeyPolicy: Address;
  poolManager: Address;
  markets: readonly RhcMarket[];
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

export type SwapFire = { owner: string; thesisId: bigint; fireId: string; actions: readonly RhcSwapAction[] };

export class SwapRunner {
  private readonly manager: SessionKeyManager;
  private readonly exec: ExecutorDeps;
  constructor(private readonly d: SwapRunnerDeps) {
    this.manager = new SessionKeyManager(d.sealKey);
    this.exec = { publicClient: d.publicClient, swapKeyPolicy: d.swapKeyPolicy, poolManager: d.poolManager, markets: d.markets };
  }

  private log(address: string, kind: string, payload: Record<string, unknown>) {
    return this.d.db.insert(activity).values({ address, kind, payload });
  }


  async run(f: SwapFire) {
    const owner = f.owner.toLowerCase();
    const base = { thesisId: f.thesisId.toString(), fireId: f.fireId };
    const now = (this.d.now ?? (() => new Date()))();
    const [row] = await this.d.db
      .select()
      .from(swapKeys)
      .where(and(eq(swapKeys.address, owner), isNotNull(swapKeys.registeredAt), isNull(swapKeys.revokedAt), gt(swapKeys.expiresAt, now)));
    if (!row?.signedPolicy) return void (await this.log(owner, "needs_swap_setup", base));
    const policy = swapKeyPolicyFromJson(row.signedPolicy as Record<string, unknown>);
    const wallet = this.d.walletFor(this.manager.unseal(row.sealed as SealedSessionKey));

    for (const action of f.actions) {
      const pair = { tokenIn: action.tokenIn, tokenOut: action.tokenOut, usd: action.size.usd };
      const market = resolveMarket(this.d.markets, action.tokenIn, action.tokenOut)?.market;
      if (market) await wantFeed(this.d.db, market.oracle);
      const [order] = await this.d.db
        .insert(orders)
        .values({ fireId: f.fireId, thesisId: f.thesisId, account: owner, role: "caller", wave: 1, venue: "rhc", coin: action.tokenOut, side: "buy", size: "0" })
        .returning({ id: orders.id });
      const settle = (status: "filled" | "rejected" | "failed", set: Partial<typeof orders.$inferInsert>) =>
        this.d.db.update(orders).set({ status, updatedAt: new Date(), ...set }).where(eq(orders.id, order!.id));

      let sent = await this.send(action, policy, wallet);
      if (!sent.plan.ok && sent.plan.reason === "stale_oracle") {
        // The first swap after an idle period can beat the on-demand feed push by a few seconds.
        await (this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(this.d.retryMs ?? 8_000);
        sent = await this.send(action, policy, wallet);
      }
      if (!sent.plan.ok) {
        await settle("rejected", { error: `${sent.plan.reason}${sent.plan.detail ? `: ${sent.plan.detail}` : ""}` });
        await this.log(owner, "swap_refused", { ...base, ...pair, reason: sent.plan.reason });
        continue;
      }
      const size = sent.plan.amountIn.toString();
      try {
        const r = await this.d.publicClient.waitForTransactionReceipt({ hash: sent.hash! });
        if (r.status !== "success") throw new Error("reverted on-chain");
        await settle("filled", { size, filledSize: size, venueOrderId: sent.hash });
        await this.log(owner, "swap_done", { ...base, ...pair, tx: sent.hash });
      } catch (e) {
        await settle("failed", { size, venueOrderId: sent.hash ?? null, error: e instanceof Error ? e.message : String(e) });
        await this.log(owner, "swap_refused", { ...base, ...pair, reason: "failed", tx: sent.hash });
      }
    }
  }

  private async send(action: RhcSwapAction, policy: ReturnType<typeof swapKeyPolicyFromJson>, wallet: WalletClient): Promise<{ plan: SwapPlan; hash?: Hex }> {
    try {
      return await (this.d.send ?? sendSwap)(this.exec, { action, policy, wallet });
    } catch (e) {
      this.d.log?.("swaps: send failed", e);
      return { plan: { ok: false, reason: "simulation_reverted", detail: e instanceof Error ? e.message.slice(0, 200) : String(e) } };
    }
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
