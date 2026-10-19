// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FeeTakingHook} from "@uniswap/v4-core/src/test/FeeTakingHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ProvisoSwapAdapter} from "../src/ProvisoSwapAdapter.sol";

contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public constant decimals = 8;

    function set(int256 a, uint256 t) external {
        (answer, updatedAt) = (a, t);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract ProvisoSwapAdapterTest is Deployers {
    ProvisoSwapAdapter adapter;
    MockFeed feed;
    uint256 mainPk = 0xA11CE;
    address account;
    // `key` (from Deployers) is the allow-listed pool, priced 1:1 like the oracle
    uint256 constant AMOUNT = 1e15;

    ModifyLiquidityParams DEEP = ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e21, salt: 0});

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key, DEEP, ZERO_BYTES);

        adapter = new ProvisoSwapAdapter(manager);
        feed = new MockFeed();
        feed.set(1e8, block.timestamp);
        account = vm.addr(mainPk);
        MockERC20(Currency.unwrap(currency0)).mint(account, 1e18);
        MockERC20(Currency.unwrap(currency1)).mint(account, 1e18);
        _setPolicy(_policy(key, 1));
    }

    // --- helpers ---

    function _policy(PoolKey memory k, uint64 nonce) internal view returns (ProvisoSwapAdapter.Policy memory) {
        return ProvisoSwapAdapter.Policy({
            account: account,
            currency0: Currency.unwrap(k.currency0),
            currency1: Currency.unwrap(k.currency1),
            fee: k.fee,
            tickSpacing: k.tickSpacing,
            hooks: address(k.hooks),
            oracle: address(feed),
            baseIsCurrency0: true,
            multiplier: 1e18,
            maxSlipBps: 100,
            maxIn0: 1e16,
            maxIn1: 1e16,
            expiresAt: uint64(block.timestamp + 30 days),
            nonce: nonce
        });
    }

    function _sign(uint256 pk, ProvisoSwapAdapter.Policy memory p) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    keccak256(
                        "Policy(address account,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks,address oracle,bool baseIsCurrency0,uint256 multiplier,uint16 maxSlipBps,uint256 maxIn0,uint256 maxIn1,uint64 expiresAt,uint64 nonce)"
                    ),
                    p.account,
                    p.currency0,
                    p.currency1,
                    p.fee,
                    p.tickSpacing,
                    p.hooks,
                    p.oracle
                ),
                abi.encode(p.baseIsCurrency0, p.multiplier, p.maxSlipBps, p.maxIn0, p.maxIn1, p.expiresAt, p.nonce)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _setPolicy(ProvisoSwapAdapter.Policy memory p) internal {
        adapter.setPolicy(p, _sign(mainPk, p));
    }

    /// The swap key's user-op: exact approve to the adapter, then adapter.swap, as the account.
    function _swap(PoolKey memory k, bool zeroForOne, uint256 amountIn, uint256 minOut) internal returns (uint256) {
        Currency cin = zeroForOne ? k.currency0 : k.currency1;
        vm.startPrank(account);
        MockERC20(Currency.unwrap(cin)).approve(address(adapter), amountIn);
        uint256 out = adapter.swap(k, zeroForOne, amountIn, minOut);
        vm.stopPrank();
        return out;
    }

    function _band(uint256 amountIn) internal pure returns (uint256) {
        return amountIn * 99 / 100; // oracle 1:1, maxSlip 1%
    }

    function _hookPool() internal returns (PoolKey memory k) {
        address hookAddr = address(
            uint160(
                Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                    | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                    | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
            )
        );
        vm.etch(hookAddr, address(new FeeTakingHook(manager)).code);
        (k,) = initPool(currency0, currency1, IHooks(hookAddr), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(k, DEEP, ZERO_BYTES);
    }

    // --- happy paths ---

    function test_swap_zeroForOne_outputToAccount() public {
        uint256 before1 = currency1.balanceOf(account);
        uint256 out = _swap(key, true, AMOUNT, _band(AMOUNT));
        assertGt(out, _band(AMOUNT));
        assertEq(currency1.balanceOf(account) - before1, out);
        assertEq(currency0.balanceOf(address(adapter)), 0);
        assertEq(currency1.balanceOf(address(adapter)), 0);
    }

    function test_swap_oneForZero() public {
        uint256 before0 = currency0.balanceOf(account);
        uint256 out = _swap(key, false, AMOUNT, _band(AMOUNT));
        assertEq(currency0.balanceOf(account) - before0, out);
    }

    function test_swap_multiplierAppliedOnce() public {
        // stock token with multiplier 2: feed quotes 0.5, token is worth 1.0
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.multiplier = 2e18;
        _setPolicy(p);
        feed.set(0.5e8, block.timestamp);
        _swap(key, true, AMOUNT, _band(AMOUNT));

        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT) - 1);
    }

    function test_swap_mixedDecimals() public {
        // 18-dec token vs 6-dec USDG, both worth 1.0; oracle quotes the token in USDG
        MockERC20 usdg = new MockERC20("USDG", "USDG", 6);
        usdg.mint(address(this), 1e30);
        usdg.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdg.mint(account, 1e12);
        Currency tok = currency0;
        Currency u = Currency.wrap(address(usdg));
        bool tokIs0 = Currency.unwrap(tok) < Currency.unwrap(u);
        (Currency c0, Currency c1) = tokIs0 ? (tok, u) : (u, tok);
        uint160 sqrtP = tokIs0 ? 79228162514264337593543 : 79228162514264337593543950336000000; // 1e-12 or 1e12 raw
        (PoolKey memory k,) = initPool(c0, c1, IHooks(address(0)), 3000, 60, sqrtP);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e15,
                salt: 0
            }),
            ZERO_BYTES
        );
        ProvisoSwapAdapter.Policy memory p = _policy(k, 2);
        p.baseIsCurrency0 = tokIs0;
        (p.maxIn0, p.maxIn1) = (1e30, 1e30);
        _setPolicy(p);

        assertGt(_swap(k, tokIs0, 1e18, 0.99e6), 0.99e6); // sell 1 token for >= 0.99 USDG
        assertGt(_swap(k, !tokIs0, 1e6, 0.99e18), 0.99e18); // sell 1 USDG for >= 0.99 token

        vm.startPrank(account);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(k, tokIs0, 1e18, 0.99e6 - 1);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(k, !tokIs0, 1e6, 0.99e18 - 1);
    }

    // --- required reverts ---

    function test_revert_poolNotAllowListed() public {
        (PoolKey memory other,) = initPool(currency0, currency1, IHooks(address(0)), 500, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(other, DEEP, ZERO_BYTES);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.NotAllowListed.selector);
        adapter.swap(other, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_policyIsPerAccount() public {
        vm.prank(makeAddr("someoneElse"));
        vm.expectRevert(ProvisoSwapAdapter.NotAllowListed.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_maliciousHookPool_notAllowListed() public {
        PoolKey memory hooked = _hookPool();
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.NotAllowListed.selector);
        adapter.swap(hooked, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_maliciousHookPool_evenIfAllowListed() public {
        // hook skims 1.23% of the output; the actual-output check catches it
        PoolKey memory hooked = _hookPool();
        _setPolicy(_policy(hooked, 2));
        vm.startPrank(account);
        MockERC20(Currency.unwrap(currency0)).approve(address(adapter), AMOUNT);
        vm.expectRevert(ProvisoSwapAdapter.InsufficientOutput.selector);
        adapter.swap(hooked, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_skewedPool() public {
        // allow-listed pool trading at 0.5 while the oracle says 1.0
        (PoolKey memory skewed,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 10, SQRT_PRICE_1_2);
        modifyLiquidityRouter.modifyLiquidity(
            skewed, ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e21, salt: 0}), ZERO_BYTES
        );
        _setPolicy(_policy(skewed, 2));
        vm.startPrank(account);
        MockERC20(Currency.unwrap(currency0)).approve(address(adapter), AMOUNT);
        vm.expectRevert(ProvisoSwapAdapter.InsufficientOutput.selector);
        adapter.swap(skewed, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_staleOracle() public {
        vm.warp(block.timestamp + 61);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));

        feed.set(1e8, block.timestamp - 60); // exactly 60 s old is fine
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_nonPositiveOracle() public {
        feed.set(0, block.timestamp);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_minOutBelowBand() public {
        vm.startPrank(account);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT) - 1);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        adapter.swap(key, false, AMOUNT, 0);
    }

    function test_revert_overPerTxCap() public {
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.AmountOutOfRange.selector);
        adapter.swap(key, true, 1e16 + 1, _band(1e16 + 1));
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.AmountOutOfRange.selector);
        adapter.swap(key, true, 0, 0);
    }

    function test_revert_withoutExactApproval() public {
        vm.prank(account);
        vm.expectRevert();
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_policyExpired() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.expiresAt = uint64(block.timestamp + 1 hours);
        _setPolicy(p);
        vm.warp(block.timestamp + 1 hours);
        feed.set(1e8, block.timestamp);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.PolicyExpired.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    // --- policy registration ---

    function test_setPolicy_wrongSigner() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        bytes memory sig = _sign(0xB0B, p);
        vm.expectRevert(ProvisoSwapAdapter.BadSignature.selector);
        adapter.setPolicy(p, sig);
    }

    function test_setPolicy_replayAndStaleNonce() public {
        ProvisoSwapAdapter.Policy memory p1 = _policy(key, 1);
        bytes memory sig1 = _sign(mainPk, p1);
        vm.expectRevert(ProvisoSwapAdapter.StaleNonce.selector);
        adapter.setPolicy(p1, sig1);

        _setPolicy(_policy(key, 5));
        ProvisoSwapAdapter.Policy memory p3 = _policy(key, 3);
        bytes memory sig3 = _sign(mainPk, p3);
        vm.expectRevert(ProvisoSwapAdapter.StaleNonce.selector);
        adapter.setPolicy(p3, sig3);
    }

    function test_setPolicy_badSlip() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.maxSlipBps = 10_000;
        bytes memory sig = _sign(mainPk, p);
        vm.expectRevert(ProvisoSwapAdapter.BadPolicy.selector);
        adapter.setPolicy(p, sig);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(ProvisoSwapAdapter.NotPoolManager.selector);
        adapter.unlockCallback(abi.encode(account, key, true, AMOUNT));
    }
}
