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
