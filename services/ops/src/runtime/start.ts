// Starts every consumer whose config is present; logs the ones left off.
import type { Db } from "@proviso/db";
import { queues, type Handler } from "../queue";
import type { ChainConfig } from "./chain";
import { stampRootsPost } from "./chain";
import { revealHandler, stampHandler, stampLeafHandler, stampRootHandler, sweepHandler } from "./consumers";
import { notifyHandler, type Senders } from "./notify";

export type Running = { names: string[]; done: Promise<unknown> };

export function startConsumers(
  db: Db,
  { chain, senders, signal, log = console.log }: { chain: ChainConfig | null; senders: Senders; signal: AbortSignal; log?: (m: string) => void },
): Running {
  const q = queues(db);
  const started: [string, Promise<void>][] = [];
  const run = <T>(name: string, handler: Handler<T>, vt = 60) => started.push([name, q.consume(name, handler, { vt, signal })]);

  run("stamp_leaf", stampLeafHandler(db));
  run("sweep", sweepHandler(db));
  if (senders.push || senders.telegram) run("notify", notifyHandler(db, senders));
  else log("ops: no VAPID or Telegram config, notify consumer off");

  const d = chain?.deployment;
  if (chain && d?.thesisSeal) {
    run("stamp", stampHandler(db, chain.clients, d.thesisSeal), 120);
    run("reveal", revealHandler(db, chain.clients, d.thesisSeal), 120);
  } else if (chain) log("ops: THESIS_SEAL_ADDRESS unset (not deployed yet), stamp and reveal consumers off");
  if (chain && d?.stampRoots) run("stamp_root", stampRootHandler(db, stampRootsPost(chain.clients, d.stampRoots)), 300);
  else if (chain) log("ops: STAMP_ROOTS_ADDRESS unset (not deployed yet), stamp_root consumer off");

  const names = started.map(([n]) => n);
  log(`ops: consumers running: ${names.join(", ")}`);
  return { names, done: Promise.all(started.map(([, p]) => p)) };
}
