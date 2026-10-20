// Minimal client for the dstack guest agent (the CVM's KMS keys and TDX quotes), speaking the
// same JSON-over-unix-socket RPC as @phala/dstack-sdk. Kept local because the SDK pins
// @noble/hashes v1 as a peer while this workspace uses v2.
import { existsSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { KeySource } from "./enclave";

const SOCKETS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock", "/run/dstack/dstack.sock"];

async function rpc<T>(path: string, body: unknown): Promise<T> {
  const unix = process.env.DSTACK_SOCKET ?? SOCKETS.find((s) => existsSync(s)) ?? SOCKETS[0];
  const res = await fetch(`http://localhost${path}`, {
    method: "POST",
    unix,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  } as RequestInit);
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || json.error) throw new Error(`dstack ${path}: ${json.error ?? res.status}`);
  return json;
}

export const dstack: KeySource = {
  async getKey(path, purpose) {
    const r = await rpc<{ key: string }>("/GetKey", { path, purpose, algorithm: "secp256k1" });
    return { key: hexToBytes(r.key.replace(/^0x/, "")) };
  },
  async getQuote(reportData) {
    if (reportData.length > 64) throw new Error("report data must be at most 64 bytes");
    const r = await rpc<{ quote: string; event_log: string }>("/GetQuote", { report_data: bytesToHex(reportData) });
    return { quote: r.quote, event_log: r.event_log };
  },
};
