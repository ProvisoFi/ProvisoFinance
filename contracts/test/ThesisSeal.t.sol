// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ThesisSeal} from "../src/ThesisSeal.sol";

contract ThesisSealTest is Test {
    ThesisSeal seal;
    uint256 ownerPk = 0xA11CE;
    address owner;
    address relayer = makeAddr("relayer");

    bytes entry = bytes('{"when":{"all":[{"price":{"coin":"HYPE","op":">","value":40}}]}}');
    bytes exit_ = bytes('{"takeProfit":0.1}');
    bytes32 saltE = keccak256("saltE");
    bytes32 saltX = keccak256("saltX");

    function setUp() public {
        vm.warp(1_800_000_000);
        seal = new ThesisSeal();
        owner = vm.addr(ownerPk);
    }

    function _stamp(uint64 nonce) internal view returns (ThesisSeal.Stamp memory s) {
        s = ThesisSeal.Stamp({
            owner: owner,
            entryHash: keccak256(abi.encodePacked(entry, saltE)),
            exitHash: keccak256(abi.encodePacked(exit_, saltX)),
            isSealed: true,
            expiresAt: uint64(block.timestamp + 7 days),
            nonce: nonce,
            deadline: uint64(block.timestamp + 10 minutes)
        });
    }

    function _sign(uint256 pk, ThesisSeal.Stamp memory s) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Stamp(address owner,bytes32 entryHash,bytes32 exitHash,bool sealed,uint64 expiresAt,uint64 nonce,uint64 deadline)"
                ),
                s.owner,
                s.entryHash,
                s.exitHash,
                s.isSealed,
                s.expiresAt,
                s.nonce,
                s.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", seal.domainSeparator(), structHash)));
        return abi.encodePacked(r, ss, v);
    }

    function _sealed() internal returns (uint256 id) {
        ThesisSeal.Stamp memory s = _stamp(1);
        vm.prank(relayer);
        id = seal.seal(s, _sign(ownerPk, s));
    }

    // --- seal: signature, nonce, deadline, expiry ---

    function test_seal_relayedByAnyone() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        vm.expectEmit(address(seal));
        emit ThesisSeal.Sealed(1, owner, s.entryHash, s.exitHash, true, s.expiresAt);
        vm.prank(relayer);
        uint256 id = seal.seal(s, _sign(ownerPk, s));
        assertEq(id, 1);
        (address o, uint64 exp,, bool isSealed,,, bytes32 eh, bytes32 xh) = seal.theses(id);
        assertEq(o, owner);
        assertEq(exp, s.expiresAt);
        assertTrue(isSealed);
        assertEq(eh, s.entryHash);
        assertEq(xh, s.exitHash);
        assertTrue(seal.nonceUsed(owner, 1));
    }

    function test_seal_revertsOnWrongSigner() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        bytes memory sig = _sign(0xB0B, s);
        vm.expectRevert(ThesisSeal.BadSignature.selector);
        seal.seal(s, sig);
    }

    function test_seal_revertsOnTamperedStamp() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        bytes memory sig = _sign(ownerPk, s);
        s.expiresAt += 1;
        vm.expectRevert(ThesisSeal.BadSignature.selector);
        seal.seal(s, sig);
    }

    function test_seal_revertsOnGarbageSig() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        vm.expectRevert(ThesisSeal.BadSignature.selector);
        seal.seal(s, hex"1234");
    }

    function test_seal_revertsOnReusedNonce() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        bytes memory sig = _sign(ownerPk, s);
        seal.seal(s, sig);
        vm.expectRevert(ThesisSeal.NonceUsed.selector);
        seal.seal(s, sig);
    }

    function test_seal_noncesAreUnordered() public {
        ThesisSeal.Stamp memory s5 = _stamp(5);
        ThesisSeal.Stamp memory s2 = _stamp(2);
        assertEq(seal.seal(s5, _sign(ownerPk, s5)), 1);
        assertEq(seal.seal(s2, _sign(ownerPk, s2)), 2);
    }

    function test_seal_revertsAfterDeadline() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        bytes memory sig = _sign(ownerPk, s);
        vm.warp(s.deadline + 1);
        vm.expectRevert(ThesisSeal.DeadlinePassed.selector);
        seal.seal(s, sig);
    }

    function test_seal_atDeadlineOk() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        bytes memory sig = _sign(ownerPk, s);
        vm.warp(s.deadline);
        seal.seal(s, sig);
    }

    function test_seal_revertsOnExpiryOver30Days() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        s.expiresAt = uint64(block.timestamp + 30 days + 1);
        bytes memory sig = _sign(ownerPk, s);
        vm.expectRevert(ThesisSeal.BadExpiry.selector);
        seal.seal(s, sig);

        s.expiresAt = uint64(block.timestamp + 30 days);
        seal.seal(s, _sign(ownerPk, s));
    }

    function test_seal_revertsOnPastExpiry() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        s.expiresAt = uint64(block.timestamp);
        bytes memory sig = _sign(ownerPk, s);
        vm.expectRevert(ThesisSeal.BadExpiry.selector);
        seal.seal(s, sig);
    }

    function test_seal_revertsOnEmptyHash() public {
        ThesisSeal.Stamp memory s = _stamp(1);
        s.exitHash = 0;
        bytes memory sig = _sign(ownerPk, s);
        vm.expectRevert(ThesisSeal.EmptyHash.selector);
        seal.seal(s, sig);
    }

    // --- reveal ---

    function test_revealEntryAndExit() public {
        uint256 id = _sealed();
        vm.expectEmit(address(seal));
        emit ThesisSeal.EntryRevealed(id, entry, seal.FIRED());
        seal.revealEntry(id, entry, saltE, seal.FIRED());
        vm.expectEmit(address(seal));
        emit ThesisSeal.ExitRevealed(id, exit_);
        seal.revealExit(id, exit_, saltX);
    }

    function test_reveal_hashMismatch() public {
        uint256 id = _sealed();
        uint8 fired = seal.FIRED();
        vm.expectRevert(ThesisSeal.HashMismatch.selector);
        seal.revealEntry(id, entry, saltX, fired);
        vm.expectRevert(ThesisSeal.HashMismatch.selector);
        seal.revealEntry(id, exit_, saltE, fired);
        vm.expectRevert(ThesisSeal.HashMismatch.selector);
        seal.revealExit(id, exit_, saltE);
    }

    function test_reveal_double() public {
        uint256 id = _sealed();
        uint8 fired = seal.FIRED();
        seal.revealEntry(id, entry, saltE, fired);
        vm.expectRevert(ThesisSeal.AlreadyRevealed.selector);
        seal.revealEntry(id, entry, saltE, fired);
        seal.revealExit(id, exit_, saltX);
        vm.expectRevert(ThesisSeal.AlreadyRevealed.selector);
        seal.revealExit(id, exit_, saltX);
    }

    function test_reveal_unknownThesis() public {
        vm.expectRevert(ThesisSeal.UnknownThesis.selector);
        seal.revealExit(42, exit_, saltX);
    }

    function test_reveal_badKindValue() public {
        uint256 id = _sealed();
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, 4);
    }

    function test_reveal_expiredOnlyAfterExpiry() public {
        uint256 id = _sealed();
        uint8 expired = seal.EXPIRED();
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, expired);
        (, uint64 exp,,,,,,) = seal.theses(id);
        vm.warp(exp);
        seal.revealEntry(id, entry, saltE, expired);
    }

    function test_reveal_firedGraceAfterExpiry() public {
        uint256 id = _sealed();
        (, uint64 exp,,,,,,) = seal.theses(id);
        uint8 fired = seal.FIRED();
        vm.warp(exp + seal.FIRE_REVEAL_GRACE() + 1);
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, fired);
        vm.warp(exp + seal.FIRE_REVEAL_GRACE());
        seal.revealEntry(id, entry, saltE, fired);
    }

    function test_reveal_manualNoTradeOnlyWhileLive() public {
        uint256 id = _sealed();
        (, uint64 exp,,,,,,) = seal.theses(id);
        uint8 manual = seal.MANUAL_NO_TRADE();
        vm.warp(exp);
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, manual);
        vm.warp(exp - 1);
        seal.revealEntry(id, entry, saltE, manual);
    }

    // --- retire ---

    function test_retire_ownerOnly() public {
        uint256 id = _sealed();
        vm.prank(relayer);
        vm.expectRevert(ThesisSeal.NotOwner.selector);
        seal.retire(id);
    }

    function test_retire_recordsAndUnlocksRetiredKind() public {
        uint256 id = _sealed();
        uint8 retiredKind = seal.RETIRED();
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, retiredKind);

        vm.expectEmit(address(seal));
        emit ThesisSeal.Retired(id, uint64(block.timestamp), uint64(block.timestamp + 24 hours));
        vm.prank(owner);
        seal.retire(id);
        (,, uint64 retiredAt,,,,,) = seal.theses(id);
        assertEq(retiredAt, block.timestamp);

        uint8 manual = seal.MANUAL_NO_TRADE();
        vm.expectRevert(ThesisSeal.BadKind.selector);
        seal.revealEntry(id, entry, saltE, manual);
        seal.revealEntry(id, entry, saltE, retiredKind);
    }

    function test_retire_twice() public {
        uint256 id = _sealed();
        vm.startPrank(owner);
        seal.retire(id);
        vm.expectRevert(ThesisSeal.NotLive.selector);
        seal.retire(id);
    }

    function test_retire_afterExpiry() public {
        uint256 id = _sealed();
        (, uint64 exp,,,,,,) = seal.theses(id);
        vm.warp(exp);
        vm.prank(owner);
        vm.expectRevert(ThesisSeal.NotLive.selector);
        seal.retire(id);
    }

    function test_retire_afterEntryRevealed() public {
        uint256 id = _sealed();
        seal.revealEntry(id, entry, saltE, seal.FIRED());
        vm.prank(owner);
        vm.expectRevert(ThesisSeal.NotLive.selector);
        seal.retire(id);
    }
}
