// Property tests for the swap sizing math the executor signs into each swap: amountInForUsd,
// oracleFairOut and quoteMinOut must agree with ProvisoSwapAdapter._oracleFloor.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { zeroAddress } from "viem";
import { amountInForUsd, oracleFairOut, quoteMinOut, type OracleQuote, type RhcMarket } from "./executor.ts";

const market = fc.record({
  baseIsCurrency0: fc.boolean(),
  decimals: fc.tuple(fc.constantFrom(6, 8, 18), fc.constantFrom(6, 8, 18)),
  multiplier: fc.bigInt({ min: 10n ** 17n, max: 10n ** 19n }),
  adapterMaxSlipBps: fc.integer({ min: 1, max: 9_999 }),
}).map(
  (m): RhcMarket => ({
    ...m,
    symbols: ["A", "B"],
    key: { currency0: zeroAddress, currency1: zeroAddress, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    oracle: zeroAddress,
  }),
);
const quote = fc.record({ answer: fc.bigInt({ min: 1n, max: 10n ** 14n }), feedDecimals: fc.constantFrom(6, 8, 18), updatedAt: fc.constant(0n) });
const BPS = 10_000n;

describe("swap sizing math", () => {
  test("amountInForUsd: the largest input worth at most `usd` at the oracle price", () => {
    fc.assert(
      fc.property(market, quote, fc.boolean(), fc.integer({ min: 1, max: 1_000_000 }), (m, q, z, usd) => {
        const amountIn = amountInForUsd(m, z, usd, q);
        const usdE6 = BigInt(usd) * 1_000_000n;
        const decIn = BigInt(z ? m.decimals[0] : m.decimals[1]);
        if (z !== m.baseIsCurrency0) {
          expect(amountIn).toBe((usdE6 * 10n ** decIn) / 1_000_000n); // paying the USD-quoted side
          return;
        }
        // value(x) = x * answer * multiplier / (10^feedDec * 1e18 * 10^decIn), in USD
        const lhs = (x: bigint) => x * q.answer * m.multiplier * 1_000_000n;
        const rhs = usdE6 * 10n ** decIn * 10n ** BigInt(q.feedDecimals) * 10n ** 18n;
        expect(lhs(amountIn) <= rhs).toBe(true);
        expect(lhs(amountIn + 1n) > rhs).toBe(true);
      }),
    );
  });

  test("quoteMinOut is never below the adapter's floor and never above fair value", () => {
    fc.assert(
      fc.property(market, quote, fc.boolean(), fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.integer({ min: 1, max: 9_999 }), (m, q, z, amountIn, slipBps) => {
        const fair = oracleFairOut(m, z, amountIn, q);
        const adapterFloor = (fair * (BPS - BigInt(m.adapterMaxSlipBps))) / BPS; // _oracleFloor
        const minOut = quoteMinOut(m, z, amountIn, slipBps / 100, q);
        expect(minOut >= adapterFloor).toBe(true);
        expect(minOut <= fair).toBe(true);
      }),
    );
  });

  test("oracleFairOut is monotone and a round trip at the same price can't create value", () => {
    fc.assert(
      fc.property(market, quote, fc.boolean(), fc.bigInt({ min: 1n, max: 10n ** 30n }), (m, q, z, amountIn) => {
        const out = oracleFairOut(m, z, amountIn, q);
        expect(oracleFairOut(m, z, amountIn + 1n, q) >= out).toBe(true);
        expect(oracleFairOut(m, !z, out, q) <= amountIn).toBe(true);
      }),
    );
  });
});
