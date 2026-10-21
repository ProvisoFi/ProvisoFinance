// Relay clients for the ops consumers on CHAIN_NETWORK. The relayer key is a hot env key (Phala's
// encrypted env): it holds gas money only.
import { callerShareAbi, CHAIN_CONFIG, chainConfig, deployment, network, stampRootsAbi, type Deployment } from "@proviso/chain";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PostFn } from "../stamps/store";

export type Clients = { public: PublicClient; wallet: WalletClient; account: Account };
export type ChainConfig = { clients: Clients; deployment: Deployment };

/**
 * Null (with a log line) when RELAYER_PRIVATE_KEY is unset. Throws on an unknown CHAIN_NETWORK (and
 * on mainnet with a contract address missing), so a misconfigured ops box refuses to start.
 */
export function chainFromEnv(env = process.env, log = console.log): ChainConfig | null {
  network(); // throws for anything but mainnet/testnet/local
  const key = env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    log("ops: RELAYER_PRIVATE_KEY unset, chain consumers off");
    return null;
  }
  const base = chainConfig().chain;
  const transport = http(env.RHC_RPC_URL || base.rpcUrls.default.http[0]);
  // One relayer key, many senders (stamps, reveals, roots, feed pushes, swap setup): the nonce
  // manager hands out nonces in order, so concurrent sends don't collide (a reveal once lost to a
  // feed push that took the same nonce).
  const account = privateKeyToAccount(key, { nonceManager });
  return {
    clients: {
      public: createPublicClient({ chain: base, transport }) as PublicClient,
      wallet: createWalletClient({ chain: base, transport, account }),
      account,
    },
    deployment: deployment(),
  };
}

/** Custom-error name of a contract revert anywhere in a viem error chain. */
export function revertName(e: unknown): string | undefined {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

/** Simulate (so reverts surface with their error name), send, and wait for a successful receipt. */
export async function send(c: Clients, call: Call) {
  // viem's generics can't follow a runtime-chosen function name; the ABI still encodes/decodes it.
  const { request } = await c.public.simulateContract({ ...call, account: c.account } as never);
  const hash = await c.wallet.writeContract(request as never);
  const receipt = await c.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} transaction ${hash} reverted`);
  const block = await c.public.getBlock({ blockHash: receipt.blockHash });
  return { hash, receipt, at: new Date(Number(block.timestamp) * 1000) };
}

/**
 * Tx hash of the first matching event, for "already done on-chain" reverts.
 * ponytail: scans from block 0; use a deploy-block lower bound if the RPC limits log ranges.
 */
export async function findEventTx(
  c: Clients,
  q: { address: Address; abi: Abi; eventName: string; args: Record<string, unknown> },
): Promise<{ hash: Hex; at: Date; args: Record<string, unknown> } | null> {
  // Start at the deploy block: public RPCs refuse log scans over the whole chain.
  const net = Object.values(CHAIN_CONFIG).find((n) => n.chain.id === c.public.chain?.id);
  const fromBlock = process.env.CONTRACTS_DEPLOY_BLOCK ? BigInt(process.env.CONTRACTS_DEPLOY_BLOCK) : (net?.deployBlock ?? 0n);
  const [log] = await c.public.getContractEvents({ ...q, fromBlock } as never);
  const l = log as { transactionHash: Hex; blockHash: Hex; args: Record<string, unknown> } | undefined;
  if (!l) return null;
  const block = await c.public.getBlock({ blockHash: l.blockHash });
  return { hash: l.transactionHash, at: new Date(Number(block.timestamp) * 1000), args: l.args };
}

/** postHourRoot's `post`, wired to StampRoots.post. AlreadyPosted resolves to the original tx. */
export const stampRootsPost =
  (c: Clients, address: Address): PostFn =>
  async (hourStartSec, root, leafCount) => {
    try {
      return (await send(c, { address, abi: stampRootsAbi, functionName: "post", args: [hourStartSec, root, leafCount] })).hash;
    } catch (e) {
      if (revertName(e) !== "AlreadyPosted") throw e;
      const prev = await findEventTx(c, { address, abi: stampRootsAbi, eventName: "RootPosted", args: { hourStart: hourStartSec } });
      if (!prev) throw new Error(`Hour ${hourStartSec} is posted on-chain but its RootPosted log wasn't found`);
      return prev.hash;
    }
  };

/**
 * runEpoch's `post`, wired to CallerShare.postEpoch. postEpoch pulls `total` USDG from the
 * relayer, so the relayer must hold and have approved it. EpochExists resolves to the original tx.
 */
export const callerSharePost =
  (c: Clients, address: Address) =>
  async (epoch: bigint, root: Hex, total: bigint): Promise<Hex> => {
    try {
      return (await send(c, { address, abi: callerShareAbi, functionName: "postEpoch", args: [epoch, root, total] })).hash;
    } catch (e) {
      if (revertName(e) !== "EpochExists") throw e;
      const prev = await findEventTx(c, { address, abi: callerShareAbi, eventName: "EpochPosted", args: { epoch } });
      if (!prev) throw new Error(`Epoch ${epoch} is posted on-chain but its EpochPosted log wasn't found`);
      return prev.hash;
    }
  };
