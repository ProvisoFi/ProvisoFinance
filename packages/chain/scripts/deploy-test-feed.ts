// Deploys one ProvisoTestFeed (TESTNET ONLY push feed, updater = relayer) per argument on
// Robinhood Chain TESTNET, then prints a TEST_FEEDS value for services/ops. Run `forge build` first.
//   bun --env-file=.env.testnet packages/chain/scripts/deploy-test-feed.ts "TSLA/USDG" "AMZN/USDG=xyz:AMZN"
// Each argument is the feed description, optionally with its price source after "=":
//   (none) / =COIN          Hyperliquid testnet mark of COIN (default: the part before "/")
//   =pool:POOL_ID:BASE:QUOTE Uniswap v4 pool spot price of BASE in QUOTE
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "../src/chains.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const args = process.argv.slice(2);
if (!args.length) throw new Error('usage: deploy-test-feed.ts "TSLA/USDG" ["AMZN/USDG=xyz:AMZN" ...]');
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL) });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(process.env.RHC_RPC_URL), account });
if ((await pub.getChainId()) !== robinhoodTestnet.id) throw new Error("RPC is not Robinhood Chain testnet");

const artifact = join(import.meta.dir, "../../../contracts/out/ProvisoTestFeed.sol/ProvisoTestFeed.json");
const { abi, bytecode } = JSON.parse(readFileSync(artifact, "utf8"));

function source(description: string, spec?: string) {
  if (spec?.startsWith("pool:")) {
    const [, poolId, base, quote] = spec.split(":");
    if (!poolId || !base || !quote) throw new Error(`bad pool source ${spec}, want pool:POOL_ID:BASE:QUOTE`);
    return { type: "pool", poolId, base, quote };
  }
  return { type: "hl", coin: spec || description.split("/")[0] };
}

const feeds = [];
for (const arg of args) {
  const [description, spec] = arg.split(/=(.*)/s) as [string, string | undefined];
  const src = source(description, spec); // validate before spending gas
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object as Hex, args: [account.address, description] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
  console.log(`ProvisoTestFeed ${description} ${r.contractAddress} (tx ${hash}) · updater ${account.address}`);
  feeds.push({ feed: r.contractAddress, source: src });
}
console.log(`\nTEST_FEEDS='${JSON.stringify(feeds)}'`);
