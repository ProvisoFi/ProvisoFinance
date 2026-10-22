// The swap_setup relay end to end against a stateful fake Robinhood Chain (PGlite): a setup built
// and signed the way swapKey.prepare / the browser do it is relayed step by step until
// swapSetupProgress reports it complete; partial runs resume without re-sending done steps; and
// install signatures are re-checked at relay time, before the relayer pays for anything.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  buildSwapSetup,
  checkRevokeOps,
  checkSwapSetup,
  ENTRY_POINT_V07,
  KERNEL_V33_IMPLEMENTATION,
  kernelAbi,
  kernelDelegationCode,
  poolId,
  revokePolicyUserOp,
  robinhoodTestnet,
  SESSION_GAS,
  swapKeyPolicyAbi,
  swapKeyPolicyHash,
  swapSetupFromJson,
  swapSetupProgress,
  swapSetupTypedData,
  TESTNET_SWAP,
  toJsonSafe,
  userOpHash,
  type AdapterPolicy,
  type SwapKeyPolicy,
} from "@proviso/chain";
import { activity, swapKeys, users } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq, like } from "drizzle-orm";
import { ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult, getAddress, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rateLimits, relayerBudget } from "./budget";
import type { Clients } from "./chain";
import { swapSetupHandler } from "./swaps";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const OWNER = addr(0xa1); // the Proviso account; the swap wallet is its own EOA below
const RELAYER = addr(0xf1);
const ADAPTER = addr(0xd1);
const POLICY = addr(0xd2);
const SESSION = getAddress(addr(0xd3)); // checksummed, as buildSwapKeyPolicy stores it
const TUSDG = TESTNET_SWAP.usdg;
type Tx = { to: Address; fn: string; args?: readonly unknown[]; authorizationList?: unknown[]; value?: bigint };
type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** A testnet chain that applies what the relayer sends: 7702 delegation, module installs, policies, gas, mints. */
function fakeChain(account: Address, o: { delegated?: boolean; installs?: boolean; handleOpsStatus?: string; failOn?: string; revertOn?: string } = {}) {
  const s = {
    code: (o.delegated ? kernelDelegationCode : "0x") as Hex,
    modules: new Set<string>(),
    adapter: new Map<Hex, bigint>(), // poolId -> policy nonce
    active: zeroHash as Hex,
    wei: new Map<string, bigint>([[RELAYER.toLowerCase(), 10n ** 18n]]),
    usdg: 0n,
    txs: [] as Tx[],
  };
  const receipt = (status = "success") => ({ status, gasUsed: 100_000n, effectiveGasPrice: 10n ** 9n, blockHash: "0xb1" });
  const fail = (fn: string) => {
    if (o.failOn === fn) throw new Error(`${fn}: connection reset by https://rpc.example/secret`);
    if (o.revertOn === fn) throw new ContractFunctionRevertedError({ abi: swapKeyPolicyAbi as never, functionName: fn, data: encodeErrorResult({ abi: swapKeyPolicyAbi, errorName: "BadSignature" }) });
  };
  const c = {
    account: { address: RELAYER },
    public: {
      chain: robinhoodTestnet,
      getCode: async ({ address }: { address: Address }) => (address.toLowerCase() === account.toLowerCase() ? s.code : "0x"),
      getTransactionCount: async () => 7,
      getBalance: async ({ address }: { address: Address }) => s.wei.get(address.toLowerCase()) ?? 0n,
      getBlock: async () => ({ timestamp: 1_800_000_000n }),
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
        switch (functionName) {
          case "isModuleInstalled":
            if (s.code !== kernelDelegationCode) throw new Error("execution reverted"); // a plain EOA has no code
            return s.modules.has(String(args[1]).toLowerCase());
          case "getNonce":
            return 0n;
          case "lastPolicyNonce":
            return [...s.adapter.values()].reduce((a, b) => (b > a ? b : a), 0n);
          case "lastNonce":
            return 0n;
          case "policyOf":
            return { nonce: s.adapter.get(args[1] as Hex) ?? 0n };
          case "activePolicy":
            return s.active;
          case "balanceOf":
            return address.toLowerCase() === TUSDG.toLowerCase() ? s.usdg : 0n;
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      simulateContract: async (call: { address: Address; functionName: string; args: readonly unknown[] }) => (fail(call.functionName), { request: call }),
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => receipt(hash === "0x0e" ? o.handleOpsStatus : "success"),
    },
    wallet: {
      writeContract: async (r: { address: Address; functionName: string; args: readonly unknown[]; authorizationList?: unknown[] }) => {
        s.txs.push({ to: r.address, fn: r.functionName, args: r.args, authorizationList: r.authorizationList });
        if (r.functionName === "handleOps") {
          if (o.handleOpsStatus === "reverted") return "0x0e"; // reverted: nothing applied
          if (r.authorizationList?.length) s.code = kernelDelegationCode;
          const [[packed]] = r.args as [[{ callData: Hex }]];
          const { functionName, args } = decodeFunctionData({ abi: kernelAbi, data: packed.callData });
          if (functionName === "installModule" && o.installs !== false) s.modules.add(String(args[1]).toLowerCase());
          if (functionName === "uninstallModule") s.modules.delete(String(args[1]).toLowerCase());
          return "0x0e";
        }
        if (r.functionName === "setPolicy" && r.address === ADAPTER) s.adapter.set(poolId(r.args[0] as AdapterPolicy), (r.args[0] as AdapterPolicy).nonce);
        if (r.functionName === "setPolicy" && r.address === POLICY) s.active = swapKeyPolicyHash(r.args[0] as SwapKeyPolicy);
        if (r.functionName === "mint") s.usdg += r.args[1] as bigint;
        return "0x01";
      },
      sendTransaction: async ({ to, value }: { to: Address; value: bigint }) => {
        s.txs.push({ to, fn: "transfer", value });
        s.wei.set(to.toLowerCase(), (s.wei.get(to.toLowerCase()) ?? 0n) + value);
        return "0x02";
      },
    },
  } as unknown as Clients;
  return { c, s };
}

/** What swapKey.prepare stores and the browser signs, built against the fake chain's current state. */
async function signedSetup(c: Clients, wallet: ReturnType<typeof privateKeyToAccount>) {
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const opts = { chainId: robinhoodTestnet.id, account: wallet.address, swapAdapter: ADAPTER, swapKeyPolicy: POLICY, markets: TESTNET_SWAP.markets, caps: TESTNET_SWAP.caps };
  const setup = await buildSwapSetup(c.public as never, { ...opts, sessionKey: SESSION, expiresAt });
  checkSwapSetup(setup, { ...opts, maxDays: TESTNET_SWAP.policyDays }); // the browser would sign exactly this
  const typed = swapSetupTypedData(setup, { swapAdapter: ADAPTER, swapKeyPolicy: POLICY });
  const a = setup.install?.authorization && (await wallet.signAuthorization({ address: KERNEL_V33_IMPLEMENTATION, chainId: setup.install.authorization.chainId, nonce: setup.install.authorization.nonce }));
  const signatures: Record<string, unknown> = {
    authorization: a ? { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity! } : undefined,
    userOp: setup.install ? await wallet.signMessage({ message: { raw: setup.install.userOpHash } }) : undefined,
    adapter: await Promise.all(typed.adapter.map((t) => wallet.signTypedData(t as never))),
    policy: await wallet.signTypedData(typed.policy as never),
  };
  return toJsonSafe({ ...setup, signatures }) as Record<string, unknown>;
}

async function store(db: TestDb, account: Address, setup: Record<string, unknown>) {
  await db.insert(users).values({ address: OWNER }).onConflictDoNothing();
  const values = { account: account.toLowerCase(), keyAddr: SESSION, sealed: {}, setup, expiresAt: new Date(Date.now() + 30 * 86_400_000), registeredAt: null, revokedAt: null };
  await db.insert(swapKeys).values({ address: OWNER, ...values }).onConflictDoUpdate({ target: swapKeys.address, set: values });
}
const row = async (db: TestDb) => (await db.select().from(swapKeys).where(eq(swapKeys.address, OWNER)))[0]!;
const kinds = async (db: TestDb) => (await db.select({ kind: activity.kind, payload: activity.payload }).from(activity)).map(({ kind, payload }) => ({ kind, payload }));
const meta = (readCt: number) => ({ msgId: 1n, readCt, enqueuedAt: new Date(), vt: new Date(), message: { address: OWNER } });
const handler = (db: TestDb, c: Clients, logs: string[] = []) =>
  swapSetupHandler(db, c, { swapAdapter: ADAPTER, swapKeyPolicy: POLICY, testnetUsdg: TUSDG, budget: relayerBudget(db, c, { pool: "setup" }) }, (m) => logs.push(m));

setDefaultTimeout(60_000); // several PGlite databases per test

describe("swap setup relay", () => {
  test("a plain EOA: delegate + install, both adapter policies, the swap-key policy, key gas and a tUSDG drip; then it's live", async () => {
    const db = await createTestDb();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const { c, s } = fakeChain(wallet.address);
    const setup = await signedSetup(c, wallet);
    expect((setup.install as { authorization: unknown }).authorization).toEqual({ address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 7 });
    await store(db, wallet.address, setup);

    await handler(db, c)({ address: OWNER.toUpperCase() }, meta(1)); // owner addresses are matched lowercased
    expect(s.txs.map((t) => `${t.fn}@${t.to}`)).toEqual([
      `handleOps@${ENTRY_POINT_V07}`,
      `setPolicy@${ADAPTER}`,
      `setPolicy@${ADAPTER}`,
      `setPolicy@${POLICY}`,
      `transfer@${SESSION}`,
      `mint@${TUSDG}`,
    ]);
    expect(s.txs[0]!.authorizationList).toHaveLength(1); // the 7702 delegation rides on the handleOps tx
    expect(s.txs[4]!.value).toBe(SESSION_GAS);
    expect(s.txs[5]!.args).toEqual([wallet.address, 100n * 10n ** 6n]);

    const r = await row(db);
    expect(r.registeredAt).not.toBeNull();
    expect(r.policySig).toBe((setup.signatures as { policy: Hex }).policy);
    expect(await kinds(db)).toEqual([{ kind: "swaps_ready", payload: { sessionKey: SESSION } }]);
    const progress = await swapSetupProgress(c.public as never, swapSetupFromJson(setup), { account: wallet.address, swapAdapter: ADAPTER, swapKeyPolicy: POLICY });
    expect(progress).toEqual({ installed: true, adapterSet: [true, true], policyActive: true, gasFunded: true, complete: true });

    // Every relayed tx (and the key's gas) is charged to the setup pool, pool-wide and for this owner.
    const spend = await db.select().from(rateLimits).where(like(rateLimits.key, "relayer_setup_gwei%"));
    const gwei = 5 * 100_000 + Number(SESSION_GAS / 10n ** 9n); // 5 contract txs at 100k gas x 1 gwei, plus the transfer's
    expect(spend.map((x) => [x.key, x.hits]).sort()).toEqual([
      ["relayer_setup_gwei", gwei + 100_000],
      [`relayer_setup_gwei:${OWNER}`, gwei + 100_000],
    ]);

    await handler(db, c)({ address: OWNER }, meta(1)); // registered: a redelivered message sends nothing
    expect(s.txs).toHaveLength(6);
  });

  test("an RPC error mid-setup is retried; the retry skips every step already on-chain", async () => {
    const db = await createTestDb();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const flaky = fakeChain(wallet.address, { failOn: "setPolicy" });
    await store(db, wallet.address, await signedSetup(flaky.c, wallet));
    await expect(handler(db, flaky.c)({ address: OWNER }, meta(1))).rejects.toThrow("connection reset");
    expect(flaky.s.txs.map((t) => t.fn)).toEqual(["handleOps"]);
    expect(await kinds(db)).toEqual([]); // nothing recorded while retries remain

    // Same chain state, RPC healthy again.
    const healthy = fakeChain(wallet.address);
    Object.assign(healthy.s, { code: flaky.s.code, modules: flaky.s.modules });
    await handler(db, healthy.c)({ address: OWNER }, meta(2));
    expect(healthy.s.txs.map((t) => t.fn)).toEqual(["setPolicy", "setPolicy", "setPolicy", "transfer", "mint"]);
    expect(await kinds(db)).toEqual([{ kind: "swaps_ready", payload: { sessionKey: SESSION } }]);
  });

  test("an already delegated wallet only needs the install UserOp: no authorization is required or sent", async () => {
    const db = await createTestDb();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const { c, s } = fakeChain(wallet.address, { delegated: true });
    const setup = await signedSetup(c, wallet);
    expect((setup.install as { authorization: unknown }).authorization).toBeNull();
    await store(db, wallet.address, setup);
    await handler(db, c)({ address: OWNER }, meta(1));
    expect(s.txs[0]!.fn).toBe("handleOps");
    expect(s.txs[0]!.authorizationList).toBeUndefined();
    expect((await row(db)).registeredAt).not.toBeNull();
  });

  const refused = async (o: Parameters<typeof fakeChain>[1], tweak: (sig: Record<string, unknown>, wallet: ReturnType<typeof privateKeyToAccount>) => void | Promise<void>) => {
    const db = await createTestDb();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const { c, s } = fakeChain(wallet.address, o);
    const setup = await signedSetup(c, wallet);
    await tweak(setup.signatures as Record<string, unknown>, wallet);
    await store(db, wallet.address, setup);
    const logs: string[] = [];
    await expect(handler(db, c, logs)({ address: OWNER }, meta(1))).rejects.toThrow(); // retried first
    await handler(db, c, logs)({ address: OWNER }, meta(3)); // then recorded
    const r = await row(db);
    return { s, r, logs, failed: (r.setup as { failed?: string }).failed, kinds: await kinds(db) };
  };

  test("a delegation to anything but Kernel v3.3, for another chain, or signed by another key is refused before any tx", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const otherAuth = await stranger.signAuthorization({ address: KERNEL_V33_IMPLEMENTATION, chainId: 46630, nonce: 7 });
    for (const tweak of [
      (sig: Record<string, any>) => void (sig.authorization.address = addr(0xee)),
      (sig: Record<string, any>) => void (sig.authorization.chainId = 4663),
      (sig: Record<string, any>) => void Object.assign(sig.authorization, { r: otherAuth.r, s: otherAuth.s, yParity: otherAuth.yParity }),
    ]) {
      const { s, r, failed, kinds } = await refused({}, tweak);
      expect(s.txs).toEqual([]);
      expect(failed).toBe("bad_authorization");
      expect(r.registeredAt).toBeNull();
      expect(kinds).toEqual([{ kind: "swap_setup_failed", payload: { reason: "bad_authorization" } }]);
    }
  });

  test("missing install signatures are refused before any tx", async () => {
    for (const tweak of [(sig: Record<string, unknown>) => void delete sig.userOp, (sig: Record<string, unknown>) => void delete sig.authorization]) {
      const { s, failed } = await refused({}, tweak);
      expect(s.txs).toEqual([]);
      expect(failed).toBe("missing_install_signature");
    }
  });

  test("a UserOp that runs but leaves the module uninstalled stops the setup (install_failed); its gas is still charged", async () => {
    const { s, failed, r } = await refused({ installs: false }, () => {});
    expect(s.txs.map((t) => t.fn)).toEqual(["handleOps", "handleOps"]); // once per attempt, nothing after it
    expect(failed).toBe("install_failed");
    expect(r.registeredAt).toBeNull();
  });

  test("a reverted handleOps is a relay_error, and a contract revert is recorded by its error name; logs carry no RPC URL", async () => {
    const reverted = await refused({ handleOpsStatus: "reverted" }, () => {});
    expect(reverted.failed).toBe("relay_error");
    expect(reverted.logs.at(-1)).toContain("handleOps 0x0e reverted");

    const badSig = await refused({ revertOn: "setPolicy" }, () => {});
    expect(badSig.failed).toBe("BadSignature");
    expect(badSig.s.txs.map((t) => t.fn)).toEqual(["handleOps"]); // the install landed; the bad policy never went out

    const rpc = await refused({ failOn: "setPolicy" }, () => {});
    expect(rpc.failed).toBe("relay_error");
    expect(rpc.logs.join()).not.toContain("rpc.example");
    expect(rpc.logs.at(-1)).toContain("[url]");
  });

  test("revoke: ops the browser accepts (checkRevokeOps) are relayed and uninstall the module; tampered or foreign ops are refused before signing", async () => {
    const db = await createTestDb();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const LEGACY = addr(0xd9);
    const { c, s } = fakeChain(wallet.address, { delegated: true });
    s.modules.add(POLICY.toLowerCase());
    const ops = [LEGACY, POLICY].map((module, i) => {
      const userOp = revokePolicyUserOp({ account: wallet.address, swapKeyPolicy: module, nonce: BigInt(i) });
      return { userOp, userOpHash: userOpHash(userOp, robinhoodTestnet.id), module };
    });
    const o = { account: wallet.address, chainId: robinhoodTestnet.id, allowed: [POLICY, LEGACY] };
    checkRevokeOps(ops, o);
    for (const [bad, why] of [
      [[], "nothing to revoke"],
      [[ops[0]!, ops[0]!], "unexpected module"],
      [[{ ...ops[0]!, module: addr(0xee) }], "unexpected module"],
      [[ops[1]!, ops[0]!], "out of order"],
      [[{ ...ops[0]!, userOpHash: ops[1]!.userOpHash }], "unexpected revoke operation"],
      [[{ ...ops[0]!, userOp: { ...ops[0]!.userOp, maxFeePerGas: 1n } }], "unexpected revoke operation"],
    ] as const)
      expect(() => checkRevokeOps(bad as never, o)).toThrow(why);

    // Op 0 (the legacy uninstall) went out on an earlier attempt: only the current module's is relayed.
    const signatures = await Promise.all(ops.map((x) => wallet.signMessage({ message: { raw: x.userOpHash } })));
    await store(db, wallet.address, { revoke: { ops: ops.map(({ userOp, module }) => ({ userOp: toJsonSafe(userOp), module })), signatures } });
    await db.update(swapKeys).set({ registeredAt: new Date(), revokedAt: new Date() }).where(eq(swapKeys.address, OWNER));
    const nonce = 1n; // the account's EntryPoint nonce: op 0 was used
    const read = c.public.readContract.bind(c.public);
    (c.public as { readContract: unknown }).readContract = async (a: { functionName: string }) => (a.functionName === "getNonce" ? nonce : read(a as never));
    await swapSetupHandler(db, c, { swapAdapter: ADAPTER, swapKeyPolicy: POLICY, legacyPolicies: [LEGACY] }, () => {})({ address: OWNER, revoke: true }, meta(1));
    expect(s.txs.map((t) => t.fn)).toEqual(["handleOps"]);
    expect(s.modules.has(POLICY.toLowerCase())).toBe(false);
    expect(await kinds(db)).toEqual([{ kind: "swaps_revoked", payload: { sessionKey: SESSION } }]);
  });
});
