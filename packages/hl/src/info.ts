import type { Hex } from "viem";
import { network as defaultNetwork, type Network } from "./config.ts";

// ---------------------------------------------------------------- transport

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Error from the Hyperliquid API: HTTP failures carry `status`, and `body` holds the parsed response. */
export class HlError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "HlError";
    this.status = status;
    this.body = body;
  }
}

/** POST `body` as JSON and parse the reply (plain-text replies stay strings); throws HlError on a non-2xx status. */
export async function postJson<T>(fetchFn: FetchLike, url: string, body: unknown): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Hyperliquid answers some failures with plain text.
  }
  if (!res.ok) throw new HlError(`HTTP ${res.status}: ${typeof parsed === "string" ? parsed : text}`, res.status, parsed);
  return parsed as T;
}

// ---------------------------------------------------------------- response types
// Shapes checked against api.hyperliquid-testnet.xyz (see test/live.test.ts).

export type Side = "A" | "B";

export interface MarginTier {
  lowerBound: string;
  maxLeverage: number;
}
export interface PerpUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: "strictIsolated" | "noCross" | string;
}
export interface Meta {
  universe: PerpUniverseEntry[];
  marginTables: [number, { description: string; marginTiers: MarginTier[] }][];
  collateralToken: number;
}
export interface PerpAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
  dayBaseVlm: string;
}

export interface SpotToken {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  index: number;
  tokenId: Hex;
  isCanonical: boolean;
  evmContract: { address: Hex; evm_extra_wei_decimals: number } | null;
  fullName: string | null;
  deployerTradingFeeShare: string;
  deployerLabel?: string;
}
export interface SpotPair {
  name: string;
  /** [base token index, quote token index] */
  tokens: [number, number];
  index: number;
  isCanonical: boolean;
}
export interface SpotMeta {
  universe: SpotPair[];
  tokens: SpotToken[];
}
export interface SpotAssetCtx {
  coin: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  circulatingSupply: string;
  totalSupply: string;
  dayBaseVlm: string;
}

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}
export interface L2Book {
  coin: string;
  time: number;
  /** [bids, asks] */
  levels: [L2Level[], L2Level[]];
}

export interface MarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}
export interface Position {
  coin: string;
  szi: string;
  leverage: { type: "cross"; value: number } | { type: "isolated"; value: number; rawUsd: string };
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
  maxLeverage: number;
  cumFunding: { allTime: string; sinceOpen: string; sinceChange: string };
}
export interface ClearinghouseState {
  marginSummary: MarginSummary;
  crossMarginSummary: MarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: { type: "oneWay"; position: Position }[];
  time: number;
}
export interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}
export interface SpotClearinghouseState {
  balances: SpotBalance[];
}

export interface OpenOrder {
  coin: string;
  side: Side;
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: Hex;
  reduceOnly?: boolean;
}
export interface FrontendOrder extends Omit<OpenOrder, "cloid"> {
  triggerCondition: string;
  isTrigger: boolean;
  triggerPx: string;
  children: FrontendOrder[];
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
  tif: string | null;
  cloid: Hex | null;
}
export type OrderStatusValue =
  | "open"
  | "filled"
  | "canceled"
  | "triggered"
  | "rejected"
  | "marginCanceled"
  | (string & {});
export type OrderStatusResponse =
  | { status: "order"; order: { order: FrontendOrder; status: OrderStatusValue; statusTimestamp: number } }
  | { status: "unknownOid" };

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: Side;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: Hex;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
  twapId: number | null;
  cloid?: Hex;
  builderFee?: string;
  liquidation?: { liquidatedUser?: Hex; markPx: string; method: string };
}

export type CandleInterval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";
export interface Candle {
  /** open time (ms) */
  t: number;
  /** close time (ms) */
  T: number;
  s: string;
  i: CandleInterval;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

export interface FundingHistoryEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface ExtraAgent {
  name: string;
  address: Hex;
  validUntil: number;
}

// ---------------------------------------------------------------- client

export interface InfoClientOptions {
  network?: Network;
  fetch?: FetchLike;
}

/** Read-only client for Hyperliquid's /info endpoint; each method is one POST with the named request `type`. */
export class InfoClient {
  readonly network: Network;
  private readonly fetchFn: FetchLike;

