// Creates a Stock Token / tUSDG Uniswap v4 pool on Robinhood Chain TESTNET at its test feed's
// price (fee 3000, tick spacing 60) and adds liquidity ±20% from 1 token of the relayer's.
//   bun --env-file=.env.testnet packages/chain/scripts/add-test-pool.ts AMZN   (run `forge build` first)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256, parseAbi, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "../src/chains.ts";
import { feedRoundAbi, poolPriceUsd, TESTNET_SWAP } from "../src/swaps.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const sym = process.argv[2];
const m = TESTNET_SWAP.markets.find((x) => x.symbols.includes(sym ?? ""));
if (!m || sym === "USDG") throw new Error(`usage: add-test-pool.ts <${TESTNET_SWAP.markets.map((x) => x.symbols.find((s) => s !== "USDG")).join("|")}>`);
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const LP = process.env.SWAP_TEST_LP as Address; // PoolModifyLiquidityTest from smoke-swaps-testnet
if (!LP) throw new Error("SWAP_TEST_LP unset");
const art = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../contracts/out/${f}.sol/${f}.json`), "utf8")).abi as Abi;
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL) });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL), account });
async function send(address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return hash;
}

// Price from the feed if fresh, else from Hyperliquid testnet directly.
const [, answer, , updatedAt] = await pub.readContract({ address: m.oracle, abi: feedRoundAbi, functionName: "latestRoundData" });
const { timestamp } = await pub.getBlock();
let usd = Number(answer) / 1e8;
if (answer <= 0n || timestamp - updatedAt > 600n) {
  const mids = await (await fetch("https://api.hyperliquid-testnet.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids", dex: "xyz" }) })).json();
  usd = Number(mids[`xyz:${sym}`]);
}
const tokenIs0 = m.symbols[0] === sym;
const raw = (tokenIs0 ? usd : 1 / usd) * 10 ** (m.decimals[1] - m.decimals[0]); // currency1 per currency0, base units
const sqrt = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
const pmAbi = parseAbi(["function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) returns (int24)"]);
if ((await poolPriceUsd(pub as never, PM, m).catch(() => 0)) === 0 || !Number.isFinite(await poolPriceUsd(pub as never, PM, m))) {
  console.log(`initialize ${sym} at $${usd}:`, await send(PM, pmAbi as Abi, "initialize", [m.key, sqrt]));
}
const tick = (p: number) => Math.floor(Math.log(p) / Math.log(1.0001) / 60) * 60;
const [lo, hi] = [tick(raw / 1.2), tick(raw * 1.2) + 60];
const s = Math.sqrt(raw), sa = Math.sqrt(1.0001 ** lo), sb = Math.sqrt(1.0001 ** hi);
const L = BigInt(Math.floor(tokenIs0 ? (1e18 * s * sb) / (sb - s) : 1e18 / (s - sa)));
const token = tokenIs0 ? m.key.currency0 : m.key.currency1;
await send(TESTNET_SWAP.usdg, parseAbi(["function mint(address to, uint256 value)"]) as Abi, "mint", [account.address, 10n ** 13n]);
for (const t of [token, TESTNET_SWAP.usdg]) await send(t, erc20Abi as Abi, "approve", [LP, maxUint256]);
console.log("liquidity:", await send(LP, art("PoolModifyLiquidityTest"), "modifyLiquidity", [m.key, { tickLower: lo, tickUpper: hi, liquidityDelta: L, salt: `0x${"0".repeat(64)}` }, "0x"]));
console.log({ sym, poolUsd: await poolPriceUsd(pub as never, PM, m), feedOrMark: usd });
