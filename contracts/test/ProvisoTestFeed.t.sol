// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvisoSwapAdapter} from "../src/ProvisoSwapAdapter.sol";
import {ProvisoTestFeed} from "../src/ProvisoTestFeed.sol";
import {ProvisoSwapAdapterTest} from "./ProvisoSwapAdapter.t.sol";

/// Inherits the adapter suite for its pool, account and swap helpers (so those tests run here too).
contract ProvisoTestFeedTest is ProvisoSwapAdapterTest {
    ProvisoTestFeed testFeed;
    address updater = makeAddr("relayer");

    function _useTestFeed() internal {
        testFeed = new ProvisoTestFeed(updater, "TOKEN0/TOKEN1");
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.oracle = address(testFeed);
        _setPolicy(p);
    }

    function _push(int256 answer) internal {
        vm.prank(updater);
        testFeed.push(answer);
    }

    // --- feed ---

    function test_feed_pushRecordsRounds() public {
        _useTestFeed();
        assertEq(testFeed.decimals(), 8);
        assertEq(testFeed.version(), 1);
        assertEq(testFeed.description(), "TOKEN0/TOKEN1");
        (uint80 id, int256 a, uint256 s, uint256 u, uint80 air) = testFeed.latestRoundData();
        assertEq(id, 0);
        assertEq(a, 0);
        assertEq(s + u + air, 0);

        _push(250e8);
        vm.warp(block.timestamp + 7);
        _push(251e8);
        (id, a, s, u, air) = testFeed.latestRoundData();
        assertEq(id, 2);
        assertEq(a, 251e8);
        assertEq(u, block.timestamp);
        assertEq(s, u);
        assertEq(air, 2);
        (, a,, u,) = testFeed.getRoundData(1);
        assertEq(a, 250e8);
        assertEq(u, block.timestamp - 7);
    }

    function test_feed_onlyUpdater() public {
        _useTestFeed();
        vm.expectRevert(ProvisoTestFeed.NotUpdater.selector);
        testFeed.push(1e8);
    }

    function test_feed_rejectsNonPositive() public {
        _useTestFeed();
        vm.startPrank(updater);
        vm.expectRevert(ProvisoTestFeed.NonPositiveAnswer.selector);
        testFeed.push(0);
        vm.expectRevert(ProvisoTestFeed.NonPositiveAnswer.selector);
        testFeed.push(-1);
    }

    function test_feed_unknownRound() public {
        _useTestFeed();
        vm.expectRevert(ProvisoTestFeed.NoDataPresent.selector);
        testFeed.getRoundData(0);
        _push(1e8);
        vm.expectRevert(ProvisoTestFeed.NoDataPresent.selector);
        testFeed.getRoundData(2);
    }

    // --- adapter end to end ---

    function test_adapter_swapsOffTestFeed() public {
        _useTestFeed();
        _push(1e8);
        uint256 before1 = currency1.balanceOf(account);
        uint256 out = _swap(key, true, AMOUNT, _band(AMOUNT));
        assertEq(currency1.balanceOf(account) - before1, out);
        _swap(key, false, AMOUNT, _band(AMOUNT));

        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT) - 1);
    }

    function test_adapter_followsPushedPrice() public {
        // feed says 0.5, so a 1:1 pool clears a band set at half the input
        _useTestFeed();
        _push(0.5e8);
        _swap(key, true, AMOUNT, AMOUNT * 99 / 200);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(key, true, AMOUNT, AMOUNT * 99 / 200 - 1);
    }

    function test_adapter_rejectsStaleTestFeed() public {
        _useTestFeed();
        _push(1e8);
        vm.warp(block.timestamp + 60);
        _swap(key, true, AMOUNT, _band(AMOUNT)); // exactly 60 s old is fine

        vm.warp(block.timestamp + 1);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));

        _push(1e8); // a fresh push revives it
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_adapter_rejectsNeverPushedFeed() public {
        _useTestFeed();
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    /// Only the updater pushes, only positive answers, and rounds count up by one.
    function testFuzz_feed_push(address caller, int256 answer) public {
        _useTestFeed();
        bool ok = caller == updater && answer > 0;
        vm.prank(caller);
        if (caller != updater) vm.expectRevert(ProvisoTestFeed.NotUpdater.selector);
        else if (answer <= 0) vm.expectRevert(ProvisoTestFeed.NonPositiveAnswer.selector);
        testFeed.push(answer);
        (uint80 round, int256 a,,,) = testFeed.latestRoundData();
        assertEq(round, ok ? 1 : 0);
        assertEq(a, ok ? answer : int256(0));
    }
}
