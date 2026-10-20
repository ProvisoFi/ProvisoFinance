// Testnet only: nobody arbitrages the Robinhood Chain testnet pools, so their price drifts away from
// the test feed and swap ideas stop firing (pool and feed must agree within 1%). Every minute this
// trades each known pool back to its feed price with the relayer's tokens: an exact-input swap
// capped by a sqrt price limit at the target, so it moves the price exactly there and no further.
import { feedRoundAbi, poolId, robinhoodTestnet, TESTNET_SWAP, type SwapMarket } from "@proviso/chain";
import { encodeAbiParameters, erc20Abi, keccak256, maxUint256, parseAbi, type Abi, type Address } from "viem";
import { send, type Clients } from "./chain";

const routerAbi = parseAbi([
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) testSettings,bytes hookData) payable returns (int256)",
]);
const extsloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const mintAbi = parseAbi(["function mint(address to, uint256 value)"]);
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const TICK_MS = 60_000;
const FEED_MAX_AGE_S = 600n;
/** Re-align once the pool is this far from the feed (the evaluator's agreement band is 1%). */
export const ALIGN_PCT = 0.5;

/** sqrtPriceX96 at which one non-quote token is worth `usd` quote tokens. */
export function targetSqrtPriceX96(m: SwapMarket, usd: number, quote = "USDG"): bigint {
  const oneIn0 = m.symbols[1] === quote ? usd : 1 / usd; // currency1 per currency0, whole tokens
  const raw = oneIn0 * 10 ** (m.decimals[1] - m.decimals[0]);
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
}

export function poolAligner(c: Clients, o: { markets?: readonly SwapMarket[]; bandPct?: number; log?: (m: string, e?: unknown) => void } = {}) {
  const log = o.log ?? console.log;
  const markets = o.markets ?? TESTNET_SWAP.markets;
  const me = c.account.address;
  const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    c.public.readContract({ address, abi, functionName, args } as never) as Promise<any>;

  async function alignOne(m: SwapMarket) {
    const [, answer, , updatedAt] = (await read(m.oracle, feedRoundAbi as Abi, "latestRoundData")) as [bigint, bigint, bigint, bigint, bigint];
    const { timestamp } = await c.public.getBlock();
    if (answer <= 0n || timestamp - updatedAt > FEED_MAX_AGE_S) return; // no fresh reference: leave it
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(m.key), 6n]));
    const sqrt = BigInt(await read(POOL_MANAGER, extsloadAbi, "extsload", [slot])) & ((1n << 160n) - 1n);
    if (sqrt === 0n) return;
    const usd = Number(answer) / 1e8;
    const target = targetSqrtPriceX96(m, usd);
    const ratio = (Number(sqrt) / Number(target)) ** 2;
    if (Math.abs(ratio - 1) * 100 < (o.bandPct ?? ALIGN_PCT)) return;

    // Price of currency0 must fall → sell currency0 (zeroForOne); rise → sell currency1.
    const zeroForOne = sqrt > target;
    const tokenIn = zeroForOne ? m.key.currency0 : m.key.currency1;
    const symIn = zeroForOne ? m.symbols[0] : m.symbols[1];
    let held = (await read(tokenIn, erc20Abi, "balanceOf", [me])) as bigint;
    if (symIn === "USDG" && held < 1_000n * 10n ** 6n) {
      await send(c, { address: tokenIn, abi: mintAbi, functionName: "mint", args: [me, 10_000n * 10n ** 6n] }); // tUSDG is a mock
      held = (await read(tokenIn, erc20Abi, "balanceOf", [me])) as bigint;
    }
    if (held === 0n) return log(`ops: pool align ${m.symbols.join("/")}: relayer holds no ${symIn}, can't move the price`);
    if (((await read(tokenIn, erc20Abi, "allowance", [me, TESTNET_SWAP.swapRouter])) as bigint) < held)
      await send(c, { address: tokenIn, abi: erc20Abi, functionName: "approve", args: [TESTNET_SWAP.swapRouter, maxUint256] });
    const { hash } = await send(c, {
      address: TESTNET_SWAP.swapRouter,
      abi: routerAbi,
      functionName: "swap",
      args: [m.key, { zeroForOne, amountSpecified: -held, sqrtPriceLimitX96: target }, { takeClaims: false, settleUsingBurn: false }, "0x"],
    });
    log(`ops: pool align ${m.symbols.join("/")}: ${((ratio - 1) * 100).toFixed(2)}% off the feed (${usd}), traded back (tx ${hash})`);
  }

  async function tick() {
    for (const m of markets) await alignOne(m).catch((e) => log(`ops: pool align ${m.symbols.join("/")} failed`, e));
  }

  async function run(signal: AbortSignal) {
    if (c.public.chain?.id !== robinhoodTestnet.id) return log("ops: pool aligner is testnet only, off");
    log(`ops: pool aligner on (${markets.length} pools, ${ALIGN_PCT}% band)`);
    while (!signal.aborted) {
      await tick();
      await new Promise<void>((r) => {
        const t = setTimeout(r, TICK_MS);
        signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
  }
  return { tick, run };
}
