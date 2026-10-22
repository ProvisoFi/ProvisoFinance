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
import {ProvisoSwapAdapter, IStockToken} from "../src/ProvisoSwapAdapter.sol";
import {AdapterHarness} from "./invariant/ProvisoSwapAdapter.invariant.t.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

        feed = new MockFeed();
        feed.set(1e8, block.timestamp);
        adapter = _newAdapter(60, address(feed));
        account = vm.addr(mainPk);
        MockERC20(Currency.unwrap(currency0)).mint(account, 1e18);
        MockERC20(Currency.unwrap(currency1)).mint(account, 1e18);
        _setPolicy(_policy(key, 1));
    }

    // --- helpers ---

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    /// The deploy shape: currency0 is the stock token pinned to `oracle`, currency1 the quote.
    function _newAdapter(uint256 age, address oracle) internal returns (ProvisoSwapAdapter) {
        return new ProvisoSwapAdapter(manager, age, Currency.unwrap(currency1), _one(Currency.unwrap(currency0)), _one(oracle));
    }

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
        adapter = new ProvisoSwapAdapter(manager, 60, address(usdg), _one(Currency.unwrap(tok)), _one(address(feed)));
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

        p.maxSlipBps = 1_001; // above MAX_SLIP_BPS
        sig = _sign(mainPk, p);
        vm.expectRevert(ProvisoSwapAdapter.BadPolicy.selector);
        adapter.setPolicy(p, sig);

        p.maxSlipBps = 1_000;
        _setPolicy(p);
    }

    function test_setPolicy_zeroMultiplier() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.multiplier = 0;
        bytes memory sig = _sign(mainPk, p);
        vm.expectRevert(ProvisoSwapAdapter.BadPolicy.selector);
        adapter.setPolicy(p, sig);
    }

    // --- pinned price source (v2) ---

    function _expectPinReject(ProvisoSwapAdapter.Policy memory p, bytes4 err) internal {
        bytes memory sig = _sign(mainPk, p);
        vm.expectRevert(err);
        adapter.setPolicy(p, sig);
    }

    function test_pins_stored() public view {
        assertEq(adapter.oracleOf(Currency.unwrap(currency0)), address(feed));
        assertEq(adapter.oracleOf(Currency.unwrap(currency1)), address(0));
        assertEq(adapter.quoteToken(), Currency.unwrap(currency1));
        assertEq(adapter.MULTIPLIER(), 1e18);
    }

    function test_setPolicy_wrongOracle() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.oracle = address(new MockFeed()); // a feed the signer was tricked into naming
        _expectPinReject(p, ProvisoSwapAdapter.OracleNotPinned.selector);
        p.oracle = address(0);
        _expectPinReject(p, ProvisoSwapAdapter.OracleNotPinned.selector);
    }

    function test_setPolicy_unpinnedBase() public {
        // flipping baseIsCurrency0 makes the quote token the priced side: it has no pin
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.baseIsCurrency0 = false;
        _expectPinReject(p, ProvisoSwapAdapter.OracleNotPinned.selector);
    }

    function test_setPolicy_wrongQuote() public {
        // the pinned stock token against something other than the quote token (a junk pool)
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.currency1 = makeAddr("junk");
        _expectPinReject(p, ProvisoSwapAdapter.OracleNotPinned.selector);
    }

    function test_setPolicy_multiplierPinned() public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        p.multiplier = 2e18;
        _expectPinReject(p, ProvisoSwapAdapter.BadPolicy.selector);
        p.multiplier = 1e18 - 1;
        _expectPinReject(p, ProvisoSwapAdapter.BadPolicy.selector);
        p.multiplier = 1e18;
        _setPolicy(p);
    }

    /// setPolicy accepts a signed policy iff its oracle, multiplier, priced side and quote are the
    /// pinned ones; whatever is signed, a stored policy prices off the pinned feed.
    function testFuzz_setPolicy_pins(address oracle, uint256 multiplier, bool base0, bool junkQuote, uint8 pick) public {
        ProvisoSwapAdapter.Policy memory p = _policy(key, 2);
        if (pick % 4 == 0) oracle = address(feed);
        if (pick % 3 == 0) multiplier = 1e18;
        p.oracle = oracle;
        p.multiplier = multiplier;
        p.baseIsCurrency0 = base0;
        if (junkQuote) p.currency1 = makeAddr("junk");
        bool ok = oracle == address(feed) && multiplier == 1e18 && base0 && !junkQuote;
        bytes memory sig = _sign(mainPk, p);
        if (multiplier != 1e18) vm.expectRevert(ProvisoSwapAdapter.BadPolicy.selector);
        else if (!ok) vm.expectRevert(ProvisoSwapAdapter.OracleNotPinned.selector);
        adapter.setPolicy(p, sig);
        if (ok) assertEq(adapter.policyOf(account, key.toId()).oracle, address(feed));
    }

    function test_constructor_badPins() public {
        address t = Currency.unwrap(currency0);
        address q = Currency.unwrap(currency1);
        address o = address(feed);
        address[] memory two = new address[](2);
        (two[0], two[1]) = (t, t);
        address[] memory twoO = new address[](2);
        (twoO[0], twoO[1]) = (o, o);
        address[] memory none = new address[](0);

        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, address(0), _one(t), _one(o)); // no quote
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, none, none); // nothing tradable
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, two, _one(o)); // length mismatch
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, _one(address(0)), _one(o)); // zero token
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, _one(t), _one(address(0))); // zero oracle
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, two, twoO); // duplicate token
        vm.expectRevert(ProvisoSwapAdapter.BadPins.selector);
        new ProvisoSwapAdapter(manager, 60, q, _one(q), _one(o)); // the quote is never priced
    }

    // --- maxOracleAge (per deployment) ---

    function test_constructor_oracleAgeBounds() public {
        vm.expectRevert(ProvisoSwapAdapter.BadOracleAge.selector);
        _newAdapter(0, address(feed));
        vm.expectRevert(ProvisoSwapAdapter.BadOracleAge.selector);
        _newAdapter(2 days + 1, address(feed));
        assertEq(_newAdapter(1, address(feed)).maxOracleAge(), 1);
        assertEq(_newAdapter(2 days, address(feed)).maxOracleAge(), 2 days);
        assertEq(adapter.maxOracleAge(), 60);
    }

    function testFuzz_constructor_oracleAge(uint256 age) public {
        if (age == 0 || age > 2 days) {
            vm.expectRevert(ProvisoSwapAdapter.BadOracleAge.selector);
            _newAdapter(age, address(feed));
        } else {
            assertEq(_newAdapter(age, address(feed)).maxOracleAge(), age);
        }
    }

    /// The band prices off a feed iff it is at most maxOracleAge old; the price math is unchanged.
    function testFuzz_maxOracleAge_staleness(uint256 age, uint256 elapsed, bool z) public {
        age = bound(age, 1, 2 days);
        elapsed = bound(elapsed, 0, 3 days);
        AdapterHarness h =
            new AdapterHarness(manager, age, Currency.unwrap(currency1), _one(Currency.unwrap(currency0)), _one(address(feed)));
        ProvisoSwapAdapter.Policy memory p = _policy(key, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(mainPk, _digestFor(h, p));
        h.setPolicy(p, abi.encodePacked(r, s, v));
        feed.set(1e8, block.timestamp - elapsed);
        PoolId id = key.toId();
        if (elapsed > age) vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        uint256 floor = h.floorOf(account, id, z, AMOUNT);
        if (elapsed <= age) assertEq(floor, _band(AMOUNT));
    }

    function test_mainnetAge_dayOldFeedSwaps() public {
        adapter = _newAdapter(90_000, address(feed));
        _setPolicy(_policy(key, 1));
        feed.set(1e8, block.timestamp - 90_000); // heartbeat + 1 h: still fine
        _swap(key, true, AMOUNT, _band(AMOUNT));
        feed.set(1e8, block.timestamp - 90_001);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.StaleOracle.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
    }

    // --- corporate-action guard (stock token = the side the feed prices) ---

    function _stock() internal view returns (address) {
        return Currency.unwrap(key.currency0); // _policy: baseIsCurrency0
    }

    function _mockPaused(address token, bool paused) internal {
        vm.mockCall(token, abi.encodeWithSelector(IStockToken.oraclePaused.selector), abi.encode(paused));
    }

    function _mockEffectiveAt(address token, uint256 t) internal {
        vm.mockCall(token, abi.encodeWithSelector(IStockToken.effectiveAt.selector), abi.encode(t));
    }

    function test_revert_oraclePaused_bothDirections() public {
        _mockPaused(_stock(), true);
        vm.startPrank(account);
        vm.expectRevert(ProvisoSwapAdapter.OraclePaused.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));
        vm.expectRevert(ProvisoSwapAdapter.OraclePaused.selector);
        adapter.swap(key, false, AMOUNT, _band(AMOUNT));
        vm.stopPrank();

        _mockPaused(_stock(), false); // unpaused: trades again
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_oraclePaused_onQuoteSideIgnored() public {
        _mockPaused(Currency.unwrap(key.currency1), true); // the quote side is not the priced token
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_multiplierChangeUnpriced() public {
        // split effective 10 s ago, feed last updated 20 s ago: the price is still pre-split
        _mockEffectiveAt(_stock(), block.timestamp - 10);
        feed.set(1e8, block.timestamp - 20);
        vm.prank(account);
        vm.expectRevert(ProvisoSwapAdapter.MultiplierChangeUnpriced.selector);
        adapter.swap(key, true, AMOUNT, _band(AMOUNT));

        feed.set(1e8, block.timestamp - 10); // first post-split update: trades again
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function test_multiplierChangeScheduled_stillSwaps() public {
        _mockEffectiveAt(_stock(), block.timestamp + 1 days); // announced, not yet effective
        _swap(key, true, AMOUNT, _band(AMOUNT));
    }

    function testFuzz_multiplierGuard(uint256 effectiveAt, uint256 updatedAgo, bool z) public {
        effectiveAt = bound(effectiveAt, 0, block.timestamp + 2 days);
        updatedAgo = bound(updatedAgo, 0, 60);
        uint256 updatedAt = block.timestamp - updatedAgo;
        _mockEffectiveAt(_stock(), effectiveAt);
        feed.set(1e8, updatedAt);
        Currency cin = z ? key.currency0 : key.currency1;
        vm.startPrank(account);
        MockERC20(Currency.unwrap(cin)).approve(address(adapter), AMOUNT);
        if (effectiveAt != 0 && effectiveAt <= block.timestamp && updatedAt < effectiveAt) {
            vm.expectRevert(ProvisoSwapAdapter.MultiplierChangeUnpriced.selector);
        }
        adapter.swap(key, z, AMOUNT, _band(AMOUNT));
        vm.stopPrank();
    }

    function test_tokensWithoutStockViews_swap() public {
        // the test tokens (like USDG) don't implement the views; the guard skips them
        (bool ok,) = _stock().staticcall(abi.encodeWithSelector(IStockToken.oraclePaused.selector));
        assertFalse(ok);
        (ok,) = _stock().staticcall(abi.encodeWithSelector(IStockToken.effectiveAt.selector));
        assertFalse(ok);
        _swap(key, true, AMOUNT, _band(AMOUNT));
        _swap(key, false, AMOUNT, _band(AMOUNT));
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(ProvisoSwapAdapter.NotPoolManager.selector);
        adapter.unlockCallback(abi.encode(account, key, true, AMOUNT));
    }

    // --- fuzz: the oracle band (minOut floor) ---

    /// The floor is fair value minus at most maxSlipBps, never above fair, monotone in amountIn,
    /// and a sell-then-buy round trip at the same price can't create value. Either side may be the
    /// priced one (the pins follow base0); the multiplier is the pinned 1e18.
    function testFuzz_oracleFloor_math(int256 answer, uint16 slip, uint256 amountIn, bool z, bool base0) public {
        (address b, address q) = base0
            ? (Currency.unwrap(currency0), Currency.unwrap(currency1))
            : (Currency.unwrap(currency1), Currency.unwrap(currency0));
        AdapterHarness h = new AdapterHarness(manager, 60, q, _one(b), _one(address(feed)));
        answer = bound(answer, 1, 1e14);
        ProvisoSwapAdapter.Policy memory p = _policy(key, 1);
        p.oracle = address(feed);
        p.maxSlipBps = uint16(bound(slip, 0, 1_000));
        p.baseIsCurrency0 = base0;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(mainPk, _digestFor(h, p));
        h.setPolicy(p, abi.encodePacked(r, s, v));
        feed.set(answer, block.timestamp);
        amountIn = bound(amountIn, 1, 1e30);

        PoolId id = key.toId();
        uint256 floor = h.floorOf(account, id, z, amountIn);
        uint256 num = uint256(answer) * p.multiplier * 1e18;
        uint256 den = 10 ** (8 + 18 + 18);
        bool sellingBase = z == base0;
        uint256 fair = sellingBase ? Math.mulDiv(amountIn, num, den) : Math.mulDiv(amountIn, den, num);
        assertLe(floor, fair);
        assertEq(floor, Math.mulDiv(fair, 10_000 - p.maxSlipBps, 10_000));
        assertGe(h.floorOf(account, id, z, amountIn + 1), floor);
        uint256 back = h.floorOf(account, id, !z, floor == 0 ? 1 : floor);
        if (floor != 0) assertLe(back, amountIn);
    }

    /// A swap is refused below the floor; when it lands, the account got >= minOut and paid amountIn.
    function testFuzz_swap_minOutHonoured(bool z, uint256 amountIn, uint256 minOut) public {
        amountIn = bound(amountIn, 1, 1e16);
        minOut = bound(minOut, 0, amountIn * 2);
        uint256 floor = amountIn * 99 / 100;
        (Currency cin, Currency cout) = z ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (uint256 in0, uint256 out0) = (cin.balanceOf(account), cout.balanceOf(account));
        vm.startPrank(account);
        MockERC20(Currency.unwrap(cin)).approve(address(adapter), amountIn);
        if (minOut < floor) {
            vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
            adapter.swap(key, z, amountIn, minOut);
            return;
        }
        try adapter.swap(key, z, amountIn, minOut) returns (uint256 out) {
            assertGe(out, minOut);
            assertEq(cout.balanceOf(account) - out0, out);
            assertEq(in0 - cin.balanceOf(account), amountIn);
        } catch {}
        vm.stopPrank();
    }

    function _digestFor(ProvisoSwapAdapter a, ProvisoSwapAdapter.Policy memory p) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    a.POLICY_TYPEHASH(), p.account, p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks, p.oracle
                ),
                abi.encode(p.baseIsCurrency0, p.multiplier, p.maxSlipBps, p.maxIn0, p.maxIn1, p.expiresAt, p.nonce)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", a.domainSeparator(), structHash));
    }
}
