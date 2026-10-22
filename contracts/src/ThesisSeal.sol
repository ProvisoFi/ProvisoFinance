// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

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
///  - reveal: keccak256(abi.encodePacked(owner, canonical, salt)) must equal the stored hash, so a
///    copied hash pair sealed under another owner never verifies. Exit reveals are permissionless.
///    revealEntry takes an extra `kind` argument (spec event carries it). Only the `revealer`
///    (the relayer that sees fires) picks the kind, within these windows:
///      FIRED           while live, or up to FIRE_REVEAL_GRACE after expiry (executor reveals
///                      "within a minute" of a fire that may land just before expiry)
///      EXPIRED         only at/after expiresAt
///      RETIRED         only after retire()
///      MANUAL_NO_TRADE only while live and not retired
///    The owner's only reveal is the liveness fallback EXPIRED once FIRED can no longer land
///    (after expiresAt + FIRE_REVEAL_GRACE), so an owner can't relabel a pending FIRED reveal.
///    Exit reveal is independent of the entry reveal. Each part can be revealed once.
///  - retire: owner only, while live, before the entry is revealed. Records retiredAt; the entry
///    reveal is due by retiredAt + 24 h. Lateness is not enforced on-chain (the record shows it).
///  - `sealed` is a reserved word in Solidity, so the field is `isSealed`; the EIP-712 type string
///    keeps `bool sealed`.
///  - Events: Sealed(id, owner, entryHash, exitHash, isSealed, expiresAt), Retired(id, retiredAt,
///    revealDueBy).
contract ThesisSeal is EIP712 {
    /// @dev The owner-signed EIP-712 message (`isSealed` is `bool sealed` in the type string).
    ///      owner: thesis owner and required signer. entryHash / exitHash:
    ///      keccak256(abi.encodePacked(owner, canonical, salt)) of each part, both non-zero.
    ///      isSealed: the owner's sealed flag, stored and emitted as given. expiresAt: unix time the
    ///      thesis stops being live (now < expiresAt <= now + MAX_EXPIRY at seal time). nonce:
    ///      unordered per-owner replay nonce. deadline: last unix second the stamp may be relayed.
    struct Stamp {
        address owner;
        bytes32 entryHash;
        bytes32 exitHash;
        bool isSealed;
        uint64 expiresAt;
        uint64 nonce;
        uint64 deadline;
    }

    /// @dev A stored thesis. retiredAt is 0 until retire(); entryRevealed / exitRevealed flip once.
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

    /// @notice Entry reveal kind: the thesis fired (revealer only, until expiresAt + FIRE_REVEAL_GRACE).
    uint8 public constant FIRED = 0;
    /// @notice Entry reveal kind: expired without firing (revealer at/after expiresAt; owner only
    ///         after expiresAt + FIRE_REVEAL_GRACE).
    uint8 public constant EXPIRED = 1;
    /// @notice Entry reveal kind: the owner retired the thesis (revealer only, any time after retire()).
    uint8 public constant RETIRED = 2;
    /// @notice Entry reveal kind: revealed early with no trade (revealer only, while live and not retired).
    uint8 public constant MANUAL_NO_TRADE = 3;

    /// @notice Longest allowed expiry, measured from the seal block's timestamp.
    uint64 public constant MAX_EXPIRY = 30 days;
    /// @notice Time after retire() by which the entry reveal is due (emitted in Retired; not enforced).
    uint64 public constant RETIRE_REVEAL_WINDOW = 24 hours;
    /// @notice How long after expiresAt the revealer may still reveal FIRED, and how long the owner
    ///         must wait after expiresAt before revealing EXPIRED.
    uint64 public constant FIRE_REVEAL_GRACE = 1 minutes;

    /// @notice EIP-712 type hash of `Stamp` (the `isSealed` field is named `sealed` in the type string).
    bytes32 public constant STAMP_TYPEHASH = keccak256(
        "Stamp(address owner,bytes32 entryHash,bytes32 exitHash,bool sealed,uint64 expiresAt,uint64 nonce,uint64 deadline)"
    );

    /// @notice The only address that may choose an entry reveal kind (the ops relayer).
    address public immutable revealer;

    /// @notice Number of theses sealed so far; ids run from 1 to thesisCount.
    uint256 public thesisCount;
    /// @notice Thesis by id (all fields zero for an unknown id).
    mapping(uint256 id => Thesis) public theses;
    /// @notice Whether an owner's stamp nonce has already been consumed by seal().
    mapping(address owner => mapping(uint64 nonce => bool)) public nonceUsed;

    /// @notice A stamp was sealed.
    /// @param id The new thesis id.
    /// @param owner The thesis owner (the stamp signer).
    /// @param entryHash Commitment to the canonical entry.
    /// @param exitHash Commitment to the canonical exit.
    /// @param isSealed The stamp's sealed flag.
    /// @param expiresAt Unix time the thesis stops being live.
    event Sealed(
        uint256 indexed id, address indexed owner, bytes32 entryHash, bytes32 exitHash, bool isSealed, uint64 expiresAt
    );
    /// @notice The entry part was revealed.
    /// @param id The thesis id.
    /// @param canonicalEntry The revealed canonical entry bytes.
    /// @param kind The reveal kind (FIRED, EXPIRED, RETIRED or MANUAL_NO_TRADE).
    event EntryRevealed(uint256 indexed id, bytes canonicalEntry, uint8 kind);
    /// @notice The exit part was revealed.
    /// @param id The thesis id.
    /// @param canonicalExit The revealed canonical exit bytes.
    event ExitRevealed(uint256 indexed id, bytes canonicalExit);
    /// @notice The owner retired a live thesis.
    /// @param id The thesis id.
    /// @param retiredAt Block timestamp of the retire.
    /// @param revealDueBy retiredAt + RETIRE_REVEAL_WINDOW (informational; not enforced on-chain).
    event Retired(uint256 indexed id, uint64 retiredAt, uint64 revealDueBy);

    /// @notice The signature is malformed or does not recover to `Stamp.owner`.
    error BadSignature();
    /// @notice block.timestamp is past the stamp's deadline.
    error DeadlinePassed();
    /// @notice The owner already used this stamp nonce.
    error NonceUsed();
    /// @notice expiresAt is not in (now, now + MAX_EXPIRY].
    error BadExpiry();
    /// @notice entryHash or exitHash is zero.
    error EmptyHash();
    /// @notice No thesis exists with this id.
    error UnknownThesis();
    /// @notice This part was already revealed.
    error AlreadyRevealed();
    /// @notice keccak256(abi.encodePacked(owner, canonical, salt)) does not match the stored hash.
    error HashMismatch();
    /// @notice The kind is unknown, outside its time window, or not allowed for this caller.
    error BadKind();
    /// @notice The caller is not the thesis owner.
    error NotOwner();
    /// @notice The thesis is already retired, its entry is revealed, or it has expired.
    error NotLive();
    /// @notice An entry reveal from an address that is neither the revealer nor the thesis owner.
    error NotRevealer();

    /// @notice Deploys the commitment registry.
    /// @param revealer_ The relayer allowed to choose entry reveal kinds (immutable; not validated).
    constructor(address revealer_) EIP712("Proviso ThesisSeal", "1") {
        revealer = revealer_;
    }

    /// @notice Records an owner-signed two-part commitment. Anyone may relay it (sponsored gas).
    /// @dev Reverts DeadlinePassed if now > s.deadline; BadExpiry unless now < s.expiresAt <= now +
    ///      MAX_EXPIRY; EmptyHash if either hash is zero; NonceUsed if (s.owner, s.nonce) was used;
    ///      BadSignature unless ownerSig is a plain ECDSA signature by s.owner over the EIP-712
    ///      digest of `s` (ERC-1271 contract signatures are not accepted). Consumes the nonce.
    /// @param s The signed stamp.
    /// @param ownerSig ECDSA signature by s.owner over the stamp's EIP-712 digest.
    /// @return id The new thesis id (thesisCount after the increment).
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

    /// @notice Reveals the entry part with a reveal kind. Each thesis's entry can be revealed once.
    /// @dev Checks in order: the thesis exists (UnknownThesis), the entry is unrevealed
    ///      (AlreadyRevealed), keccak256(abi.encodePacked(owner, canonicalEntry, saltE)) == entryHash
    ///      (HashMismatch). Then, if the caller is the revealer: FIRED needs now <= expiresAt +
    ///      FIRE_REVEAL_GRACE; EXPIRED needs now >= expiresAt; RETIRED needs a prior retire();
    ///      MANUAL_NO_TRADE needs now < expiresAt and no retire. Else if the caller is the owner: only
    ///      EXPIRED, and only once now > expiresAt + FIRE_REVEAL_GRACE. Any other caller reverts
    ///      NotRevealer. A kind outside these rules (including kind > 3) reverts BadKind. If the
    ///      revealer is also the owner, the revealer rules apply.
    /// @param id The thesis id.
    /// @param canonicalEntry The canonical entry bytes that were committed.
    /// @param saltE The entry salt that was committed.
    /// @param kind FIRED, EXPIRED, RETIRED or MANUAL_NO_TRADE.
    function revealEntry(uint256 id, bytes calldata canonicalEntry, bytes32 saltE, uint8 kind) external {
        Thesis storage t = _get(id);
        if (t.entryRevealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(t.owner, canonicalEntry, saltE)) != t.entryHash) revert HashMismatch();

        bool live = block.timestamp < t.expiresAt;
        bool ok;
        if (msg.sender == revealer) {
            if (kind == FIRED) ok = block.timestamp <= t.expiresAt + FIRE_REVEAL_GRACE;
            else if (kind == EXPIRED) ok = !live;
            else if (kind == RETIRED) ok = t.retiredAt != 0;
            else if (kind == MANUAL_NO_TRADE) ok = live && t.retiredAt == 0;
        } else if (msg.sender == t.owner) {
            ok = kind == EXPIRED && block.timestamp > t.expiresAt + FIRE_REVEAL_GRACE;
        } else {
            revert NotRevealer();
        }
        if (!ok) revert BadKind();

        t.entryRevealed = true;
        emit EntryRevealed(id, canonicalEntry, kind);
    }

    /// @notice Reveals the exit part. Permissionless, at any time, independent of the entry reveal;
    ///         each thesis's exit can be revealed once.
    /// @dev Reverts UnknownThesis, AlreadyRevealed, or HashMismatch unless
    ///      keccak256(abi.encodePacked(owner, canonicalExit, saltX)) == exitHash.
    /// @param id The thesis id.
    /// @param canonicalExit The canonical exit bytes that were committed.
    /// @param saltX The exit salt that was committed.
    function revealExit(uint256 id, bytes calldata canonicalExit, bytes32 saltX) external {
        Thesis storage t = _get(id);
        if (t.exitRevealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(t.owner, canonicalExit, saltX)) != t.exitHash) revert HashMismatch();
        t.exitRevealed = true;
        emit ExitRevealed(id, canonicalExit);
    }

    /// @notice The owner retires a live thesis; its entry reveal is then due within RETIRE_REVEAL_WINDOW.
    /// @dev Reverts UnknownThesis; NotOwner if the caller is not the owner; NotLive if already retired,
    ///      the entry is already revealed, or now >= expiresAt. A late reveal is not penalised on-chain.
    /// @param id The thesis id.
    function retire(uint256 id) external {
        Thesis storage t = _get(id);
        if (msg.sender != t.owner) revert NotOwner();
        if (t.retiredAt != 0 || t.entryRevealed || block.timestamp >= t.expiresAt) revert NotLive();
        uint64 nowTs = uint64(block.timestamp);
        t.retiredAt = nowTs;
        emit Retired(id, nowTs, nowTs + RETIRE_REVEAL_WINDOW);
    }

    /// @notice The EIP-712 domain separator ("Proviso ThesisSeal", "1", this chain id, this address).
    /// @return The domain separator stamps must be signed under.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _get(uint256 id) private view returns (Thesis storage t) {
        t = theses[id];
        if (t.owner == address(0)) revert UnknownThesis();
    }
}
