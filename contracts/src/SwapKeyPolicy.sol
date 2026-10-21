// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @dev ERC-7579 execution struct (batch mode encodes `abi.encode(Execution[])`).
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/// @dev The part of an ERC-7579 account an executor module uses (Kernel v3 implements it).
interface IERC7579Execution {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

interface ISwapAdapter {
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
}

/// @title SwapKeyPolicy
/// @notice ERC-7579 executor module that limits a session ("swap") key to one thing: on the
///         account's behalf, run the atomic batch [tokenIn.approve(adapter, amountIn),
///         adapter.swap(key, zeroForOne, amountIn, minOut)]. The module builds both calls itself,
///         so the session key never supplies a target or calldata: it cannot transfer, approve
///         anything else, or reach Permit2 / Universal Router / any other contract.
/// @dev "Proviso Backend" §3 swap-key policy. Choices made here:
///  - Used instead of the Kernel permission plugin because ZeroDev's on-chain policies can't tie the
///    approve amount to the swap amount, nor keep a per-day token-amount budget (RateLimitPolicy
///    counts calls and isn't deployed on chain 46630). Install it on the 7702-delegated account as
///    an executor (module type 2).
///  - One active policy per account, stored as its EIP-712 struct hash; the session key passes the
///    full policy each call. Signed with plain ECDSA by the account's main key (account == main-key
///    EOA under EIP-7702); ERC-1271 is not accepted so a session key can never sign a policy.
///  - Nonces strictly increase per account, so applying a newer policy voids every older one and a
///    revoked policy can't be re-applied. Revoke = account calls `revoke()` (under 7702 the main key
///    sends it directly) or uninstalls the module.
///  - Nonces live in windows of 2^32 and setPolicy only takes a nonce in lastNonce's window.
///    Revoking moves lastNonce to the start of a later window, numbered by the revoke's timestamp,
///    so every policy signed before the revoke is dead (one pre-signed for that window would have
///    had to guess the revoke's second), while a fresh setup (lastNonce + 1) still works.
///  - Caps are in tokenIn units, per allow-listed token. The day is the UTC day
///    (block.timestamp / 1 days); spend is per account and token, so re-signing doesn't reset it.
///  - The adapter is fixed at deploy and every policy must name it, so a phished signature can't
///    point the key at a router.
///  - After the batch the adapter's allowance must be back to zero (exact-amount approval only).
///  - The session key sends the tx itself (needs gas). ponytail: add a session-key-signed intent
///    path if a relayer or 4337 bundler should pay gas.
contract SwapKeyPolicy is EIP712 {
    struct Policy {
        address account;
        address sessionKey;
        address adapter;
        address[] tokens;
        uint256[] maxPerTx;
        uint256[] maxPerDay;
        bytes32[] poolIds;
        uint64 expiresAt;
        uint64 nonce;
    }

    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "Policy(address account,address sessionKey,address adapter,address[] tokens,uint256[] maxPerTx,uint256[] maxPerDay,bytes32[] poolIds,uint64 expiresAt,uint64 nonce)"
    );
    /// @dev ERC-7579 mode: callType BATCH (0x01), execType DEFAULT (revert on failure).
    bytes32 internal constant BATCH_MODE = bytes32(uint256(1) << 248);
    uint256 internal constant TYPE_EXECUTOR = 2;
    uint256 internal constant NONCE_WINDOW = 1 << 32;

    address public immutable adapter;

    mapping(address account => bytes32) public activePolicy;
    mapping(address account => uint64) public lastNonce;
    mapping(address account => mapping(address token => mapping(uint256 day => uint256))) public spent;

    event PolicySet(address indexed account, address indexed sessionKey, bytes32 policyHash, uint64 nonce, uint64 expiresAt);
    event Revoked(address indexed account);
    event SwapExecuted(address indexed account, address indexed tokenIn, bytes32 indexed poolId, uint256 amountIn, uint256 amountOut);

    error BadPolicy();
    error BadSignature();
    error StaleNonce();
    error NotSessionKey();
    error PolicyNotActive();
    error PolicyExpired();
    error PoolNotAllowed();
    error TokenNotAllowed();
    error OverTxCap();
    error OverDayCap();
    error AllowanceLeft();

    constructor(address adapter_) EIP712("Proviso Swap Key Policy", "1") {
        adapter = adapter_;
    }

    // --- main key ---

