// Starts every consumer whose config is present; logs the ones left off.
import type { Db } from "@proviso/db";
import { queues, type Handler } from "../queue";
import type { ChainConfig } from "./chain";
import { stampRootsPost } from "./chain";
import { revealHandler, stampHandler, stampLeafHandler, stampRootHandler, sweepHandler } from "./consumers";
import { swapSetupHandler } from "./swaps";
import { poolAligner } from "./pool-align";
import { balanceWatch } from "./balance-watch";
import { relayerBudget, sponsorRule } from "./budget";
import { notifyHandler, type Senders } from "./notify";
import { startTelegramBot } from "./telegram";
import { epochHandler } from "./epochs";
import { chainConfig, robinhoodMainnet, robinhoodTestnet, swapConfig, TESTNET_SWAP } from "@proviso/chain";
import { parseEther, type Address } from "viem";
import { xPoller } from "./xposts";
import { feedPusher } from "./feeds";

export type Running = { names: string[]; done: Promise<unknown> };

export function startConsumers(
  db: Db,
  {
    chain,
    senders,
    signal,
    env = process.env,
    log = console.log,
  }: { chain: ChainConfig | null; senders: Senders; signal: AbortSignal; env?: Record<string, string | undefined>; log?: (m: string) => void },
): Running {
  const q = queues(db);
  const started: [string, Promise<void>][] = [];
  const run = <T>(name: string, handler: Handler<T>, vt = 60) => started.push([name, q.consume(name, handler, { vt, signal })]);

  run("stamp_leaf", stampLeafHandler(db));
  run("sweep", sweepHandler(db));
  if (senders.push || senders.telegram) run("notify", notifyHandler(db, senders));
  else log("ops: no VAPID or Telegram config, notify consumer off");

  const d = chain?.deployment;
  // User-triggered sponsored work only, one pool each so setup abuse can't block seals; reveals,
  // roots and epochs never wait on it.
  if (chain && d?.thesisSeal) {
    const stampBudget = relayerBudget(db, chain.clients, { pool: "stamp", capEth: env.RELAYER_DAILY_STAMP_BUDGET_ETH, minEth: env.RELAYER_MIN_ETH, log });
    // Mainnet only: a sponsored seal needs the owner (or its swap wallet) to hold some USDG or ETH.
    const unsponsored =
      chain.clients.public?.chain?.id === robinhoodMainnet.id
        ? sponsorRule(db, chain.clients, { usdg: swapConfig().usdg, minUsdg: BigInt(env.SPONSOR_MIN_USDG || 1_000_000), minWei: parseEther(env.SPONSOR_MIN_ETH || "0.0002"), label: chainConfig().label })
        : undefined;
    run("stamp", stampHandler(db, chain.clients, d.thesisSeal, undefined, stampBudget, unsponsored), 120);
    run("reveal", revealHandler(db, chain.clients, d.thesisSeal), 120);
  } else if (chain) log("ops: THESIS_SEAL_ADDRESS unset (not deployed yet), stamp and reveal consumers off");
  if (chain && d?.stampRoots) run("stamp_root", stampRootHandler(db, stampRootsPost(chain.clients, d.stampRoots)), 300);
  else if (chain) log("ops: STAMP_ROOTS_ADDRESS unset (not deployed yet), stamp_root consumer off");

  const usdg = (env.USDG_ADDRESS || chainConfig().usdg) as Address | undefined;
  if (chain && d?.callerShare && usdg) {
    const poolUsdg = BigInt(env.EPOCH_POOL_USDG || 0); // throws at startup on a malformed value
    const capUsdg = env.EPOCH_CAP_USDG ? BigInt(env.EPOCH_CAP_USDG) : undefined;
    run("epoch", epochHandler(db, chain.clients, { callerShare: d.callerShare, usdg, poolUsdg, capUsdg }), 600);
  } else if (chain) log("ops: CALLER_SHARE_ADDRESS or USDG_ADDRESS unset, epoch consumer off");
  if (chain && d?.swapAdapter && d.swapKeyPolicy) {
    const onTestnet = chain.clients.public.chain?.id === robinhoodTestnet.id;
    // Testnet drips tUSDG during setup, so the USDG floor applies on mainnet only.
    const minUsdg = onTestnet ? 0n : BigInt(env.SETUP_MIN_USDG || 1_000_000);
    const setupBudget = relayerBudget(db, chain.clients, { pool: "setup", capEth: env.RELAYER_DAILY_SETUP_BUDGET_ETH, minEth: env.RELAYER_MIN_ETH, log });
    run("swap_setup", swapSetupHandler(db, chain.clients, { swapAdapter: d.swapAdapter, swapKeyPolicy: d.swapKeyPolicy, testnetUsdg: onTestnet ? TESTNET_SWAP.usdg : undefined, budget: setupBudget, usdg: swapConfig().usdg, minUsdg }), 180);
  } else if (chain) log("ops: SWAP_ADAPTER_ADDRESS or SWAP_KEY_POLICY_ADDRESS unset, swap_setup consumer off");
  if (chain && env.RELAYER_ALERT_ADDRESS)
    started.push(["balance_watch", balanceWatch(chain.clients, { alertAddress: env.RELAYER_ALERT_ADDRESS, minEth: env.RELAYER_MIN_ETH || undefined, notify: (m) => q.send("notify", m), log }).run(signal)]);
  else if (chain) log("ops: RELAYER_ALERT_ADDRESS unset, relayer balance watch off");
  // Testnet only: mainnet has Chainlink feeds and arbitraged pools.
  if (chain?.clients.public?.chain?.id === robinhoodTestnet.id) started.push(["pool_align", poolAligner(chain!.clients, { log }).run(signal)]);
  const feeds = chain && feedPusher(db, chain.clients, { env, log }); // testnet only, null otherwise
  if (feeds) started.push(["test_feeds", feeds.run(signal)]);

  if (env.X_BEARER_TOKEN) {
    const poller = xPoller(db, {
      token: env.X_BEARER_TOKEN,
      maxHandles: Number(env.X_MAX_HANDLES || 50),
      send: (post) => q.send("posts", post),
    });
    started.push(["xposts", poller.run(signal)]);
  } else log("ops: X_BEARER_TOKEN unset, X poller off");
  if (env.TELEGRAM_BOT_TOKEN) started.push(["telegram", startTelegramBot(db, env.TELEGRAM_BOT_TOKEN, (m) => q.send("confirm", m), signal)]);
  else log("ops: TELEGRAM_BOT_TOKEN unset, Telegram bot off");

  const names = started.map(([n]) => n);
  log(`ops: consumers running: ${names.join(", ")}`);
  return { names, done: Promise.all(started.map(([, p]) => p)) };
}
