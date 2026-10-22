// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title CallerShare
/// @notice Per-epoch USDG caller-share distribution. The poster funds each epoch when posting
///         its root; callers (or anyone on their behalf) pull their amount.
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - postEpoch is poster-only (immutable key) and pulls `totalUsdg` from the poster in the same
///    call ("funded per epoch"); each epoch can be posted once.
///  - Leaf = OpenZeppelin StandardMerkleTree double hash of abi.encode(address caller, uint256
///    amount). Claims pay `caller`, never msg.sender, so relaying a claim is harmless.
///  - One claim per (epoch, caller); claims per epoch can never exceed that epoch's funding, so a
///    bad root can't drain other epochs.
///  - No sweep of unclaimed funds (not in the spec).
contract CallerShare {
    using SafeERC20 for IERC20;

    /// @dev merkleRoot: non-zero once posted. totalUsdg: amount pulled from the poster at post time.
    ///      claimedUsdg: running total paid out; invariant claimedUsdg <= totalUsdg.
    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalUsdg;
        uint256 claimedUsdg;
    }

    /// @notice The token paid out (USDG).
    IERC20 public immutable usdg;
    /// @notice The only address allowed to post (and fund) epochs.
    address public immutable poster;

    /// @notice Epoch data by epoch number (all zero if not posted).
    mapping(uint64 epoch => Epoch) public epochs;
    /// @notice Whether `caller` has claimed in `epoch`.
    mapping(uint64 epoch => mapping(address caller => bool)) public claimed;

    /// @notice An epoch was posted and funded.
    /// @param epoch The epoch number.
    /// @param merkleRoot Root over (caller, amount) leaves.
    /// @param totalUsdg USDG pulled from the poster to fund the epoch.
    event EpochPosted(uint64 indexed epoch, bytes32 merkleRoot, uint256 totalUsdg);
    /// @notice A caller's share was paid.
    /// @param epoch The epoch number.
    /// @param caller The recipient named in the leaf.
    /// @param amount USDG paid.
    event Claimed(uint64 indexed epoch, address indexed caller, uint256 amount);

    /// @notice The caller is not the poster.
    error NotPoster();
    /// @notice The Merkle root is zero.
    error EmptyRoot();
    /// @notice The epoch was already posted.
    error EpochExists();
    /// @notice The epoch has not been posted.
    error UnknownEpoch();
    /// @notice This caller already claimed in this epoch.
    error AlreadyClaimed();
    /// @notice The proof does not verify the (caller, amount) leaf against the epoch root.
    error BadProof();
    /// @notice Paying this claim would exceed the epoch's funding.
    error ExceedsEpochFunding();

    /// @notice Deploys the distributor.
    /// @param usdg_ The payout token (immutable).
    /// @param poster_ The only address allowed to post and fund epochs (immutable; not validated).
    constructor(IERC20 usdg_, address poster_) {
        usdg = usdg_;
        poster = poster_;
    }

    /// @notice Posts an epoch's Merkle root and funds it by pulling `totalUsdg` from the poster in the
    ///         same call. Poster only; each epoch number can be posted once.
    /// @dev Reverts NotPoster, EmptyRoot or EpochExists. Requires the poster's USDG allowance for this
    ///      contract to cover totalUsdg (SafeERC20 transferFrom). totalUsdg is not checked against the
    ///      leaves; it caps what the epoch can ever pay out.
    /// @param epoch The epoch number.
    /// @param merkleRoot Root of the OpenZeppelin StandardMerkleTree over (address caller, uint256 amount).
    /// @param totalUsdg USDG to fund the epoch with.
    function postEpoch(uint64 epoch, bytes32 merkleRoot, uint256 totalUsdg) external {
        if (msg.sender != poster) revert NotPoster();
        if (merkleRoot == 0) revert EmptyRoot();
        if (epochs[epoch].merkleRoot != 0) revert EpochExists();
        epochs[epoch] = Epoch(merkleRoot, totalUsdg, 0);
        usdg.safeTransferFrom(msg.sender, address(this), totalUsdg);
        emit EpochPosted(epoch, merkleRoot, totalUsdg);
    }

    /// @notice Pays `amount` USDG to `caller` for `epoch`. Anyone may submit; funds always go to
    ///         `caller`, never msg.sender.
    /// @dev Reverts UnknownEpoch, AlreadyClaimed (one claim per epoch and caller), BadProof unless
    ///      `proof` verifies leaf keccak256(bytes.concat(keccak256(abi.encode(caller, amount)))), and
    ///      ExceedsEpochFunding if claimedUsdg + amount > totalUsdg.
    /// @param epoch The epoch number.
    /// @param caller The recipient named in the leaf.
    /// @param amount The USDG amount named in the leaf.
    /// @param proof Merkle proof for the leaf.
    function claim(uint64 epoch, address caller, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == 0) revert UnknownEpoch();
        if (claimed[epoch][caller]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(caller, amount))));
        if (!MerkleProof.verifyCalldata(proof, e.merkleRoot, leaf)) revert BadProof();
        if (e.claimedUsdg + amount > e.totalUsdg) revert ExceedsEpochFunding();

        claimed[epoch][caller] = true;
        e.claimedUsdg += amount;
        usdg.safeTransfer(caller, amount);
        emit Claimed(epoch, caller, amount);
    }
}
