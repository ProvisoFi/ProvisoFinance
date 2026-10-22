// Setup payloads end to end without a chain: buildSwapSetup over a stubbed reader must produce what
// checkSwapSetup accepts, survive its jsonb round trip, sign/recover as EIP-712, and swapSetupProgress
// must only call a setup complete when every step is live. Pool reads decode slot0 / liquidity words.
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildSwapKeyPolicy,
  buildSwapSetup,
  checkSwapSetup,
  kernelDelegationCode,
  KERNEL_V33_IMPLEMENTATION,
  MAINNET_SWAP,
  poolDepthUsd,
  poolId,
  poolPriceUsd,
  SESSION_GAS,
  swapKeyPolicyHash,
  swapSetupFromJson,
  swapSetupProgress,
  swapSetupTypedData,
  TESTNET_SWAP,
  toJsonSafe,
  userOpHash,
  type SwapSetup,
} from "./swaps.ts";

const account = "0x1111111111111111111111111111111111111111" as Address;
const sessionKey = "0x4444444444444444444444444444444444444444" as Address;
const C = { swapAdapter: "0x2222222222222222222222222222222222222222", swapKeyPolicy: "0x3333333333333333333333333333333333333333" } as const;
const chainId = 46630;
const now = Date.parse("2026-10-20T12:00:00Z");
const expiresAt = BigInt(now / 1000 + 30 * 86_400);
const markets = TESTNET_SWAP.markets;
const caps = TESTNET_SWAP.caps;

type Call = { address: Address; functionName: string; args?: readonly unknown[] };
/** On-chain state the stub answers with. `code` undefined + module reverting = a plain EOA. */
function reader(s: { code?: Hex; moduleOn?: boolean | "revert"; epNonce?: bigint; txCount?: number; adapterNonce?: bigint; policyNonce?: bigint }) {
  const calls: Call[] = [];
  return {
    calls,
    getCode: async () => s.code,
    getTransactionCount: async () => s.txCount ?? 0,
    readContract: async (c: Call) => {
      calls.push(c);
      switch (c.functionName) {
        case "isModuleInstalled":
          if (s.moduleOn === "revert" || s.moduleOn === undefined) throw new Error("execution reverted");
          return s.moduleOn;
        case "getNonce":
          return s.epNonce ?? 0n;
        case "lastPolicyNonce":
          return s.adapterNonce ?? 0n;
        case "lastNonce":
          return s.policyNonce ?? 0n;
      }
      throw new Error(`unexpected read ${c.functionName}`);
    },
  };
}
const build = (r: ReturnType<typeof reader>, over: Partial<Parameters<typeof buildSwapSetup>[1]> = {}) =>
  buildSwapSetup(r, { chainId, account, sessionKey, expiresAt, ...C, markets, caps, ...over });
const checkOpts = { account, chainId, ...C, markets, caps, maxDays: TESTNET_SWAP.policyDays, now };

