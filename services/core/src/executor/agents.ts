import { agentKeys, users, type Db } from "@proviso/db";
import {
  approveAgentAction,
  approveAgentTypedData,
  approveBuilderFeeAction,
  approveBuilderFeeTypedData,
  network,
  type ExtraAgent,
} from "@proviso/hl";
import { and, desc, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { AgentKeyManager, typedApproveAgentFields, type SealedAgentKey } from "../signer/agentKey";
import type { Hex } from "../signer/policy";


/** Builder fees per spec: perps 0.05%, spot 0.30%. Unset env vars are omitted. */
export function builders(env: Record<string, string | undefined> = process.env) {
  return [
    { kind: "perps" as const, builder: env.HL_PERPS_BUILDER, maxFeeRate: "0.05%" },
    { kind: "spot" as const, builder: env.HL_SPOT_BUILDER, maxFeeRate: "0.30%" },
  ].filter((b): b is typeof b & { builder: Hex } => !!b.builder && /^0x[0-9a-fA-F]{40}$/.test(b.builder));
}

type AgentRow = typeof agentKeys.$inferSelect;

// sealed_priv = nonce(24) ‖ ciphertext.
const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
/** Packs a sealed agent key into the `sealed_priv` column layout: nonce(24) ‖ ciphertext. */
export const sealedToBytes = (k: SealedAgentKey) =>
  new Uint8Array(Buffer.from(k.nonce.slice(2) + k.ciphertext.slice(2), "hex"));
/** Reads an `agent_keys` row back into a SealedAgentKey (splits `sealed_priv` into nonce and ciphertext). */
export const rowToSealed = (r: AgentRow): SealedAgentKey => ({
  user: r.address as Hex,
  agent: r.agentAddr as Hex,
  name: r.name,
  version: r.version,
  validUntil: r.validUntil.getTime(),
  nonce: toHex(r.sealedPriv.subarray(0, 24)),
  ciphertext: toHex(r.sealedPriv.subarray(24)),
});

/** The newest approved, non-revoked, unexpired agent key for `address`, or null. */
export async function currentAgentKey(db: Db, address: string, now: Date): Promise<SealedAgentKey | null> {
  const [row] = await db
    .select()
    .from(agentKeys)
    .where(and(eq(agentKeys.address, address.toLowerCase()), isNull(agentKeys.revokedAt),
      isNotNull(agentKeys.approvedAt), gt(agentKeys.validUntil, now)))
    .orderBy(desc(agentKeys.version))
    .limit(1);
  return row ? rowToSealed(row) : null;
}

/**
 * Create the next agent key version (sealed, approved_at null) and everything the browser
 * needs to approve it with the main key and post to Hyperliquid (HL_NETWORK) itself.
 */
export async function handleAgentRequest(
  db: Db,
  manager: AgentKeyManager,
  req: { owner: string; version?: number; now?: number; env?: Record<string, string | undefined> },
) {
  const owner = req.owner.toLowerCase();
  const now = req.now ?? Date.now();
  const [user] = await db.select({ address: users.address }).from(users).where(eq(users.address, owner));
  if (!user) throw new Error(`unknown user ${owner}`);
  const [last] = await db.select({ version: agentKeys.version }).from(agentKeys)
    .where(eq(agentKeys.address, owner)).orderBy(desc(agentKeys.version)).limit(1);
  const version = req.version ?? (last?.version ?? 0) + 1;
  if (last && version <= last.version) throw new Error(`agent version ${version} already used`);

  const k = manager.create(owner, version, now);
  await db.insert(agentKeys).values({
    address: owner, version, agentAddr: k.agent, name: k.name,
    validUntil: new Date(k.validUntil), sealedPriv: sealedToBytes(k),
  });

  const { agentAddress, agentName } = typedApproveAgentFields(k);
  const net = network();
  const approveAgent = approveAgentAction({ agentAddress, agentName, nonce: now }, net);
  const approveBuilderFee = builders(req.env).map((b, i) => {
    const action = approveBuilderFeeAction({ builder: b.builder, maxFeeRate: b.maxFeeRate, nonce: now + 1 + i }, net);
    return { kind: b.kind, builder: b.builder, maxFeeRate: b.maxFeeRate, action, typedData: approveBuilderFeeTypedData(action) };
  });
  return {
    version,
    agentAddress,
    agentName,
    validUntil: k.validUntil,
    nonce: now,
    approveAgent,
    approveAgentTypedData: approveAgentTypedData(approveAgent),
    approveBuilderFee,
  };
}

/**
 * Mark `version` approved once Hyperliquid lists the agent, and revoke older versions so the
 * executor never signs with them again. Returns false (and changes nothing) if it is not listed yet.
 */
export async function confirmAgent(
  db: Db,
  info: { extraAgents(user: Hex): Promise<ExtraAgent[]> },
  owner: string,
  version: number,
  now = new Date(),
): Promise<boolean> {
  const address = owner.toLowerCase();
  const [row] = await db.select().from(agentKeys)
    .where(and(eq(agentKeys.address, address), eq(agentKeys.version, version), isNull(agentKeys.revokedAt)));
  if (!row) throw new Error(`no agent key v${version} for ${address}`);
  const listed = await info.extraAgents(address as Hex);
  if (!listed.some((a) => a.address.toLowerCase() === row.agentAddr.toLowerCase())) return false;
  await db.transaction(async (tx) => {
    await tx.update(agentKeys).set({ approvedAt: now })
      .where(and(eq(agentKeys.address, address), eq(agentKeys.version, version)));
    await tx.update(agentKeys).set({ revokedAt: now })
      .where(and(eq(agentKeys.address, address), lt(agentKeys.version, version), isNull(agentKeys.revokedAt)));
  });
  return true;
}