  constructor(opts: InfoClientOptions = {}) {
    this.network = opts.network ?? defaultNetwork();
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** POST a raw /info request; throws HlError on HTTP failure. */
  post<T>(body: Record<string, unknown>): Promise<T> {
    return postJson<T>(this.fetchFn, `${this.network.apiUrl}/info`, body);
  }

  /** Perp universe: coins, size decimals and max leverage, indexed by asset id. */
  meta() {
    return this.post<Meta>({ type: "meta" });
  }
  /** Perp universe plus per-asset context (mark, funding, open interest), in the same order. */
  metaAndAssetCtxs() {
    return this.post<[Meta, PerpAssetCtx[]]>({ type: "metaAndAssetCtxs" });
  }
  /** Spot tokens and pairs. */
  spotMeta() {
    return this.post<SpotMeta>({ type: "spotMeta" });
  }
  /** Spot tokens and pairs plus per-pair context. */
  spotMetaAndAssetCtxs() {
    return this.post<[SpotMeta, SpotAssetCtx[]]>({ type: "spotMetaAndAssetCtxs" });
  }
  /** coin → mid. Spot pairs appear as "PURR/USDC" or "@N". */
  allMids() {
    return this.post<Record<string, string>>({ type: "allMids" });
  }
  /** Order book snapshot for `coin`, optionally aggregated to `nSigFigs` significant figures. */
  l2Book(coin: string, opts: { nSigFigs?: 2 | 3 | 4 | 5 | null; mantissa?: 2 | 5 | null } = {}) {
    return this.post<L2Book>({ type: "l2Book", coin, ...opts });
  }
  /** Perp account state for `user`: margin summary and open positions. */
  clearinghouseState(user: Hex) {
    return this.post<ClearinghouseState>({ type: "clearinghouseState", user });
  }
  /** Spot balances for `user`. */
  spotClearinghouseState(user: Hex) {
    return this.post<SpotClearinghouseState>({ type: "spotClearinghouseState", user });
  }
  /** Resting orders for `user`. */
  openOrders(user: Hex) {
    return this.post<OpenOrder[]>({ type: "openOrders", user });
  }
  /** `oid` is a numeric order id or a 0x cloid. */
  orderStatus(user: Hex, oid: number | Hex) {
    return this.post<OrderStatusResponse>({ type: "orderStatus", user, oid });
  }
  /** Most recent fills (up to 2000). */
  userFills(user: Hex, aggregateByTime?: boolean) {
    return this.post<Fill[]>({ type: "userFills", user, ...(aggregateByTime != null && { aggregateByTime }) });
  }
  /** Fills for `user` from `startTime` (ms) to `endTime` (ms, default now). */
  userFillsByTime(user: Hex, startTime: number, endTime?: number, aggregateByTime?: boolean) {
    return this.post<Fill[]>({
      type: "userFillsByTime",
      user,
      startTime,
      ...(endTime != null && { endTime }),
      ...(aggregateByTime != null && { aggregateByTime }),
    });
  }
  /**
   * One request. The API returns the latest candles in range and only retains roughly the
   * most recent 5000 per interval; older ranges come back empty.
   */
  candleSnapshot(coin: string, interval: CandleInterval, startTime: number, endTime: number) {
    return this.post<Candle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
  }
  /**
   * Candles over [startTime, endTime], paging past the per-request cap. The API fills
   * from the end of the range, so this walks backwards until it reaches startTime or
   * the history runs out (an empty page). Result is ascending by `t`, de-duplicated.
   */
  async candles(coin: string, interval: CandleInterval, startTime: number, endTime: number, maxPages = 50) {
    const byT = new Map<number, Candle>();
    let end = endTime;
    for (let page = 0; page < maxPages && end >= startTime; page++) {
      const batch = await this.candleSnapshot(coin, interval, startTime, end);
      if (batch.length === 0) break;
      let first = Infinity;
      for (const c of batch) {
        byT.set(c.t, c);
        first = Math.min(first, c.t);
      }
      if (first <= startTime || first - 1 >= end) break;
      end = first - 1;
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }
  /** Funding rate history for `coin` from `startTime` (ms) to `endTime` (ms, default now). */
  fundingHistory(coin: string, startTime: number, endTime?: number) {
    return this.post<FundingHistoryEntry[]>({ type: "fundingHistory", coin, startTime, ...(endTime != null && { endTime }) });
  }
  /** Approved max builder fee, in tenths of a basis point. */
  maxBuilderFee(user: Hex, builder: Hex) {
    return this.post<number>({ type: "maxBuilderFee", user, builder });
  }
  /** Approved agent (API) wallets. */
  extraAgents(user: Hex) {
    return this.post<ExtraAgent[]>({ type: "extraAgents", user });
  }
}
