// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ProvisoSwapAdapter} from "../../src/ProvisoSwapAdapter.sol";
import {SwapKeyPolicy} from "../../src/SwapKeyPolicy.sol";
import {MockFeed} from "../ProvisoSwapAdapter.t.sol";
import {MiniAccount7579} from "../utils/MiniAccount7579.sol";

/// Drives a 7702 account through its session key: random swaps (any size, any minOut), clock
/// moves, revokes and fresh re-setups. Ghosts record what each successful swap spent.
contract SwapKeyHandler is Test {
    uint256 public constant TX_CAP = 1e16;
    uint256 public constant DAY_CAP = 2.5e16;

    SwapKeyPolicy public policy;
    ProvisoSwapAdapter public adapter;
    MockFeed feed;
    PoolKey key;
    uint256 mainPk;
    address public account;
    address sess;
    SwapKeyPolicy.Policy current;
    SwapKeyPolicy.Policy revoked; // the last policy a revoke killed, replayed by `replay`
    bytes revokedSig;
    bool public active;

    address[2] public tokens;
    uint256[] public daysSeen;
    mapping(uint256 day => bool) seen;
    mapping(uint256 day => mapping(address token => uint256)) public ghostSpent;
    uint256 public swapsWhileRevoked;
    uint256 public overTxCap;
    uint256 public revivedAfterRevoke;

    constructor(SwapKeyPolicy p, ProvisoSwapAdapter a, MockFeed f, PoolKey memory k, uint256 pk, address s) {
        (policy, adapter, feed, key, mainPk, sess) = (p, a, f, k, pk, s);
        account = vm.addr(pk);
        tokens = [Currency.unwrap(k.currency0), Currency.unwrap(k.currency1)];
        _setFresh();
    }

    function swap(bool zeroForOne, uint256 amountIn, uint256 minOutBps) external {
        amountIn = bound(amountIn, 0, 2 * TX_CAP);
        uint256 minOut = amountIn * bound(minOutBps, 9_900, 10_000) / 10_000; // around the 1% band
        feed.set(1e8, block.timestamp);
        address tokenIn = zeroForOne ? tokens[0] : tokens[1];
        uint256 day = block.timestamp / 1 days;
        vm.prank(sess);
        try policy.executeSwap(current, key, zeroForOne, amountIn, minOut) {
            if (!active) swapsWhileRevoked++;
            if (amountIn > TX_CAP) overTxCap++;
            if (!seen[day]) {
                seen[day] = true;
                daysSeen.push(day);
            }
            ghostSpent[day][tokenIn] += amountIn;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
        if (active && block.timestamp >= current.expiresAt) _setFresh();
    }

    /// Revoke while a policy signed one nonce ahead (a renewal) sits unapplied.
    function revoke() external {
        if (!active) return;
        revoked = current;
        revoked.nonce = current.nonce + 1;
        revokedSig = _sign(revoked);
        vm.prank(account);
        policy.revoke();
        active = false;
    }

    /// Anyone relays the pre-revoke renewal: it must never activate.
    function replay() external {
        if (revokedSig.length == 0) return;
        try policy.setPolicy(revoked, revokedSig) {
            revivedAfterRevoke++;
        } catch {}
    }

    /// A fresh setup the way buildSwapSetup does it: lastNonce + 1.
    function resetup() external {
        _setFresh();
    }

    function dayCount() external view returns (uint256) {
        return daysSeen.length;
    }

    function _sign(SwapKeyPolicy.Policy memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(mainPk, keccak256(abi.encodePacked("\x19\x01", policy.domainSeparator(), policy.hashPolicy(p))));
        return abi.encodePacked(r, s, v);
    }

    function _setFresh() internal {
        address[] memory t = new address[](2);
        (t[0], t[1]) = (tokens[0], tokens[1]);
        uint256[] memory perTx = new uint256[](2);
        (perTx[0], perTx[1]) = (TX_CAP, TX_CAP);
        uint256[] memory perDay = new uint256[](2);
        (perDay[0], perDay[1]) = (DAY_CAP, DAY_CAP);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256(abi.encode(key));
        current = SwapKeyPolicy.Policy({
            account: account,
            sessionKey: sess,
            adapter: address(adapter),
            tokens: t,
            maxPerTx: perTx,
            maxPerDay: perDay,
            poolIds: ids,
            expiresAt: uint64(block.timestamp + 7 days),
            nonce: policy.lastNonce(account) + 1
        });
        policy.setPolicy(current, _sign(current));
        active = true;
    }
}

contract SwapKeyPolicyInvariantTest is Deployers {
    SwapKeyHandler h;
    SwapKeyPolicy policy;
    ProvisoSwapAdapter adapter;

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e21, salt: 0}), ZERO_BYTES
        );
        MockFeed feed = new MockFeed();
        feed.set(1e8, block.timestamp);
        address[] memory pinTokens = new address[](1);
        pinTokens[0] = Currency.unwrap(currency0);
        address[] memory pinOracles = new address[](1);
        pinOracles[0] = address(feed);
        adapter = new ProvisoSwapAdapter(manager, 60, Currency.unwrap(currency1), pinTokens, pinOracles);
        policy = new SwapKeyPolicy(address(adapter));

        uint256 mainPk = 0xA11CE;
        address account = vm.addr(mainPk);
        MockERC20(Currency.unwrap(currency0)).mint(account, 1e20);
        MockERC20(Currency.unwrap(currency1)).mint(account, 1e20);
        vm.signAndAttachDelegation(address(new MiniAccount7579()), mainPk);
        vm.prank(account);
        MiniAccount7579(payable(account)).installModule(2, address(policy), "");
        _allowAdapterPool(mainPk, address(feed));

        h = new SwapKeyHandler(policy, adapter, feed, key, mainPk, vm.addr(0x5E55));
        targetContract(address(h));
    }

    function _allowAdapterPool(uint256 pk, address feed) internal {
        ProvisoSwapAdapter.Policy memory a = ProvisoSwapAdapter.Policy({
            account: vm.addr(pk),
            currency0: Currency.unwrap(key.currency0),
            currency1: Currency.unwrap(key.currency1),
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: address(key.hooks),
            oracle: feed,
            baseIsCurrency0: true,
            multiplier: 1e18,
            maxSlipBps: 100,
            maxIn0: 1e30,
            maxIn1: 1e30,
            expiresAt: type(uint64).max,
            nonce: 1
        });
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    adapter.POLICY_TYPEHASH(), a.account, a.currency0, a.currency1, a.fee, a.tickSpacing, a.hooks, a.oracle
                ),
                abi.encode(a.baseIsCurrency0, a.multiplier, a.maxSlipBps, a.maxIn0, a.maxIn1, a.expiresAt, a.nonce)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparator(), structHash)));
        adapter.setPolicy(a, abi.encodePacked(r, s, v));
    }

    /// I-15: per token and UTC day, what the session key spent never exceeds the day cap (and the
    /// contract's counter agrees with the ghost); no swap ever exceeded the per-tx cap.
    function invariant_spentWithinDayCap() public view {
        for (uint256 d; d < h.dayCount(); ++d) {
            uint256 day = h.daysSeen(d);
            for (uint256 i; i < 2; ++i) {
                address t = h.tokens(i);
                assertLe(h.ghostSpent(day, t), h.DAY_CAP());
                assertEq(policy.spent(h.account(), t, day), h.ghostSpent(day, t));
            }
        }
        assertEq(h.overTxCap(), 0);
    }

    /// I-17: no allowance to the adapter is ever left standing.
    function invariant_noLeftoverAllowance() public view {
        for (uint256 i; i < 2; ++i) {
            assertEq(MockERC20(h.tokens(i)).allowance(h.account(), address(adapter)), 0);
        }
    }

    /// I-14: after a revoke the session key can't swap, and a policy signed before the revoke
    /// never activates; only a fresh main-key setup re-arms it.
    function invariant_revokeIsFinal() public view {
        assertEq(h.swapsWhileRevoked(), 0);
        assertEq(h.revivedAfterRevoke(), 0);
    }
}
