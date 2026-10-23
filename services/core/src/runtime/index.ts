// Wires the evaluator to the database, Hyperliquid, Fear & Greed, the queues and the executor.
import type { Db } from "@proviso/db";
import { ExchangeClient, HlSocket, InfoClient, listedDexes, network, perpUniverse, type Network } from "@proviso/hl";
import { privateKeyToAccount } from "viem/accounts";
import { config, type EvalConfig } from "../evaluator/conditions.ts";
import { Evaluator } from "../evaluator/engine.ts";
import type { MachineEvent } from "../evaluator/machine.ts";
import { EventSink } from "./events.ts";
import { IdeaRegistry } from "./ideas.ts";
import { HlMarket, pollFearGreed } from "./market.ts";
import { PostsFeed } from "./posts.ts";
import { TestJob } from "./tests.ts";
import { handleAgentRequest } from "../executor/agents.ts";
import { Executor } from "../executor/executor.ts";
import { AgentKeyManager } from "../signer/agentKey.ts";
import { chainConfig, checkRhcNetwork, deployment, rhcRpcUrl, swapConfig } from "@proviso/chain";
import { createPublicClient, createWalletClient, http, nonceManager, type PublicClient } from "viem";
import { UNISWAP_V4 } from "../rhc/NETWORK.ts";
import { SessionKeyManager } from "../rhc/policy.ts";
import { handleSwapKeyRequest, SwapRunner, wantFeed } from "../rhc/runner.ts";
import { pollRhc } from "./rhc-market.ts";
import { VenueHealth } from "./venue.ts";
import { FILL_MODEL, PaperEngine } from "../paper/engine.ts";
import { activity } from "@proviso/db";
import { NoopExecutor, pgmq, type ExecutorPort, type Log } from "./ports.ts";

/**
 * Testnet volumes are tiny, so the HL volume floor drops to TESTNET_MIN_HL_VOLUME_USD (default
 * $1000) there. Mainnet keeps the spec floors ($250k HL volume, $100k pool depth).
 */
export function evalConfigFor(net: Network, env: Record<string, string | undefined> = process.env): EvalConfig {
  if (net.name !== "testnet") return config();
  const floor = Number(env.TESTNET_MIN_HL_VOLUME_USD ?? 1000);
  if (!(floor >= 0)) throw new Error("TESTNET_MIN_HL_VOLUME_USD must be a number >= 0");
  const pool = Number(env.TESTNET_MIN_POOL_DEPTH_USD ?? 25); // the testnet pools are tiny too (±2% depth)
  if (!(pool >= 0)) throw new Error("TESTNET_MIN_POOL_DEPTH_USD must be a number >= 0");
  return config({ minHlVolumeUsd: floor, minPoolDepthUsd: pool, closedGapDepthUsd: pool });
}

export type RuntimeDeps = {
  db: Db;
  specKey: Uint8Array;
  executor?: ExecutorPort;
  /** 32-byte key sealing per-user agent keys (enclave-derived). Enables the executor (HL_NETWORK). */
  agentSealKey?: Uint8Array;
  /** 32-byte key sealing per-user Robinhood Chain session keys. Enables swaps (CHAIN_NETWORK). */
  swapSealKey?: Uint8Array;
  net?: Network;
  log?: Log;
};

/** Refuses to start when HL_NETWORK and CHAIN_NETWORK disagree or the RPC is on another chain. */
export const checkNetworks = (net: Network = network()) =>
  checkRhcNetwork(createPublicClient({ chain: chainConfig().chain, transport: http(rhcRpcUrl()) }), net.name);

const RESTORE_TRIES = 6; // ~30 s of 5 s ticks
const KEY_REQUEST_READS = 3; // an enclave key request that keeps failing is dropped after this many reads

/** Holds fire events until `open()` (after the restart restore, L-3); expiries and later events pass straight through. */
export function fireGate(handle: (e: MachineEvent) => void, opened = false) {
  const held: MachineEvent[] = [];
  return {
    onEvent: (e: MachineEvent) => (!opened && e.kind === "fire" ? void held.push(e) : handle(e)),
    open: () => {
      opened = true;
      for (const e of held.splice(0)) handle(e);
    },
  };
}

