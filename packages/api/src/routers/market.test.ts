import { expect, test } from "bun:test";
import { floorsFor } from "./market";

test("liquidity floors: lowered on testnet only", () => {
  expect(floorsFor("testnet", {})).toEqual({ hlVolumeUsd: 1000, poolDepthUsd: 25 });
  expect(floorsFor("testnet", { TESTNET_MIN_HL_VOLUME_USD: "5000", TESTNET_MIN_POOL_DEPTH_USD: "50" })).toEqual({ hlVolumeUsd: 5000, poolDepthUsd: 50 });
  // Mainnet ignores the testnet overrides: $250k HL 24h volume, $100k pool depth (±2%).
  expect(floorsFor("mainnet", { TESTNET_MIN_HL_VOLUME_USD: "5000" })).toEqual({ hlVolumeUsd: 250_000, poolDepthUsd: 100_000 });
});
