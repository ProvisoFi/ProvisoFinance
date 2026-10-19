// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StampRoots} from "../src/StampRoots.sol";

contract StampRootsTest is Test {
    StampRoots roots;
    address poster = makeAddr("poster");
    uint64 hour;

    function setUp() public {
        vm.warp(1_800_000_000);
        roots = new StampRoots(poster);
        hour = uint64(block.timestamp / 3600 * 3600 - 3600); // last completed hour
    }

    function test_post() public {
        vm.expectEmit(address(roots));
        emit StampRoots.RootPosted(hour, bytes32("root"), 7);
        vm.prank(poster);
        roots.post(hour, bytes32("root"), 7);
        (bytes32 r, uint32 n, uint64 postedAt) = roots.roots(hour);
        assertEq(r, bytes32("root"));
        assertEq(n, 7);
        assertEq(postedAt, block.timestamp);
    }

    function test_post_onlyPoster() public {
        vm.expectRevert(StampRoots.NotPoster.selector);
        roots.post(hour, bytes32("root"), 7);
    }

    function test_post_oncePerHour() public {
        vm.startPrank(poster);
        roots.post(hour, bytes32("root"), 7);
        vm.expectRevert(StampRoots.AlreadyPosted.selector);
        roots.post(hour, bytes32("other"), 8);
    }

    function test_post_aligned() public {
        vm.prank(poster);
        vm.expectRevert(StampRoots.NotHourAligned.selector);
        roots.post(hour + 1, bytes32("root"), 7);
    }

    function test_post_hourMustBeOver() public {
        vm.prank(poster);
        vm.expectRevert(StampRoots.HourNotOver.selector);
        roots.post(hour + 3600, bytes32("root"), 7);
    }

    function test_post_emptyRoot() public {
        vm.prank(poster);
        vm.expectRevert(StampRoots.EmptyRoot.selector);
        roots.post(hour, 0, 0);
    }
}
