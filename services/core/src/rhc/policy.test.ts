import { expect, test } from "bun:test";
import { randomBytes } from "@noble/hashes/utils.js";
import { hashTypedData, recoverTypedDataAddress, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildSwapKeyPolicy,
  poolId,
  SessionKeyManager,
  swapKeyPolicyTypedData,
  type PoolKey,
} from "./policy";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const key: PoolKey = { currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const main = privateKeyToAccount(generatePrivateKey());

const base = {
  account: main.address,
  sessionKey: "0x3333333333333333333333333333333333333333" as Address,
  adapter: "0x4444444444444444444444444444444444444444" as Address,
  caps: [{ token: A, maxPerTx: 10n, maxPerDay: 20n }],
  pools: [key],
  expiresAt: 2_000_000_000n,
  nonce: 1n,
  now: 1_800_000_000n,
};

test("poolId depends on every PoolKey field (the on-chain match is checked in executor.test.ts)", () => {
  expect(poolId(key)).toBe(poolId({ ...key }));
  for (const k of [{ fee: 500 }, { tickSpacing: 10 }, { hooks: A }, { currency1: A }])
    expect(poolId({ ...key, ...k })).not.toBe(poolId(key));
});

test("main key signs the policy; signature recovers to the account", async () => {
  const p = buildSwapKeyPolicy(base);
  const td = swapKeyPolicyTypedData(p, { chainId: 46630, verifyingContract: base.adapter });
  const sig = await main.signTypedData(td);
  expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(main.address);
  // chain id is part of the domain: a testnet signature can't be replayed elsewhere
  expect(hashTypedData(td)).not.toBe(hashTypedData({ ...td, domain: { ...td.domain, chainId: 4663 } }));
});

test("buildSwapKeyPolicy refuses shapes the contract would reject", () => {
  expect(() => buildSwapKeyPolicy({ ...base, sessionKey: main.address })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, caps: [] })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, pools: [] })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, caps: [{ token: zeroAddress, maxPerTx: 1n, maxPerDay: 1n }] })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, caps: [base.caps[0]!, base.caps[0]!] })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, caps: [{ token: A, maxPerTx: 5n, maxPerDay: 4n }] })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, expiresAt: base.now })).toThrow();
  expect(() => buildSwapKeyPolicy({ ...base, nonce: 0n })).toThrow();
});

test("session keys are sealed, bound to their metadata, and unseal only under the right key", () => {
  const sealKey = randomBytes(32);
  const m = new SessionKeyManager(sealKey);
  const k = m.create(main.address, { chainId: 46630, expiresAt: 2_000_000_000 });
  expect(k.account).toBe(main.address.toLowerCase() as typeof k.account);
  expect(privateKeyToAccount(m.unseal(k)).address.toLowerCase()).toBe(k.sessionKey);
  expect(JSON.stringify(k)).not.toContain(m.unseal(k).slice(2));

  expect(() => m.unseal({ ...k, expiresAt: k.expiresAt + 1 })).toThrow();
  expect(() => m.unseal({ ...k, account: B.toLowerCase() as typeof k.account })).toThrow();
  expect(() => m.unseal({ ...k, chainId: 4663 })).toThrow();
  expect(() => new SessionKeyManager(randomBytes(32)).unseal(k)).toThrow();
  expect(() => new SessionKeyManager(randomBytes(31))).toThrow();
  expect(m.create(main.address, { chainId: 46630, expiresAt: 2_000_000_000 }).sessionKey).not.toBe(k.sessionKey);
});
