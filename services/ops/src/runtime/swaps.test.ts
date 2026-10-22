// Revoke relay giving up: the user gets its own activity row (PGlite, a chain that always fails).
import { expect, test } from "bun:test";
import { revokePolicyUserOp, toJsonSafe } from "@proviso/chain";
import { activity, swapKeys, users } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import type { Clients } from "./chain";
import { swapSetupHandler } from "./swaps";

const OWNER = "0x00000000000000000000000000000000000000a1";
const ACCOUNT = "0x00000000000000000000000000000000000000a2";
const KEY = "0x00000000000000000000000000000000000000a3";

test("a revoke relay that keeps failing is retried, then recorded as swaps_revoke_failed", async () => {
  const db = await createTestDb();
  await db.insert(users).values({ address: OWNER });
  await db.insert(swapKeys).values({
    address: OWNER,
    account: ACCOUNT,
    keyAddr: KEY,
    sealed: {},
    setup: { revoke: { ops: [{ userOp: toJsonSafe(revokePolicyUserOp({ account: ACCOUNT, swapKeyPolicy: ACCOUNT, nonce: 0n })), module: ACCOUNT }], signatures: ["0x01"] } },
    expiresAt: new Date(Date.now() + 86_400_000),
    registeredAt: new Date(),
    revokedAt: new Date(),
  });
  const down = async () => Promise.reject(new Error("rpc down at https://rpc.example/key"));
  const c = { public: { getCode: down, readContract: down } } as unknown as Clients;
  const logs: string[] = [];
  const handle = swapSetupHandler(db, c, { swapAdapter: ACCOUNT, swapKeyPolicy: ACCOUNT }, (m) => logs.push(m));
  const meta = (readCt: number) => ({ msgId: 1n, readCt, enqueuedAt: new Date(), vt: new Date(), message: { address: OWNER, revoke: true } });

  await expect(handle({ address: OWNER, revoke: true }, meta(1))).rejects.toThrow("rpc down");
  expect(await db.select().from(activity)).toHaveLength(0);
  await handle({ address: OWNER, revoke: true }, meta(3));
  expect(await db.select({ kind: activity.kind, payload: activity.payload }).from(activity)).toEqual([
    { kind: "swaps_revoke_failed", payload: { reason: "relay_error", sessionKey: KEY } },
  ]);
  expect(logs.join()).not.toContain("rpc.example"); // RPC URLs can carry keys
});
