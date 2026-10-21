// Rejection paths for the routers without their own tests: no session, bad input, wrong state.
import { expect, test } from "bun:test";
import type { Db } from "@proviso/db";
import { appRouter } from "../index";

const me = "0x" + "ab".repeat(20);
// Every select finds nothing; the rate limiter allows.
const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
  execute: async () => [{ ok: true }],
} as unknown as Db;
const anon = appRouter.createCaller({ db, auth: null });
const user = appRouter.createCaller({ db, auth: { uid: "u1", address: me } });

test("signed-out calls are refused", async () => {
  for (const call of [anon.account.get, anon.follow.mine, anon.notify.status, anon.route.mine, anon.swapKey.status, anon.hl.status])
    await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("account: limits outside the bounds are rejected", async () => {
  await expect(user.account.setLimits({ maxAllocation: 100, maxLeverage: 11, dailyLoss: 10, maxSlippage: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("follow: bad caller address and self-follow are rejected", async () => {
  const base = { sizeRule: { kind: "fixed" as const, usd: 100 }, limits: { maxUsd: 100, maxLev: 2 } };
  await expect(user.follow.create({ ...base, caller: "nope" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(user.follow.create({ ...base, caller: me })).rejects.toThrow("can't follow yourself");
  await expect(user.follow.create({ ...base, caller: "0x" + "cd".repeat(20) })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("notify: push endpoints outside the known services are rejected", async () => {
  await expect(user.notify.subscribePush({ endpoint: "https://evil.example/push", keys: { p256dh: "k", auth: "a" } })).rejects.toThrow("supported Web Push");
});

test("route: out-of-range amounts and testnet are rejected", async () => {
  await expect(user.route.quote({ direction: "fund", amountUsd: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  process.env.CHAIN_NETWORK = "testnet";
  await expect(user.route.quote({ direction: "fund", amountUsd: 20 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

test("swapKey: register/revoke without a prepared setup and malformed signatures are rejected", async () => {
  await expect(user.swapKey.register({ adapter: [], policy: "0x00" })).rejects.toThrow("Start the swap setup again");
  await expect(user.swapKey.revoke({ signature: "0x00" })).rejects.toThrow("Start the revoke again");
  await expect(user.swapKey.revoke({ signature: "not hex" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("hl: approvals for an unknown agent key are rejected", async () => {
  const action = { agentAddress: "0x" + "11".repeat(20) };
  await expect(user.hl.submitApprovals({ version: 1, agent: { action, signature: { r: "0x1", s: "0x2", v: 27 } }, builders: [] })).rejects.toThrow("current agent key");
  await expect(user.hl.submitApprovals({ version: 0, agent: { action, signature: { r: "0x1", s: "0x2", v: 27 } }, builders: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
