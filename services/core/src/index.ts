// core CVM (Phala TDX): market data, evaluator, executor/signer and Fair Copy live here.
// B0 serves the attested spec-encryption key; later milestones add the workers.
import { DstackClient } from "@phala/dstack-sdk";
import { attest } from "./enclave";

const attestation = await attest(new DstackClient());

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/attestation") return Response.json(attestation);
    if (pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
});
console.log("core: attestation ready, public key", attestation.publicKey);
