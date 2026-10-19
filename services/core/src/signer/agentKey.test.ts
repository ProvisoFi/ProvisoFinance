import { describe, expect, test } from "bun:test";
import { AgentKeyManager, addressOf, agentName, refundedFromEmpty, typedApproveAgentFields } from "./agentKey";

const USER = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const sealKey = new Uint8Array(32).fill(7);
const NOW = 1_760_000_000_000;

describe("AgentKeyManager", () => {
  const m = new AgentKeyManager(sealKey, 86_400_000);

  test("address derivation matches the known vector for private key 1", () => {
    expect(addressOf(`0x${"0".repeat(63)}1`)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  test("creates a sealed key named per user and version with validUntil", () => {
    const k = m.create(USER, 1, NOW);
    expect(k.name).toBe("proviso-abcdef01-v1");
    expect(k.user).toBe(USER.toLowerCase() as never);
    expect(k.validUntil).toBe(NOW + 86_400_000);
    expect(k.agent).toMatch(/^0x[0-9a-f]{40}$/);
    expect(k.nonce).toMatch(/^0x[0-9a-f]{48}$/);
    expect(agentName(USER, 7)).toBe("proviso-abcdef01-v7");
    expect(() => agentName("0x12", 1)).toThrow();
    expect(() => agentName(USER, 0)).toThrow();
  });

  test("seal / unseal round trip recovers the agent's private key", () => {
    const k = m.create(USER, 1, NOW);
    const sk = m.unseal(k);
    expect(sk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(addressOf(sk)).toBe(k.agent);
    expect(k.ciphertext).not.toContain(sk.slice(2));
  });

  test("each key is fresh", () => {
    const a = m.create(USER, 1, NOW);
    const b = m.create(USER, 1, NOW);
    expect(a.agent).not.toBe(b.agent);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("unseal fails under another key or on any tampering", () => {
    const k = m.create(USER, 1, NOW);
    expect(() => new AgentKeyManager(new Uint8Array(32).fill(8)).unseal(k)).toThrow();
    const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}` as `0x${string}`;
    expect(() => m.unseal({ ...k, ciphertext: flip(k.ciphertext) })).toThrow();
    expect(() => m.unseal({ ...k, name: "proviso-abcdef01-v2" })).toThrow();
    expect(() => m.unseal({ ...k, validUntil: k.validUntil + 1 })).toThrow();
    expect(() => m.unseal({ ...k, user: "0x0000000000000000000000000000000000000001" })).toThrow();
    const other = m.create(USER, 1, NOW);
    expect(() => m.unseal({ ...k, agent: other.agent })).toThrow();
  });

  test("rejects a seal key that is not 32 bytes", () => {
    expect(() => new AgentKeyManager(new Uint8Array(31))).toThrow();
    expect(() => new AgentKeyManager("x".repeat(32) as never)).toThrow();
  });

  test("re-fund from empty requires a fresh version", () => {
    const k = m.create(USER, 1, NOW);
    expect(m.rotationReason(k, { prevAccountValue: 0, accountValue: 12.5, now: NOW })).toBe("refunded");
    expect(m.rotationReason(k, { prevAccountValue: 5, accountValue: 0, now: NOW })).toBeNull();
    expect(m.rotationReason(k, { prevAccountValue: 0, accountValue: 0, now: NOW })).toBeNull();
    expect(m.rotationReason(k, { prevAccountValue: 5, accountValue: 9, now: NOW })).toBeNull();
    expect(m.rotationReason(k, { prevAccountValue: null, accountValue: 9, now: NOW })).toBeNull();
    expect(m.rotationReason(k, { accountValue: 9, now: k.validUntil })).toBe("expired");
    expect(refundedFromEmpty(0, 1)).toBe(true);

    const k2 = m.rotate(k, NOW + 1);
    expect(k2.version).toBe(2);
    expect(k2.name).toBe("proviso-abcdef01-v2");
    expect(k2.agent).not.toBe(k.agent);
    expect(addressOf(m.unseal(k2))).toBe(k2.agent);
  });

  test("typed ApproveAgent fields carry the valid_until suffix", () => {
    const k = m.create(USER, 3, NOW);
    expect(typedApproveAgentFields(k)).toEqual({
      agentAddress: k.agent,
      agentName: `proviso-abcdef01-v3 valid_until ${NOW + 86_400_000}`,
    });
  });
});
