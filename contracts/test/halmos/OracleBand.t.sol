// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OracleBand} from "../../src/ProvisoSwapAdapter.sol";

/// Properties of the adapter's oracle floor (OracleBand.floor, the math behind
/// ProvisoSwapAdapter._oracleFloor), stated once as `check_` functions with symbolic arguments for
/// Halmos and run at full width by forge through the `testFuzz_` wrappers at the bottom.
/// Status (halmos 0.3.3, 2026-10-22): the SMT queries time out at full width with yices, z3,
/// bitwuzla and bitwuzla --abstraction (60-400 s per query; even `x * 9700 / 10000 <= x` over a
/// 240-bit x does), because they bit-blast 256-bit division and OZ mulDiv's 512-bit path. So these
/// are not in the CI `halmos` job (that job proves the oracle pins, AdapterPinsSymTest); forge
/// fuzzes every property below on the deployed code. Try: `halmos --match-contract
/// OracleBandSymTest --solver-timeout-assertion 0` in contracts/.
/// Range: what the v2 adapter can see on its deployed pairs. The multiplier is pinned at 1e18,
/// every feed has 8 decimals, the stock token 18 and USDG 6 (TSLA, AMZN on mainnet and testnet).
/// answer is a positive 8-decimal price up to $1e12; amountIn up to 1e28 base units (1e10 whole
/// stock tokens, 1e22 USDG); slipBps up to MAX_SLIP_BPS. Within that every product below fits in
/// 256 bits, so the reference arithmetic here is exact.
contract OracleBandSymTest is Test {
    uint256 constant MULTIPLIER = 1e18;
    uint256 constant FEED_DEC = 8;
    uint256 constant MAX_ANSWER = 1e20;
    uint256 constant MAX_IN = 1e28;
    uint16 constant MAX_SLIP = 1_000;
    uint256 constant BPS = 10_000;

    uint256 constant DEC_BASE = 18;
    uint256 constant DEC_QUOTE = 6;

    /// The deployed code path: OracleBand.floor with the adapter's v2 parameters.
    function _floor(uint256 amountIn, uint256 answer, bool sellingBase, uint16 slip)
        internal
        pure
        returns (uint256)
    {
        return OracleBand.floor(amountIn, answer, MULTIPLIER, FEED_DEC, DEC_BASE, DEC_QUOTE, sellingBase, slip);
    }

    /// External so a revert can be caught.
    function floorExt(uint256 amountIn, uint256 answer, bool sellingBase, uint16 slip)
        external
        pure
        returns (uint256)
    {
        return _floor(amountIn, answer, sellingBase, slip);
    }

    function _inRange(uint256 amountIn, uint256 answer, uint16 slip) internal pure {
        vm.assume(amountIn <= MAX_IN);
        vm.assume(answer >= 1 && answer <= MAX_ANSWER);
        vm.assume(slip <= MAX_SLIP);
    }

    /// The exact fair value as a fraction n/d (no rounding): output units per amountIn.
    function _fairFraction(uint256 amountIn, uint256 answer, bool sellingBase)
        internal
        pure
        returns (uint256 n, uint256 d)
    {
        uint256 num = answer * MULTIPLIER * 10 ** DEC_QUOTE;
        uint256 den = 10 ** (FEED_DEC + 18 + DEC_BASE);
        return sellingBase ? (amountIn * num, den) : (amountIn * den, num);
    }

    /// No overflow or other revert anywhere in range.
    function check_floor_noRevert(uint96 amountIn, uint72 answer, bool sellingBase, uint16 slip)
        public
        view
    {
        _inRange(amountIn, answer, slip);
        try this.floorExt(amountIn, answer, sellingBase, slip) returns (uint256) {}
        catch {
            assert(false);
        }
    }

    /// The floor never exceeds fair value: floor * d <= n (exact, no rounding in the comparison).
    function check_floor_atMostFair(uint96 amountIn, uint72 answer, bool sellingBase, uint16 slip)
        public
        pure
    {
        _inRange(amountIn, answer, slip);
        uint256 f = _floor(amountIn, answer, sellingBase, slip);
        (uint256 n, uint256 d) = _fairFraction(amountIn, answer, sellingBase);
        assert(f * d <= n);
    }

    /// The band is exactly slipBps wide around the rounded-down fair value: with fair = floor(n/d),
    /// floor = floor(fair * (BPS - slip) / BPS), so fair - floor <= fair * slip / BPS + 1, and with
    /// slip = 0 the floor is fair itself.
    function check_floor_slipBounds(uint96 amountIn, uint72 answer, bool sellingBase, uint16 slip)
        public
        pure
    {
        _inRange(amountIn, answer, slip);
        uint256 f = _floor(amountIn, answer, sellingBase, slip);
        (uint256 n, uint256 d) = _fairFraction(amountIn, answer, sellingBase);
        uint256 fair = n / d;
        assert(f <= fair);
        assert(f * BPS <= fair * (BPS - slip));
        assert(fair * (BPS - slip) < (f + 1) * BPS);
        assert(fair - f <= fair * slip / BPS + 1);
        if (slip == 0) assert(f == fair);
    }

    /// No policy can push the floor more than MAX_SLIP_BPS (10%) below fair value (two units of
    /// rounding: fair and the band each round down once).
    function check_floor_atLeast90PctOfFair(uint96 amountIn, uint72 answer, bool sellingBase, uint16 slip)
        public
        pure
    {
        _inRange(amountIn, answer, slip);
        uint256 f = _floor(amountIn, answer, sellingBase, slip);
        (uint256 n, uint256 d) = _fairFraction(amountIn, answer, sellingBase);
        assert((f + 2) * BPS * d > (BPS - MAX_SLIP) * n);
    }

    /// Selling the priced token: a higher price never lowers the floor. Buying it: a higher price
    /// never raises the floor (fewer tokens per unit of quote).
    function check_floor_monotoneInPrice(uint96 amountIn, uint72 a1, uint72 a2, bool sellingBase, uint16 slip)
        public
        pure
    {
        _inRange(amountIn, a1, slip);
        vm.assume(a1 <= a2 && a2 <= MAX_ANSWER);
        uint256 f1 = _floor(amountIn, a1, sellingBase, slip);
        uint256 f2 = _floor(amountIn, a2, sellingBase, slip);
        if (sellingBase) assert(f1 <= f2);
        else assert(f1 >= f2);
    }

    /// A larger trade never has a lower floor.
    function check_floor_monotoneInAmount(uint96 x1, uint96 x2, uint72 answer, bool sellingBase, uint16 slip)
        public
        pure
    {
        _inRange(x2, answer, slip);
        vm.assume(x1 <= x2);
        assert(_floor(x1, answer, sellingBase, slip) <= _floor(x2, answer, sellingBase, slip));
    }

    /// A wider band never raises the floor.
    function check_floor_monotoneInSlip(uint96 amountIn, uint72 answer, bool sellingBase, uint16 s1, uint16 s2)
        public
        pure
    {
        _inRange(amountIn, answer, s2);
        vm.assume(s1 <= s2);
        assert(_floor(amountIn, answer, sellingBase, s1) >= _floor(amountIn, answer, sellingBase, s2));
    }

    // --- forge: the same properties, fuzzed at full width on the deployed code ---

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_floor_properties(uint96 x1, uint96 x2, uint72 a1, uint72 a2, bool sell, uint16 s1, uint16 s2)
        public
        view
    {
        x1 = uint96(bound(x1, 0, MAX_IN));
        x2 = uint96(bound(x2, x1, MAX_IN));
        a1 = uint72(bound(a1, 1, MAX_ANSWER));
        a2 = uint72(bound(a2, a1, MAX_ANSWER));
        s1 = uint16(bound(s1, 0, MAX_SLIP));
        s2 = uint16(bound(s2, s1, MAX_SLIP));
        check_floor_noRevert(x2, a1, sell, s1);
        check_floor_atMostFair(x2, a1, sell, s1);
        check_floor_slipBounds(x2, a1, sell, s1);
        check_floor_atLeast90PctOfFair(x2, a1, sell, s1);
        check_floor_monotoneInPrice(x2, a1, a2, sell, s1);
        check_floor_monotoneInAmount(x1, x2, a1, sell, s1);
        check_floor_monotoneInSlip(x2, a1, sell, s1, s2);
    }

    /// The range corners: largest amounts at the extreme prices, both directions, widest band.
    function test_floor_rangeCorners() public view {
        uint72[3] memory prices = [uint72(1), uint72(1e8), uint72(MAX_ANSWER)];
        for (uint256 i; i < 3; ++i) {
            for (uint256 d; d < 2; ++d) {
                check_floor_noRevert(uint96(MAX_IN), prices[i], d == 0, MAX_SLIP);
                check_floor_slipBounds(uint96(MAX_IN), prices[i], d == 0, MAX_SLIP);
                check_floor_atLeast90PctOfFair(uint96(MAX_IN), prices[i], d == 0, MAX_SLIP);
            }
        }
    }
}
