// Deploys ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter and SwapKeyPolicy to Robinhood
// Chain MAINNET (4663) from a fresh single-use deployer key, and records every step in
// packages/chain/deployments/mainnet.json (written after each contract, so a re-run resumes:
// a recorded contract whose code is on chain is skipped). The relayer (RELAYER_ADDRESS) gets the
// roles: ThesisSeal revealer, StampRoots poster, CallerShare poster. The deployer keeps none.
// Run `forge build && bun packages/chain/scripts/gen-abi.ts` first, commit, then:
//   bun --env-file=.env.mainnet packages/chain/scripts/deploy-mainnet.ts
// Env: CHAIN_NETWORK=mainnet, DEPLOYER_PRIVATE_KEY, RELAYER_ADDRESS, optional RHC_RPC_URL.
//
// ADAPTER_V2=1 replaces only the swap pair on an existing deployment: a ProvisoSwapAdapter with
// its feeds pinned (TSLA, AMZN -> Chainlink, quoted in USDG, from MAINNET_SWAP) and a SwapKeyPolicy
// bound to it, from the recorded deployer (its nonce is > 0 by now; it holds no role). The old
// entries move to `previous` with a retiredAt time. Resumable like the full run.
//   ADAPTER_V2=1 bun --env-file=.env.mainnet packages/chain/scripts/deploy-mainnet.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, getAddress, http, isAddressEqual, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { callerShareAbi, provisoSwapAdapterAbi, stampRootsAbi, swapKeyPolicyAbi, thesisSealAbi } from "../src/abi.ts";
import { callerShareBytecode, provisoSwapAdapterBytecode, stampRootsBytecode, swapKeyPolicyBytecode, thesisSealBytecode } from "../src/bytecode.ts";
import { MAINNET_RELAYER, MAINNET_USDG, POOL_MANAGER, robinhoodMainnet } from "../src/chains.ts";
import { adapterPins, MAINNET_SWAP } from "../src/swaps.ts";

const CHAIN_ID = 4663;
/** Chainlink equity feeds: 86400 s heartbeat + 1 h. */
const MAX_ORACLE_AGE = BigInt(MAINNET_SWAP.oracleMaxAgeS); // one source of truth with the off-chain checks
const PINS = adapterPins(MAINNET_SWAP); // [USDG, [TSLA, AMZN], [their Chainlink feeds]]
const V2 = process.env.ADAPTER_V2 === "1";

if (process.env.CHAIN_NETWORK !== "mainnet") throw new Error("CHAIN_NETWORK must be mainnet.");
if (robinhoodMainnet.id !== CHAIN_ID) throw new Error("chains.ts mainnet id is not 4663.");
if (!isAddressEqual(PINS[0], MAINNET_USDG)) throw new Error("MAINNET_SWAP markets aren't quoted in MAINNET_USDG.");
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("DEPLOYER_PRIVATE_KEY missing or malformed (value not shown).");
const account = privateKeyToAccount(pk as Hex);
if (!process.env.RELAYER_ADDRESS) throw new Error("RELAYER_ADDRESS missing.");
const relayer = getAddress(process.env.RELAYER_ADDRESS);
if (!isAddressEqual(relayer, MAINNET_RELAYER)) throw new Error(`RELAYER_ADDRESS ${relayer} differs from chains.ts MAINNET_RELAYER ${MAINNET_RELAYER}.`);
if (isAddressEqual(relayer, account.address)) throw new Error("The deployer must be a fresh key, not the relayer.");

