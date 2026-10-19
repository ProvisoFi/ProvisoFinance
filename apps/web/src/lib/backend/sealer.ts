// Client sealer (Backend §2–3): runs entirely in the browser. Plaintext spec and salts never
// leave the device unencrypted; the server receives only hashes, a signature and a sealed box.
import type { AppRouter } from "@proviso/api";
import { chains, network, randomNonce, stampTypedData, type Stamp } from "@proviso/chain";
import { durationMs, splitCommitments, type Spec } from "@proviso/dsl";
import { checkAttestation, encryptRecovery, RECOVERY_MESSAGE, recoveryKey, sealSpec } from "@proviso/seal";
import type { TRPCClient } from "@trpc/client";
import { createWalletClient, custom, getAddress, type EIP1193Provider } from "viem";

export type SealStep = "attesting" | "signing" | "backup" | "submitting" | "relaying" | "sealed";
export type SealResult = { thesisId: string; requestId: string; entryHash: string };

const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function sealIdea(opts: {
  spec: Spec;
  provider: EIP1193Provider;
  address: string;
  api: TRPCClient<AppRouter>;
  onStep: (s: SealStep) => void;
  sealed?: boolean;
}): Promise<SealResult> {
  const { spec, api, onStep } = opts;
  const chain = chains[network()];

  onStep("attesting");
  const target = await api.idea.sealTarget.query();
  if (target.chainId !== chain.id) throw new Error("The server and this page disagree on the network.");
  const enclaveKey = checkAttestation(await api.idea.attestation.query());

  const wallet = createWalletClient({ account: getAddress(opts.address), chain, transport: custom(opts.provider) });
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }

  // Live markets, liquidity and the user's server-side limits, before anything is signed.
  const check = await api.market.validate.mutate({ spec });
  if (!check.ok) throw new Error(check.errors.map((e) => e.message).join("; "));

  onStep("signing");
  const c = splitCommitments(spec);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const stamp: Stamp = {
    owner: getAddress(opts.address),
    entryHash: c.entryHash,
    exitHash: c.exitHash,
    sealed: opts.sealed ?? true,
    expiresAt: now + BigInt(durationMs(spec.expires) / 1000),
    nonce: randomNonce(),
    deadline: now + 15n * 60n,
  };
  const signedAt = new Date();
  const ownerSig = await wallet.signTypedData(stampTypedData(chain.id, target.address, stamp));

  // The owner's own copy of spec + salts, encrypted to a key only their wallet can re-derive.
  onStep("backup");
  const payload = { v: 1 as const, spec, saltE: c.saltE, saltX: c.saltX };
  const recoverySig = await wallet.signMessage({ message: RECOVERY_MESSAGE });
  download(`proviso-idea-${c.entryHash.slice(2, 10)}.backup`, encryptRecovery(recoveryKey(recoverySig), payload));

  onStep("submitting");
  const { requestId } = await api.idea.stamp.mutate({
    encSpec: b64(sealSpec(enclaveKey, payload)),
    mode: spec.mode,
    stamp,
    ownerSig,
    signedAt,
  });

  onStep("relaying");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await api.idea.stampStatus.query({ requestId });
    if (s.status === "sealed" && s.thesisId != null) {
      onStep("sealed");
      return { thesisId: String(s.thesisId), requestId, entryHash: c.entryHash };
    }
    if (s.status === "failed") throw new Error(s.error ?? "The stamp could not be relayed.");
  }
  throw new Error("Still waiting for the chain. Your stamp is queued; check the ledger shortly.");
}
