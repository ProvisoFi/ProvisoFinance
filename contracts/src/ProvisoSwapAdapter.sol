// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev Chainlink AggregatorV3Interface subset.
interface IAggregatorV3 {
    /// @notice Decimals of the feed answer.
    /// @return The answer's decimals.
    function decimals() external view returns (uint8);
    /// @notice The latest round.
    /// @return roundId Round id.
    /// @return answer Price.
    /// @return startedAt Round start time.
    /// @return updatedAt Time the answer was last updated (the adapter's staleness input).
    /// @return answeredInRound Round the answer was computed in.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev Robinhood Stock Token (ERC-8056 scaled UI) views the adapter reads, when present.
interface IStockToken {
    /// @notice Whether the token's oracle is paused (corporate action in progress).
    /// @return True while paused.
    function oraclePaused() external view returns (bool);
    /// @notice When the latest multiplier change takes (or took) effect.
    /// @return Unix time, 0 if none.
    function effectiveAt() external view returns (uint256);
}

/// @title OracleBand
/// @notice The adapter's minOut floor: fair value at the feed price, minus slipBps.
library OracleBand {
    /// @notice Lowest output the band accepts.
    /// @dev fair = amountIn * answer * multiplier * 10^decQuote / (10^feedDec * 1e18 * 10^decBase)
    ///      when selling the base token, the inverse conversion when buying it; floor = fair *
    ///      (10000 - slipBps) / 10000, both rounded down. Properties: test/halmos/OracleBand.t.sol.
    /// @param amountIn Exact input amount.
    /// @param answer Feed answer (> 0).
    /// @param multiplier 1e18-scaled factor on the answer.
    /// @param feedDec Feed decimals.
    /// @param decBase Base (priced) token decimals.
    /// @param decQuote Quote token decimals.
    /// @param sellingBase True if amountIn is the base token.
    /// @param slipBps Band width in basis points (<= 10000).
    /// @return The floor, in output-token units.
    function floor(
        uint256 amountIn,
        uint256 answer,
        uint256 multiplier,
        uint256 feedDec,
        uint256 decBase,
        uint256 decQuote,
        bool sellingBase,
        uint16 slipBps
    ) internal pure returns (uint256) {
        uint256 num = answer * multiplier * 10 ** decQuote;
        uint256 den = 10 ** (feedDec + 18 + decBase);
        uint256 fair = sellingBase ? Math.mulDiv(amountIn, num, den) : Math.mulDiv(amountIn, den, num);
        return Math.mulDiv(fair, 10_000 - slipBps, 10_000);
    }
}

/// @title ProvisoSwapAdapter
/// @notice The only swap venue a user's Robinhood Chain swap key can reach (SwapKeyPolicy makes the
///         account call it). Swaps exact-in on a Uniswap v4 pool the user's main key allow-listed,
///         with an oracle-banded minOut, and sends the output to msg.sender (the user account).
///         Holds no funds between calls: input goes straight from the account to the PoolManager.
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - Allow-list = one EIP-712 `Policy` per pool, signed with plain ECDSA by the account's main
///    key (account == main-key EOA under EIP-7702; ERC-1271 is deliberately not accepted so a
///    session key can never sign a policy). Anyone may relay setPolicy. Policy nonces must strictly
///    increase per account, so applying a newer policy voids every older unapplied one. A policy
///    with expiresAt <= now (or zero caps) revokes that pool.
///  - The policy fixes currency0/currency1/fee/tickSpacing/hooks (PoolId must match exactly), the
///    Chainlink feed, which side the feed prices (`baseIsCurrency0`: feed = currency1 per
///    currency0, else currency0 per currency1), the stock-token multiplier, maxSlipBps, per-tx caps
///    for each input side, and an expiry. Per-day caps are not enforced here; SwapKeyPolicy keeps
///    them.
///  - The price reference is pinned in this contract, not taken from the signature. The
///    constructor stores one feed per stock token (`oracleOf`) and one quote token (`quoteToken`,
///    USDG), once, with no setter or admin. setPolicy only accepts a policy whose base token (the
///    side `baseIsCurrency0` names) has a pinned feed, whose `oracle` is exactly that feed, whose
///    other side is `quoteToken`, and whose `multiplier` is 1e18 (every pinned feed embeds the
///    Stock Token multiplier). A policy signed through a compromised front-end therefore can't
///    move the floor: the feed, the side it prices, the quote and the scale are all fixed here.
///  - minOut >= fair * (1 - maxSlip), fair = amountIn converted at the feed answer with token
///    decimals (OracleBand.floor); the feed's updatedAt must be <= maxOracleAge old (immutable,
///    set per deployment: 60 s on testnet where ops pushes ProvisoTestFeed, 90000 s on mainnet =
///    the Chainlink equity feeds' 86400 s heartbeat + 1 h). Over weekends the 24/5 feeds go older
///    than that and swaps revert StaleOracle, which is the safe side.
///  - Corporate actions: the stock token (the side the feed prices) is asked oraclePaused() and
///    effectiveAt() via staticcall. A paused token, or a multiplier change that took effect after
///    the feed's last update (the price is still pre-split), refuses the swap. Tokens without
///    these views (USDG, test tokens) are skipped.
///  - No L2 sequencer-uptime check: Chainlink publishes no sequencer feed for Robinhood Chain.
///    After an outage a price up to maxOracleAge old can still pass; the band, the actual-output
///    check and the per-tx caps bound what that costs.
///  - maxSlipBps is capped on-chain at MAX_SLIP_BPS (10%), so no policy can set a floor more than
///    10% below the pinned feed's fair value.
///  - The actual pool output must also be >= minOut (catches skewed pools and hooks that skim),
///    and the input charged can't exceed amountIn (catches hooks that overcharge).
///  - Native currency is not supported (swap is not payable, and the quote side must be
///    `quoteToken`).
///  - Adding a market (a new stock token or feed) means deploying a new adapter and SwapKeyPolicy.
contract ProvisoSwapAdapter is EIP712, IUnlockCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev The main-key-signed allow-list entry for one pool. account: the account (and required
    ///      signer). currency0/currency1/fee/tickSpacing/hooks: the PoolKey. oracle: must be
    ///      oracleOf[base]. baseIsCurrency0: true if the feed prices currency0 in currency1 (the
    ///      other side must be quoteToken). multiplier: must be 1e18 (kept so the EIP-712 type is
    ///      unchanged). maxSlipBps: band width (<= 1000).
    ///      maxIn0 / maxIn1: per-swap input cap when selling currency0 / currency1. expiresAt: swaps
    ///      need now < expiresAt. nonce: must exceed the account's lastPolicyNonce.
    struct Policy {
        address account;
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        address oracle;
        bool baseIsCurrency0;
        uint256 multiplier;
        uint16 maxSlipBps;
        uint256 maxIn0;
        uint256 maxIn1;
        uint64 expiresAt;
        uint64 nonce;
    }

    /// @notice EIP-712 type hash of `Policy`.
    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "Policy(address account,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks,address oracle,bool baseIsCurrency0,uint256 multiplier,uint16 maxSlipBps,uint256 maxIn0,uint256 maxIn1,uint64 expiresAt,uint64 nonce)"
    );
    /// @notice Upper bound the constructor accepts for maxOracleAge.
    uint256 public constant MAX_ORACLE_AGE_LIMIT = 2 days;
    /// @notice The only multiplier a policy may carry (the pinned feeds embed the Stock Token one).
    uint256 public constant MULTIPLIER = 1e18;
    /// @notice Basis-point denominator.
    uint16 public constant BPS = 10_000;
    /// @notice Widest slippage band a policy may set (10%).
    uint16 public constant MAX_SLIP_BPS = 1_000;

