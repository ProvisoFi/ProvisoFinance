// ops CVM (Phala TDX): stamper, stamps, shares, routes, tester, notify, Telegram, X poller.
// Runs the market-data recorder plus every queue consumer whose config is present.
import { checkRhcNetwork } from "@proviso/chain";
import { createDb } from "@proviso/db";
import { network as hlNetwork } from "@proviso/hl";
import { chainFromEnv } from "./runtime/chain";
import { sendersFromEnv } from "./runtime/notify";
import { startRecorder } from "./runtime/recorder-loop";
import { startConsumers } from "./runtime/start";

const db = createDb();
const chain = chainFromEnv(); // throws on an unknown CHAIN_NETWORK or a foreign RPC host
if (chain) await checkRhcNetwork(chain.clients.public, hlNetwork().name); // RPC chain id, HL/RHC networks agree
const stopRecorder = startRecorder(db);
const ac = new AbortController();
const consumers = startConsumers(db, { chain, senders: sendersFromEnv(), signal: ac.signal });

// Graceful shutdown: stop polling, let in-flight handlers finish (bounded), then exit.
async function shutdown(sig: string) {
  console.log(`ops: ${sig}, shutting down`);
  stopRecorder();
  ac.abort();
  await Promise.race([consumers.done, Bun.sleep(25_000)]);
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
