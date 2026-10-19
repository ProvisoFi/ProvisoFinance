import { expect, test } from "bun:test";
import { mapStatus, relayQuote, routeConfig, ROUTES_MAINNET, toUnits } from "./relay";

test("routes are off on testnet and on with mainnet", () => {
  expect(routeConfig({ CHAIN_NETWORK: "testnet" })).toBeNull();
  expect(routeConfig({})).toBeNull();
  expect(routeConfig({ CHAIN_NETWORK: "mainnet" })).toBe(ROUTES_MAINNET);
});

test("amounts use each side's decimals", () => {
  expect(toUnits(20, 6)).toBe(20_000_000n); // USDG
  expect(toUnits(10, 8)).toBe(1_000_000_000n); // Hyperliquid perps USDC
  expect(toUnits(1.5, 6)).toBe(1_500_000n);
});

test("fund and exit quotes send the right chains, currencies, refund and protocol", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ requestId: "0xabc", steps: [{ id: "deposit", kind: "transaction", items: [{ status: "incomplete", data: {} }] }] });
  }) as typeof fetch;
  const user = "0x000000000000000000000000000000000000dead";
  await relayQuote(ROUTES_MAINNET, { user, direction: "fund", amountUsd: 20 }, fetcher, undefined);
  await relayQuote(ROUTES_MAINNET, { user, direction: "exit", amountUsd: 10 }, fetcher, undefined);
  expect(bodies[0]).toMatchObject({ originChainId: 4663, destinationChainId: 1337, amount: "20000000", refundTo: user, recipient: user });
  expect(bodies[0].protocolVersion).toBeUndefined();
  expect(bodies[1]).toMatchObject({ originChainId: 1337, destinationChainId: 4663, amount: "1000000000", protocolVersion: "v2" });
});

test("relay errors surface their message", async () => {
  const fetcher = (async () => Response.json({ message: "Amount too low" }, { status: 400 })) as unknown as typeof fetch;
  await expect(relayQuote(ROUTES_MAINNET, { user: "0x1", direction: "fund", amountUsd: 5 }, fetcher, undefined)).rejects.toThrow("Amount too low");
});

test("relay states map to route states", () => {
  expect(mapStatus("success")).toBe("done");
  expect(mapStatus("refund")).toBe("refunded");
  expect(mapStatus("failure")).toBe("failed");
  expect(mapStatus("pending")).toBe("bridging");
  expect(mapStatus("waiting")).toBe("submitted");
});

// Read-only mainnet quote (no funds move): RELAY_LIVE_TESTS=1 bun test src/relay.test.ts
test.skipIf(!process.env.RELAY_LIVE_TESTS)("live mainnet quote parses", async () => {
  const q = await relayQuote(ROUTES_MAINNET, { user: "0x000000000000000000000000000000000000dEaD", direction: "fund", amountUsd: 20 });
  expect(q.requestId).toMatch(/^0x/);
  expect(q.steps.map((s) => s.id)).toContain("deposit");
});
