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

    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalUsdg;
        uint256 claimedUsdg;
    }

    IERC20 public immutable usdg;
    address public immutable poster;

    mapping(uint64 epoch => Epoch) public epochs;
    mapping(uint64 epoch => mapping(address caller => bool)) public claimed;

    event EpochPosted(uint64 indexed epoch, bytes32 merkleRoot, uint256 totalUsdg);
    event Claimed(uint64 indexed epoch, address indexed caller, uint256 amount);

    error NotPoster();
    error EmptyRoot();
    error EpochExists();
    error UnknownEpoch();
    error AlreadyClaimed();
    error BadProof();
    error ExceedsEpochFunding();

    constructor(IERC20 usdg_, address poster_) {
        usdg = usdg_;
        poster = poster_;
    }

    function postEpoch(uint64 epoch, bytes32 merkleRoot, uint256 totalUsdg) external {
        if (msg.sender != poster) revert NotPoster();
        if (merkleRoot == 0) revert EmptyRoot();
        if (epochs[epoch].merkleRoot != 0) revert EpochExists();
        epochs[epoch] = Epoch(merkleRoot, totalUsdg, 0);
        usdg.safeTransferFrom(msg.sender, address(this), totalUsdg);
        emit EpochPosted(epoch, merkleRoot, totalUsdg);
    }

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