describe("buildSwapSetup", () => {
  test("a plain EOA gets the 7702 authorization at its tx nonce plus the install UserOp", async () => {
    const r = reader({ txCount: 3, epNonce: 7n, adapterNonce: 4n, policyNonce: 9n });
    const s = await build(r);
    expect(s.install?.authorization).toEqual({ address: KERNEL_V33_IMPLEMENTATION, chainId, nonce: 3 });
    expect(s.install?.userOp.nonce).toBe(7n);
    expect(s.install?.userOpHash).toBe(userOpHash(s.install!.userOp, chainId));
    // One adapter policy per market, nonces continuing from the contract's last one.
    expect(s.adapterPolicies.map((p) => p.nonce)).toEqual([5n, 6n]);
    expect(s.policy.nonce).toBe(10n);
    expect(s.policy.poolIds).toEqual(markets.map((m) => poolId(m.key)));
    // tUSDG is shared by both pools: listed once, with its caps.
    expect(s.policy.tokens.length).toBe(3);
    expect(() => checkSwapSetup(s, checkOpts)).not.toThrow();
    // The nonce reads went to the right contracts.
    expect(r.calls.find((c) => c.functionName === "lastPolicyNonce")?.address).toBe(C.swapAdapter);
    expect(r.calls.find((c) => c.functionName === "lastNonce")?.address).toBe(C.swapKeyPolicy);
  });

  test("an account already delegated to Kernel only needs the UserOp", async () => {
    const s = await build(reader({ code: kernelDelegationCode.toUpperCase().replace("0X", "0x") as Hex, moduleOn: false }));
    expect(s.install).not.toBeNull();
    expect(s.install!.authorization).toBeNull();
    expect(() => checkSwapSetup(s, checkOpts)).not.toThrow();
  });

  test("delegated with SwapKeyPolicy installed: no install step at all", async () => {
    const s = await build(reader({ code: kernelDelegationCode, moduleOn: true }));
    expect(s.install).toBeNull();
    expect(() => checkSwapSetup(s, checkOpts)).not.toThrow();
  });

  test("a module reported installed on an undelegated account still installs", async () => {
    const s = await build(reader({ code: "0x6080", moduleOn: true }));
    expect(s.install?.authorization).not.toBeNull();
  });

  test("refuses a token without caps and an expired policy", async () => {
    await expect(build(reader({}), { caps: { [TESTNET_SWAP.usdg]: caps[TESTNET_SWAP.usdg]! } })).rejects.toThrow("no cap for token");
    await expect(build(reader({}), { expiresAt: 1n })).rejects.toThrow("expiry must be in the future");
  });

  test("a setup built for one chain is refused on another", async () => {
    const s = await build(reader({}));
    expect(() => checkSwapSetup(s, { ...checkOpts, chainId: 4663 })).toThrow("unexpected chain");
  });

  test("a policy for fewer markets than expected is refused", async () => {
    const s = await build(reader({}), { markets: [markets[0]!] });
    expect(() => checkSwapSetup(s, checkOpts)).toThrow("adapter policy count");
  });

  test("a session key equal to the account never gets built", async () => {
    await expect(build(reader({}), { sessionKey: account })).rejects.toThrow("session key must differ");
  });
});

describe("buildSwapKeyPolicy refusals", () => {
  const m = markets[0]!;
  const base = {
    account, sessionKey, adapter: C.swapAdapter as Address, pools: [m.key], expiresAt, nonce: 1n, now: BigInt(now / 1000),
    caps: [{ token: m.key.currency0, maxPerTx: 1n, maxPerDay: 2n }],
  };
  test.each([
    ["zero session key", { sessionKey: "0x0000000000000000000000000000000000000000" as Address }, "session key must differ"],
    ["no pools", { pools: [] }, "at least one token and one pool"],
    ["no caps", { caps: [] }, "at least one token and one pool"],
    ["native token", { caps: [{ token: "0x0000000000000000000000000000000000000000" as Address, maxPerTx: 1n, maxPerDay: 1n }] }, "native input"],
    ["duplicate token", { caps: [base.caps[0]!, { ...base.caps[0]!, token: m.key.currency0.toLowerCase() as Address }] }, "duplicate token"],
    ["zero per-tx cap", { caps: [{ ...base.caps[0]!, maxPerTx: 0n }] }, "0 < maxPerTx <= maxPerDay"],
    ["day cap under tx cap", { caps: [{ ...base.caps[0]!, maxPerTx: 3n }] }, "0 < maxPerTx <= maxPerDay"],
    ["zero nonce", { nonce: 0n }, "nonce must fit uint64"],
    ["nonce over uint64", { nonce: 2n ** 64n }, "nonce must fit uint64"],
  ])("%s", (_, over, msg) => {
    expect(() => buildSwapKeyPolicy({ ...base, ...over })).toThrow(msg);
  });
});

