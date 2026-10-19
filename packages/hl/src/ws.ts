import type { Hex } from "viem";
import { network as defaultNetwork, type Network } from "./config.ts";
import type { Fill, L2Book, PerpAssetCtx, Side, SpotAssetCtx } from "./info.ts";

// ---------------------------------------------------------------- message types

export interface WsTrade {
  coin: string;
  side: Side;
  px: string;
  sz: string;
  time: number;
  hash: Hex;
  tid: number;
  /** [buyer, seller] */
  users: [Hex, Hex];
}
export type WsActiveAssetCtx = { coin: string; ctx: PerpAssetCtx } | { coin: string; ctx: SpotAssetCtx };
export interface WsOrderUpdate {
  order: {
    coin: string;
    side: Side;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
    cloid?: Hex;
  };
  status: string;
  statusTimestamp: number;
}
export interface WsUserFills {
  isSnapshot?: boolean;
  user: Hex;
  fills: Fill[];
}
export type WsUserEvent =
  | { fills: Fill[] }
  | { funding: { time: number; coin: string; usdc: string; szi: string; fundingRate: string } }
  | { liquidation: { lid: number; liquidator: Hex; liquidated_user: Hex; liquidated_ntl_pos: string; liquidated_account_value: string } }
  | { nonUserCancel: { coin: string; oid: number }[] };

export type Subscription =
  | { type: "allMids" }
  | { type: "activeAssetCtx"; coin: string }
  | { type: "l2Book"; coin: string; nSigFigs?: number | null; mantissa?: number | null }
  | { type: "trades"; coin: string }
  | { type: "userEvents"; user: Hex }
  | { type: "orderUpdates"; user: Hex }
  | { type: "userFills"; user: Hex; aggregateByTime?: boolean };

export interface SubscriptionData {
  allMids: { mids: Record<string, string> };
  activeAssetCtx: WsActiveAssetCtx;
  l2Book: L2Book;
  trades: WsTrade[];
  userEvents: WsUserEvent;
  orderUpdates: WsOrderUpdate[];
  userFills: WsUserFills;
}

export type DataOf<S extends Subscription> = SubscriptionData[S["type"]];

// ---------------------------------------------------------------- socket

/** Minimal WebSocket surface, satisfied by the WHATWG WebSocket in Bun, Node 22+ and browsers. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // `any` events so the DOM/undici WebSocket types are assignable.
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface HlSocketOptions {
  network?: Network;
  url?: string;
  WebSocket?: WebSocketCtor;
  /** Ping cadence; the server drops idle connections after 60s. */
  pingIntervalMs?: number;
  /** Reconnect when nothing (not even a pong) arrives for this long. */
  staleAfterMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  onError?: (err: unknown) => void;
  onStateChange?: (state: "open" | "closed" | "reconnecting") => void;
}

const OPEN = 1;

/** Routing key, mirroring the SDK's subscription_to_identifier. */
export function subscriptionKey(s: Subscription): string {
  switch (s.type) {
    case "allMids":
    case "userEvents":
    case "orderUpdates":
      return s.type;
    case "userFills":
      return `userFills:${s.user.toLowerCase()}`;
    default:
      return `${s.type}:${s.coin.toLowerCase()}`;
  }
}

/** Routing key for an incoming message, or null for control/unknown channels. */
export function messageKey(msg: { channel: string; data?: any }): string | null {
  const d = msg.data;
  switch (msg.channel) {
    case "allMids":
    case "orderUpdates":
      return msg.channel;
    case "user":
      return "userEvents";
    case "l2Book":
      return `l2Book:${String(d?.coin).toLowerCase()}`;
    case "trades":
      return Array.isArray(d) && d.length > 0 ? `trades:${String(d[0].coin).toLowerCase()}` : null;
    case "userFills":
      return `userFills:${String(d?.user).toLowerCase()}`;
    case "activeAssetCtx":
    case "activeSpotAssetCtx":
      return `activeAssetCtx:${String(d?.coin).toLowerCase()}`;
    default:
      return null;
  }
}

interface Entry {
  sub: Subscription;
  handlers: Set<(data: any) => void>;
}

export class HlSocket {
  readonly url: string;
  private readonly Ctor: WebSocketCtor;
  private readonly opts: Required<Pick<HlSocketOptions, "pingIntervalMs" | "staleAfterMs" | "backoffMinMs" | "backoffMaxMs">> &
    HlSocketOptions;
  private ws: WebSocketLike | null = null;
  private readonly subs = new Map<string, Entry>();
  private attempts = 0;
  private lastMessageAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(opts: HlSocketOptions = {}) {
    this.url = opts.url ?? (opts.network ?? defaultNetwork()).wsUrl;
    const Ctor = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error("No WebSocket implementation available; pass opts.WebSocket");
    this.Ctor = Ctor;
    this.opts = { pingIntervalMs: 30_000, staleAfterMs: 75_000, backoffMinMs: 500, backoffMaxMs: 30_000, ...opts };
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.opts.onStateChange?.("closed");
  }

  /** Subscribe and connect if needed. Returns an unsubscribe function. */
  subscribe<S extends Subscription>(sub: S, handler: (data: DataOf<S>) => void): () => void {
    const key = subscriptionKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.subs.set(key, entry);
      this.send({ method: "subscribe", subscription: sub });
    }
    entry.handlers.add(handler);
    this.connect();
    return () => this.unsubscribe(sub, handler);
  }

  unsubscribe<S extends Subscription>(sub: S, handler?: (data: DataOf<S>) => void): void {
    const key = subscriptionKey(sub);
    const entry = this.subs.get(key);
    if (!entry) return;
    if (handler) entry.handlers.delete(handler);
    else entry.handlers.clear();
    if (entry.handlers.size === 0) {
      this.subs.delete(key);
      this.send({ method: "unsubscribe", subscription: entry.sub });
    }
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
    // Otherwise it goes out on (re)open via resubscribe.
  }

  private open() {
    const ws = new this.Ctor(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      for (const { sub } of this.subs.values()) ws.send(JSON.stringify({ method: "subscribe", subscription: sub }));
      this.startPing();
      this.opts.onStateChange?.("open");
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.dispatch(ev.data);
    };
    ws.onerror = (ev) => {
      if (this.ws === ws) this.opts.onError?.(ev);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private dispatch(raw: unknown) {
    let msg: { channel: string; data?: unknown };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch (err) {
      this.opts.onError?.(err);
      return;
    }
    if (msg.channel === "error") {
      this.opts.onError?.(new Error(String(msg.data)));
      return;
    }
    const key = messageKey(msg);
    const entry = key ? this.subs.get(key) : undefined;
    if (!entry) return;
    for (const h of [...entry.handlers]) {
      try {
        h(msg.data);
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastMessageAt > this.opts.staleAfterMs) {
        // Dead connection: drop it and let onclose-driven reconnect take over.
        this.ws = null;
        this.clearTimers();
        ws.close();
        this.scheduleReconnect();
        return;
      }
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ method: "ping" }));
    }, this.opts.pingIntervalMs);
  }

  private scheduleReconnect() {
    const { backoffMinMs, backoffMaxMs } = this.opts;
    const base = Math.min(backoffMaxMs, backoffMinMs * 2 ** this.attempts++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.opts.onStateChange?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.reconnectTimer = null;
  }
}
