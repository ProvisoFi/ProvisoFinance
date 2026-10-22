import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { balanceWatch } from "./balance-watch";
import type { Clients } from "./chain";

describe("relayer balance watch", () => {
  test("alerts once below the floor, repeats after 6 h, re-arms after a top-up", async () => {
    let wei = parseEther("0.001");
    let t = 0;
    const sent: string[] = [];
    const c = { account: { address: "0x00000000000000000000000000000000000000aa" }, public: { getBalance: async () => wei } } as unknown as Clients;
    const w = balanceWatch(c, { alertAddress: "0xABC", notify: async (m) => void sent.push(m.address), now: () => t });
    await w.tick();
    await w.tick();
    expect(sent).toEqual(["0xabc"]);
    t += 6 * 3_600_000;
    await w.tick();
    expect(sent).toHaveLength(2);
    wei = parseEther("1");
    await w.tick();
    wei = parseEther("0.001");
    await w.tick();
    expect(sent).toHaveLength(3);
  });
});

describe("relayer balance watch loop", () => {
  test("a failed balance read is logged and the loop keeps going until aborted", async () => {
    const logs: string[] = [];
    let reads = 0;
    const c = { account: { address: "0x00000000000000000000000000000000000000aa" }, public: { getBalance: async () => (reads++, Promise.reject(new Error("rpc down"))) } } as unknown as Clients;
    const sent: unknown[] = [];
    const ac = new AbortController();
    const done = balanceWatch(c, { alertAddress: "0xabc", minEth: "0.5", notify: async (m) => void sent.push(m), log: (m) => logs.push(m) }).run(ac.signal);
    while (!logs.some((l) => l.includes("failed"))) await Bun.sleep(1);
    ac.abort();
    await done;
    expect(reads).toBe(1);
    expect(sent).toEqual([]);
    expect(logs).toEqual(["ops: relayer balance watch on (alert below 0.5 ETH)", "ops: balance watch failed: rpc down"]);
  });

  test("the alert names the relayer, its balance and the address to notify (lowercased)", async () => {
    const sent: { address: string; title: string; body: string }[] = [];
    const c = { account: { address: "0x00000000000000000000000000000000000000aa" }, public: { getBalance: async () => parseEther("0.0012345") } } as unknown as Clients;
    await balanceWatch(c, { alertAddress: "0xABCDEF", notify: async (m) => void sent.push(m), now: () => 0 }).tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.address).toBe("0xabcdef");
    expect(sent[0]!.title).toBe("Relayer low on ETH");
    expect(sent[0]!.body).toContain("0x00000000000000000000000000000000000000aa has 0.00123 ETH");
  });
});
