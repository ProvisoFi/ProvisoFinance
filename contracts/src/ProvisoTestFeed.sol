// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProvisoTestFeed
/// @notice TESTNET ONLY. NEVER USE ON MAINNET. A push price feed for Robinhood Chain testnet
///         (46630), which has no Chainlink feeds. One trusted hot key (`updater`, the ops relayer)
///         sets the price with no aggregation, no deviation bounds and no circuit breaker: whoever
///         holds that key sets every price an adapter policy using this feed will accept.
/// @dev Chainlink AggregatorV3Interface-compatible, as ProvisoSwapAdapter reads it: 8 decimals,
///      updatedAt = block.timestamp of the push (the adapter rejects answers older than 60 s).
///      The answer is the token price in the quote token, multiplier already embedded (like
///      Robinhood's Stock Token feeds), so adapter policies pricing off it use multiplier = 1e18.
contract ProvisoTestFeed {
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    address public immutable updater;
    string public description;
    uint80 public latestRound;
    mapping(uint80 roundId => Round) internal _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error NotUpdater();
    error NonPositiveAnswer();
    error NoDataPresent();

    constructor(address updater_, string memory description_) {
        updater = updater_;
        description = description_;
    }

    function push(int256 answer) external {
        if (msg.sender != updater) revert NotUpdater();
        if (answer <= 0) revert NonPositiveAnswer();
        uint80 id = ++latestRound;
        _rounds[id] = Round(answer, uint64(block.timestamp));
        emit AnswerUpdated(answer, id, block.timestamp);
    }

    function getRoundData(uint80 roundId)
        public
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    /// @dev All zeros before the first push, so readers see answer 0 / updatedAt 0 (the adapter
    ///      reverts StaleOracle) instead of an unexpected revert.
    function latestRoundData()
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint80 id = latestRound;
        Round memory r = _rounds[id];
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }
}
