// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title StampRoots
/// @notice Hourly Merkle roots of evidence leaves (FIRE, FILL, EXIT, PNL, EXPIRE).
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - post is restricted to an immutable poster key set at deploy; one root per hour.
///  - hourStart must be a multiple of 3600 and the hour must have ended (hourStart + 1 h <= now),
///    so a root can't be posted for an hour that is still collecting leaves.
///  - Leaf encoding (keccak(thesisId, seq, kind, data)) is off-chain; proofs are verified by
///    clients against `roots(hourStart).root`.
contract StampRoots {
    /// @dev root: Merkle root (non-zero once posted). leafCount: as reported by the poster (not
    ///      checked on-chain). postedAt: block timestamp of the post.
    struct Root {
        bytes32 root;
        uint32 leafCount;
        uint64 postedAt;
    }

    /// @notice The only address allowed to post roots (immutable, set at deploy).
    address public immutable poster;
    /// @notice Posted root by hour start (unix seconds, multiple of 3600); all zero if not posted.
    mapping(uint64 hourStart => Root) public roots;

    /// @notice A root was posted for an hour.
    /// @param hourStart Unix start of the hour (multiple of 3600).
    /// @param root The Merkle root.
    /// @param leafCount Number of leaves the poster reports under the root.
    event RootPosted(uint64 indexed hourStart, bytes32 root, uint32 leafCount);

    /// @notice The caller is not the poster.
    error NotPoster();
    /// @notice hourStart is not a multiple of 3600.
    error NotHourAligned();
    /// @notice The hour has not ended yet (hourStart + 1 h > now).
    error HourNotOver();
    /// @notice A root was already posted for this hour.
    error AlreadyPosted();
    /// @notice The root is zero.
    error EmptyRoot();

    /// @notice Deploys the root registry.
    /// @param poster_ The only address allowed to post roots (immutable; not validated).
    constructor(address poster_) {
        poster = poster_;
    }

    /// @notice Posts the Merkle root for one finished hour. Poster only; each hour can be posted once
    ///         and a posted root can never be changed.
    /// @dev Reverts NotPoster, NotHourAligned (hourStart % 3600 != 0), HourNotOver (hourStart + 3600 >
    ///      block.timestamp), EmptyRoot (root == 0) or AlreadyPosted, in that order.
    /// @param hourStart Unix start of the hour (multiple of 3600).
    /// @param root The Merkle root of that hour's evidence leaves.
    /// @param leafCount Number of leaves under the root (recorded as given).
    function post(uint64 hourStart, bytes32 root, uint32 leafCount) external {
        if (msg.sender != poster) revert NotPoster();
        if (hourStart % 1 hours != 0) revert NotHourAligned();
        if (uint256(hourStart) + 1 hours > block.timestamp) revert HourNotOver();
        if (root == 0) revert EmptyRoot();
        if (roots[hourStart].root != 0) revert AlreadyPosted();
        roots[hourStart] = Root(root, leafCount, uint64(block.timestamp));
        emit RootPosted(hourStart, root, leafCount);
    }
}
