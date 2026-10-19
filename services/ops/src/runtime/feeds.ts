// TESTNET ONLY: keeps ProvisoTestFeed contracts fresh so ProvisoSwapAdapter can price swaps on
// Robinhood Chain testnet (46630), which has no Chainlink feeds. Never runs on any other network.
//
// TEST_FEEDS       JSON [{feed, source: {type:"hl", coin} | {type:"pool", poolId, base, quote}}]
// TEST_FEEDS_MODE  "always" (default) or "on-demand": push only feeds with a feed_wanted row
//                  touched in the last 5 minutes (the RHC executor touches it before swaps).
// FEED_MIN_ETH     pause pushing while the relayer holds less than this (default 0.002 ETH).
import { feedWanted, type Db } from "@proviso/db";
import { InfoClient, NETWORKS, type Meta, type PerpAssetCtx } from "@proviso/hl";
import { gt, sql } from "drizzle-orm";
import { erc20Abi, formatEther, isAddress, isHex, parseAbi, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { send, type Clients } from "./chain";

// services/core/src/rhc/NETWORK.ts UNISWAP_V4.stateView on testnet 46630 (copied, not imported).
export const TESTNET_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address;
export const RHC_TESTNET_CHAIN_ID = 46630;
export const PUSH_AGE_S = 45n; // the adapter rejects answers older than 60 s
export const PUSH_DEVIATION_BPS = 50n; // 0.5%
const TICK_MS = 5_000;

export const testFeedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function push(int256 answer)",
  "error NotUpdater()",
  "error NonPositiveAnswer()",
]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

export type FeedSource = { type: "hl"; coin: string } | { type: "pool"; poolId: Hex; base: Address; quote: Address };
export type TestFeed = { feed: Address; source: FeedSource };
type InfoPort = Pick<InfoClient, "post">;

/** Throws on anything malformed, so a bad TEST_FEEDS fails ops at startup. */
export function parseTestFeeds(json: string): TestFeed[] {
  const v = JSON.parse(json) as TestFeed[];
  if (!Array.isArray(v)) throw new Error("TEST_FEEDS must be a JSON array");
  for (const f of v) {
    const s = f?.source;
    const ok =
      isAddress(f?.feed) &&
      ((s?.type === "hl" && typeof s.coin === "string" && s.coin !== "") ||
        (s?.type === "pool" && isHex(s.poolId) && s.poolId.length === 66 && isAddress(s.base) && isAddress(s.quote)));
    if (!ok) throw new Error(`TEST_FEEDS entry malformed: ${JSON.stringify(f)}`);
  }
  return v;
}

/** Pool spot price of `base` in `quote` (whole tokens), scaled to `dec` decimals. Fee not applied. */
export function poolAnswer(sqrtPriceX96: bigint, baseIsCurrency0: boolean, decB: number, decQ: number, dec: number): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96; // currency1 raw per currency0 raw, × 2^192
  const up = 10n ** BigInt(dec + decB);
  const down = 10n ** BigInt(decQ);
  return baseIsCurrency0 ? (p2 * up) / ((1n << 192n) * down) : ((1n << 192n) * up) / (p2 * down);
}

/** Push when the on-chain answer is older than 45 s or `next` deviates more than 0.5% from it. */
export function needsPush(onchain: { answer: bigint; updatedAt: bigint }, next: bigint, now: bigint): boolean {
  if (now - onchain.updatedAt > PUSH_AGE_S) return true;
  const diff = next > onchain.answer ? next - onchain.answer : onchain.answer - next;
  return diff * 10_000n > onchain.answer * PUSH_DEVIATION_BPS;
}

/**
 * Null (with a log line) unless TEST_FEEDS is set and CHAIN_NETWORK is exactly "testnet". `run`
 * also checks the RPC's chain id is 46630 and stops otherwise. `tick` returns the feeds pushed.
 */
