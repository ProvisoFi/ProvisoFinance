// Live testnet check of ThesisSeal: a throwaway owner signs a real DSL commitment, the
// relayer seals it (sponsored gas), then both parts are revealed (MANUAL_NO_TRADE).
//   bun --env-file=.env.testnet packages/chain/scripts/smoke-testnet.ts
import { splitCommitments } from "@proviso/dsl";
import { createPublicClient, createWalletClient, http, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { thesisSealAbi } from "../src/abi.ts";
import { robinhoodTestnet } from "../src/chains.ts";
import { randomNonce, REVEAL_KIND, stampTuple, stampTypedData, type Stamp } from "../src/stamp.ts";

if (process.env.CHAIN_NETWORK !== "testnet") throw new Error("testnet only");
const address = process.env.THESIS_SEAL_ADDRESS as Address;
const rpc = process.env.RHC_RPC_URL ?? robinhoodTestnet.rpcUrls.default.http[0];
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const owner = privateKeyToAccount(generatePrivateKey()); // never funded: the relayer pays
const pub = createPublicClient({ chain: robinhoodTestnet, transport: http(rpc) });
const wallet = createWalletClient({ chain: robinhoodTestnet, transport: http(rpc), account: relayer });

const c = splitCommitments({
  v: 1,
  entry: {
    when: { price: { coin: "BTC", op: ">", value: 1_000_000 } },
    then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 1, size: { usd: 10 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -5 }, take: { pct: 10 }, ref: "trigger_mark" },
  limits: { maxUsd: 10, maxLev: 1 },
  mode: "alert",
  expires: "1d",
});
const now = BigInt((await pub.getBlock()).timestamp);
const stamp: Stamp = {
  owner: owner.address,
  entryHash: c.entryHash,
  exitHash: c.exitHash,
  sealed: true,
  expiresAt: now + 86_400n,
  nonce: randomNonce(),
  deadline: now + 600n,
};
const sig = await owner.signTypedData(stampTypedData(robinhoodTestnet.id, address, stamp));

const send = async (label: string, p: Parameters<typeof wallet.writeContract>[0]) => {
  const { request } = await pub.simulateContract({ ...p, account: relayer } as never);
  const hash = await wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`${label} ok · ${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`);
  return r;
};

const sealed = await send("seal", { address, abi: thesisSealAbi, functionName: "seal", args: [stampTuple(stamp), sig] } as never);
const [ev] = parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: sealed.logs });
console.log(`thesis #${ev.args.id} sealed for ${owner.address}`);
await send("revealEntry", {
  address,
  abi: thesisSealAbi,
  functionName: "revealEntry",
  args: [ev.args.id, toHex(c.canonicalEntry), c.saltE, REVEAL_KIND.MANUAL_NO_TRADE],
} as never);
await send("revealExit", { address, abi: thesisSealAbi, functionName: "revealExit", args: [ev.args.id, toHex(c.canonicalExit), c.saltX] } as never);
const t = await pub.readContract({ address, abi: thesisSealAbi, functionName: "theses", args: [ev.args.id] });
console.log("on-chain state:", t);
