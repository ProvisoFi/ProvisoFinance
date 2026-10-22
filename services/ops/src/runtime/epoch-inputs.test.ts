// What an epoch's caller shares are built from, below runEpoch: the link heuristics that exclude a
// follower from a caller's shares (core/faircopy/links.ts, run by ops before every epoch) and the
// Hyperliquid info transport the fills and ledger come through (a failed read must throw, never
// come back as data, so a bad venue answer posts nothing).
import { describe, expect, test } from "bun:test";
import { HlError, InfoClient, NETWORKS, postJson, type FetchLike } from "@proviso/hl";
import { EXCLUDE_SCORE, followerWeights, holdWeight, linkFlags, MIN_HOLD_MS } from "../../../core/src/faircopy/links.ts";

const CALLER = "0x00000000000000000000000000000000000000Ca";
const FOLLOWER = "0x00000000000000000000000000000000000000F1";
const a = CALLER.toLowerCase();
const b = FOLLOWER.toLowerCase();
const pairs = [{ caller: CALLER, follower: FOLLOWER }];
const DAY = 86_400_000;

describe("link heuristics", () => {
  test("a transfer either way between caller and follower is a direct link (score 1), case-insensitively", () => {
    for (const [from, to] of [[CALLER, FOLLOWER], [b, a]]) {
      expect(linkFlags([{ from: from!, to: to!, usd: 10, time: 0 }], [], pairs)).toEqual([{ a, b, reason: "direct_transfer", score: 1 }]);
    }
  });

  test("a shared funder links the pair unless it is an ignored bridge / exchange wallet; the pair itself isn't a shared funder", () => {
    const BRIDGE = "0x00000000000000000000000000000000000000B0";
    const funded = (from: string) => [{ from, to: CALLER, usd: 1, time: 0 }, { from, to: FOLLOWER, usd: 1, time: 0 }];
    expect(linkFlags(funded("0x00000000000000000000000000000000000000F0"), [], pairs)).toEqual([{ a, b, reason: "shared_funder", score: 0.6 }]);
    expect(linkFlags(funded(BRIDGE), [], pairs, { ignoreFunders: [BRIDGE.toLowerCase()] })).toEqual([]);
    expect(linkFlags(funded(BRIDGE.toLowerCase()), [], pairs, { ignoreFunders: [BRIDGE] })).toEqual([]);
  });

  test("timing: follower trades of its own, same coin and side, inside the window before the caller's; Proviso copies don't count", () => {
    const callerFill = (time: number) => ({ account: CALLER, coin: "BTC", isBuy: true, time });
    const own = (time: number, o: object = {}) => ({ account: FOLLOWER, coin: "BTC", isBuy: true, time, ...o });
    const at = 1_000_000;
    expect(linkFlags([], [own(at - 30_000), callerFill(at)], pairs)).toEqual([{ a, b, reason: "timing", score: 0.25 }]);
    // Not a hit: a Proviso wave-1 copy, after the caller, outside 60 s, another coin, the other side.
    const misses = [own(at - 1, { viaProviso: true }), own(at + 1), own(at - 61_000), own(at - 1, { coin: "ETH" }), own(at - 1, { isBuy: false })];
    expect(linkFlags([], [...misses, callerFill(at)], pairs)).toEqual([]);
    expect(linkFlags([], [own(at - 90_000), callerFill(at)], pairs, { windowSec: 120 })).toHaveLength(1);
    // The score counts the caller's front-run fills and caps at 1.
    const many = [own(at - 1), ...[0, 1, 2, 3, 4, 5].map((i) => callerFill(at + i))];
    expect(linkFlags([], many, pairs)[0]!.score).toBe(1);
  });

  test("a follower flagged at or above EXCLUDE_SCORE gets no weight with that caller; holds under 30 minutes weigh nothing", () => {
    expect(EXCLUDE_SCORE).toBe(0.5);
    expect(holdWeight(1000, 0, MIN_HOLD_MS - 1)).toBe(0);
    expect(holdWeight(1000, 0, DAY)).toBe(1000);
    const OTHER = "0x00000000000000000000000000000000000000f2";
    const holds = [
      { follower: FOLLOWER, notionalUsd: 1000, openedAt: 0, closedAt: DAY },
      { follower: OTHER, notionalUsd: 500, openedAt: 0, closedAt: DAY / 2 },
      { follower: OTHER.toUpperCase().replace("0X", "0x"), notionalUsd: 500, openedAt: 0, closedAt: DAY / 2 },
    ];
    expect(followerWeights(CALLER, holds, [{ a, b, reason: "shared_funder", score: 0.6 }])).toEqual(new Map([[OTHER, 500]])); // both holds, summed case-insensitively
    expect(followerWeights(CALLER, holds, [{ a: b, b: a, reason: "timing", score: 0.25 }])).toEqual(new Map([[b, 1000], [OTHER, 500]])); // weak: kept
    expect(followerWeights(CALLER, holds, [{ a: "0xsomeone", b, reason: "direct_transfer", score: 1 }]).get(b)).toBe(1000); // another caller's flag
  });
});

describe("Hyperliquid info transport", () => {
  const fetchOf = (status: number, text: string, seen: unknown[] = []): FetchLike =>
    async (url, init) => (seen.push({ url, init }), { ok: status < 400, status, text: async () => text });

  test("posts the request as JSON to the network's /info and parses the answer", async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const info = new InfoClient({ network: NETWORKS.testnet, fetch: fetchOf(200, '[{"coin":"BTC"}]', seen) });
    expect(await info.post({ type: "userFillsByTime", user: "0xab", startTime: 0 })).toEqual([{ coin: "BTC" }]);
    expect(seen[0]!.url).toBe(`${NETWORKS.testnet.apiUrl}/info`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0]!.init.body)).toEqual({ type: "userFillsByTime", user: "0xab", startTime: 0 });
  });

  test("a non-2xx answer throws HlError with the status and body (plain text or JSON), never returns it as data", async () => {
    const plain = await postJson(fetchOf(429, "rate limited"), "https://x/info", {}).catch((e) => e);
    expect(plain).toBeInstanceOf(HlError);
    expect(plain).toMatchObject({ name: "HlError", status: 429, body: "rate limited", message: "HTTP 429: rate limited" });
    const json = await postJson(fetchOf(500, '{"error":"boom"}'), "https://x/info", {}).catch((e) => e);
    expect(json).toMatchObject({ status: 500, body: { error: "boom" }, message: 'HTTP 500: {"error":"boom"}' });
    expect(await postJson(fetchOf(200, "ok"), "https://x/info", {})).toBe("ok"); // a 2xx plain-text answer stays a string
  });
});
