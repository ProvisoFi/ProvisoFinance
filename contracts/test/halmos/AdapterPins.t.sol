// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ProvisoSwapAdapter} from "../../src/ProvisoSwapAdapter.sol";

/// Halmos symbolic proof of the v2 oracle pins: for every policy and every signature (all fields
/// symbolic), setPolicy succeeds only if the policy names the pinned feed of its priced token, the
/// pinned quote token and multiplier 1e18; and a pin-conforming policy is never refused for a pin
/// reason. Run: `halmos --match-contract AdapterPinsSymTest` in contracts/ (CI job `halmos`).
/// Mirrors the mainnet deploy shape: two stock tokens, one quote token.
contract AdapterPinsSymTest is Test {
    address constant STOCK_A = address(0x1001);
    address constant STOCK_B = address(0x1002);
    address constant QUOTE = address(0x1003);
    address constant FEED_A = address(0x2001);
    address constant FEED_B = address(0x2002);

    ProvisoSwapAdapter adapter;

    function setUp() public {
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (STOCK_A, STOCK_B);
        address[] memory oracles = new address[](2);
        (oracles[0], oracles[1]) = (FEED_A, FEED_B);
        adapter = new ProvisoSwapAdapter(IPoolManager(address(0xBEEF)), 90_000, QUOTE, tokens, oracles);
    }

    function check_setPolicy_onlyPinned(ProvisoSwapAdapter.Policy memory p, bytes32 r, bytes32 s, uint8 v) public {
        (address base, address quote) = p.baseIsCurrency0 ? (p.currency0, p.currency1) : (p.currency1, p.currency0);
        bool pinned = p.multiplier == 1e18 && quote == QUOTE
            && ((base == STOCK_A && p.oracle == FEED_A) || (base == STOCK_B && p.oracle == FEED_B));

        (bool ok, bytes memory ret) =
            address(adapter).call(abi.encodeCall(adapter.setPolicy, (p, abi.encodePacked(r, s, v))));

        if (!pinned) assert(!ok); // nothing off the pins is ever stored
        if (ok) {
            ProvisoSwapAdapter.Policy memory stored = adapter.policyOf(p.account, _id(p));
            assert(stored.oracle == p.oracle && stored.multiplier == 1e18);
        }
        if (!ok && pinned && p.maxSlipBps <= adapter.MAX_SLIP_BPS() && ret.length >= 4) {
            bytes4 err = bytes4(ret);
            assert(err != ProvisoSwapAdapter.OracleNotPinned.selector && err != ProvisoSwapAdapter.BadPolicy.selector);
        }
        // the pins themselves never move
        assert(adapter.oracleOf(STOCK_A) == FEED_A && adapter.oracleOf(STOCK_B) == FEED_B);
        assert(adapter.oracleOf(QUOTE) == address(0) && adapter.quoteToken() == QUOTE);
    }

    function _id(ProvisoSwapAdapter.Policy memory p) internal pure returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks)));
    }
}
