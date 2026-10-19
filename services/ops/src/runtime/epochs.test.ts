// Epoch consumer end to end: PGlite + CallerShare (real bytecode) funded with a mock USDG on anvil.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anvil, callerShareAbi } from "@proviso/chain";
import { callerShareBytecode } from "@proviso/chain/bytecode";
import { callerShares, epochs, orders, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, http, maxUint256, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { send, type Clients } from "./chain";
import { epochHandler } from "./epochs";

const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
// solmate MockERC20 from `forge build` (contracts/out is gitignored; the test skips without it)
const mockArtifact = join(import.meta.dirname, "../../../../contracts/out/MockERC20.sol/MockERC20.json");
const has = existsSync(bin) && existsSync(mockArtifact);
const port = 11545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${port}`;
const poster = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0
const chain = { ...anvil, rpcUrls: { default: { http: [rpc] } } };
const CALLER_A = "0x00000000000000000000000000000000000000aa";
const CALLER_B = "0x00000000000000000000000000000000000000bb";
const FOLLOWER = "0x00000000000000000000000000000000000000f1";
const USDG = 1_000_000n;
const H = 3_600_000;

let proc: ReturnType<typeof Bun.spawn> | undefined;
let db: Db;
let c: Clients;
let usdg: Address;
let share: Address;
let mockAbi: Abi;
let now: number;

async function deploy(abi: Abi, bytecode: Hex, args: unknown[]) {
  const hash = await c.wallet.deployContract({ abi, bytecode, args, account: poster, chain } as never);
  return (await c.public.waitForTransactionReceipt({ hash })).contractAddress as Address;
}
const balance = () => c.public.readContract({ address: usdg, abi: mockAbi, functionName: "balanceOf", args: [poster.address] }) as Promise<bigint>;

beforeAll(async () => {
  if (!has) return;
  proc = Bun.spawn([bin, "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  c = { public: pub, wallet: createWalletClient({ chain, transport: http(rpc), account: poster, pollingInterval: 50 }), account: poster };
  const art = JSON.parse(readFileSync(mockArtifact, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  mockAbi = art.abi;
  usdg = await deploy(mockAbi, art.bytecode.object, ["USDG", "USDG", 6]);
  share = await deploy(callerShareAbi as Abi, callerShareBytecode, [usdg, poster.address]);
  await send(c, { address: usdg, abi: mockAbi, functionName: "approve", args: [share, maxUint256] });

  db = await createTestDb();
  await db.insert(users).values([{ address: CALLER_A }, { address: CALLER_B }, { address: FOLLOWER }]);
  now = Number((await pub.getBlock()).timestamp) * 1000;
  const t = (id: bigint, owner: string) => ({
    id,
    owner,
    encSpec: new Uint8Array(1),
    entryHash: "0x1",
    exitHash: "0x2",
    mode: "live",
    signedAt: new Date(now - 100 * H),
    stampedAt: new Date(now - 100 * H),
    sealTx: "0x3",
    expiresAt: new Date(now + 24 * H),
    state: "live",
  });
  await db.insert(theses).values([t(1n, CALLER_A), t(2n, CALLER_B)]);
  const o = (thesisId: bigint, reduceOnly: boolean, filled: string, px: string, hoursAgo: number) => ({
    thesisId,
    account: FOLLOWER,
    role: "follower",
    wave: 1,
    venue: "hl",
    coin: "HYPE",
    side: reduceOnly ? "sell" : "buy",
    size: filled,
    reduceOnly,
    status: "filled",
    filledSize: filled,
    avgPx: px,
    createdAt: new Date(now - hoursAgo * H),
    updatedAt: new Date(now - hoursAgo * H),
  });
  await db.insert(orders).values([
    o(1n, false, "10", "30", 48), // $300 for 24 h
    o(1n, true, "10", "31", 24),
    o(2n, false, "1", "100", 12), // $100, still open
  ]);
}, 30_000);
afterAll(() => proc?.kill());

describe.skipIf(!has)("epoch consumer on anvil", () => {
  const msg = () => ({ epoch: 202643, start: new Date(now - 7 * 24 * H).toISOString(), end: new Date(now).toISOString() });

  test("no pool: logged, finished, nothing stored", async () => {
    const logs: string[] = [];
    const cfg = { callerShare: share, usdg, poolUsdg: 500n * USDG, log: (m: string) => logs.push(m) };
    await epochHandler(db, c, cfg)(msg()); // relayer holds 0 USDG
    await epochHandler(db, c, { ...cfg, poolUsdg: 0n })(msg());
    expect(logs).toHaveLength(2);
    for (const l of logs) expect(l).toContain("epoch 202643 skipped: no pool");
    expect(await db.select().from(epochs)).toHaveLength(0);
  }, 30_000);

  test("a funded epoch posts min(balance, EPOCH_POOL_USDG) with the stored root; redelivery is a no-op", async () => {
    await send(c, { address: usdg, abi: mockAbi, functionName: "mint", args: [poster.address, 1000n * USDG] });
    const cfg = { callerShare: share, usdg, poolUsdg: 400n * USDG, capUsdg: 250n * USDG, log: () => {} };
    await epochHandler(db, c, cfg)(msg());

    const [e] = await db.select().from(epochs).where(eq(epochs.epoch, 202643n));
    expect(e!.tx).toMatch(/^0x[0-9a-f]{64}$/);
    // weights 300×24 : 100×12 = 6 : 1 → A ≈ 342.86 > cap 250 → A = 250, B takes the other 150
    expect(e!.totalUsdg).toBe(String(400n * USDG));
    const rows = await db.select().from(callerShares);
    expect(rows.map((r) => [r.caller, r.amountUsdg]).sort()).toEqual([
      [CALLER_A, String(250n * USDG)],
      [CALLER_B, String(150n * USDG)],
    ]);
    const [root, total] = (await c.public.readContract({ address: share, abi: callerShareAbi, functionName: "epochs", args: [202643n] })) as readonly [Hex, bigint, bigint];
    expect(root).toBe(e!.root as Hex);
    expect(total).toBe(400n * USDG);
    expect(await balance()).toBe(600n * USDG);

    // The stored proof claims on-chain.
    const b = rows.find((r) => r.caller === CALLER_B)!;
    await send(c, { address: share, abi: callerShareAbi as Abi, functionName: "claim", args: [202643n, CALLER_B, BigInt(b.amountUsdg), b.proof] });

    await epochHandler(db, c, cfg)(msg()); // redelivery
    const [again] = await db.select().from(epochs).where(eq(epochs.epoch, 202643n));
    expect(again!.tx).toBe(e!.tx);
    expect(await balance()).toBe(600n * USDG); // nothing pulled twice
    const posted = await c.public.getContractEvents({ address: share, abi: callerShareAbi, eventName: "EpochPosted", fromBlock: 0n });
    expect(posted).toHaveLength(1);
  }, 30_000);

  test("db lost the tx: EpochExists resolves to the original post", async () => {
    const [e] = await db.select().from(epochs).where(eq(epochs.epoch, 202643n));
    await db.update(epochs).set({ tx: null, postedAt: null }).where(eq(epochs.epoch, 202643n));
    await epochHandler(db, c, { callerShare: share, usdg, poolUsdg: 1n, log: () => {} })(msg());
    const [again] = await db.select().from(epochs).where(eq(epochs.epoch, 202643n));
    expect(again!.tx).toBe(e!.tx);
  }, 30_000);
});
