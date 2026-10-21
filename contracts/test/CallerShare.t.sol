// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {CallerShare} from "../src/CallerShare.sol";

contract CallerShareTest is Test {
    CallerShare share;
    MockERC20 usdg;
    address poster = makeAddr("poster");
    address[4] callers = [makeAddr("c0"), makeAddr("c1"), makeAddr("c2"), makeAddr("c3")];
    uint256[4] amounts = [uint256(100e6), 250e6, 1e6, 49e6];
    bytes32[4] leaves;
    bytes32 root;

    function setUp() public {
        usdg = new MockERC20("USDG", "USDG", 6);
        share = new CallerShare(IERC20(address(usdg)), poster);
        usdg.mint(poster, 1_000e6);
        vm.prank(poster);
        usdg.approve(address(share), type(uint256).max);

        // OZ StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(addr, amount))))
        for (uint256 i; i < 4; i++) {
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(callers[i], amounts[i]))));
        }
        root = Hashes.commutativeKeccak256(
            Hashes.commutativeKeccak256(leaves[0], leaves[1]), Hashes.commutativeKeccak256(leaves[2], leaves[3])
        );
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2
            ? Hashes.commutativeKeccak256(leaves[2], leaves[3])
            : Hashes.commutativeKeccak256(leaves[0], leaves[1]);
    }

    function _post(uint256 total) internal {
        vm.prank(poster);
        share.postEpoch(1, root, total);
    }

    function test_postEpoch_pullsFunding() public {
        _post(400e6);
        assertEq(usdg.balanceOf(address(share)), 400e6);
        assertEq(usdg.balanceOf(poster), 600e6);
    }

    function test_postEpoch_onlyPoster() public {
        vm.expectRevert(CallerShare.NotPoster.selector);
        share.postEpoch(1, root, 400e6);
    }

    function test_postEpoch_once() public {
        _post(400e6);
        vm.prank(poster);
        vm.expectRevert(CallerShare.EpochExists.selector);
        share.postEpoch(1, root, 400e6);
    }

    function test_claim_allCallers_relayedByAnyone() public {
        _post(400e6);
        for (uint256 i; i < 4; i++) {
            vm.prank(makeAddr("relayer"));
            share.claim(1, callers[i], amounts[i], _proof(i));
            assertEq(usdg.balanceOf(callers[i]), amounts[i]);
            assertTrue(share.claimed(1, callers[i]));
        }
        assertEq(usdg.balanceOf(address(share)), 0);
    }

    function test_claim_double() public {
        _post(400e6);
        share.claim(1, callers[1], amounts[1], _proof(1));
        vm.expectRevert(CallerShare.AlreadyClaimed.selector);
        share.claim(1, callers[1], amounts[1], _proof(1));
    }

    function test_claim_badProofs() public {
        _post(400e6);
        vm.expectRevert(CallerShare.BadProof.selector);
        share.claim(1, callers[1], amounts[1] + 1, _proof(1));
        vm.expectRevert(CallerShare.BadProof.selector);
        share.claim(1, callers[2], amounts[1], _proof(1));
        vm.expectRevert(CallerShare.BadProof.selector);
        share.claim(1, callers[1], amounts[1], _proof(0));
    }

    function test_claim_unknownEpoch() public {
        vm.expectRevert(CallerShare.UnknownEpoch.selector);
        share.claim(1, callers[0], amounts[0], _proof(0));
    }

    function test_claim_cannotExceedEpochFunding() public {
        _post(300e6); // underfunded: root sums to 400e6
        share.claim(1, callers[1], amounts[1], _proof(1)); // 250
        vm.expectRevert(CallerShare.ExceedsEpochFunding.selector);
        share.claim(1, callers[0], amounts[0], _proof(0)); // +100 > 300
        share.claim(1, callers[3], amounts[3], _proof(3)); // +49 fits
    }

    /// Only an exact (caller, amount) leaf of the root pays, whoever relays it.
    function testFuzz_claim_onlyExactLeaf(uint256 i, address who, uint256 amount, address relayer) public {
        _post(400e6);
        i %= 4;
        bool exact = who == callers[i] && amount == amounts[i];
        vm.prank(relayer);
        if (!exact) vm.expectRevert(CallerShare.BadProof.selector);
        share.claim(1, who, amount, _proof(i));
        if (exact) assertEq(usdg.balanceOf(callers[i]), amounts[i]);
    }
}