describe("swap setup JSON round trip (swap_keys.setup / tRPC)", () => {
  test.each([
    ["plain EOA", {}],
    ["delegated", { code: kernelDelegationCode, moduleOn: false }],
    ["installed", { code: kernelDelegationCode, moduleOn: true }],
  ] as const)("%s setup comes back identical", async (_, state) => {
    const s = await build(reader({ txCount: 2, epNonce: 1n, ...state }));
    const json = toJsonSafe(s);
    expect((json as { policy: { nonce: unknown } }).policy.nonce).toBeTypeOf("string"); // jsonb-safe
    const back = swapSetupFromJson(JSON.parse(JSON.stringify(json)));
    expect(back).toEqual(s);
    expect(() => checkSwapSetup(back, checkOpts)).not.toThrow();
  });

  test("a stored UserOp without a signature reads back as 0x", async () => {
    const s = await build(reader({}));
    const json = toJsonSafe(s) as { install: { userOp: Record<string, unknown> } };
    delete json.install.userOp.signature;
    expect(swapSetupFromJson(json).install!.userOp.signature).toBe("0x");
  });
});

describe("swapSetupTypedData", () => {
  test("the main key's signatures recover to it, over the adapter and policy domains", async () => {
    const pk = generatePrivateKey();
    const signer = privateKeyToAccount(pk);
    const s = await build(reader({}), { account: signer.address });
    const td = swapSetupTypedData(s, C);
    expect(td.adapter.length).toBe(markets.length);
    expect(td.adapter[0]!.domain).toEqual({ name: "Proviso Swap Adapter", version: "1", chainId, verifyingContract: C.swapAdapter });
    expect(td.policy.domain).toEqual({ name: "Proviso Swap Key Policy", version: "1", chainId, verifyingContract: C.swapKeyPolicy });
    for (const t of [...td.adapter, td.policy]) {
      const signature = await signer.signTypedData(t as never);
      expect(await recoverTypedDataAddress({ ...(t as object), signature } as never)).toBe(signer.address);
    }
  });

  test("the policy hash changes with any signed field", async () => {
    const s = await build(reader({}));
    const h = swapKeyPolicyHash(s.policy);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(swapKeyPolicyHash({ ...s.policy })).toBe(h);
    expect(swapKeyPolicyHash({ ...s.policy, expiresAt: s.policy.expiresAt + 1n })).not.toBe(h);
    expect(swapKeyPolicyHash({ ...s.policy, maxPerTx: s.policy.maxPerTx.map((x) => x + 1n) })).not.toBe(h);
    expect(swapKeyPolicyHash({ ...s.policy, sessionKey: account })).not.toBe(h);
  });
});

describe("swapSetupProgress", () => {
  async function progress(o: { code?: Hex; moduleOn?: boolean | "revert"; nonces?: bigint[]; active?: Hex; wei?: bigint }, s: SwapSetup) {
    return swapSetupProgress(
      {
        getCode: async () => o.code,
        getTransactionCount: async () => 0,
        getBalance: async ({ address }) => (address === s.policy.sessionKey ? (o.wei ?? 0n) : 10n ** 18n),
        readContract: async (c: Call) => {
          if (c.functionName === "isModuleInstalled") {
            if (o.moduleOn === "revert" || o.moduleOn === undefined) throw new Error("reverted");
            return o.moduleOn;
          }
          if (c.functionName === "policyOf") {
            const i = s.adapterPolicies.findIndex((p) => poolId(p) === (c.args?.[1] as Hex));
            return { nonce: o.nonces?.[i] ?? 0n };
          }
          if (c.functionName === "activePolicy") return o.active ?? `0x${"00".repeat(32)}`;
          throw new Error(c.functionName);
        },
      },
      s,
      { account, ...C },
    );
  }

  test("complete only once delegated, installed, every adapter policy at its nonce, policy active and key funded", async () => {
    const s = await build(reader({ adapterNonce: 4n }));
    const all = { code: kernelDelegationCode, moduleOn: true, nonces: [5n, 6n], active: swapKeyPolicyHash(s.policy).toUpperCase().replace("0X", "0x") as Hex, wei: SESSION_GAS / 3n };
    expect(await progress(all, s)).toEqual({ installed: true, adapterSet: [true, true], policyActive: true, gasFunded: true, complete: true });

    expect(await progress({}, s)).toEqual({ installed: false, adapterSet: [false, false], policyActive: false, gasFunded: false, complete: false });
    expect((await progress({ ...all, moduleOn: false }, s)).complete).toBe(false);
    expect((await progress({ ...all, code: "0x6080" }, s)).installed).toBe(false);
    // An older policy still at the adapter (stale nonce) isn't this setup.
    const stale = await progress({ ...all, nonces: [5n, 4n] }, s);
    expect(stale.adapterSet).toEqual([true, false]);
    expect(stale.complete).toBe(false);
    expect((await progress({ ...all, active: swapKeyPolicyHash({ ...s.policy, nonce: s.policy.nonce + 1n }) }, s)).policyActive).toBe(false);
    const dry = await progress({ ...all, wei: SESSION_GAS / 3n - 1n }, s);
    expect(dry.gasFunded).toBe(false);
    expect(dry.complete).toBe(false);
  });
});

