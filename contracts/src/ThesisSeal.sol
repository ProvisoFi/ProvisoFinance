// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ThesisSeal
/// @notice Two-part hash commitment of a trading idea (entry + exit), sealed by an owner
///         signature and relayed by anyone (sponsored gas). Revealed later against the hashes.
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - Stamp tail = `uint64 expiresAt; uint64 nonce; uint64 deadline` (the task brief's struct).
///  - seal: owner signs the Stamp (EIP-712, domain "Proviso ThesisSeal"/"1") with plain ECDSA
///    (main key is an EOA, also under EIP-7702). Requires block.timestamp <= deadline, an unused
///    per-owner nonce (unordered, so stamps can be relayed out of order), and
///    now < expiresAt <= now + 30 days (the 30-day max expiry from the red-team table).
///  - reveal: keccak256(abi.encodePacked(canonical, salt)) must equal the stored hash. Reveals are
///    permissionless (the stamper auto-reveals; knowing the preimage is the authorization).
///    revealEntry takes an extra `kind` argument (spec event carries it). Kind rules:
///      FIRED           while live, or up to FIRE_REVEAL_GRACE after expiry (executor reveals
///                      "within a minute" of a fire that may land just before expiry)
///      EXPIRED         only at/after expiresAt
///      RETIRED         only after retire()
///      MANUAL_NO_TRADE only while live and not retired
///    Exit reveal is independent of the entry reveal. Each part can be revealed once.
///  - retire: owner only, while live, before the entry is revealed. Records retiredAt; the entry
///    reveal is due by retiredAt + 24 h. Lateness is not enforced on-chain (the record shows it).
///  - `sealed` is a reserved word in Solidity, so the field is `isSealed`; the EIP-712 type string
///    keeps `bool sealed`.
///  - Events: Sealed(id, owner, entryHash, exitHash, isSealed, expiresAt), Retired(id, retiredAt,
///    revealDueBy).
contract ThesisSeal is EIP712 {
    struct Stamp {
        address owner;
        bytes32 entryHash;
        bytes32 exitHash;
        bool isSealed;
        uint64 expiresAt;
        uint64 nonce;
        uint64 deadline;
    }

    struct Thesis {
        address owner;
        uint64 expiresAt;
        uint64 retiredAt;
        bool isSealed;
        bool entryRevealed;
        bool exitRevealed;
        bytes32 entryHash;
        bytes32 exitHash;
    }

    uint8 public constant FIRED = 0;
    uint8 public constant EXPIRED = 1;
    uint8 public constant RETIRED = 2;
    uint8 public constant MANUAL_NO_TRADE = 3;

    uint64 public constant MAX_EXPIRY = 30 days;
    uint64 public constant RETIRE_REVEAL_WINDOW = 24 hours;
    uint64 public constant FIRE_REVEAL_GRACE = 1 minutes;

    bytes32 public constant STAMP_TYPEHASH = keccak256(
        "Stamp(address owner,bytes32 entryHash,bytes32 exitHash,bool sealed,uint64 expiresAt,uint64 nonce,uint64 deadline)"
    );

    uint256 public thesisCount;
    mapping(uint256 id => Thesis) public theses;
    mapping(address owner => mapping(uint64 nonce => bool)) public nonceUsed;

    event Sealed(
        uint256 indexed id, address indexed owner, bytes32 entryHash, bytes32 exitHash, bool isSealed, uint64 expiresAt
    );
    event EntryRevealed(uint256 indexed id, bytes canonicalEntry, uint8 kind);
    event ExitRevealed(uint256 indexed id, bytes canonicalExit);
    event Retired(uint256 indexed id, uint64 retiredAt, uint64 revealDueBy);

    error BadSignature();
    error DeadlinePassed();
    error NonceUsed();
    error BadExpiry();
    error EmptyHash();
    error UnknownThesis();
    error AlreadyRevealed();
    error HashMismatch();
    error BadKind();
    error NotOwner();
    error NotLive();

    constructor() EIP712("Proviso ThesisSeal", "1") {}

    function seal(Stamp calldata s, bytes calldata ownerSig) external returns (uint256 id) {
        if (block.timestamp > s.deadline) revert DeadlinePassed();
        if (s.expiresAt <= block.timestamp || s.expiresAt > block.timestamp + MAX_EXPIRY) revert BadExpiry();
        if (s.entryHash == 0 || s.exitHash == 0) revert EmptyHash();
        if (nonceUsed[s.owner][s.nonce]) revert NonceUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STAMP_TYPEHASH, s.owner, s.entryHash, s.exitHash, s.isSealed, s.expiresAt, s.nonce, s.deadline
                )
            )
        );
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, ownerSig);
        if (err != ECDSA.RecoverError.NoError || signer != s.owner) revert BadSignature();

        nonceUsed[s.owner][s.nonce] = true;
        id = ++thesisCount;
        theses[id] = Thesis({
            owner: s.owner,
            expiresAt: s.expiresAt,
            retiredAt: 0,
            isSealed: s.isSealed,
            entryRevealed: false,
            exitRevealed: false,
            entryHash: s.entryHash,
            exitHash: s.exitHash
        });
        emit Sealed(id, s.owner, s.entryHash, s.exitHash, s.isSealed, s.expiresAt);
    }

    function revealEntry(uint256 id, bytes calldata canonicalEntry, bytes32 saltE, uint8 kind) external {
        Thesis storage t = _get(id);
        if (t.entryRevealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(canonicalEntry, saltE)) != t.entryHash) revert HashMismatch();

        bool live = block.timestamp < t.expiresAt;
        bool ok;
        if (kind == FIRED) ok = block.timestamp <= t.expiresAt + FIRE_REVEAL_GRACE;
        else if (kind == EXPIRED) ok = !live;
        else if (kind == RETIRED) ok = t.retiredAt != 0;
        else if (kind == MANUAL_NO_TRADE) ok = live && t.retiredAt == 0;
        if (!ok) revert BadKind();

        t.entryRevealed = true;
        emit EntryRevealed(id, canonicalEntry, kind);
    }

    function revealExit(uint256 id, bytes calldata canonicalExit, bytes32 saltX) external {
        Thesis storage t = _get(id);
        if (t.exitRevealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(canonicalExit, saltX)) != t.exitHash) revert HashMismatch();
        t.exitRevealed = true;
        emit ExitRevealed(id, canonicalExit);
    }

    function retire(uint256 id) external {
        Thesis storage t = _get(id);
        if (msg.sender != t.owner) revert NotOwner();
        if (t.retiredAt != 0 || t.entryRevealed || block.timestamp >= t.expiresAt) revert NotLive();
        uint64 nowTs = uint64(block.timestamp);
        t.retiredAt = nowTs;
        emit Retired(id, nowTs, nowTs + RETIRE_REVEAL_WINDOW);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _get(uint256 id) private view returns (Thesis storage t) {
        t = theses[id];
        if (t.owner == address(0)) revert UnknownThesis();
    }
}
