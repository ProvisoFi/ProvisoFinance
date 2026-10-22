// Read-only post-deploy check: every deployed contract runs the local build (contracts/out, run
// `forge build` first) with immutables masked, and its immutables / roles / EIP-712 domain are
// the expected ones. Network from CHAIN_NETWORK (default testnet); addresses come from deployment()
// (testnet: TESTNET_DEPLOYMENT, mainnet: deployments/mainnet.json; env overrides either).
// Exits 1 on any mismatch.
//   bun --env-file=.env.testnet packages/chain/scripts/post-deploy-check.ts
//   CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, http, isAddressEqual, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { chainConfig, deployment, network, TESTNET_TEST_FEEDS } from "../src/chains.ts";
import { adapterPins, swapConfig } from "../src/swaps.ts";

const net = network();
if (net === "local") throw new Error("Set CHAIN_NETWORK to testnet or mainnet.");
const cfg = chainConfig();
const chain = cfg.chain;
const rpc = process.env.RHC_RPC_URL ?? chain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain, transport: http(rpc) });
const relayer = (process.env.RELAYER_ADDRESS ?? cfg.relayer) as Address;
/** ProvisoSwapAdapter.maxOracleAge per network: pushed test feeds vs Chainlink's 86400 s heartbeat + 1 h. */
const MAX_ORACLE_AGE = net === "mainnet" ? 90_000n : 60n;
const d = deployment();
const out = join(import.meta.dir, "../../../contracts/out");

