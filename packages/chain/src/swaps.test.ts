import { describe, expect, test } from "bun:test";
import {
  adapterPolicyFor,
  buildSwapKeyPolicy,
  checkRevokeUserOp,
  checkSwapSetup,
  installPolicyUserOp,
  revokePolicyUserOp,
  KERNEL_V33_IMPLEMENTATION,
  TESTNET_SWAP,
  userOpHash,
  type SwapSetup,
} from "./swaps.ts";

const account = "0x1111111111111111111111111111111111111111" as const;
const C = { swapAdapter: "0x2222222222222222222222222222222222222222", swapKeyPolicy: "0x3333333333333333333333333333333333333333" } as const;
const now = Date.parse("2026-10-20T12:00:00Z");
const expiresAt = BigInt(now / 1000 + 30 * 86_400);
const opts = { account, chainId: 46630, ...C, markets: [TESTNET_SWAP.markets[0]!], caps: TESTNET_SWAP.caps, maxDays: TESTNET_SWAP.policyDays, now } as const;

function good(): SwapSetup {
  const op = installPolicyUserOp({ account, swapKeyPolicy: C.swapKeyPolicy, nonce: 0n });
  const m = TESTNET_SWAP.markets[0]!;
  const cap = (t: string) => TESTNET_SWAP.caps[t]!;
  return {
    chainId: 46630,
    install: { authorization: { address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 0 }, userOp: op, userOpHash: userOpHash(op, 46630) },
    adapterPolicies: [
      adapterPolicyFor(m.key, {
        account, oracle: m.oracle, baseIsCurrency0: m.baseIsCurrency0, multiplier: m.multiplier, maxSlipBps: m.adapterMaxSlipBps,
        maxIn0: cap(m.key.currency0).maxPerTx, maxIn1: cap(m.key.currency1).maxPerTx, expiresAt, nonce: 1n,
      }),
    ],
    policy: buildSwapKeyPolicy({
      account, sessionKey: "0x4444444444444444444444444444444444444444", adapter: C.swapAdapter,
      caps: [m.key.currency0, m.key.currency1].map((token) => ({ token, ...cap(token) })), pools: [m.key], expiresAt, nonce: 1n, now: BigInt(now / 1000),
    }),
  };
}

describe("checkSwapSetup", () => {
  test("accepts the expected setup", () => {
    expect(() => checkSwapSetup(good(), opts)).not.toThrow();
  });

  test.each([
    ["delegation target", (s: SwapSetup) => void (s.install!.authorization!.address = "0x5555555555555555555555555555555555555555")],
    ["account operation", (s: SwapSetup) => void (s.install!.userOp.callData = "0xdeadbeef")],
    ["account operation fee", (s: SwapSetup) => void (s.install!.userOp.maxFeePerGas = 1n)],
    ["account operation hash", (s: SwapSetup) => void (s.install!.userOpHash = `0x${"00".repeat(32)}`)],
    ["adapter policy", (s: SwapSetup) => void (s.adapterPolicies[0]!.oracle = "0x5555555555555555555555555555555555555555")],
    ["swap-key policy", (s: SwapSetup) => void (s.policy = { ...s.policy, adapter: "0x5555555555555555555555555555555555555555" })],
    ["swap-key policy", (s: SwapSetup) => void (s.policy = { ...s.policy, maxPerDay: s.policy.maxPerDay.map((x) => x * 10n) })],
    ["swap-key policy", (s: SwapSetup) => void (s.policy = { ...s.policy, expiresAt: expiresAt + 365n * 86_400n })],
  ])("refuses a tampered %s", (what, tamper) => {
    const s = good();
    tamper(s);
    expect(() => checkSwapSetup(s, opts)).toThrow(`unexpected ${what}`);
  });
});

describe("checkRevokeUserOp", () => {
  test("accepts only the uninstall of SwapKeyPolicy for this account", () => {
    const op = revokePolicyUserOp({ account, swapKeyPolicy: C.swapKeyPolicy, nonce: 3n });
    const o = { account, chainId: 46630, swapKeyPolicy: C.swapKeyPolicy };
    expect(() => checkRevokeUserOp(op, userOpHash(op, 46630), o)).not.toThrow();
    const install = installPolicyUserOp({ account, swapKeyPolicy: C.swapKeyPolicy, nonce: 3n });
    expect(() => checkRevokeUserOp(install, userOpHash(install, 46630), o)).toThrow("unexpected revoke");
    expect(() => checkRevokeUserOp(op, userOpHash({ ...op, nonce: 4n }, 46630), o)).toThrow("unexpected revoke");
  });
});

describe("default caps", () => {
  // Exits are never gated: selling back everything the USDG caps let a policy buy (any price
  // down to $1, every day of the policy) fits one day's sell caps, one holding per tx.
  test("a Stock Token's caps cover every buy the USDG caps allow", () => {
    const usdg = TESTNET_SWAP.caps[TESTNET_SWAP.usdg]!;
    for (const m of TESTNET_SWAP.markets) {
      const i = m.symbols[0] === "USDG" ? 1 : 0;
      const stock = TESTNET_SWAP.caps[i === 0 ? m.key.currency0 : m.key.currency1]!;
      const unit = 10n ** BigInt(m.decimals[i]!);
      expect(stock.maxPerTx).toBeGreaterThanOrEqual((usdg.maxPerTx / 10n ** 6n) * unit);
      expect(stock.maxPerDay).toBeGreaterThanOrEqual((usdg.maxPerDay / 10n ** 6n) * BigInt(TESTNET_SWAP.policyDays) * unit);
    }
  });
});
