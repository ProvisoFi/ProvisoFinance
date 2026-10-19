// Relay clients for the ops consumers. Testnet/local only: the relayer key is a hot env key.
import { callerShareAbi, chains, deployment, network, stampRootsAbi, TESTNET_DEPLOY_BLOCK, type Deployment } from "@proviso/chain";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
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
 * Null (with a log line) when RELAYER_PRIVATE_KEY is unset. Throws on any network other than
 * testnet/local, so a misconfigured ops box refuses to start rather than relay somewhere else.
 */
export function chainFromEnv(env = process.env, log = console.log): ChainConfig | null {
  const net = network(); // throws for anything but testnet/local
  const key = env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    log("ops: RELAYER_PRIVATE_KEY unset, chain consumers off");
    return null;
  }
  const base = chains[net];
  const transport = http(env.RHC_RPC_URL || base.rpcUrls.default.http[0]);
  const account = privateKeyToAccount(key);
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
): Promise<{ hash: Hex; at: Date } | null> {
  // Start at the deploy block: public RPCs refuse log scans over the whole chain.
  const onTestnet = c.public.chain?.id === chains.testnet.id;
  const fromBlock = process.env.CONTRACTS_DEPLOY_BLOCK ? BigInt(process.env.CONTRACTS_DEPLOY_BLOCK) : onTestnet ? TESTNET_DEPLOY_BLOCK : 0n;
  const [log] = await c.public.getContractEvents({ ...q, fromBlock } as never);
  const l = log as { transactionHash: Hex; blockHash: Hex } | undefined;
  if (!l) return null;
  const block = await c.public.getBlock({ blockHash: l.blockHash });
  return { hash: l.transactionHash, at: new Date(Number(block.timestamp) * 1000) };
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
