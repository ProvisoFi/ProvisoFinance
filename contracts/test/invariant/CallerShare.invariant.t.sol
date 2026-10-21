// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {CallerShare} from "../../src/CallerShare.sol";

/// Posts 4-leaf epochs (sometimes under-funded) and fires claims: right, doubled, wrong amount,
/// wrong caller. Ghosts track what the contract should hold and who was paid.
contract CallerShareHandler is Test {
    CallerShare public share;
    MockERC20 public usdg;
    address public poster;
    address[4] public callers = [makeAddr("c0"), makeAddr("c1"), makeAddr("c2"), makeAddr("c3")];

    struct Tree {
        bytes32[4] leaves;
        uint256[4] amounts;
    }

    uint64[] public epochIds;
    mapping(uint64 => Tree) internal trees;
    uint256 public funded;
    uint256 public paid;
    mapping(uint64 => mapping(address => uint256)) public claims;

    constructor(CallerShare share_, MockERC20 usdg_, address poster_) {
        (share, usdg, poster) = (share_, usdg_, poster_);
    }

    function postEpoch(uint64 epoch, uint256[4] memory amounts, uint256 fundingBps) external {
        epoch = uint64(bound(epoch, 0, 31)); // few epochs, many claims each
        (bytes32 posted,,) = share.epochs(epoch);
        if (posted != 0) return; // posting twice is a unit test
        Tree storage t = trees[epoch];
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            amounts[i] = bound(amounts[i], 0, 1_000e6);
            t.amounts[i] = amounts[i];
            t.leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(callers[i], amounts[i]))));
            sum += amounts[i];
        }
        // 50%..100% of what the leaves owe: a bad root must not reach other epochs' funds.
        uint256 total = sum * bound(fundingBps, 5_000, 10_000) / 10_000;
        usdg.mint(poster, total);
        vm.prank(poster);
        share.postEpoch(epoch, _root(t.leaves), total);
        epochIds.push(epoch);
        funded += total;
    }

    function claim(uint256 epochSeed, uint256 i, uint256 mode) external {
        if (epochIds.length == 0) return;
        uint64 epoch = epochIds[epochSeed % epochIds.length];
        i %= 4;
        Tree storage t = trees[epoch];
        address who = callers[i];
        uint256 amount = t.amounts[i];
        mode %= 4;
        if (mode == 1) amount += 1; // inflated amount
        if (mode == 2) who = callers[(i + 1) % 4]; // someone else's proof
        uint256 before = usdg.balanceOf(who);
        try share.claim(epoch, who, amount, _proof(t.leaves, i)) {
            claims[epoch][who] += 1;
            paid += amount;
            assertEq(usdg.balanceOf(who) - before, amount);
        } catch {}
    }

    function epochCount() external view returns (uint256) {
        return epochIds.length;
    }

    function _root(bytes32[4] storage l) internal view returns (bytes32) {
        return Hashes.commutativeKeccak256(Hashes.commutativeKeccak256(l[0], l[1]), Hashes.commutativeKeccak256(l[2], l[3]));
    }

    function _proof(bytes32[4] storage l, uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = l[i ^ 1];
        p[1] = i < 2 ? Hashes.commutativeKeccak256(l[2], l[3]) : Hashes.commutativeKeccak256(l[0], l[1]);
    }
}

contract CallerShareInvariantTest is Test {
    CallerShare share;
    MockERC20 usdg;
    CallerShareHandler h;

    function setUp() public {
        usdg = new MockERC20("USDG", "USDG", 6);
        address poster = makeAddr("poster");
        share = new CallerShare(IERC20(address(usdg)), poster);
        vm.prank(poster);
        usdg.approve(address(share), type(uint256).max);
        h = new CallerShareHandler(share, usdg, poster);
        targetContract(address(h));
    }

    /// I-9: total claimed never exceeds total funded, and the contract holds exactly the difference.
    function invariant_claimedNeverExceedsFunded() public view {
        assertLe(h.paid(), h.funded());
        assertEq(usdg.balanceOf(address(share)), h.funded() - h.paid());
    }

    /// I-7/I-8: per epoch, claims stay within that epoch's funding; each leaf pays at most once.
    function invariant_perEpochFundingAndOneClaimPerLeaf() public view {
        for (uint256 e; e < h.epochCount(); ++e) {
            uint64 id = h.epochIds(e);
            (, uint256 total, uint256 claimedUsdg) = share.epochs(id);
            assertLe(claimedUsdg, total);
            for (uint256 i; i < 4; ++i) {
                address c = h.callers(i);
                assertLe(h.claims(id, c), 1);
                assertEq(share.claimed(id, c), h.claims(id, c) == 1);
            }
        }
    }
}
