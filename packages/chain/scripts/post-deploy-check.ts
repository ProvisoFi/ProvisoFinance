// Read-only post-deploy check: every deployed contract runs the local build (contracts/out, run
// `forge build` first) with immutables masked, and its immutables / roles / EIP-712 domain are
// the expected ones. Addresses come from deployment() (TESTNET_DEPLOYMENT + env overrides).
// Exits 1 on any mismatch.
//   bun packages/chain/scripts/post-deploy-check.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, http, isAddressEqual, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { deployment, robinhoodTestnet, TESTNET_POOL_MANAGER, TESTNET_RELAYER, TESTNET_TEST_FEEDS, TESTNET_USDG } from "../src/chains.ts";

const rpc = process.env.RHC_RPC_URL ?? robinhoodTestnet.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(rpc) });
const relayer = (process.env.RELAYER_ADDRESS ?? TESTNET_RELAYER) as Address;
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
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);
const DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

let failed = false;
const report = (name: string, what: string, ok: boolean, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} ${what}${detail ? ` (${detail})` : ""}`);
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

async function checkAddr(name: string, address: Address, fn: "poster" | "usdg" | "poolManager" | "adapter" | "revealer" | "updater", want: Address) {
  try {
    const got = (await pub.readContract({ address, abi, functionName: fn })) as Address;
    report(name, `${fn}()`, isAddressEqual(got, want), isAddressEqual(got, want) ? got : `${got}, expected ${want}`);
  } catch {
    report(name, `${fn}()`, false, "call reverted");
  }
}

async function checkDomain(name: string, address: Address, domainName: string) {
  const [, n, v, chainId, self] = await pub.readContract({ address, abi, functionName: "eip712Domain" });
  const want = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toHex(domainName)), keccak256(toHex("1")), BigInt(robinhoodTestnet.id), address],
    ),
  );
  const sep = (await pub.readContract({ address, abi, functionName: "domainSeparator" })) as Hex;
  const ok = n === domainName && v === "1" && chainId === BigInt(robinhoodTestnet.id) && isAddressEqual(self, address) && sep === want;
  report(name, "EIP-712 domain", ok, `"${n}"/"${v}" chain ${chainId}`);
}

const need = (k: keyof typeof d) => d[k] ?? (report(k, "address", false, "not configured") as never);

console.log(`chain ${await pub.getChainId()} via ${rpc}; expected relayer ${relayer}\n`);
if ((await pub.getChainId()) !== robinhoodTestnet.id) report("rpc", "chain id", false);

const seal = need("thesisSeal");
await checkCode("ThesisSeal", "ThesisSeal", seal);
await checkAddr("ThesisSeal", seal, "revealer", relayer);
await checkDomain("ThesisSeal", seal, "Proviso ThesisSeal");

const roots = need("stampRoots");
await checkCode("StampRoots", "StampRoots", roots);
await checkAddr("StampRoots", roots, "poster", relayer);

const share = need("callerShare");
await checkCode("CallerShare", "CallerShare", share);
await checkAddr("CallerShare", share, "usdg", TESTNET_USDG);
await checkAddr("CallerShare", share, "poster", relayer);

const adapter = need("swapAdapter");
await checkCode("ProvisoSwapAdapter", "ProvisoSwapAdapter", adapter);
await checkAddr("ProvisoSwapAdapter", adapter, "poolManager", TESTNET_POOL_MANAGER);
await checkDomain("ProvisoSwapAdapter", adapter, "Proviso Swap Adapter");

const policy = need("swapKeyPolicy");
await checkCode("SwapKeyPolicy", "SwapKeyPolicy", policy);
await checkAddr("SwapKeyPolicy", policy, "adapter", adapter);
await checkDomain("SwapKeyPolicy", policy, "Proviso Swap Key Policy");

for (const [pair, { feed }] of Object.entries(TESTNET_TEST_FEEDS)) {
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

console.log(failed ? "\nMISMATCH: the deployment differs from this build or config." : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
