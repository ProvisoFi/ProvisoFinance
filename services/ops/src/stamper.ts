// Stamper (Backend §8): relays owner-signed stamps to ThesisSeal with sponsored gas and
// records signed-at vs stamped-at. The relayer only pays gas; it can't change what was signed.
import { stampTuple, thesisSealAbi, type Stamp } from "@proviso/chain";
import { activity, reveals, stampRequests, theses, type Db } from "@proviso/db";
import { eq } from "drizzle-orm";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export type Relay = { public: PublicClient; wallet: WalletClient; address: Address };

type StoredStamp = Record<keyof Stamp, string> & { mode: "live" | "alert" };

// Reverts the owner must fix by signing again; everything else is retried by the queue.
const FINAL = new Set(["DeadlinePassed", "NonceUsed", "BadExpiry", "EmptyHash", "BadSignature"]);

export class FinalRelayError extends Error {}

export async function relayStamp(db: Db, relay: Relay, requestId: string): Promise<bigint | null> {
  const [req] = await db.select().from(stampRequests).where(eq(stampRequests.id, requestId));
  if (!req || req.status === "sealed" || req.status === "failed") return req?.thesisId ?? null;
  await db.update(stampRequests).set({ status: "relaying" }).where(eq(stampRequests.id, requestId));

  const s = req.stamp as StoredStamp;
  const stamp: Stamp = {
    owner: s.owner as Address,
    entryHash: s.entryHash as Hex,
    exitHash: s.exitHash as Hex,
    sealed: Boolean(s.sealed),
    expiresAt: BigInt(s.expiresAt),
    nonce: BigInt(s.nonce),
    deadline: BigInt(s.deadline),
  };

  let hash: Hex;
  try {
    const { request } = await relay.public.simulateContract({
      address: relay.address,
      abi: thesisSealAbi,
      functionName: "seal",
      args: [stampTuple(stamp), req.ownerSig as Hex],
      account: relay.wallet.account!,
    });
    hash = await relay.wallet.writeContract(request);
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    if (name && FINAL.has(name)) {
      await db.update(stampRequests).set({ status: "failed", error: `Rejected on-chain: ${name}` }).where(eq(stampRequests.id, requestId));
      throw new FinalRelayError(name);
    }
    await db.update(stampRequests).set({ status: "pending" }).where(eq(stampRequests.id, requestId));
    throw e; // transient: the queue retries
  }

  const receipt = await relay.public.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: receipt.logs });
  if (receipt.status !== "success" || !ev) throw new Error(`Seal transaction ${hash} did not emit Sealed`);
  const block = await relay.public.getBlock({ blockHash: receipt.blockHash });
  const id = ev.args.id;
  const owner = req.owner;

  await db.transaction(async (tx) => {
    await tx.insert(theses).values({
      id,
      owner,
      encSpec: req.encSpec,
      entryHash: stamp.entryHash,
      exitHash: stamp.exitHash,
      mode: s.mode,
      signedAt: req.signedAt,
      stampedAt: new Date(Number(block.timestamp) * 1000),
      sealTx: hash,
      expiresAt: new Date(Number(stamp.expiresAt) * 1000),
      state: s.mode,
    }).onConflictDoNothing();
    // The entry must be revealed by expiry at the latest (or within a minute of a fire).
    await tx.insert(reveals).values({ thesisId: id, part: "entry", dueAt: new Date(Number(stamp.expiresAt) * 1000) }).onConflictDoNothing();
    await tx.update(stampRequests).set({ status: "sealed", thesisId: id, error: null }).where(eq(stampRequests.id, requestId));
    await tx.insert(activity).values({ address: owner, kind: "sealed", payload: { thesisId: String(id), tx: hash } });
  });
  return id;
}