/** Starts the core runtime on HL_NETWORK and CHAIN_NETWORK: evaluator, idea registry, event sink, market feeds, the executor (only with `agentSealKey`) and swaps (only with `swapSealKey`). Returns handles plus `stop()`, which clears the timers and closes the feeds. */
export function startRuntime(d: RuntimeDeps) {
  const log = d.log ?? console.error;
  const net = d.net ?? network();
  const cfg = evalConfigFor(net);
  const info = new InfoClient({ network: net });
  // Robinhood Chain swaps (R4) on CHAIN_NETWORK; on mainnet a missing contract address throws here.
  const rhcChain = chainConfig().chain;
  const swap = swapConfig();
  const rhc = http(rhcRpcUrl()); // allow-listed host only
  const swaps =
    d.swapSealKey
      ? new SwapRunner({
          db: d.db,
          sealKey: d.swapSealKey,
          publicClient: createPublicClient({ chain: rhcChain, transport: rhc }) as PublicClient,
          walletFor: (pk) => createWalletClient({ chain: rhcChain, transport: rhc, account: privateKeyToAccount(pk, { nonceManager }) }),
          swapKeyPolicy: deployment().swapKeyPolicy!,
          poolManager: UNISWAP_V4.poolManager,
          markets: swap.markets,
          maxOracleAgeS: swap.oracleMaxAgeS,
          // Swap-only exits report like the executor's: reveal the exit part, EXIT + PNL stamps.
          onExit: (e) =>
            void sink.onExit({ thesisId: e.thesisId, at: e.at, data: { reason: e.reason, venue: "rhc" }, pnl: e.pnl == null ? undefined : { pnlUsd: e.pnl } })
              .catch((err) => log("runtime: exit report failed", err)),
          hlOwns: (id) => !!live?.openIdeas().includes(id),
          log,
        })
      : undefined;
  // Venue health guard: while Hyperliquid is degraded its readings are unknown, so nothing fires into an outage.
  const venue = new VenueHealth({
    onChange: (s) => {
      log(s.down ? `venue: Hyperliquid degraded (${s.reason}); rules paused` : "venue: Hyperliquid healthy again; rules resume");
      evaluator.apply({ src: "venue", venue: "hl", at: Date.now(), down: s.down }, Date.now());
    },
  });
  // Live trading on HL_NETWORK; without a seal key nothing is placed.
  const executor: ExecutorPort =
    d.executor ??
    (d.agentSealKey
      ? new Executor({
          db: d.db,
          venue,
          exchangeFor: (pk) => new ExchangeClient({ account: privateKeyToAccount(pk), network: net }),
          info,
          sealKey: d.agentSealKey,
          swaps,
          onExit: (e) =>
            void sink.onExit({ thesisId: e.thesisId, at: e.at, data: { reason: e.reason }, pnl: e.pnl == null ? undefined : { pnlUsd: e.pnl } })
              .catch((err) => log("runtime: exit report failed", err)),
        })
      : new NoopExecutor());
  // Events only flow once the clocks start below, after `sink` exists.
  const live = executor instanceof Executor ? executor : undefined;
  // Proviso Paper: paper calls fire into simulated fills on the live books; everything else goes to the executor.
  const maxLev = new Map<string, number>();
  const paper = new PaperEngine({
    db: d.db,
    info,
    maxLeverage: (c) => maxLev.get(c),
    log: async (owner, kind, payload) => void (await d.db.insert(activity).values({ address: owner, kind, payload })),
    onExit: (e) =>
      void sink
        .onExit({ thesisId: e.thesisId, at: e.at, data: { reason: e.reason, venue: "paper", fillModel: FILL_MODEL }, pnl: { pnlUsd: e.pnlUsd, feesUsd: e.feesUsd, fundingUsd: e.fundingUsd, fillModel: FILL_MODEL } })
        .catch((err) => log("runtime: paper exit report failed", err)),
  });
  const port: ExecutorPort = {
    onFire: (e) => (e.spec.mode === "paper" ? paper.onFire(e) : executor.onFire(e)),
    onMark: (coin, mark, at) => {
      executor.onMark(coin, mark, at);
      paper.onMark(coin, mark, at);
    },
    stop: async (id, owner) => {
      if (!(await paper.stopPaper(id, owner))) await executor.stop(id, owner);
    },
  };
  // After a restart, fires wait until open positions are rebuilt: a repeat idea firing first would buy
  // again and orphan the position bought before the restart (L-3).
  let restored = false; // paper positions are rebuilt too, with or without a live executor
  let restoreTries = 0;
  const gate = fireGate((e) => void sink.handle(e).catch((err) => log("runtime: event failed", err)), restored);
  const evaluator = new Evaluator(gate.onEvent);
  const ideas = new IdeaRegistry({
    db: d.db,
    evaluator,
    specKey: d.specKey,
    config: cfg,
    log,
    // Exact answer for retired ideas: keep the exit salt while a position is still open.
    hasOpenPosition: async (id) => !!live?.openIdeas().includes(id) || !!swaps?.openIdeas().includes(id) || paper.openIdeas().includes(id),
  });
  const sink = new EventSink({ db: d.db, executor: port, ideas, log });
  const socket = new HlSocket({ network: net, onError: (e) => log("market: socket error", e) });
  const market = new HlMarket({
    socket,
    // Main dex plus the listed HIP-3 dexes (default xyz), so their delisted flags and contexts refresh too.
    info: { metaAndAssetCtxs: () => perpUniverse(info, listedDexes()) },
    apply: (u) => evaluator.apply(u, Date.now()),
    onMark: (coin, mark, at) => port.onMark(coin, mark, at),
    log,
  });

  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, name: string, job: () => unknown, now = true) => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await job();
      } catch (e) {
        log(`runtime: ${name} failed`, e);
      } finally {
        busy = false;
      }
    };
    if (now) void run();
    timers.push(setInterval(run, ms));
  };

  every(5_000, "ideas", async () => {
    await ideas.sync();
    // After a restart: rebuild open positions once the decrypted specs are back in memory.
    if (!restored) {
      // A restore that keeps failing must not stop every idea from firing: after a few tries the gate
      // opens anyway (loudly); positions it couldn't rebuild then need a manual exit.
      if (++restoreTries > RESTORE_TRIES) {
        restored = true;
        gate.open();
        return log(`runtime: restore failed ${RESTORE_TRIES} times; fires resume without restored positions`);
      }
      const r = live ? await live.restore((id) => ideas.get(id)?.spec) : { restored: [], skipped: [] };
      const spot = (await swaps?.restore((id) => ideas.get(id)?.spec)) ?? [];
      const papers = await paper.restore((id) => ideas.get(id)?.spec);
      restored = true;
      ideas.keepRetired([...(live?.openIdeas() ?? []), ...spot, ...papers]);
      gate.open(); // held fires go through now; an idea restored above refuses its fire (already_open)
      log(`runtime: restored ${r.restored.length} open idea(s) + ${spot.length} swap position(s) + ${papers.length} paper position(s), skipped ${r.skipped.length}`);
    }
    market.setCoins(ideas.hlCoins());
    await ideas.checkStampFlags();
  });
  if (live) {
    const confirms = pgmq(d.db);
    every(2_000, "copy confirms", () => live.pollConfirms(confirms));
  }
  every(1_000, "clock", async () => {
    market.flush();
    evaluator.tick(Date.now());
    await sink.retryPending();
  });
  every(60_000, "hl meta", () => market.refreshMeta());
  every(10_000, "venue health", () => venue.probe(() => info.allMids()));
  // Paper: hourly funding at the venue's rates, max leverage for maintenance margin, and venue settlement of delisted markets. The run at
  // startup only loads leverage: it must not charge restored positions an extra hour.
  let fundingStarted = false;
  every(60 * 60_000, "paper funding", async () => {
    const [meta, ctxs] = await perpUniverse(info, listedDexes());
    const rate = new Map<string, number>();
    const delisted = new Set<string>();
    meta.universe.forEach((u, i) => {
      maxLev.set(u.name, u.maxLeverage);
      if (u.isDelisted) delisted.add(u.name);
      const f = Number(ctxs[i]?.funding);
      if (Number.isFinite(f)) rate.set(u.name, f);
    });
    paper.settleDelisted((c) => delisted.has(c));
    if (fundingStarted) paper.accrueFunding((c) => rate.get(c));
    fundingStarted = true;
  });
  if (live) every(5 * 60_000, "carry budget", () => live.checkCarry());
  every(30_000, "time exits", () => {
    live?.checkTimeExits();
    paper.checkTimeExits();
  });
  if (swaps) {
    const rhcClient = createPublicClient({ chain: rhcChain, transport: rhc }) as PublicClient;
    every(20_000, "rhc market", () =>
      pollRhc({ client: rhcClient, poolManager: UNISWAP_V4.poolManager, markets: swap.markets, coins: ideas.rhcCoins(), wantFeed: (o) => wantFeed(d.db, o), maxFeedAgeS: swap.oracleMaxAgeS,
        apply: (u) => {
          evaluator.apply(u, Date.now());
          if (u.src === "rhc" && u.pool) swaps.onPrice(u.coin, u.pool);
        },
      }),
    );
  }
  every(15 * 60_000, "fear & greed", async () => {
    const u = await pollFearGreed();
    if (u) evaluator.apply(u, Date.now());
  });
  every(2_000, "stops", () => sink.pollStops());
  // Hyperliquid onboarding: the API asks for a fresh agent key; it is made and sealed here.
  if (d.agentSealKey) {
    const manager = new AgentKeyManager(d.agentSealKey);
    const queue = pgmq(d.db);
    const swapManager = d.swapSealKey && new SessionKeyManager(d.swapSealKey);
    every(2_000, "agent keys", async () => {
      for (const m of await queue.read<{ owner: string; kind?: "swap"; account?: string }>("agent", 60, 5)) {
        // One bad request (e.g. an unknown user) must not hold the ones behind it: it is retried a few
        // times on its own, then dropped.
        try {
          const owner = String(m.message?.owner ?? "").toLowerCase();
          if (m.message.kind === "swap") {
            const account = /^0x[0-9a-fA-F]{40}$/.test(m.message.account ?? "") ? m.message.account : undefined;
            if (swapManager) await handleSwapKeyRequest(d.db, swapManager, owner, { chainId: rhcChain.id, days: swap.policyDays, account });
          } else await handleAgentRequest(d.db, manager, { owner });
        } catch (e) {
          if (m.readCt < KEY_REQUEST_READS) {
            log(`runtime: key request ${m.msgId} failed, will retry`, e);
            continue;
          }
          log(`runtime: key request ${m.msgId} failed ${m.readCt} times, dropped`, e);
        }
        await queue.delete("agent", m.msgId);
      }
    });
  }
  const tests = new TestJob({ db: d.db, specKey: d.specKey, config: cfg, log });
  every(3_000, "tests", () => tests.poll());
  const posts = new PostsFeed({ db: d.db, evaluator, handles: () => ideas.postHandles(), log });
  every(5_000, "posts", () => posts.poll());

  log(`runtime: started on Hyperliquid ${net.name} and ${chainConfig().label}, HL volume floor $${cfg.minHlVolumeUsd}`);
  return {
    evaluator,
    ideas,
    sink,
    market,
    venue,
    paper,
    /** For the executor: report a closed position so the exit part is revealed. */
    onExit: sink.onExit,
    stop() {
      for (const t of timers) clearInterval(t);
      market.close();
      socket.close();
    },
  };
}