const abi = parseAbi([
  "function poster() view returns (address)",
  "function usdg() view returns (address)",
  "function poolManager() view returns (address)",
  "function adapter() view returns (address)",
  "function revealer() view returns (address)",
  "function updater() view returns (address)",
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function domainSeparator() view returns (bytes32)",
  "function maxOracleAge() view returns (uint256)",
  "function quoteToken() view returns (address)",
  "function oracleOf(address) view returns (address)",
  "function MAX_ORACLE_AGE() view returns (uint256)",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);
const DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

let failed = false;
let known = 0;
const report = (name: string, what: string, ok: boolean, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} ${what}${detail ? ` (${detail})` : ""}`);
};
/** An expected, documented difference: printed loudly, doesn't fail the run. */
const knownDiff = (name: string, what: string, detail: string) => {
  known++;
  console.log(`KNOWN ${name.padEnd(21)} ${what} (${detail})`);
};

/** Live runtime code equals the local build once every immutable range is zeroed in both. */
async function checkCode(name: string, artifact: string, address: Address) {
  const a = JSON.parse(readFileSync(join(out, `${artifact}.sol`, `${artifact}.json`), "utf8"));
  const local = Buffer.from(a.deployedBytecode.object.slice(2), "hex");
  const live = Buffer.from(((await pub.getCode({ address })) ?? "0x").slice(2), "hex");
  if (live.length !== local.length) return report(name, "bytecode", false, `live ${live.length} B, local ${local.length} B`);
  for (const refs of Object.values(a.deployedBytecode.immutableReferences ?? {}) as { start: number; length: number }[][])
    for (const { start, length } of refs) {
      live.fill(0, start, start + length);
      local.fill(0, start, start + length);
    }
  const at = live.findIndex((b, i) => b !== local[i]);
  report(name, "bytecode (immutables masked)", at === -1, at === -1 ? `${live.length} B` : `first difference at byte ${at}`);
}

async function checkAddr(
  name: string,
  address: Address,
  fn: "poster" | "usdg" | "poolManager" | "adapter" | "revealer" | "updater" | "quoteToken" | "oracleOf",
  want: Address,
  arg?: Address,
) {
  const what = `${fn}(${arg ?? ""})`;
  try {
    const got = (await pub.readContract({ address, abi, functionName: fn, args: arg ? [arg] : [] } as never)) as Address;
    report(name, what, isAddressEqual(got, want), isAddressEqual(got, want) ? got : `${got}, expected ${want}`);
  } catch {
    report(name, what, false, "call reverted");
  }
}

async function checkDomain(name: string, address: Address, domainName: string) {
  const [, n, v, chainId, self] = await pub.readContract({ address, abi, functionName: "eip712Domain" });
  const want = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toHex(domainName)), keccak256(toHex("1")), BigInt(chain.id), address],
    ),
  );
  const sep = (await pub.readContract({ address, abi, functionName: "domainSeparator" })) as Hex;
  const ok = n === domainName && v === "1" && chainId === BigInt(chain.id) && isAddressEqual(self, address) && sep === want;
  report(name, "EIP-712 domain", ok, `"${n}"/"${v}" chain ${chainId}`);
}

const need = (k: keyof typeof d) => d[k] ?? (report(k, "address", false, "not configured") as never);

console.log(`${net}: chain ${await pub.getChainId()} via ${rpc}; expected relayer ${relayer}\n`);
if ((await pub.getChainId()) !== chain.id) report("rpc", "chain id", false);

const seal = need("thesisSeal");
await checkCode("ThesisSeal", "ThesisSeal", seal);
await checkAddr("ThesisSeal", seal, "revealer", relayer);
await checkDomain("ThesisSeal", seal, "Proviso ThesisSeal");

const roots = need("stampRoots");
await checkCode("StampRoots", "StampRoots", roots);
await checkAddr("StampRoots", roots, "poster", relayer);

const share = need("callerShare");
await checkCode("CallerShare", "CallerShare", share);
await checkAddr("CallerShare", share, "usdg", cfg.usdg!);
await checkAddr("CallerShare", share, "poster", relayer);

const adapter = need("swapAdapter");
// The testnet adapter of 2026-10-19 predates maxOracleAge (it has the MAX_ORACLE_AGE = 60 constant
// and no corporate-action guard) and isn't being redeployed: reported as KNOWN, not a failure.
const maxAge = await pub.readContract({ address: adapter, abi, functionName: "maxOracleAge" }).catch(() => undefined);
const legacyAge =
  maxAge === undefined ? await pub.readContract({ address: adapter, abi, functionName: "MAX_ORACLE_AGE" }).catch(() => undefined) : undefined;
if (net === "testnet" && legacyAge === 60n) {
  knownDiff("ProvisoSwapAdapter", "bytecode", "testnet runs the pre-maxOracleAge adapter: MAX_ORACLE_AGE() = 60 constant, no corporate-action guard; redeploy to match this build");
} else {
  await checkCode("ProvisoSwapAdapter", "ProvisoSwapAdapter", adapter);
  report("ProvisoSwapAdapter", "maxOracleAge()", maxAge === MAX_ORACLE_AGE, maxAge === undefined ? "call reverted" : `${maxAge}, expected ${MAX_ORACLE_AGE}`);
  // v2 pins (immutable / constructor-only): the quote token and one feed per stock token, from swapConfig().
  const [quote, tokens, oracles] = adapterPins(swapConfig());
  await checkAddr("ProvisoSwapAdapter", adapter, "quoteToken", quote);
  for (const [i, t] of tokens.entries()) await checkAddr("ProvisoSwapAdapter", adapter, "oracleOf", oracles[i]!, t);
  await checkAddr("ProvisoSwapAdapter", adapter, "oracleOf", "0x0000000000000000000000000000000000000000", quote); // the quote is never priced
}
await checkAddr("ProvisoSwapAdapter", adapter, "poolManager", cfg.poolManager!);
await checkDomain("ProvisoSwapAdapter", adapter, "Proviso Swap Adapter");

const policy = need("swapKeyPolicy");
await checkCode("SwapKeyPolicy", "SwapKeyPolicy", policy);
await checkAddr("SwapKeyPolicy", policy, "adapter", adapter);
await checkDomain("SwapKeyPolicy", policy, "Proviso Swap Key Policy");

// Test feeds exist on testnet only; mainnet prices come from Chainlink.
for (const [pair, { feed }] of net === "testnet" ? Object.entries(TESTNET_TEST_FEEDS) : []) {
  const name = `ProvisoTestFeed ${pair.split("/")[0]}`;
  const address = feed as Address;
  await checkCode(name, "ProvisoTestFeed", address);
  await checkAddr(name, address, "updater", relayer);
  const [desc, dec] = await Promise.all([
    pub.readContract({ address, abi, functionName: "description" }),
    pub.readContract({ address, abi, functionName: "decimals" }),
  ]);
  report(name, "description / decimals", desc === pair && dec === 8, `"${desc}" / ${dec}`);
}

const knownNote = known ? ` ${known} known difference(s) marked KNOWN above.` : "";
console.log(failed ? `\nMISMATCH: the deployment differs from this build or config.${knownNote}` : `\nAll checks passed.${knownNote}`);
process.exit(failed ? 1 : 0);
