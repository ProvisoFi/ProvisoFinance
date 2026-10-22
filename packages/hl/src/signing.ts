// Port of hyperliquid-python-sdk hyperliquid/utils/signing.py.
import { encode } from "@msgpack/msgpack";
import { hexToBytes, keccak256, parseSignature, type Hex, type LocalAccount } from "viem";
import type { Network } from "./config.ts";

export type Tif = "Alo" | "Ioc" | "Gtc";
export type Tpsl = "tp" | "sl";
export type OrderType =
  | { limit: { tif: Tif } }
  | { trigger: { triggerPx: number; isMarket: boolean; tpsl: Tpsl } };
export type OrderTypeWire =
  | { limit: { tif: Tif } }
  | { trigger: { isMarket: boolean; triggerPx: string; tpsl: Tpsl } };

export interface OrderRequest {
  asset: number;
  isBuy: boolean;
  limitPx: number;
  sz: number;
  reduceOnly: boolean;
  orderType: OrderType;
  cloid?: Hex;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: OrderTypeWire;
  c?: Hex;
}

export type Grouping = "na" | "normalTpsl" | "positionTpsl";
/** Builder fee: `b` builder address, `f` fee in tenths of a basis point. */
export interface Builder {
  b: Hex;
  f: number;
}

export interface OrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: Grouping;
  builder?: Builder;
}
export interface CancelAction {
  type: "cancel";
  cancels: { a: number; o: number }[];
}
export interface CancelByCloidAction {
  type: "cancelByCloid";
  cancels: { asset: number; cloid: Hex }[];
}
export interface UpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}
export interface ScheduleCancelAction {
  type: "scheduleCancel";
  time?: number;
}

