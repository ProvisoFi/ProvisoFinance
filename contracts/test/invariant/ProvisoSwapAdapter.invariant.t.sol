// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ProvisoSwapAdapter} from "../../src/ProvisoSwapAdapter.sol";
import {MockFeed} from "../ProvisoSwapAdapter.t.sol";

/// Exposes the oracle floor so tests can check every accepted minOut against it.
contract AdapterHarness is ProvisoSwapAdapter {
    constructor(IPoolManager m, uint256 maxAge) ProvisoSwapAdapter(m, maxAge) {}

    function floorOf(address account, PoolId id, bool zeroForOne, uint256 amountIn) external view returns (uint256) {
        return _oracleFloor(_policies[account][id], zeroForOne, amountIn);
    }
}

/// The account swaps with random size and minOut while a third party skews the pool and the feed
/// moves. Ghosts count any accepted swap that broke the band, paid below minOut or overcharged.
contract AdapterHandler is Test {
    AdapterHarness public adapter;
    MockFeed feed;
    PoolKey key;
    PoolSwapTest router;
    address public account;
    uint256 public swaps;
    uint256 public belowMinOut;
    uint256 public belowBand;
    uint256 public overpaid;

    constructor(AdapterHarness a, MockFeed f, PoolKey memory k, PoolSwapTest r, address acct) {
        (adapter, feed, key, router, account) = (a, f, k, r, acct);
    }

    function swap(bool zeroForOne, uint256 amountIn, uint256 minOut) external {
        amountIn = bound(amountIn, 1, 1e16);
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 floor = adapter.floorOf(account, key.toId(), zeroForOne, amountIn);
        minOut = bound(minOut, floor * 98 / 100, floor * 102 / 100 + 1); // either side of the band edge
        (uint256 in0, uint256 out0) = (cin.balanceOf(account), cout.balanceOf(account));
        vm.startPrank(account);
        MockERC20(Currency.unwrap(cin)).approve(address(adapter), amountIn);
        try adapter.swap(key, zeroForOne, amountIn, minOut) returns (uint256 out) {
            swaps++;
            if (out < minOut || cout.balanceOf(account) - out0 != out) belowMinOut++;
            if (minOut < floor) belowBand++;
            if (in0 - cin.balanceOf(account) > amountIn) overpaid++;
        } catch {}
        MockERC20(Currency.unwrap(cin)).approve(address(adapter), 0);
        vm.stopPrank();
    }

    /// Someone else trades the pool to push its price away from the oracle.
    function skew(bool zeroForOne, uint256 amount) external {
        amount = bound(amount, 1e12, 5e18);
        router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// The feed moves within +-10% and stays fresh.
    function price(uint256 bps) external {
        feed.set(int256(1e8 * bound(bps, 9_000, 11_000) / 10_000), block.timestamp);
    }
}

contract ProvisoSwapAdapterInvariantTest is Deployers {
    AdapterHandler h;
    AdapterHarness adapter;

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e21, salt: 0}), ZERO_BYTES
        );
        adapter = new AdapterHarness(manager, 60);
        MockFeed feed = new MockFeed();
        feed.set(1e8, block.timestamp);

        uint256 pk = 0xA11CE;
        address account = vm.addr(pk);
        MockERC20(Currency.unwrap(currency0)).mint(account, 1e22);
        MockERC20(Currency.unwrap(currency1)).mint(account, 1e22);
        _allow(pk, address(feed));

        h = new AdapterHandler(adapter, feed, key, swapRouter, account);
        MockERC20(Currency.unwrap(currency0)).mint(address(h), 1e24);
        MockERC20(Currency.unwrap(currency1)).mint(address(h), 1e24);
        vm.startPrank(address(h));
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        targetContract(address(h));
    }

    function _allow(uint256 pk, address feed) internal {
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
            maxIn0: 1e16,
            maxIn1: 1e16,
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

    /// G-30/G-31/G-34: every accepted swap had minOut >= the oracle floor, paid the account
    /// >= minOut, and never took more than amountIn.
    function invariant_minOutHonoured() public view {
        assertEq(h.belowBand(), 0);
        assertEq(h.belowMinOut(), 0);
        assertEq(h.overpaid(), 0);
    }

    /// The adapter never holds tokens between calls.
    function invariant_adapterHoldsNothing() public view {
        assertEq(currency0.balanceOf(address(adapter)), 0);
        assertEq(currency1.balanceOf(address(adapter)), 0);
    }
}
