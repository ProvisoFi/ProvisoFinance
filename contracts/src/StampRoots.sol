// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StampRoots
/// @notice Hourly Merkle roots of evidence leaves (FIRE, FILL, EXIT, PNL, EXPIRE).
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - post is restricted to an immutable poster key set at deploy; one root per hour.
///  - hourStart must be a multiple of 3600 and the hour must have ended (hourStart + 1 h <= now),
///    so a root can't be posted for an hour that is still collecting leaves.
///  - Leaf encoding (keccak(thesisId, seq, kind, data)) is off-chain; proofs are verified by
///    clients against `roots(hourStart).root`.
contract StampRoots {
    struct Root {
        bytes32 root;
        uint32 leafCount;
        uint64 postedAt;
    }

    address public immutable poster;
    mapping(uint64 hourStart => Root) public roots;

    event RootPosted(uint64 indexed hourStart, bytes32 root, uint32 leafCount);

    error NotPoster();
    error NotHourAligned();
    error HourNotOver();
    error AlreadyPosted();
    error EmptyRoot();

    constructor(address poster_) {
        poster = poster_;
    }

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
