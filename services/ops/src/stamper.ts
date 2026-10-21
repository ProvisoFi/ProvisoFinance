// Stamper (Backend §8): relays owner-signed stamps to ThesisSeal with sponsored gas and
// records signed-at vs stamped-at. The relayer only pays gas; it can't change what was signed.
import { stampTuple, thesisSealAbi, type Stamp } from "@proviso/chain";
import { recordSeal, stampRequests, type Db } from "@proviso/db";
import { and, eq, ne } from "drizzle-orm";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { txCost, type Budget } from "./runtime/budget";

export type Relay = { public: PublicClient; wallet: WalletClient; address: Address };

type StoredStamp = Record<keyof Stamp, string> & { mode: "live" | "alert" };

// Reverts the owner must fix by signing again; everything else is retried by the queue.
const FINAL = new Set(["DeadlinePassed", "NonceUsed", "BadExpiry", "EmptyHash", "BadSignature"]);

export class FinalRelayError extends Error {}

const PAUSED_SEAL = "Sponsored seals are paused for today (relayer budget reached). Send the seal from your own wallet, or sign again tomorrow.";

/**
 * `budget`: the relayer's "stamp" pool (and the owner's share of it). `unsponsored`: the mainnet cost
 * rule (budget.ts sponsorRule): the refusal message, or null. Refused stamps fail for good; the owner
 * can still send the seal from their own wallet (idea.confirmSelfSeal).
 */
export async function relayStamp(db: Db, relay: Relay, requestId: string, budget?: Budget, unsponsored?: (owner: string) => Promise<string | null>): Promise<bigint | null> {
  const [req] = await db.select().from(stampRequests).where(eq(stampRequests.id, requestId));
  if (!req || req.status === "sealed" || req.status === "failed") return req?.thesisId ?? null;
  // Never overwrite a seal the owner confirmed from their own wallet meanwhile.
  const set = (v: Partial<typeof stampRequests.$inferInsert>) =>
    db.update(stampRequests).set(v).where(and(eq(stampRequests.id, requestId), ne(stampRequests.status, "sealed")));
  const why = await unsponsored?.(req.owner);
  if (why) {
    await set({ status: "failed", error: why });
    throw new FinalRelayError("sponsor_unfunded");
  }
  if (budget && !(await budget.allowed(req.owner))) {
    await set({ status: "failed", error: PAUSED_SEAL });
    throw new FinalRelayError("relayer_budget");
  }
  await set({ status: "relaying" });

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
      await set({ status: "failed", error: `Rejected on-chain: ${name}` });
      throw new FinalRelayError(name);
    }
    await set({ status: "pending" });
    throw e; // transient: the queue retries
  }

  const receipt = await relay.public.waitForTransactionReceipt({ hash });
  await budget?.spend(txCost(receipt), req.owner).catch((e) => console.error(`ops: relayer spend not recorded: ${e instanceof Error ? e.message : e}`));
  const [ev] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: receipt.logs });
  if (receipt.status !== "success" || !ev) throw new Error(`Seal transaction ${hash} did not emit Sealed`);
  const block = await relay.public.getBlock({ blockHash: receipt.blockHash });
  await recordSeal(db, req, { id: ev.args.id, tx: hash, stampedAt: new Date(Number(block.timestamp) * 1000) });
  return ev.args.id;
}
