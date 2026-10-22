import type { Hex } from "viem";

/**
 * 16-byte client order id, "0x" + 32 lowercase hex:
 *   thesisId u64 ‖ fireSeq u32 ‖ leg u8 ‖ nonce u24   (big-endian)
 * leg and nonce share the last u32: leg in the high byte, nonce in the low 24 bits.
 */
export interface CloidParts {
  thesisId: bigint;
  fireSeq: number;
  leg: number;
  nonce: number;
}

const CLOID_RE = /^0x[0-9a-fA-F]{32}$/;

function checkUint(name: string, v: number, bits: number) {
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) throw new Error(`${name} must be a u${bits}, got ${v}`);
}

/** Packs thesis id, fire sequence, leg and nonce into a cloid; throws if any part is out of its unsigned range. */
export function encodeCloid(p: { thesisId: bigint | number; fireSeq: number; leg: number; nonce: number }): Hex {
  const thesisId = BigInt(p.thesisId);
  if (thesisId < 0n || thesisId >= 2n ** 64n) throw new Error(`thesisId must be a u64, got ${thesisId}`);
  checkUint("fireSeq", p.fireSeq, 32);
  checkUint("leg", p.leg, 8);
  checkUint("nonce", p.nonce, 24);
  const tail = p.leg * 2 ** 24 + p.nonce;
  return `0x${thesisId.toString(16).padStart(16, "0")}${p.fireSeq.toString(16).padStart(8, "0")}${tail
    .toString(16)
    .padStart(8, "0")}`;
}

/** Splits a cloid back into its parts; throws unless it is "0x" + 32 hex chars. */
export function decodeCloid(cloid: string): CloidParts {
  if (!CLOID_RE.test(cloid)) throw new Error(`Invalid cloid ${cloid}`);
  const hex = cloid.slice(2);
  const tail = Number.parseInt(hex.slice(24, 32), 16);
  return {
    thesisId: BigInt(`0x${hex.slice(0, 16)}`),
    fireSeq: Number.parseInt(hex.slice(16, 24), 16),
    leg: Math.floor(tail / 2 ** 24),
    nonce: tail % 2 ** 24,
  };
}

/** The thesis id carried in a cloid; throws on a malformed cloid. */
export const thesisIdOfCloid = (cloid: string): bigint => decodeCloid(cloid).thesisId;
