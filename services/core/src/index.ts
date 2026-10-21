// core CVM (Phala TDX): market data, evaluator, executor/signer and Fair Copy live here.
// Serves the attested spec-encryption key; runs the live evaluator when DATABASE_URL is set.
import { sha256 } from "@noble/hashes/sha2.js";
import { createDb } from "@proviso/db";
import { dstack } from "./dstack";
import { attest, deriveSpecKey } from "./enclave";
import { checkNetworks, startRuntime } from "./runtime/index.ts";

const attestation = await attest(dstack);
if (process.env.DATABASE_URL) await checkNetworks();
const runtime = process.env.DATABASE_URL
  ? startRuntime({
      db: createDb(),
      specKey: (await deriveSpecKey(dstack)).privateKey,
      agentSealKey: sha256((await dstack.getKey("proviso/agent-keys/v1", "agent-key-seal")).key),
      swapSealKey: sha256((await dstack.getKey("proviso/swap-keys/v1", "swap-key-seal")).key),
    })
  : undefined;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/attestation") return Response.json(attestation);
    if (pathname === "/health")
      return Response.json({ ok: true, runtime: runtime ? { ideas: runtime.ideas.size, coins: runtime.market.coins.length } : null });
    return new Response("Not found", { status: 404 });
  },
});
console.log("core: attestation ready, public key", attestation.publicKey);
if (!runtime) console.log("core: DATABASE_URL not set, evaluator runtime not started");

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`core: ${signal}, shutting down`);
  runtime?.stop();
  void server.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
