// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ProvisoSwapAdapter
/// @notice The only contract a user's Robinhood Chain swap key may call. Swaps exact-in on a
///         Uniswap v4 pool the user's main key allow-listed, with an oracle-banded minOut, and
///         sends the output to msg.sender (the user account). Holds no funds between calls:
///         input goes straight from the account to the PoolManager.
/// @dev Completions of lines cut off in "Proviso Backend" §3 (choices made here):
///  - Allow-list = one EIP-712 `Policy` per pool, signed with plain ECDSA by the account's main
///    key (account == main-key EOA under EIP-7702; ERC-1271 is deliberately not accepted so a
///    session key can never sign a policy). Anyone may relay setPolicy. Policy nonces must strictly
///    increase per account, so applying a newer policy voids every older unapplied one. A policy
///    with expiresAt <= now (or zero caps) revokes that pool.
///  - The policy fixes currency0/currency1/fee/tickSpacing/hooks (PoolId must match exactly), the
///    Chainlink feed, which side the feed prices (`baseIsCurrency0`: feed = currency1 per
///    currency0, else currency0 per currency1), the stock-token multiplier (1e18 = 1; pass 1e18
///    when the feed is multiplierEmbedded, so it is applied once), maxSlipBps, per-tx caps for
///    each input side, and an expiry. Per-day caps stay in the Kernel permission plugin.
///  - minOut >= fair * (1 - maxSlip), fair = amountIn converted at feedAnswer * multiplier with
///    token decimals; the feed's updatedAt must be <= 60 s old ("publish time" read as Chainlink
///    updatedAt). (U) Equity feeds with long heartbeats will revert here; verify the feed type.
///  - The actual pool output must also be >= minOut (catches skewed pools and hooks that skim),
///    and the input charged can't exceed amountIn (catches hooks that overcharge).
///  - Native currency is supported as output only (swap is not payable).
///  - ponytail: multiplier is a signed constant, so a corporate action needs a re-signed policy;
///    read it from the token once the Robinhood Stock Token ABI is confirmed.
contract ProvisoSwapAdapter is EIP712, IUnlockCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

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

    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "Policy(address account,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks,address oracle,bool baseIsCurrency0,uint256 multiplier,uint16 maxSlipBps,uint256 maxIn0,uint256 maxIn1,uint64 expiresAt,uint64 nonce)"
    );
    uint256 public constant MAX_ORACLE_AGE = 60;
    uint16 public constant BPS = 10_000;

    IPoolManager public immutable poolManager;

    mapping(address account => mapping(PoolId => Policy)) internal _policies;
    mapping(address account => uint64) public lastPolicyNonce;

    event PolicySet(address indexed account, PoolId indexed poolId, uint64 nonce, uint64 expiresAt);
    event Swapped(address indexed account, PoolId indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error BadSignature();
    error StaleNonce();
    error BadPolicy();
    error NotAllowListed();
    error PolicyExpired();
    error AmountOutOfRange();
    error StaleOracle();
    error MinOutBelowBand();
    error InsufficientOutput();
    error Overcharged();
    error NativeInputUnsupported();
    error NotPoolManager();

    constructor(IPoolManager poolManager_) EIP712("Proviso Swap Adapter", "1") {
        poolManager = poolManager_;
    }

    function setPolicy(Policy calldata p, bytes calldata mainKeySig) external {
        if (p.maxSlipBps >= BPS || p.multiplier == 0) revert BadPolicy();
        if (p.nonce <= lastPolicyNonce[p.account]) revert StaleNonce();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(_hashPolicy(p)), mainKeySig);
        if (err != ECDSA.RecoverError.NoError || signer != p.account) revert BadSignature();

        lastPolicyNonce[p.account] = p.nonce;
        PoolId id = _keyOf(p).toId();
        _policies[p.account][id] = p;
        emit PolicySet(p.account, id, p.nonce, p.expiresAt);
    }

    function policyOf(address account, PoolId id) external view returns (Policy memory) {
        return _policies[account][id];
    }

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
        if (answer <= 0 || block.timestamp > updatedAt + MAX_ORACLE_AGE) revert StaleOracle();

        (address base, address quote) = p.baseIsCurrency0 ? (p.currency0, p.currency1) : (p.currency1, p.currency0);
        // fair quote out = amountIn * answer * multiplier * 10^decQ / (10^feedDec * 1e18 * 10^decB)
        uint256 num = uint256(answer) * p.multiplier * 10 ** _decimals(quote);
        uint256 den = 10 ** (uint256(feed.decimals()) + 18 + _decimals(base));
        bool sellingBase = zeroForOne == p.baseIsCurrency0;
        uint256 fair = sellingBase ? Math.mulDiv(amountIn, num, den) : Math.mulDiv(amountIn, den, num);
        return Math.mulDiv(fair, BPS - p.maxSlipBps, BPS);
    }

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
