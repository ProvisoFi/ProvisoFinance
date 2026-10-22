// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ProvisoTestFeed
/// @notice TESTNET ONLY. NEVER USE ON MAINNET. A push price feed for Robinhood Chain testnet
///         (46630), which has no Chainlink feeds. One trusted hot key (`updater`, the ops relayer)
///         sets the price with no aggregation, no deviation bounds and no circuit breaker: whoever
///         holds that key sets every price an adapter policy using this feed will accept.
/// @dev Chainlink AggregatorV3Interface-compatible, as ProvisoSwapAdapter reads it: 8 decimals,
///      updatedAt = block.timestamp of the push (the adapter rejects answers older than its
///      maxOracleAge, 60 s on testnet).
///      The answer is the token price in the quote token, multiplier already embedded (like
///      Robinhood's Stock Token feeds), so adapter policies pricing off it use multiplier = 1e18.
contract ProvisoTestFeed {
    /// @dev answer: pushed price (> 0). updatedAt: block timestamp of the push (0 = no round).
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    /// @notice Decimals of `answer` (Chainlink-style).
    uint8 public constant decimals = 8;
    /// @notice Aggregator interface version.
    uint256 public constant version = 1;
    /// @notice The only address allowed to push prices (immutable).
    address public immutable updater;
    /// @notice Human-readable feed name, set at deploy.
    string public description;
    /// @notice Id of the most recent round (0 before the first push; rounds start at 1).
    uint80 public latestRound;
    mapping(uint80 roundId => Round) internal _rounds;

    /// @notice A new price was pushed.
    /// @param current The new answer.
    /// @param roundId The new round id.
    /// @param updatedAt Block timestamp of the push.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    /// @notice The caller is not the updater.
    error NotUpdater();
    /// @notice The pushed answer is zero or negative.
    error NonPositiveAnswer();
    /// @notice The requested round does not exist.
    error NoDataPresent();

    /// @notice Deploys the feed.
    /// @param updater_ The only address allowed to push prices (immutable; not validated).
    /// @param description_ Feed name returned by description().
    constructor(address updater_, string memory description_) {
        updater = updater_;
        description = description_;
    }

    /// @notice Pushes a new price as the next round, timestamped with the current block. Updater only.
    /// @dev Reverts NotUpdater or NonPositiveAnswer (answer <= 0). No bounds or deviation checks.
    /// @param answer The price, 8 decimals, multiplier embedded.
    function push(int256 answer) external {
        if (msg.sender != updater) revert NotUpdater();
        if (answer <= 0) revert NonPositiveAnswer();
        uint80 id = ++latestRound;
        _rounds[id] = Round(answer, uint64(block.timestamp));
        emit AnswerUpdated(answer, id, block.timestamp);
    }

    /// @notice Data for one round, Chainlink-style. Reverts NoDataPresent for a round never pushed.
    /// @param roundId The round id (1..latestRound).
    /// @return The round id queried.
    /// @return answer The pushed price.
    /// @return startedAt The push timestamp (same as updatedAt).
    /// @return updatedAt The push timestamp.
    /// @return answeredInRound The round id queried.
    function getRoundData(uint80 roundId)
        public
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    /// @notice Data for the latest round, Chainlink-style.
    /// @dev All zeros before the first push, so readers see answer 0 / updatedAt 0 (the adapter
    ///      reverts StaleOracle) instead of an unexpected revert.
    /// @return The latest round id.
    /// @return answer The latest price.
    /// @return startedAt The latest push timestamp (same as updatedAt).
    /// @return updatedAt The latest push timestamp.
    /// @return answeredInRound The latest round id.
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
