import type { Address, Hex } from "viem";

// Must match ThesisSeal: EIP712("Proviso ThesisSeal", "1") and STAMP_TYPEHASH, whose type
// string names the bool `sealed` (the Solidity field is isSealed).
export const STAMP_TYPES = {
  Stamp: [
    { name: "owner", type: "address" },
    { name: "entryHash", type: "bytes32" },
    { name: "exitHash", type: "bytes32" },
    { name: "sealed", type: "bool" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export type Stamp = {
  owner: Address;
  entryHash: Hex;
  exitHash: Hex;
  sealed: boolean;
  expiresAt: bigint;
  nonce: bigint;
  deadline: bigint;
};

/** EIP-712 domain of the ThesisSeal deployed at `verifyingContract` on `chainId`. */
export const stampDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "Proviso ThesisSeal", version: "1", chainId, verifyingContract }) as const;

/** Typed data the owner signs to authorise `ThesisSeal.seal` for this stamp. */
export const stampTypedData = (chainId: number, verifyingContract: Address, message: Stamp) =>
  ({ domain: stampDomain(chainId, verifyingContract), types: STAMP_TYPES, primaryType: "Stamp", message }) as const;

/** The contract's tuple uses isSealed; map the signed message to calldata order. */
export const stampTuple = (s: Stamp) => ({
  owner: s.owner,
  entryHash: s.entryHash,
  exitHash: s.exitHash,
  isSealed: s.sealed,
  expiresAt: s.expiresAt,
  nonce: s.nonce,
  deadline: s.deadline,
});

/** Unordered per-owner nonces: random 64-bit values avoid coordinating a counter across devices. */
export const randomNonce = () => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
};

export const REVEAL_KIND = { FIRED: 0, EXPIRED: 1, RETIRED: 2, MANUAL_NO_TRADE: 3 } as const;
export type RevealKind = keyof typeof REVEAL_KIND;
