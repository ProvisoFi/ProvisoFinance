import { afterEach, describe, expect, test } from "bun:test";
import { chainConfig, checkRhcNetwork, deployment, legacySwapKeyPolicies, MAINNET_DEPLOYMENT, network, rhcRpcUrl } from "./chains.ts";
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

  test("retired SwapKeyPolicy deployments are revoked on mainnet only (L-4)", () => {
    delete process.env.CHAIN_NETWORK;
    expect(legacySwapKeyPolicies()).toEqual([]);
    process.env.CHAIN_NETWORK = "mainnet";
    const legacy = legacySwapKeyPolicies();
    expect(legacy).toContain("0x7242dc76248421006cec4651b73489f243914a9d");
    // Only swapKeyPolicy entries: a retired adapter isn't a module to uninstall.
    expect(legacy).not.toContain("0xcb0b0d2f0b4440b96161b39c7808dccaa3733c0d");
    expect(legacy.map((a) => a.toLowerCase())).not.toContain(MAINNET_DEPLOYMENT.swapKeyPolicy?.toLowerCase());
  });

  test("an unknown network throws", () => {
    process.env.CHAIN_NETWORK = "mainet";
    expect(() => network()).toThrow();
  });
});

describe("RHC RPC allow-list", () => {
  test("allow-listed hosts pass; the public RPC is the default", () => {
    expect(rhcRpcUrl({}, "mainnet")).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(rhcRpcUrl({}, "testnet")).toBe("https://rpc.testnet.chain.robinhood.com");
    const alchemy = "https://robinhood-mainnet.g.alchemy.com/v2/abc";
    expect(rhcRpcUrl({ RHC_RPC_URL: alchemy }, "mainnet")).toBe(alchemy);
    expect(rhcRpcUrl({ RHC_RPC_URL: "http://127.0.0.1:8545" }, "local")).toBe("http://127.0.0.1:8545");
  });

  test("RHC_RPC_KEY is appended to the Alchemy mainnet URL", () => {
    expect(rhcRpcUrl({ RHC_RPC_KEY: "k3y_-A", RHC_RPC_URL: "https://evil.example" }, "mainnet")).toBe("https://robinhood-mainnet.g.alchemy.com/v2/k3y_-A");
    expect(() => rhcRpcUrl({ RHC_RPC_KEY: "x@evil.example/" }, "mainnet")).toThrow("RHC_RPC_KEY");
    expect(() => rhcRpcUrl({ RHC_RPC_KEY: "abc" }, "testnet")).toThrow("RHC_RPC_KEY");
  });

  test("a foreign host, another network's host or plain http throws", () => {
    expect(() => rhcRpcUrl({ RHC_RPC_URL: "https://rpc.evil.example" }, "mainnet")).toThrow("not allowed");
    expect(() => rhcRpcUrl({ RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com.evil.example" }, "mainnet")).toThrow("not allowed");
    expect(() => rhcRpcUrl({ RHC_RPC_URL: "https://rpc.testnet.chain.robinhood.com" }, "mainnet")).toThrow("not allowed");
    expect(() => rhcRpcUrl({ RHC_RPC_URL: "http://rpc.mainnet.chain.robinhood.com" }, "mainnet")).toThrow("not allowed");
  });
});

describe("startup network check", () => {
  const rpc = (id: number) => ({ getChainId: async () => id });
  test("passes when the chain id and both networks match", async () => {
    await checkRhcNetwork(rpc(4663), "mainnet", "mainnet");
    await checkRhcNetwork(rpc(46630), "testnet", "testnet");
  });
  test("a chain id mismatch throws", async () => {
    await expect(checkRhcNetwork(rpc(46630), "mainnet", "mainnet")).rejects.toThrow("expected 4663");
  });
  test("HL_NETWORK and CHAIN_NETWORK disagreeing throws", async () => {
    await expect(checkRhcNetwork(rpc(4663), "testnet", "mainnet")).rejects.toThrow("doesn't match");
    await expect(checkRhcNetwork(rpc(46630), "mainnet", "testnet")).rejects.toThrow("doesn't match");
  });
});
