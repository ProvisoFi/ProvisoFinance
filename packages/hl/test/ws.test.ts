import { describe, expect, test } from "bun:test";
import { HlSocket, type WebSocketLike } from "../src/ws.ts";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("send while not open");
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test drivers
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverMessage(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function make(extra: object = {}) {
  FakeSocket.instances = [];
  const errors: unknown[] = [];
  const sock = new HlSocket({
    WebSocket: FakeSocket,
    backoffMinMs: 2,
    backoffMaxMs: 8,
    pingIntervalMs: 1_000_000,
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { sock, errors };
}

describe("HlSocket", () => {
  test("defaults to the testnet ws url", () => {
    const { sock } = make();
    expect(sock.url).toBe("wss://api.hyperliquid-testnet.xyz/ws");
  });

  test("queues subscriptions until open, then dispatches typed data by key", () => {
    const { sock } = make();
    const books: any[] = [];
    const trades: any[] = [];
    const ctxs: any[] = [];
    const mids: any[] = [];
    sock.subscribe({ type: "l2Book", coin: "BTC" }, (d) => books.push(d));
    sock.subscribe({ type: "trades", coin: "ETH" }, (d) => trades.push(d));
    sock.subscribe({ type: "activeAssetCtx", coin: "PURR/USDC" }, (d) => ctxs.push(d));
    sock.subscribe({ type: "allMids" }, (d) => mids.push(d));
    expect(FakeSocket.instances.length).toBe(1);
    const ws = last();
    ws.serverOpen();
    expect(ws.sent.map((m) => m.subscription.type)).toEqual(["l2Book", "trades", "activeAssetCtx", "allMids"]);

    ws.serverMessage({ channel: "subscriptionResponse", data: {} });
    ws.serverMessage({ channel: "l2Book", data: { coin: "BTC", time: 1, levels: [[], []] } });
    ws.serverMessage({ channel: "l2Book", data: { coin: "SOL", time: 1, levels: [[], []] } });
    ws.serverMessage({ channel: "trades", data: [{ coin: "ETH", px: "1" }] });
    ws.serverMessage({ channel: "trades", data: [] });
    ws.serverMessage({ channel: "activeSpotAssetCtx", data: { coin: "PURR/USDC", ctx: {} } });
    ws.serverMessage({ channel: "allMids", data: { mids: { BTC: "1" } } });
    ws.serverMessage({ channel: "pong" });
    expect(books).toEqual([{ coin: "BTC", time: 1, levels: [[], []] }]);
    expect(trades).toEqual([[{ coin: "ETH", px: "1" }]]);
    expect(ctxs.length).toBe(1);
    expect(mids).toEqual([{ mids: { BTC: "1" } }]);
    sock.close();
  });

  test("user channels route: user -> userEvents, userFills by user, orderUpdates", () => {
    const { sock } = make();
    const got: string[] = [];
    const user = "0xAbC0000000000000000000000000000000000001" as const;
    sock.subscribe({ type: "userEvents", user }, () => got.push("events"));
    sock.subscribe({ type: "userFills", user }, () => got.push("fills"));
    sock.subscribe({ type: "orderUpdates", user }, () => got.push("orders"));
    last().serverOpen();
    last().serverMessage({ channel: "user", data: { fills: [] } });
    last().serverMessage({ channel: "userFills", data: { user: user.toLowerCase(), fills: [] } });
    last().serverMessage({ channel: "orderUpdates", data: [] });
    expect(got).toEqual(["events", "fills", "orders"]);
    sock.close();
  });

  test("shared subscriptions: one wire subscribe, unsubscribe after the last handler", () => {
    const { sock } = make();
    sock.connect();
    last().serverOpen();
    const a: number[] = [];
    const offA = sock.subscribe({ type: "trades", coin: "BTC" }, () => a.push(1));
    const offB = sock.subscribe({ type: "trades", coin: "btc" }, () => a.push(2));
    expect(last().sent.filter((m) => m.method === "subscribe").length).toBe(1);
    last().serverMessage({ channel: "trades", data: [{ coin: "BTC" }] });
    expect(a).toEqual([1, 2]);
    offA();
    expect(last().sent.some((m) => m.method === "unsubscribe")).toBe(false);
    offB();
    expect(last().sent[last().sent.length - 1]).toEqual({ method: "unsubscribe", subscription: { type: "trades", coin: "BTC" } });
    last().serverMessage({ channel: "trades", data: [{ coin: "BTC" }] });
    expect(a).toEqual([1, 2]);
    sock.close();
  });

  test("handler errors and server errors reach onError without breaking dispatch", () => {
    const { sock, errors } = make();
    const ok: number[] = [];
    sock.subscribe({ type: "allMids" }, () => {
      throw new Error("boom");
    });
    sock.subscribe({ type: "allMids" }, () => ok.push(1));
    last().serverOpen();
    last().serverMessage({ channel: "allMids", data: { mids: {} } });
    last().serverMessage({ channel: "error", data: "Invalid subscription" });
    last().onmessage?.({ data: "not json" });
    expect(ok).toEqual([1]);
    expect(errors.length).toBe(3);
    sock.close();
  });

  test("sends ping on the keepalive interval", async () => {
    const { sock } = make({ pingIntervalMs: 5 });
    sock.connect();
    last().serverOpen();
    await sleep(30);
    expect(last().sent.some((m) => m.method === "ping")).toBe(true);
    sock.close();
  });

  test("reconnects with backoff and resubscribes after a server close", async () => {
    const states: string[] = [];
    const { sock } = make({ onStateChange: (s: string) => states.push(s) });
    const got: unknown[] = [];
    sock.subscribe({ type: "l2Book", coin: "BTC" }, (d) => got.push(d));
    sock.subscribe({ type: "allMids" }, () => {});
    last().serverOpen();
    last().serverClose();
    expect(FakeSocket.instances.length).toBe(1);
    await sleep(30);
    expect(FakeSocket.instances.length).toBe(2);
    last().serverOpen();
    expect(last().sent.map((m) => m.subscription)).toEqual([{ type: "l2Book", coin: "BTC" }, { type: "allMids" }]);
    last().serverMessage({ channel: "l2Book", data: { coin: "BTC" } });
    expect(got.length).toBe(1);
    expect(states).toEqual(["open", "reconnecting", "open"]);

    // Repeated failures keep retrying (backoff capped at backoffMaxMs).
    last().serverClose();
    await sleep(15);
    last().serverClose();
    await sleep(30);
    expect(FakeSocket.instances.length).toBe(4);
    sock.close();
  });

  test("a silent connection is dropped and replaced", async () => {
    const { sock } = make({ pingIntervalMs: 5, staleAfterMs: 15 });
    sock.connect();
    const first = last();
    first.serverOpen();
    await sleep(60);
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    sock.close();
  });

  test("close() stops reconnecting", async () => {
    const { sock } = make();
    sock.connect();
    last().serverOpen();
    sock.close();
    expect(last().closed).toBe(true);
    last().serverClose();
    await sleep(30);
    expect(FakeSocket.instances.length).toBe(1);
  });
});
