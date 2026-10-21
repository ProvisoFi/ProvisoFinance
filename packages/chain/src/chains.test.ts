import { afterEach, describe, expect, test } from "bun:test";
import { chainConfig, deployment, MAINNET_DEPLOYMENT, network } from "./chains.ts";
import { MAINNET_SWAP, poolId, swapConfig, swapWalletProofMessage, TESTNET_SWAP } from "./swaps.ts";

const prev = process.env.CHAIN_NETWORK;
afterEach(() => {
  if (prev === undefined) delete process.env.CHAIN_NETWORK;
  else process.env.CHAIN_NETWORK = prev;
  delete process.env.THESIS_SEAL_ADDRESS;
});

describe("network selection", () => {
  test("testnet stays the default", () => {
    delete process.env.CHAIN_NETWORK;
    expect(network()).toBe("testnet");
    expect(chainConfig().chain.id).toBe(46630);
    expect(swapConfig()).toBe(TESTNET_SWAP);
    expect(swapWalletProofMessage("0xA", "0xB")).toEndWith("on Robinhood Chain testnet.");
  });

  test("CHAIN_NETWORK=mainnet resolves to Robinhood Chain 4663", () => {
    process.env.CHAIN_NETWORK = "mainnet";
    const c = chainConfig();
    expect(c.chain.id).toBe(4663);
    expect(c.chain.rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(c.chain.blockExplorers?.default.url).toBe("https://robinhoodchain.blockscout.com");
    expect(c.usdg).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(c.relayer).toBe("0xb257791e8c789Bc792EF4794A02Aa9B17BA080f1");
    expect(c.poolManager).toBe("0x8366a39cc670b4001a1121b8f6a443a643e40951");
    expect(swapConfig()).toBe(MAINNET_SWAP);
    expect(swapConfig().oracleMaxAgeS).toBe(90_000);
  });

  test("mainnet pools and oracles are the verified ones", () => {
    const [tsla, amzn] = MAINNET_SWAP.markets;
    expect(poolId(tsla!.key)).toBe("0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e");
    expect(poolId(amzn!.key)).toBe("0xd32646872e6712af8cf778e34b6bbef1d2ae0bddd83764e1b07333518ad59333");
    expect(tsla!.oracle).toBe("0x4A1166a659A55625345e9515b32adECea5547C38");
    expect(amzn!.oracle).toBe("0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C");
    for (const m of MAINNET_SWAP.markets) expect([m.baseIsCurrency0, m.multiplier, m.symbols[1]]).toEqual([true, 10n ** 18n, "USDG"]);
  });

  test("mainnet refuses to run with a contract address missing", () => {
    process.env.CHAIN_NETWORK = "mainnet";
    if (Object.values(MAINNET_DEPLOYMENT).filter(Boolean).length < 5) expect(() => deployment()).toThrow(/Mainnet contracts missing/);
    else expect(deployment()).toEqual(MAINNET_DEPLOYMENT);
  });

  test("an unknown network throws", () => {
    process.env.CHAIN_NETWORK = "mainet";
    expect(() => network()).toThrow();
  });
});