describe("pool reads", () => {
  const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
  const slot0Of = (m: (typeof markets)[number]) => BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(m.key), 6n])));
  const hex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
  // slot0 packs sqrtPriceX96 (low 160 bits) under tick / fees; liquidity is the low 128 bits of +3.
  const junk = 0xabcdefn;
  function pool(m: (typeof markets)[number], sqrtX96: bigint, L: bigint) {
    const base = slot0Of(m);
    const seen: Hex[] = [];
    return {
      seen,
      readContract: async (c: Call) => {
        expect(c.address).toBe(PM);
        expect(c.functionName).toBe("extsload");
        const slot = c.args?.[0] as Hex;
        seen.push(slot);
        if (BigInt(slot) === base) return hex((junk << 160n) | sqrtX96);
        if (BigInt(slot) === base + 3n) return hex((junk << 128n) | L);
        return hex(0n);
      },
    };
  }

  test("testnet USDG/TSLA (stock is currency1): $400 TSLA reads back as 400", async () => {
    const m = markets[0]!; // 6 / 18 decimals, quote is currency0
    // 1 USDG = 1/400 TSLA => raw ratio 1e12/400, sqrt = 1e6/20.
    const r = pool(m, 50_000n << 96n, 0n);
    expect(await poolPriceUsd(r, PM, m)).toBeCloseTo(400, 6);
    expect(r.seen).toEqual([hex(slot0Of(m))]);
  });

  test("mainnet TSLA/USDG (stock is currency0): $400 reads back as 400", async () => {
    const m = MAINNET_SWAP.markets[0]!; // 18 / 6 decimals, quote is currency1
    const sqrt = BigInt(Math.round(Math.sqrt(400e-12) * 2 ** 96));
    expect(await poolPriceUsd(pool(m, sqrt, 0n), PM, m)).toBeCloseTo(400, 6);
  });

  test("depth is zero for an empty or uninitialised pool and scales with liquidity", async () => {
    const m = MAINNET_SWAP.markets[0]!;
    const sqrt = BigInt(Math.round(Math.sqrt(400e-12) * 2 ** 96));
    expect(await poolDepthUsd(pool(m, sqrt, 0n), PM, m)).toBe(0);
    expect(await poolDepthUsd(pool(m, 0n, 10n ** 18n), PM, m)).toBe(0);
    const r = pool(m, sqrt, 10n ** 15n);
    const d = await poolDepthUsd(r, PM, m);
    expect(r.seen.map(BigInt)).toEqual([slot0Of(m), slot0Of(m) + 3n]);
    // Quote is currency1: Δy ≈ L·√P·0.02 over ±2%, in USDG units.
    expect(d / ((1e15 * Math.sqrt(400e-12) * 0.02) / 1e6)).toBeCloseTo(1, 3);
    expect(await poolDepthUsd(pool(m, sqrt, 2n * 10n ** 15n), PM, m)).toBeCloseTo(2 * d, 6);
  });

  test("depth with the quote as currency0 counts the USDG side too", async () => {
    const m = markets[0]!;
    const r = pool(m, 50_000n << 96n, 10n ** 15n);
    const d = await poolDepthUsd(r, PM, m);
    // Δx ≈ (L/√P)·0.02 over ±2%, in USDG units (6 decimals).
    expect(d / (((1e15 / 50_000) * 0.02) / 1e6)).toBeCloseTo(1, 3);
    expect(d).toBeGreaterThan(0);
  });
});