export function feedPusher(
  db: Db,
  c: Clients,
  {
    env = process.env,
    log = console.log,
    info = new InfoClient({ network: NETWORKS.testnet }),
    stateView = TESTNET_STATE_VIEW,
  }: { env?: Record<string, string | undefined>; log?: (m: string, e?: unknown) => void; info?: InfoPort; stateView?: Address } = {},
) {
  if (!env.TEST_FEEDS) {
    log("ops: TEST_FEEDS unset, test feed pusher off");
    return null;
  }
  if (env.CHAIN_NETWORK !== "testnet") {
    log(`ops: test feeds are testnet only (CHAIN_NETWORK=${env.CHAIN_NETWORK ?? "unset"}), test feed pusher off`);
    return null;
  }
  const feeds = parseTestFeeds(env.TEST_FEEDS);
  const mode = env.TEST_FEEDS_MODE || "always";
  if (mode !== "always" && mode !== "on-demand") throw new Error(`TEST_FEEDS_MODE must be "always" or "on-demand", got ${mode}`);
  const minEth = parseEther(env.FEED_MIN_ETH || "0.002");
  const decimals = new Map<Address, Promise<number>>(); // feeds and tokens never change decimals
  let chainOk: Promise<void> | undefined;
  let refused = false;
  let low = false;

  const decimalsOf = (a: Address, read: () => Promise<number>) => {
    if (!decimals.has(a)) decimals.set(a, read().catch((e) => (decimals.delete(a), Promise.reject(e)))); // retry RPC errors
    return decimals.get(a)!;
  };
  const tokenDecimals = (t: Address) =>
    t === zeroAddress ? Promise.resolve(18) : decimalsOf(t, () => c.public.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }));
  const feedDecimals = (f: Address) => decimalsOf(f, () => c.public.readContract({ address: f, abi: testFeedAbi, functionName: "decimals" }));

  function guardChain() {
    chainOk ??= c.public.getChainId().then(
      (id) => {
        if (id === RHC_TESTNET_CHAIN_ID) return;
        refused = true;
        throw new Error(`test feed pusher refuses chain ${id}: Robinhood Chain testnet (46630) only`);
      },
      (e) => ((chainOk = undefined), Promise.reject(e)), // RPC down: ask again next tick
    );
    return chainOk;
  }

  async function wanted(): Promise<Set<string>> {
    const rows = await db.select({ feed: feedWanted.feed }).from(feedWanted).where(gt(feedWanted.wantedAt, sql`now() - interval '5 minutes'`));
    return new Set(rows.map((x) => x.feed.toLowerCase()));
  }

  /** HL testnet perp marks for these coins; "dex:COIN" reads that HIP-3 dex. */
  async function hlMarks(coins: string[]): Promise<Map<string, string>> {
    const marks = new Map<string, string>();
    for (const dex of new Set(coins.map((k) => (k.includes(":") ? k.split(":")[0]! : "")))) {
      const [meta, ctxs] = await info.post<[Meta, PerpAssetCtx[]]>({ type: "metaAndAssetCtxs", ...(dex && { dex }) });
      meta.universe.forEach((u, i) => ctxs[i] && marks.set(u.name, ctxs[i].markPx));
    }
    return marks;
  }

  async function price(s: FeedSource, dec: number, marks: Map<string, string>): Promise<bigint> {
    if (s.type === "hl") {
      const m = marks.get(s.coin);
      if (!m) throw new Error(`no Hyperliquid testnet mark for ${s.coin}`);
      return parseUnits(m, dec);
    }
    const [sqrtPriceX96] = await c.public.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [s.poolId] });
    if (sqrtPriceX96 === 0n) throw new Error(`pool ${s.poolId} is not initialized`);
    const [decB, decQ] = await Promise.all([tokenDecimals(s.base), tokenDecimals(s.quote)]);
    return poolAnswer(sqrtPriceX96, BigInt(s.base) < BigInt(s.quote), decB, decQ, dec);
  }

  async function tick(): Promise<Address[]> {
    await guardChain();
    let due = feeds;
    if (mode === "on-demand") {
      const w = await wanted();
      due = feeds.filter((f) => w.has(f.feed.toLowerCase()));
      if (!due.length) return [];
    }

    const balance = await c.public.getBalance({ address: c.account.address });
    if (balance < minEth) {
      if (!low) log(`ops: relayer has ${formatEther(balance)} ETH < FEED_MIN_ETH ${formatEther(minEth)}, test feed pushes paused`);
      low = true;
      return [];
    }
    if (low) log("ops: relayer topped up, test feed pushes resumed");
    low = false;

    const [block, marks] = await Promise.all([
      c.public.getBlock(),
      hlMarks(due.flatMap((f) => (f.source.type === "hl" ? [f.source.coin] : []))).catch((e) => {
        log("ops: Hyperliquid testnet marks unavailable", e); // pool feeds still push
        return new Map<string, string>();
      }),
    ]);
    const pushed: Address[] = [];
    for (const f of due) {
      try {
        const [next, round] = await Promise.all([
          feedDecimals(f.feed).then((d) => price(f.source, d, marks)),
          c.public.readContract({ address: f.feed, abi: testFeedAbi, functionName: "latestRoundData" }),
        ]);
        if (!needsPush({ answer: round[1], updatedAt: round[3] }, next, block.timestamp)) continue;
        await send(c, { address: f.feed, abi: testFeedAbi, functionName: "push", args: [next] });
        pushed.push(f.feed);
      } catch (e) {
        log(`ops: test feed ${f.feed} push failed`, e);
      }
    }
    return pushed;
  }

  /** Ticks every 5 s until `signal` aborts; stops for good on a non-testnet chain id. */
  async function run(signal: AbortSignal) {
    log(`ops: test feed pusher on (${feeds.length} feeds, ${mode})`);
    while (!signal.aborted) {
      try {
        await tick();
      } catch (e) {
        if (refused) return log(`ops: ${(e as Error).message}, test feed pusher stopped`);
        log("ops: test feed tick failed", e);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, TICK_MS);
        signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
  }

  return { tick, run };
}