    /// @notice Activate a main-key-signed policy. Anyone may relay.
    function setPolicy(Policy calldata p, bytes calldata mainKeySig) external {
        uint256 n = p.tokens.length;
        if (
            p.adapter != adapter || n == 0 || p.maxPerTx.length != n || p.maxPerDay.length != n
                || p.poolIds.length == 0 || p.sessionKey == address(0) || p.sessionKey == p.account
                || p.expiresAt <= block.timestamp
        ) revert BadPolicy();
        for (uint256 i; i < n; ++i) {
            if (p.tokens[i] == address(0)) revert BadPolicy();
        }
        uint64 last = lastNonce[p.account];
        if (p.nonce <= last || p.nonce / NONCE_WINDOW != last / NONCE_WINDOW) revert StaleNonce();
        bytes32 h = _hashPolicy(p);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(h), mainKeySig);
        if (err != ECDSA.RecoverError.NoError || signer != p.account) revert BadSignature();

        lastNonce[p.account] = p.nonce;
        activePolicy[p.account] = h;
        emit PolicySet(p.account, p.sessionKey, h, p.nonce, p.expiresAt);
    }

    /// @notice Revoke the caller's active policy (the account itself, i.e. the main key under 7702).
    function revoke() external {
        _revoke(msg.sender);
    }

    // --- session key ---

    /// @notice The only action a session key has: exact approve + adapter.swap, atomically, as `p.account`.
    function executeSwap(Policy calldata p, PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != p.sessionKey) revert NotSessionKey();
        bytes32 active = activePolicy[p.account];
        if (active == bytes32(0) || active != _hashPolicy(p)) revert PolicyNotActive();
        if (block.timestamp >= p.expiresAt) revert PolicyExpired();

        bytes32 poolId = keccak256(abi.encode(key));
        if (!_contains(p.poolIds, poolId)) revert PoolNotAllowed();
        address tokenIn = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        uint256 i = _indexOf(p.tokens, tokenIn);
        if (amountIn == 0 || amountIn > p.maxPerTx[i]) revert OverTxCap();
        uint256 day = block.timestamp / 1 days;
        uint256 total = spent[p.account][tokenIn][day] + amountIn;
        if (total > p.maxPerDay[i]) revert OverDayCap();
        spent[p.account][tokenIn][day] = total;

        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(tokenIn, 0, abi.encodeCall(IERC20.approve, (adapter, amountIn)));
        calls[1] = Execution(adapter, 0, abi.encodeCall(ISwapAdapter.swap, (key, zeroForOne, amountIn, minOut)));
        bytes[] memory ret = IERC7579Execution(p.account).executeFromExecutor(BATCH_MODE, abi.encode(calls));

        if (IERC20(tokenIn).allowance(p.account, adapter) != 0) revert AllowanceLeft();
        amountOut = abi.decode(ret[1], (uint256));
        emit SwapExecuted(p.account, tokenIn, poolId, amountIn, amountOut);
    }

    // --- views ---

    function hashPolicy(Policy calldata p) external pure returns (bytes32) {
        return _hashPolicy(p);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Amount of `token` the account may still swap today (0 if the token isn't allow-listed).
    function remainingToday(Policy calldata p, address token) external view returns (uint256) {
        for (uint256 i; i < p.tokens.length; ++i) {
            if (p.tokens[i] == token) {
                uint256 s = spent[p.account][token][block.timestamp / 1 days];
                return s >= p.maxPerDay[i] ? 0 : p.maxPerDay[i] - s;
            }
        }
        return 0;
    }

    // --- ERC-7579 module ---

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {
        _revoke(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == TYPE_EXECUTOR;
    }

    function isInitialized(address account) external view returns (bool) {
        return activePolicy[account] != bytes32(0);
    }

    // --- internal ---

    /// @dev Clears the active policy and voids every signed-but-unapplied one (a later nonce window).
    function _revoke(address account) private {
        uint256 w = uint256(lastNonce[account]) / NONCE_WINDOW + 1;
        uint256 next = (w > block.timestamp ? w : block.timestamp) * NONCE_WINDOW;
        lastNonce[account] = next > type(uint64).max ? type(uint64).max : uint64(next);
        delete activePolicy[account];
        emit Revoked(account);
    }

    function _hashPolicy(Policy calldata p) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                p.account,
                p.sessionKey,
                p.adapter,
                keccak256(abi.encodePacked(p.tokens)),
                keccak256(abi.encodePacked(p.maxPerTx)),
                keccak256(abi.encodePacked(p.maxPerDay)),
                keccak256(abi.encodePacked(p.poolIds)),
                p.expiresAt,
                p.nonce
            )
        );
    }

    function _contains(bytes32[] calldata xs, bytes32 x) private pure returns (bool) {
        for (uint256 i; i < xs.length; ++i) {
            if (xs[i] == x) return true;
        }
        return false;
    }

    function _indexOf(address[] calldata xs, address x) private pure returns (uint256) {
        for (uint256 i; i < xs.length; ++i) {
            if (xs[i] == x) return i;
        }
        revert TokenNotAllowed();
    }
}