export interface Signature {
  r: Hex;
  s: Hex;
  v: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const CLOID_RE = /^0x[0-9a-f]{32}$/;

// ---------------------------------------------------------------- wire helpers

/** Python: f"{x:.8f}" then Decimal.normalize(). */
export function floatToWire(x: number): string {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) throw new Error(`floatToWire: unsupported value ${x}`);
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire causes rounding: ${x}`);
  const out = rounded.replace(/\.?0+$/, "");
  // The SDK emits "-0" for negative zero (its "-0" guard never matches); "0" is what it intends.
  return out === "-0" ? "0" : out;
}

/** Python float_to_int: exact integer of x * 10^power, refusing lossy inputs. */
export function floatToInt(x: number, power: number): bigint {
  const w = x * 10 ** power;
  if (!Number.isFinite(w) || Math.abs(x) >= 1e21 || Math.abs(Math.round(w) - w) >= 1e-3) {
    throw new Error(`floatToInt causes rounding: ${x}`);
  }
  return BigInt(x.toFixed(power).replace(".", ""));
}
/** `floatToInt(x, 8)`, the precision used when hashing prices and sizes. */
export const floatToIntForHashing = (x: number): bigint => floatToInt(x, 8);
/** `floatToInt(x, 6)`, USD amounts in micro-units. */
export const floatToUsdInt = (x: number): bigint => floatToInt(x, 6);

/** Wire form of a limit or trigger order type, with keys in the order msgpack hashing needs; throws on anything else. */
export function orderTypeToWire(t: OrderType): OrderTypeWire {
  if ("limit" in t) return { limit: { tif: t.limit.tif } };
  if ("trigger" in t) {
    // Key order matters for msgpack: isMarket, triggerPx, tpsl.
    return { trigger: { isMarket: t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
  }
  throw new Error("Invalid order type");
}

function checkCloid(cloid: string): Hex {
  if (!CLOID_RE.test(cloid)) throw new Error(`Invalid cloid ${cloid} (expected 0x + 32 lowercase hex)`);
  return cloid as Hex;
}

/** Wire form of an order: price and size as canonical strings, cloid validated. */
export function orderToWire(order: OrderRequest): OrderWire {
  const wire: OrderWire = {
    a: order.asset,
    b: order.isBuy,
    p: floatToWire(order.limitPx),
    s: floatToWire(order.sz),
    r: order.reduceOnly,
    t: orderTypeToWire(order.orderType),
  };
  if (order.cloid != null) wire.c = checkCloid(order.cloid);
  return wire;
}

/** Wraps wire orders into an `order` action; a builder address is lowercased. */
export function orderWireToAction(orders: OrderWire[], builder?: Builder, grouping: Grouping = "na"): OrderAction {
  const action: OrderAction = { type: "order", orders, grouping };
  if (builder) action.builder = { b: builder.b.toLowerCase() as Hex, f: builder.f };
  return action;
}

/** A `cancel` action for orders by numeric oid. */
export const cancelAction = (cancels: { asset: number; oid: number }[]): CancelAction => ({
  type: "cancel",
  cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })),
});

/** A `cancelByCloid` action; throws on a malformed cloid. */
export const cancelByCloidAction = (cancels: { asset: number; cloid: Hex }[]): CancelByCloidAction => ({
  type: "cancelByCloid",
  cancels: cancels.map((c) => ({ asset: c.asset, cloid: checkCloid(c.cloid) })),
});

/** An `updateLeverage` action for one asset. */
export const updateLeverageAction = (asset: number, leverage: number, isCross = true): UpdateLeverageAction => ({
  type: "updateLeverage",
  asset,
  isCross,
  leverage,
});

/** `time` omitted unsets a scheduled cancel. */
export function scheduleCancelAction(time?: number): ScheduleCancelAction {
  return time == null ? { type: "scheduleCancel" } : { type: "scheduleCancel", time };
}

// ---------------------------------------------------------------- L1 actions

// Python msgpack picks the smallest int encoding and uses uint64/int64 beyond 32 bits.
// @msgpack/msgpack only does that for bigints when useBigInt64 is on (and then turns
// large plain numbers into floats), so wide ints become bigints and narrow bigints numbers.
function msgpackSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v >= -(2n ** 31n) && v < 2n ** 32n ? Number(v) : v;
  if (typeof v === "number" && Number.isInteger(v) && (v >= 2 ** 32 || v < -(2 ** 31))) {
    if (!Number.isSafeInteger(v)) throw new Error(`Unsafe integer ${v} in action; pass a bigint`);
    return BigInt(v);
  }
  if (Array.isArray(v)) return v.map(msgpackSafe);
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = msgpackSafe(x);
    return out;
  }
  return v;
}

/** keccak(msgpack(action) ‖ nonce u64 BE ‖ 0x00 | 0x01 vault ‖ [0x00 expiresAfter u64 BE]). */
export function actionHash(
  action: unknown,
  vaultAddress: Hex | null | undefined,
  nonce: number | bigint,
  expiresAfter?: number | bigint | null,
): Hex {
  const packed = encode(msgpackSafe(action), { useBigInt64: true });
  const vault = vaultAddress ? hexToBytes(vaultAddress) : null;
  if (vault && vault.length !== 20) throw new Error(`Invalid vault address ${vaultAddress}`);
  const len = packed.length + 8 + (vault ? 21 : 1) + (expiresAfter != null ? 9 : 0);
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  out.set(packed, 0);
  let i = packed.length;
  view.setBigUint64(i, BigInt(nonce));
  i += 8;
  if (vault) {
    out[i++] = 1;
    out.set(vault, i);
    i += 20;
  } else {
    out[i++] = 0;
  }
  if (expiresAfter != null) {
    out[i++] = 0;
    view.setBigUint64(i, BigInt(expiresAfter));
  }
  return keccak256(out);
}

/** The phantom agent L1 actions sign: the network's source tag and the action hash. */
export const constructPhantomAgent = (hash: Hex, net: Network) => ({ source: net.source, connectionId: hash });

/** EIP-712 typed data for an L1 action hash (Exchange domain, chainId 1337). */
export function l1TypedData(hash: Hex, net: Network) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: constructPhantomAgent(hash, net),
  } as const;
}

/** Split a 65-byte hex signature into the {r, s, v} form the API expects. */
export function splitSignature(sig: Hex): Signature {
  const { r, s, v, yParity } = parseSignature(sig);
  return { r, s, v: v !== undefined ? Number(v) : yParity + 27 };
}

/** Hash and sign an L1 action with `account`; `nonce`, `vaultAddress` and `expiresAfter` must match what is posted. */
export async function signL1Action(
  account: LocalAccount,
  action: unknown,
  nonce: number | bigint,
  net: Network,
  vaultAddress?: Hex | null,
  expiresAfter?: number | bigint | null,
): Promise<Signature> {
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter);
  return splitSignature(await account.signTypedData(l1TypedData(hash, net)));
}

// ---------------------------------------------------------------- user-signed actions

export type TypedField = { name: string; type: string };

export const APPROVE_AGENT_TYPES: readonly TypedField[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "agentAddress", type: "address" },
  { name: "agentName", type: "string" },
  { name: "nonce", type: "uint64" },
];

export const APPROVE_BUILDER_FEE_TYPES: readonly TypedField[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "maxFeeRate", type: "string" },
  { name: "builder", type: "address" },
  { name: "nonce", type: "uint64" },
];

export interface UserSignedBase {
  signatureChainId: Hex;
  hyperliquidChain: "Mainnet" | "Testnet";
}
export interface ApproveAgentAction extends UserSignedBase {
  type: "approveAgent";
  agentAddress: Hex;
  /** "" signs an unnamed agent; the field is then dropped from the posted action (SDK behaviour). */
  agentName: string;
  nonce: number;
}
export interface ApproveBuilderFeeAction extends UserSignedBase {
  type: "approveBuilderFee";
  /** Percent string, e.g. "0.05%". */
  maxFeeRate: string;
  builder: Hex;
  nonce: number;
}

/**
 * EIP-712 typed data for a user-signed action, in viem's shape (EIP712Domain is derived
 * from `domain`), so it can go straight to walletClient.signTypedData / wagmi.
 * The message carries only the typed fields.
 */
export function userSignedTypedData(
  primaryType: string,
  fields: readonly TypedField[],
  action: UserSignedBase & Record<string, unknown>,
) {
  const message: Record<string, unknown> = {};
  for (const f of fields) {
    if (action[f.name] === undefined) throw new Error(`User-signed action missing field ${f.name}`);
    message[f.name] = action[f.name];
  }
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(action.signatureChainId, 16),
      verifyingContract: ZERO_ADDRESS,
    },
    types: { [primaryType]: fields.map((f) => ({ ...f })) },
    primaryType,
    message,
  };
}

/** Sign a user-signed action's typed data with `account`; throws if a typed field is missing. */
export async function signUserSignedAction(
  account: LocalAccount,
  primaryType: string,
  fields: readonly TypedField[],
  action: UserSignedBase & Record<string, unknown>,
): Promise<Signature> {
  // viem's generics can't see through a runtime-built type map.
  const typed = userSignedTypedData(primaryType, fields, action) as Parameters<LocalAccount["signTypedData"]>[0];
  return splitSignature(await account.signTypedData(typed));
}

/** An approveAgent action for `net`; an omitted name signs an unnamed agent. */
export function approveAgentAction(
  p: { agentAddress: Hex; agentName?: string; nonce: number },
  net: Network,
): ApproveAgentAction {
  return {
    type: "approveAgent",
    signatureChainId: net.signatureChainId,
    hyperliquidChain: net.hyperliquidChain,
    agentAddress: p.agentAddress,
    agentName: p.agentName ?? "",
    nonce: p.nonce,
  };
}
/** EIP-712 typed data for an approveAgent action, for a browser wallet to sign. */
export const approveAgentTypedData = (a: ApproveAgentAction) =>
  userSignedTypedData("HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, { ...a });
/** Sign an approveAgent action with a local account (the main wallet, not the agent). */
export async function signApproveAgent(account: LocalAccount, action: ApproveAgentAction): Promise<Signature> {
  return signUserSignedAction(account, "HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, { ...action });
}

/** An approveBuilderFee action for `net`; throws unless `maxFeeRate` is a percent string like "0.05%". */
export function approveBuilderFeeAction(
  p: { builder: Hex; maxFeeRate: string; nonce: number },
  net: Network,
): ApproveBuilderFeeAction {
  if (!/^\d+(\.\d+)?%$/.test(p.maxFeeRate)) throw new Error(`maxFeeRate must look like "0.05%", got ${p.maxFeeRate}`);
  return {
    type: "approveBuilderFee",
    signatureChainId: net.signatureChainId,
    hyperliquidChain: net.hyperliquidChain,
    maxFeeRate: p.maxFeeRate,
    builder: p.builder,
    nonce: p.nonce,
  };
}
/** EIP-712 typed data for an approveBuilderFee action, for a browser wallet to sign. */
export const approveBuilderFeeTypedData = (a: ApproveBuilderFeeAction) =>
  userSignedTypedData("HyperliquidTransaction:ApproveBuilderFee", APPROVE_BUILDER_FEE_TYPES, { ...a });
/** Sign an approveBuilderFee action with a local account (the main wallet). */
export async function signApproveBuilderFee(account: LocalAccount, action: ApproveBuilderFeeAction): Promise<Signature> {
  return signUserSignedAction(account, "HyperliquidTransaction:ApproveBuilderFee", APPROVE_BUILDER_FEE_TYPES, {
    ...action,
  });
}
