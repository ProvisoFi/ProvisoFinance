// Wires the evaluator to the database, Hyperliquid, Fear & Greed, the queues and the executor.
import type { Db } from "@proviso/db";
import { ExchangeClient, HlSocket, InfoClient, network, type Network } from "@proviso/hl";
import { privateKeyToAccount } from "viem/accounts";
import { config, type EvalConfig } from "../evaluator/conditions.ts";
import { Evaluator } from "../evaluator/engine.ts";
import { EventSink } from "./events.ts";
import { IdeaRegistry } from "./ideas.ts";
import { HlMarket, pollFearGreed } from "./market.ts";
import { PostsFeed } from "./posts.ts";
import { TestJob } from "./tests.ts";
import { handleAgentRequest } from "../executor/agents.ts";
import { Executor } from "../executor/executor.ts";
import { AgentKeyManager } from "../signer/agentKey.ts";
import { NoopExecutor, pgmq, type ExecutorPort, type Log } from "./ports.ts";

/**
 * Testnet volumes are tiny, so the HL volume floor drops to TESTNET_MIN_HL_VOLUME_USD (default
 * $1000) there. Mainnet keeps the spec floors ($250k HL volume, $100k pool depth).
 */
export function evalConfigFor(net: Network, env: Record<string, string | undefined> = process.env): EvalConfig {
  if (net.name !== "testnet") return config();
  const floor = Number(env.TESTNET_MIN_HL_VOLUME_USD ?? 1000);
  if (!(floor >= 0)) throw new Error("TESTNET_MIN_HL_VOLUME_USD must be a number >= 0");
  return config({ minHlVolumeUsd: floor });
}

export type RuntimeDeps = {
  db: Db;
  specKey: Uint8Array;
  executor?: ExecutorPort;
  /** 32-byte key sealing per-user agent keys (enclave-derived). Enables the executor on testnet. */
  agentSealKey?: Uint8Array;
  net?: Network;
  log?: Log;
};

export function startRuntime(d: RuntimeDeps) {
  const log = d.log ?? console.error;
  const net = d.net ?? network();
  const cfg = evalConfigFor(net);
  const info = new InfoClient({ network: net });
  // Live trading only on testnet until mainnet sign-off; without a seal key nothing is placed.
  const executor: ExecutorPort =
    d.executor ??
    (d.agentSealKey && net.name === "testnet"
      ? new Executor({
          db: d.db,
          exchangeFor: (pk) => new ExchangeClient({ account: privateKeyToAccount(pk), network: net }),
          info,
          sealKey: d.agentSealKey,
          onExit: (e) =>
            void sink.onExit({ thesisId: e.thesisId, at: e.at, data: { reason: e.reason }, pnl: e.pnl == null ? undefined : { pnlUsd: e.pnl } }),
        })
      : new NoopExecutor());
  // Events only flow once the clocks start below, after `sink` exists.
  const evaluator = new Evaluator((e) => void sink.handle(e));
  const ideas = new IdeaRegistry({ db: d.db, evaluator, specKey: d.specKey, config: cfg, log });
  const sink = new EventSink({ db: d.db, executor, ideas, log });
  const socket = new HlSocket({ network: net, onError: (e) => log("market: socket error", e) });
  const market = new HlMarket({
    socket,
    info,
    apply: (u) => evaluator.apply(u, Date.now()),
    onMark: (coin, mark, at) => executor.onMark(coin, mark, at),
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
    market.setCoins(ideas.hlCoins());
  });
  every(1_000, "clock", async () => {
    market.flush();
    evaluator.tick(Date.now());
    await sink.retryPending();
  });
  every(60_000, "hl meta", () => market.refreshMeta());
  every(15 * 60_000, "fear & greed", async () => {
    const u = await pollFearGreed();
    if (u) evaluator.apply(u, Date.now());
  });
  every(2_000, "stops", () => sink.pollStops());
  // Hyperliquid onboarding: the API asks for a fresh agent key; it is made and sealed here.
  if (d.agentSealKey) {
    const manager = new AgentKeyManager(d.agentSealKey);
    const queue = pgmq(d.db);
    every(2_000, "agent keys", async () => {
      for (const m of await queue.read<{ owner: string }>("agent", 60, 5)) {
        await handleAgentRequest(d.db, manager, { owner: m.message.owner.toLowerCase() });
        await queue.delete("agent", m.msgId);
      }
    });
  }
  const tests = new TestJob({ db: d.db, specKey: d.specKey, config: cfg, log });
  every(3_000, "tests", () => tests.poll());
  const posts = new PostsFeed({ db: d.db, evaluator, handles: () => ideas.postHandles(), log });
  every(5_000, "posts", () => posts.poll());

  log(`runtime: started on Hyperliquid ${net.name}, HL volume floor $${cfg.minHlVolumeUsd}`);
  return {
    evaluator,
    ideas,
    sink,
    market,
    /** For the executor: report a closed position so the exit part is revealed. */
    onExit: sink.onExit,
    stop() {
      for (const t of timers) clearInterval(t);
      market.close();
      socket.close();
    },
  };
}