    /// @notice The Uniswap v4 PoolManager swaps run on (immutable).
    IPoolManager public immutable poolManager;
    /// @notice Oldest feed updatedAt (seconds) a swap accepts.
    uint256 public immutable maxOracleAge;
    /// @notice The token every pool's other side must be (USDG); the pinned feeds price in it.
    address public immutable quoteToken;
    /// @notice The feed pinned for each stock token at deploy (zero = not tradable). Written only
    ///         by the constructor.
    mapping(address token => address oracle) public oracleOf;

    mapping(address account => mapping(PoolId => Policy)) internal _policies;
    /// @notice Highest policy nonce applied per account; setPolicy needs a strictly larger one.
    mapping(address account => uint64) public lastPolicyNonce;

    /// @notice A policy was applied for one of an account's pools.
    /// @param account The account.
    /// @param poolId The pool the policy covers.
    /// @param nonce The policy nonce (now lastPolicyNonce).
    /// @param expiresAt When the policy stops allowing swaps.
    event PolicySet(address indexed account, PoolId indexed poolId, uint64 nonce, uint64 expiresAt);
    /// @notice A swap completed.
    /// @param account The account that swapped and received the output.
    /// @param poolId The pool.
    /// @param zeroForOne True if currency0 was sold.
    /// @param amountIn The exact-in amount requested (the amount charged can be lower, never higher).
    /// @param amountOut Output sent to the account.
    event Swapped(address indexed account, PoolId indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    /// @notice The policy signature is malformed or not by `Policy.account`.
    error BadSignature();
    /// @notice The policy nonce is not above the account's lastPolicyNonce.
    error StaleNonce();
    /// @notice maxSlipBps > MAX_SLIP_BPS or multiplier != MULTIPLIER.
    error BadPolicy();
    /// @notice The policy's base token has no pinned feed, its oracle isn't that feed, or its other
    ///         side isn't quoteToken.
    error OracleNotPinned();
    /// @notice The constructor's pins are malformed (zero quote, empty or mismatched arrays, a zero
    ///         token or oracle, a repeated token, or a token equal to the quote token).
    error BadPins();
    /// @notice The caller has no policy for this pool.
    error NotAllowListed();
    /// @notice The pool's policy has expired.
    error PolicyExpired();
    /// @notice amountIn is zero or above the policy's cap for that input side.
    error AmountOutOfRange();
    /// @notice The feed answer is <= 0 or older than maxOracleAge.
    error StaleOracle();
    /// @notice minOut is below the oracle floor.
    error MinOutBelowBand();
    /// @notice The pool returned less than minOut.
    error InsufficientOutput();
    /// @notice The pool charged more than amountIn, or returned deltas with the wrong signs.
    error Overcharged();
    /// @notice The input currency is native (swap is not payable).
    error NativeInputUnsupported();
    /// @notice unlockCallback was called by something other than the PoolManager.
    error NotPoolManager();
    /// @notice The constructor's maxOracleAge is 0 or above MAX_ORACLE_AGE_LIMIT.
    error BadOracleAge();
    /// @notice The priced stock token reports oraclePaused().
    error OraclePaused();
    /// @notice The stock token's multiplier changed after the feed's last update.
    error MultiplierChangeUnpriced();

    /// @notice Deploys the adapter with its price sources pinned for good.
    /// @dev Reverts BadOracleAge unless 0 < maxOracleAge_ <= MAX_ORACLE_AGE_LIMIT; BadPins if
    ///      quoteToken_ is zero, the arrays are empty or differ in length, or any token or oracle is
    ///      zero, a token repeats, or a token is the quote token. Feeds are not called here.
    /// @param poolManager_ The Uniswap v4 PoolManager (immutable; not validated).
    /// @param maxOracleAge_ Oldest feed age in seconds a swap accepts (immutable).
    /// @param quoteToken_ The quote side of every pool (USDG; immutable).
    /// @param tokens Stock tokens that may be traded.
    /// @param oracles The feed pricing tokens[i] in quoteToken_ (multiplier embedded).
    constructor(
        IPoolManager poolManager_,
        uint256 maxOracleAge_,
        address quoteToken_,
        address[] memory tokens,
        address[] memory oracles
    ) EIP712("Proviso Swap Adapter", "1") {
        if (maxOracleAge_ == 0 || maxOracleAge_ > MAX_ORACLE_AGE_LIMIT) revert BadOracleAge();
        if (quoteToken_ == address(0) || tokens.length == 0 || tokens.length != oracles.length) revert BadPins();
        poolManager = poolManager_;
        maxOracleAge = maxOracleAge_;
        quoteToken = quoteToken_;
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(0) || t == quoteToken_ || oracles[i] == address(0) || oracleOf[t] != address(0)) {
                revert BadPins();
            }
            oracleOf[t] = oracles[i];
        }
    }

    /// @notice Applies a main-key-signed policy for one pool, replacing that pool's previous policy.
    ///         Anyone may relay.
    /// @dev Reverts BadPolicy if maxSlipBps > MAX_SLIP_BPS or multiplier != MULTIPLIER;
    ///      OracleNotPinned unless the base token (currency0 if baseIsCurrency0, else currency1) has
    ///      a pinned feed equal to p.oracle and the other side is quoteToken; StaleNonce if
    ///      p.nonce <= lastPolicyNonce[p.account]; BadSignature unless mainKeySig is a plain ECDSA
    ///      signature by p.account over the EIP-712 digest (ERC-1271 is not accepted). Caps,
    ///      expiresAt, fee, tickSpacing and hooks are taken as signed. Policies for the account's
    ///      other pools are untouched, but their unapplied signatures with lower nonces become
    ///      unusable.
    /// @param p The signed policy.
    /// @param mainKeySig ECDSA signature by p.account over the policy's EIP-712 digest.
    function setPolicy(Policy calldata p, bytes calldata mainKeySig) external {
        if (p.maxSlipBps > MAX_SLIP_BPS || p.multiplier != MULTIPLIER) revert BadPolicy();
        (address base, address quote) = p.baseIsCurrency0 ? (p.currency0, p.currency1) : (p.currency1, p.currency0);
        if (p.oracle == address(0) || p.oracle != oracleOf[base] || quote != quoteToken) revert OracleNotPinned();
        if (p.nonce <= lastPolicyNonce[p.account]) revert StaleNonce();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(_hashPolicy(p)), mainKeySig);
        if (err != ECDSA.RecoverError.NoError || signer != p.account) revert BadSignature();

        lastPolicyNonce[p.account] = p.nonce;
        PoolId id = _keyOf(p).toId();
        _policies[p.account][id] = p;
        emit PolicySet(p.account, id, p.nonce, p.expiresAt);
    }

    /// @notice The stored policy for an account and pool.
    /// @param account The account.
    /// @param id The pool id.
    /// @return The policy (all fields zero if none was set).
    function policyOf(address account, PoolId id) external view returns (Policy memory) {
        return _policies[account][id];
    }

    /// @notice Exact-in swap on an allow-listed pool for msg.sender (the account). Pulls up to
    ///         amountIn of the input token from msg.sender (needs an allowance to this adapter) and
    ///         sends the output to msg.sender.
    /// @dev Reverts NotAllowListed (no policy for msg.sender and this exact PoolKey), PolicyExpired
    ///      (now >= expiresAt), AmountOutOfRange (amountIn == 0 or above maxIn0 / maxIn1),
    ///      NativeInputUnsupported, StaleOracle, OraclePaused, MultiplierChangeUnpriced,
    ///      MinOutBelowBand (minOut below the oracle floor), InsufficientOutput (pool output below
    ///      minOut) or Overcharged (raised in unlockCallback). The swap runs with no price limit, so
    ///      minOut is the only output bound.
    /// @param key The pool key; its PoolId must match a policy of msg.sender.
    /// @param zeroForOne True to sell currency0 for currency1.
    /// @param amountIn Exact input amount.
    /// @param minOut Minimum output; must be >= the oracle floor.
    /// @return amountOut Output sent to msg.sender.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        PoolKey memory k = key;
        PoolId id = k.toId();
        Policy storage p = _policies[msg.sender][id];
        if (p.account == address(0)) revert NotAllowListed();
        if (block.timestamp >= p.expiresAt) revert PolicyExpired();
        if (amountIn == 0 || amountIn > (zeroForOne ? p.maxIn0 : p.maxIn1)) revert AmountOutOfRange();
        Currency currencyIn = zeroForOne ? k.currency0 : k.currency1;
        if (currencyIn.isAddressZero()) revert NativeInputUnsupported();
        if (minOut < _oracleFloor(p, zeroForOne, amountIn)) revert MinOutBelowBand();

        amountOut = abi.decode(poolManager.unlock(abi.encode(msg.sender, k, zeroForOne, amountIn)), (uint256));
        if (amountOut < minOut) revert InsufficientOutput();
        emit Swapped(msg.sender, id, zeroForOne, amountIn, amountOut);
    }

    /// @notice Lowest minOut the band accepts for this policy and trade.
    function _oracleFloor(Policy storage p, bool zeroForOne, uint256 amountIn) internal view returns (uint256) {
        IAggregatorV3 feed = IAggregatorV3(p.oracle);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || block.timestamp > updatedAt + maxOracleAge) revert StaleOracle();

        (address base, address quote) = p.baseIsCurrency0 ? (p.currency0, p.currency1) : (p.currency1, p.currency0);
        _checkCorporateAction(base, updatedAt);
        return OracleBand.floor(
            amountIn,
            uint256(answer),
            p.multiplier,
            feed.decimals(),
            _decimals(base),
            _decimals(quote),
            zeroForOne == p.baseIsCurrency0,
            p.maxSlipBps
        );
    }

    /// @dev The feed prices `base` (the stock token). Paused oracle (corporate action) or a
    ///      multiplier change that took effect after the feed's last update: refuse.
    function _checkCorporateAction(address base, uint256 updatedAt) internal view {
        if (_view(base, IStockToken.oraclePaused.selector) != 0) revert OraclePaused();
        uint256 effectiveAt = _view(base, IStockToken.effectiveAt.selector);
        if (effectiveAt != 0 && effectiveAt <= block.timestamp && updatedAt < effectiveAt) {
            revert MultiplierChangeUnpriced();
        }
    }

    /// @dev One-word view, 0 when the token doesn't implement it (revert or short return).
    function _view(address token, bytes4 selector) private view returns (uint256 v) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(selector));
        if (ok && ret.length >= 32) v = abi.decode(ret, (uint256));
    }

    /// @notice Uniswap v4 unlock callback: runs the swap and settles it. PoolManager only.
    /// @dev Reverts NotPoolManager for any other caller. The PoolManager only calls back the
    ///      contract that called unlock(), so `data` always comes from swap(). Swaps exact-in with
    ///      the extreme sqrt price limit, reverts Overcharged if the input delta is positive, the
    ///      output delta negative, or more than amountIn is charged; then pulls the charged input
    ///      from the account into the PoolManager (sync / transferFrom / settle) and takes the
    ///      output to the account.
    /// @param data abi.encode(account, PoolKey, zeroForOne, amountIn) from swap().
    /// @return abi.encode(uint256 out), the output amount sent to the account.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address account, PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (address, PoolKey, bool, uint256));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -amountIn.toInt256(),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (inDelta > 0 || outDelta < 0) revert Overcharged();
        // forge-lint: disable-next-line(unsafe-typecast) -- signs checked above
        uint256 pay = uint256(uint128(-inDelta));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 out = uint256(uint128(outDelta));
        if (pay > amountIn) revert Overcharged();

        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        poolManager.sync(cin);
        IERC20(Currency.unwrap(cin)).safeTransferFrom(account, address(poolManager), pay);
        poolManager.settle();
        poolManager.take(cout, account, out);
        return abi.encode(out);
    }

    /// @notice The EIP-712 domain separator ("Proviso Swap Adapter", "1", this chain id, this address).
    /// @return The domain separator policies must be signed under.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _hashPolicy(Policy calldata p) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                p.account,
                p.currency0,
                p.currency1,
                p.fee,
                p.tickSpacing,
                p.hooks,
                p.oracle,
                p.baseIsCurrency0,
                p.multiplier,
                p.maxSlipBps,
                p.maxIn0,
                p.maxIn1,
                p.expiresAt,
                p.nonce
            )
        );
    }

    function _keyOf(Policy calldata p) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(p.currency0), Currency.wrap(p.currency1), p.fee, p.tickSpacing, IHooks(p.hooks));
    }

    function _decimals(address token) private view returns (uint256) {
        return token == address(0) ? 18 : IERC20Metadata(token).decimals();
    }
}
