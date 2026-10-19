import type { Hex, LocalAccount } from "viem";
import { network as defaultNetwork, type Network } from "./config.ts";
import { HlError, postJson, type FetchLike } from "./info.ts";
import {
  cancelAction,
  cancelByCloidAction,
  orderToWire,
  orderWireToAction,
  scheduleCancelAction,
  signL1Action,
  splitSignature,
  updateLeverageAction,
  type ApproveAgentAction,
  type ApproveBuilderFeeAction,
  type Builder,
  type Grouping,
  type OrderRequest,
  type Signature,
} from "./signing.ts";

export type OrderStatus =
  | { resting: { oid: number; cloid?: Hex } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: Hex } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger";
export type CancelStatus = "success" | { error: string };

export type ExchangeResponse =
  | { status: "ok"; response: { type: "order"; data: { statuses: OrderStatus[] } } }
  | { status: "ok"; response: { type: "cancel" | "cancelByCloid"; data: { statuses: CancelStatus[] } } }
  | { status: "ok"; response: { type: "default" } }
  | { status: "err"; response: string };

// ponytail: per-process nonce memory; separate processes sharing one signer (e.g. several
// serverless instances) need an agent key each, or a shared counter.
const lastNonce = new Map<string, number>();

/** Millisecond timestamp, strictly increasing per signer within this process. */
export function nextNonce(signer: string, now = Date.now()): number {
  const key = signer.toLowerCase();
  const n = Math.max(now, (lastNonce.get(key) ?? 0) + 1);
  lastNonce.set(key, n);
  return n;
}

export interface ExchangeClientOptions {
  /** Signs L1 actions (orders, cancels, leverage). Usually an approved agent key. */
  account?: LocalAccount;
  network?: Network;
  fetch?: FetchLike;
  /** Trade on behalf of a vault or subaccount. */
  vaultAddress?: Hex;
  /** Reject L1 actions after this ms timestamp. Not used for user-signed actions. */
  expiresAfter?: number;
}

export class ExchangeClient {
  readonly network: Network;
  readonly account?: LocalAccount;
  vaultAddress?: Hex;
  expiresAfter?: number;
  private readonly fetchFn: FetchLike;

  constructor(opts: ExchangeClientOptions = {}) {
    this.network = opts.network ?? defaultNetwork();
    this.account = opts.account;
    this.vaultAddress = opts.vaultAddress;
    this.expiresAfter = opts.expiresAfter;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** POST a signed payload to /exchange; throws HlError on HTTP or `status: "err"`. */
  async post(payload: {
    action: unknown;
    nonce: number;
    signature: Signature;
    vaultAddress?: Hex;
    expiresAfter?: number;
  }): Promise<ExchangeResponse> {
    const res = await postJson<ExchangeResponse>(this.fetchFn, `${this.network.apiUrl}/exchange`, payload);
    if (!res || typeof res !== "object" || !("status" in res)) throw new HlError("Malformed exchange response", undefined, res);
    if (res.status === "err") throw new HlError(`Exchange error: ${res.response}`, undefined, res);
    return res;
  }

  private async l1(action: unknown): Promise<ExchangeResponse> {
    if (!this.account) throw new Error("ExchangeClient needs an account to sign L1 actions");
    const nonce = nextNonce(this.account.address);
    const signature = await signL1Action(this.account, action, nonce, this.network, this.vaultAddress, this.expiresAfter);
    return this.post({
      action,
      nonce,
      signature,
      ...(this.vaultAddress && { vaultAddress: this.vaultAddress }),
      ...(this.expiresAfter != null && { expiresAfter: this.expiresAfter }),
    });
  }

  private static statuses<T>(res: ExchangeResponse, type: string, expected: number): T[] {
    const r = res.response as { type?: string; data?: { statuses?: T[] } };
    const statuses = r.data?.statuses;
    if (r.type !== type || !Array.isArray(statuses) || statuses.length !== expected) {
      throw new HlError(`Unexpected ${type} response`, undefined, res);
    }
    return statuses;
  }

  /** One status per order, in order. Per-order rejections come back as `{ error }`, not thrown. */
  async placeOrders(orders: OrderRequest[], opts: { grouping?: Grouping; builder?: Builder } = {}): Promise<OrderStatus[]> {
    const action = orderWireToAction(orders.map(orderToWire), opts.builder, opts.grouping);
    return ExchangeClient.statuses<OrderStatus>(await this.l1(action), "order", orders.length);
  }

  async cancel(cancels: { asset: number; oid: number }[]): Promise<CancelStatus[]> {
    return ExchangeClient.statuses<CancelStatus>(await this.l1(cancelAction(cancels)), "cancel", cancels.length);
  }

  async cancelByCloid(cancels: { asset: number; cloid: Hex }[]): Promise<CancelStatus[]> {
    const res = await this.l1(cancelByCloidAction(cancels));
    return ExchangeClient.statuses<CancelStatus>(res, "cancel", cancels.length);
  }

  async updateLeverage(asset: number, leverage: number, isCross = true): Promise<void> {
    await this.l1(updateLeverageAction(asset, leverage, isCross));
  }

  /** Cancel all open orders at `time` (ms, ≥5s ahead); omit to clear. */
  async scheduleCancel(time?: number): Promise<void> {
    await this.l1(scheduleCancelAction(time));
  }

  /** Submit an approveAgent already signed by the main wallet (e.g. in the browser). */
  async approveAgent(action: ApproveAgentAction, signature: Signature | Hex): Promise<void> {
    const { agentName, ...rest } = action;
    await this.post({
      action: agentName === "" ? rest : action,
      nonce: action.nonce,
      signature: typeof signature === "string" ? splitSignature(signature) : signature,
    });
  }

  /** Submit an approveBuilderFee already signed by the main wallet. */
  async approveBuilderFee(action: ApproveBuilderFeeAction, signature: Signature | Hex): Promise<void> {
    await this.post({
      action,
      nonce: action.nonce,
      signature: typeof signature === "string" ? splitSignature(signature) : signature,
    });
  }
}