const rpc = process.env.RHC_RPC_URL ?? robinhoodMainnet.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: robinhoodMainnet, transport: http(rpc) });
const wallet = createWalletClient({ chain: robinhoodMainnet, transport: http(rpc), account });
const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected ${CHAIN_ID}.`);

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--", "contracts", "packages/chain/src"], { encoding: "utf8" }).trim())
  console.warn("warning: contracts/ or packages/chain/src has uncommitted changes; the recorded commit won't match the bytecode.");

type Entry = { address: Address; tx: Hex; block: number; gasUsed: string; args: unknown[]; commit?: string };
type Retired = { contract: string; address: Address; tx: Hex; block: number; retiredAt: string };
type Record_ = {
  chainId: number;
  commit?: string | null;
  deployer?: Address | null;
  relayer?: Address | null;
  startBlock?: number | null;
  timestamp?: string | null;
  maxOracleAge?: number;
  previous?: Retired[];
  [contract: string]: unknown;
};
const file = join(import.meta.dir, "../deployments/mainnet.json");
const rec: Record_ = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { chainId: CHAIN_ID };
if (rec.chainId !== CHAIN_ID) throw new Error(`${file} is for chain ${rec.chainId}.`);
if (rec.deployer && !isAddressEqual(rec.deployer, account.address)) throw new Error(`mainnet.json was started by deployer ${rec.deployer}; resume with that key.`);
if (rec.relayer && !isAddressEqual(rec.relayer, relayer)) throw new Error(`mainnet.json records relayer ${rec.relayer}.`);
if (V2 && !rec.deployer) throw new Error("ADAPTER_V2 replaces the swap pair of an existing deployment; mainnet.json has none.");
const save = () => writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");

type Step = { key: string; name: string; abi: Abi; bytecode: Hex; args: () => unknown[] };
const all: Step[] = [
  { key: "thesisSeal", name: "ThesisSeal", abi: thesisSealAbi, bytecode: thesisSealBytecode, args: () => [relayer] },
  { key: "stampRoots", name: "StampRoots", abi: stampRootsAbi, bytecode: stampRootsBytecode, args: () => [relayer] },
  { key: "callerShare", name: "CallerShare", abi: callerShareAbi, bytecode: callerShareBytecode, args: () => [MAINNET_USDG, relayer] },
  { key: "swapAdapter", name: "ProvisoSwapAdapter", abi: provisoSwapAdapterAbi, bytecode: provisoSwapAdapterBytecode, args: () => [POOL_MANAGER, MAX_ORACLE_AGE, ...PINS] },
  // Bound to the adapter deployed (or recorded) above.
  { key: "swapKeyPolicy", name: "SwapKeyPolicy", abi: swapKeyPolicyAbi, bytecode: swapKeyPolicyBytecode, args: () => [(rec.swapAdapter as Entry).address] },
];
const steps = V2 ? all.filter((s) => s.key === "swapAdapter" || s.key === "swapKeyPolicy") : all;

const live = async (e: unknown) => Boolean(e && (e as Entry).address && ((await pub.getCode({ address: (e as Entry).address })) ?? "0x") !== "0x");
const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as Parameters<typeof pub.readContract>[0]).catch(() => undefined);
/** A recorded adapter is v2 iff it reports the expected pins (v1 has no quoteToken / oracleOf). */
const pinned = async (a: Address) =>
  isAddressEqual(((await read(a, provisoSwapAdapterAbi, "quoteToken")) as Address | undefined) ?? "0x0000000000000000000000000000000000000000", PINS[0]) &&
  (await Promise.all(PINS[1].map((t) => read(a, provisoSwapAdapterAbi, "oracleOf", [t])))).every((o, i) => o && isAddressEqual(o as Address, PINS[2][i]!));
/** Whether a recorded contract can stay: on chain, and (swap pair) the pinned adapter / bound to the recorded adapter. */
async function current(s: Step): Promise<boolean> {
  const e = rec[s.key] as Entry | undefined;
  if (!(await live(e))) return false;
  if (s.key === "swapAdapter" && !(await pinned(e!.address))) {
    if (!V2) throw new Error(`Recorded adapter ${e!.address} has no oracle pins (v1): rerun with ADAPTER_V2=1.`);
    return false;
  }
  if (s.key === "swapKeyPolicy") {
    const bound = (await read(e!.address, swapKeyPolicyAbi, "adapter")) as Address | undefined;
    return Boolean(bound && rec.swapAdapter && isAddressEqual(bound, (rec.swapAdapter as Entry).address)) && !todo.some((t) => t.key === "swapAdapter");
  }
  return true;
}

const todo: Step[] = [];
for (const s of steps) {
  if (await current(s)) console.log(`${s.name.padEnd(19)} recorded at ${(rec[s.key] as Entry).address}, skipping`);
  else todo.push(s);
}
if (!todo.length) {
  console.log("Nothing to deploy.");
  process.exit(0);
}

// Preflight: a fresh deployer (nonce 0) unless resuming or ADAPTER_V2, and balance >= 2x the estimated cost.
const nonce = await pub.getTransactionCount({ address: account.address });
const resuming = steps.some((s) => rec[s.key]);
if (nonce !== 0 && !resuming && !V2) throw new Error(`Deployer ${account.address} has nonce ${nonce}: use a fresh single-use key.`);
const balance = await pub.getBalance({ address: account.address });
const fees = await pub.estimateFeesPerGas();
const placeholder = account.address; // SwapKeyPolicy's adapter may not exist yet; any address sizes the estimate
let gasTotal = 0n;
for (const s of todo) {
  const args = s.key === "swapKeyPolicy" && !rec.swapAdapter ? [placeholder] : s.args();
  const data = encodeDeployData({ abi: s.abi, bytecode: s.bytecode, args } as Parameters<typeof encodeDeployData>[0]);
  gasTotal += await pub.estimateGas({ account: account.address, data });
}
const estimate = gasTotal * fees.maxFeePerGas;
console.log(`${V2 ? "ADAPTER_V2 · " : ""}deployer ${account.address} (nonce ${nonce}) · balance ${formatEther(balance)} ETH`);
console.log(`relayer  ${relayer} · chain ${chainId} via ${rpc} · commit ${commit}`);
console.log(`pins     quote ${PINS[0]} · ${PINS[1].map((t, i) => `${t} -> ${PINS[2][i]}`).join(" · ")}`);
console.log(`estimate ${todo.length} deploys, ${gasTotal} gas × ${fees.maxFeePerGas} wei = ${formatEther(estimate)} ETH`);
if (balance < 2n * estimate) throw new Error(`Balance below 2× the estimate (${formatEther(2n * estimate)} ETH). Fund the deployer.`);

// V2 keeps the top-level commit (the other three contracts' build); each new entry records its own.
Object.assign(rec, { chainId: CHAIN_ID, deployer: account.address, relayer, maxOracleAge: Number(MAX_ORACLE_AGE) }, V2 ? {} : { commit });
for (const s of todo) {
  const args = s.args();
  const hash = await wallet.deployContract({ abi: s.abi, bytecode: s.bytecode, args } as unknown as Parameters<typeof wallet.deployContract>[0]);
  console.log(`${s.name.padEnd(19)} tx ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${s.name} deploy failed: ${hash}`);
  const block = Number(r.blockNumber);
  const old = rec[s.key] as Entry | undefined;
  if (V2 && old?.address) {
    const { address, tx, block: b } = old;
    (rec.previous ??= []).push({ contract: s.key, address, tx, block: b, retiredAt: new Date().toISOString() });
  }
  const str = (a: unknown): unknown => (Array.isArray(a) ? a.map(str) : String(a));
  rec[s.key] = { address: r.contractAddress, tx: hash, block, gasUsed: r.gasUsed.toString(), args: args.map(str), commit } satisfies Entry;
  rec.startBlock = Math.min(rec.startBlock ?? block, block); // log scans start at the oldest contract
  rec.timestamp = new Date().toISOString();
  save();
  console.log(`${s.name.padEnd(19)} ${r.contractAddress} · block ${block} · gas ${r.gasUsed}`);
}
console.log(`\nRecorded in ${file}. Next: CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts`);
