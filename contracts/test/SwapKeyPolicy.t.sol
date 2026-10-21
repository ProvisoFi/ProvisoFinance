// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeTakingHook} from "@uniswap/v4-core/src/test/FeeTakingHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ProvisoSwapAdapter} from "../src/ProvisoSwapAdapter.sol";
import {SwapKeyPolicy, Execution} from "../src/SwapKeyPolicy.sol";
import {MockFeed} from "./ProvisoSwapAdapter.t.sol";
import {MiniAccount7579} from "./utils/MiniAccount7579.sol";
import {stdStorage, StdStorage} from "forge-std/Test.sol";

/// Approves nothing back: takes the approval, pulls nothing (leaves the allowance standing).
contract LazyAdapter {
    function swap(PoolKey calldata, bool, uint256, uint256) external pure returns (uint256) {
        return 0;
    }
}

contract SwapKeyPolicyTest is Deployers {
    using stdStorage for StdStorage;

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant BATCH = bytes32(uint256(1) << 248);
    uint256 constant AMOUNT = 1e15;
    uint256 constant TX_CAP = 1e16;
    uint256 constant DAY_CAP = 2.5e16;

    ProvisoSwapAdapter adapter;
    SwapKeyPolicy policy;
    MockFeed feed;
    MiniAccount7579 impl;

    uint256 mainPk = 0xA11CE;
    uint256 sessPk = 0x5E55;
    address account;
    address sess;

    ModifyLiquidityParams DEEP = ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e21, salt: 0});

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key, DEEP, ZERO_BYTES);

        adapter = new ProvisoSwapAdapter(manager, 60);
        policy = new SwapKeyPolicy(address(adapter));
        feed = new MockFeed();
        feed.set(1e8, block.timestamp);
        impl = new MiniAccount7579();

        account = vm.addr(mainPk);
        sess = vm.addr(sessPk);
        MockERC20(Currency.unwrap(currency0)).mint(account, 1e18);
        MockERC20(Currency.unwrap(currency1)).mint(account, 1e18);

        // EIP-7702: the main-key EOA delegates to the account code, then installs the module itself.
        vm.signAndAttachDelegation(address(impl), mainPk);
        vm.prank(account);
        MiniAccount7579(payable(account)).installModule(2, address(policy), "");

        _allowAdapterPool(key, 1);
        _activate(_policy(_ids(key), 1));
    }

    // --- helpers ---

    function _ids(PoolKey memory k) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = keccak256(abi.encode(k));
    }

    function _policy(bytes32[] memory poolIds, uint64 nonce) internal view returns (SwapKeyPolicy.Policy memory p) {
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (Currency.unwrap(currency0), Currency.unwrap(currency1));
        uint256[] memory perTx = new uint256[](2);
        (perTx[0], perTx[1]) = (TX_CAP, TX_CAP);
        uint256[] memory perDay = new uint256[](2);
        (perDay[0], perDay[1]) = (DAY_CAP, DAY_CAP);
        p = SwapKeyPolicy.Policy({
            account: account,
            sessionKey: sess,
            adapter: address(adapter),
            tokens: tokens,
            maxPerTx: perTx,
            maxPerDay: perDay,
            poolIds: poolIds,
            expiresAt: uint64(block.timestamp + 7 days),
            nonce: nonce
        });
    }

    /// EIP-712 digest computed independently of the contract (what the browser signs).
    function _digest(SwapKeyPolicy.Policy memory p) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Policy(address account,address sessionKey,address adapter,address[] tokens,uint256[] maxPerTx,uint256[] maxPerDay,bytes32[] poolIds,uint64 expiresAt,uint64 nonce)"
                ),
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
        return keccak256(abi.encodePacked("\x19\x01", policy.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, SwapKeyPolicy.Policy memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(p));
        return abi.encodePacked(r, s, v);
    }

    function _activate(SwapKeyPolicy.Policy memory p) internal {
        policy.setPolicy(p, _sign(mainPk, p));
    }

    /// Adapter-side allow-list for a pool (the adapter's own main-key-signed policy).
    function _allowAdapterPool(PoolKey memory k, uint64 nonce) internal {
        ProvisoSwapAdapter.Policy memory a = ProvisoSwapAdapter.Policy({
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
            maxIn0: 1e17,
            maxIn1: 1e17,
            expiresAt: uint64(block.timestamp + 30 days),
            nonce: nonce
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
            vm.sign(mainPk, keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparator(), structHash)));
        adapter.setPolicy(a, abi.encodePacked(r, s, v));
    }

    function _band(uint256 amountIn) internal pure returns (uint256) {
        return amountIn * 99 / 100;
    }

    function _swapAs(address who, SwapKeyPolicy.Policy memory p, PoolKey memory k, bool z, uint256 amt, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return policy.executeSwap(p, k, z, amt, minOut);
    }

    function _expectSwapRevert(bytes4 sel, SwapKeyPolicy.Policy memory p, PoolKey memory k, bool z, uint256 amt)
        internal
    {
        vm.prank(sess);
        vm.expectRevert(sel);
        policy.executeSwap(p, k, z, amt, _band(amt));
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

    function _one(Execution memory e) internal pure returns (bytes memory) {
        Execution[] memory calls = new Execution[](1);
        calls[0] = e;
        return abi.encode(calls);
    }

    // --- 7702 wiring ---

    function test_7702_accountIsDelegatedEoa() public view {
        assertEq(account.code, abi.encodePacked(hex"ef0100", address(impl)));
        assertTrue(MiniAccount7579(payable(account)).isExecutor(address(policy)));
    }

    // --- happy paths ---

    function test_swap_outputToAccount_exactApprovalConsumed() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        uint256 before0 = currency0.balanceOf(account);
        uint256 before1 = currency1.balanceOf(account);
        uint256 out = _swapAs(sess, p, key, true, AMOUNT, _band(AMOUNT));
        assertGt(out, _band(AMOUNT));
        assertEq(before0 - currency0.balanceOf(account), AMOUNT);
        assertEq(currency1.balanceOf(account) - before1, out);
        assertEq(MockERC20(Currency.unwrap(currency0)).allowance(account, address(adapter)), 0);
        assertEq(currency1.balanceOf(sess), 0);
        assertEq(policy.spent(account, Currency.unwrap(currency0), block.timestamp / 1 days), AMOUNT);
        assertEq(policy.remainingToday(p, Currency.unwrap(currency0)), DAY_CAP - AMOUNT);
    }

    function test_swap_oneForZero() public {
        uint256 before0 = currency0.balanceOf(account);
        uint256 out = _swapAs(sess, _policy(_ids(key), 1), key, false, AMOUNT, _band(AMOUNT));
        assertEq(currency0.balanceOf(account) - before0, out);
    }

    function test_hashMatchesBrowserEncoding() public view {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        bytes32 structHash = policy.hashPolicy(p);
        assertEq(keccak256(abi.encodePacked("\x19\x01", policy.domainSeparator(), structHash)), _digest(p));
        assertEq(policy.activePolicy(account), structHash);
    }

    // --- caps, expiry, revocation ---

    function test_revert_overTxCap() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        _expectSwapRevert(SwapKeyPolicy.OverTxCap.selector, p, key, true, TX_CAP + 1);
        _expectSwapRevert(SwapKeyPolicy.OverTxCap.selector, p, key, true, 0);
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP)); // exactly the cap is fine
    }

    function test_revert_overDayCap_resetsNextDay() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP));
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP));
        _expectSwapRevert(SwapKeyPolicy.OverDayCap.selector, p, key, true, TX_CAP); // 3e16 > 2.5e16
        _swapAs(sess, p, key, true, DAY_CAP - 2 * TX_CAP, _band(DAY_CAP - 2 * TX_CAP)); // exactly the cap
        _expectSwapRevert(SwapKeyPolicy.OverDayCap.selector, p, key, true, 1);
        // the other token has its own budget
        _swapAs(sess, p, key, false, TX_CAP, _band(TX_CAP));

        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        feed.set(1e8, block.timestamp);
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP));
    }

    function test_revert_daySpendSurvivesResign() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP));
        _swapAs(sess, p, key, true, TX_CAP, _band(TX_CAP));
        SwapKeyPolicy.Policy memory p2 = _policy(_ids(key), 2);
        _activate(p2);
        _expectSwapRevert(SwapKeyPolicy.OverDayCap.selector, p2, key, true, TX_CAP);
    }

    function test_revert_expired() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        vm.warp(p.expiresAt);
        feed.set(1e8, block.timestamp);
        _expectSwapRevert(SwapKeyPolicy.PolicyExpired.selector, p, key, true, AMOUNT);
    }

    function test_revert_afterRevoke_andCannotReapply() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        bytes memory sig = _sign(mainPk, p);
        vm.prank(account); // the main key sends revoke() directly
        policy.revoke();
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p, sig);
    }

    function test_revert_sessionKeyCannotRevokeForAccount() public {
        vm.prank(sess);
        policy.revoke(); // only clears the session key's own (empty) slot
        _swapAs(sess, _policy(_ids(key), 1), key, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_afterUninstall() public {
        vm.prank(account);
        MiniAccount7579(payable(account)).uninstallModule(2, address(policy), "");
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, _policy(_ids(key), 1), key, true, AMOUNT);
    }

    function test_revert_newPolicyVoidsOld() public {
        SwapKeyPolicy.Policy memory p1 = _policy(_ids(key), 1);
        _activate(_policy(_ids(key), 2));
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p1, key, true, AMOUNT);
    }

    // --- revoke voids signed-but-unapplied policies ---

    /// Policies signed ahead (renewal, a failed relay) die with the revoke; a fresh setup that
    /// reads lastNonce and signs +1 (packages/chain buildSwapSetup) still works.
    function test_revoke_voidsSignedUnappliedPolicies() public {
        SwapKeyPolicy.Policy memory p2 = _policy(_ids(key), 2);
        SwapKeyPolicy.Policy memory p3 = _policy(_ids(key), 3);
        (bytes memory sig2, bytes memory sig3) = (_sign(mainPk, p2), _sign(mainPk, p3));
        vm.prank(account);
        policy.revoke();
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p2, sig2);
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p3, sig3);

        SwapKeyPolicy.Policy memory fresh = _policy(_ids(key), policy.lastNonce(account) + 1);
        _activate(fresh);
        _swapAs(sess, fresh, key, true, AMOUNT, _band(AMOUNT));
    }

    function test_uninstall_voidsSignedUnappliedPolicy_reinstallWorks() public {
        SwapKeyPolicy.Policy memory p2 = _policy(_ids(key), 2);
        bytes memory sig2 = _sign(mainPk, p2);
        vm.startPrank(account);
        MiniAccount7579(payable(account)).uninstallModule(2, address(policy), "");
        MiniAccount7579(payable(account)).installModule(2, address(policy), "");
        vm.stopPrank();
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p2, sig2);

        SwapKeyPolicy.Policy memory fresh = _policy(_ids(key), policy.lastNonce(account) + 1);
        _activate(fresh);
        _swapAs(sess, fresh, key, true, AMOUNT, _band(AMOUNT));
    }

    /// A nonce signed for a later window (i.e. meant to outlive a revoke) is refused up front.
    function test_setPolicy_rejectsNonceOutsideWindow() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), uint64(1 << 32) + 1);
        bytes memory sig = _sign(mainPk, p);
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p, sig);
    }

    /// revoke never reverts, even in the last window (lastNonce saturates; the account is done).
    function test_revoke_saturatesInLastWindow() public {
        stdstore.target(address(policy)).sig("lastNonce(address)").with_key(account).checked_write(
            uint256(type(uint64).max - 5)
        );
        vm.prank(account);
        policy.revoke();
        assertEq(policy.lastNonce(account), type(uint64).max);
        assertEq(policy.activePolicy(account), bytes32(0));
    }

    // --- who may act ---

    function test_revert_notSessionKey() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SwapKeyPolicy.NotSessionKey.selector);
        policy.executeSwap(p, key, true, AMOUNT, _band(AMOUNT));
        vm.prank(account);
        vm.expectRevert(SwapKeyPolicy.NotSessionKey.selector);
        policy.executeSwap(p, key, true, AMOUNT, _band(AMOUNT));
    }

    /// The session key edits the policy it passes (raise caps, swap the adapter for the router or
    /// Permit2, add a pool, add a token, extend expiry, change account): the hash no longer matches.
    function test_revert_forgedPolicy() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        p.maxPerTx[0] = type(uint256).max;
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);

        p = _policy(_ids(key), 1);
        p.adapter = address(swapRouter);
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);

        p = _policy(_ids(key), 1);
        p.adapter = PERMIT2;
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);

        p = _policy(_ids(key), 1);
        p.expiresAt += 365 days;
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);

        p = _policy(_ids(key), 1);
        p.account = makeAddr("victim");
        _expectSwapRevert(SwapKeyPolicy.PolicyNotActive.selector, p, key, true, AMOUNT);
    }

    // --- what may be swapped ---

    function test_revert_poolNotAllowListed() public {
        (PoolKey memory other,) = initPool(currency0, currency1, IHooks(address(0)), 500, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(other, DEEP, ZERO_BYTES);
        _allowAdapterPool(other, 2); // even if the adapter would accept it
        _expectSwapRevert(SwapKeyPolicy.PoolNotAllowed.selector, _policy(_ids(key), 1), other, true, AMOUNT);
    }

    function test_revert_tokenNotAllowListed() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 2);
        address[] memory tokens = new address[](1);
        tokens[0] = Currency.unwrap(currency0);
        uint256[] memory caps = new uint256[](1);
        caps[0] = TX_CAP;
        (p.tokens, p.maxPerTx, p.maxPerDay) = (tokens, caps, caps);
        _activate(p);
        _swapAs(sess, p, key, true, AMOUNT, _band(AMOUNT));
        _expectSwapRevert(SwapKeyPolicy.TokenNotAllowed.selector, p, key, false, AMOUNT);
    }

    function test_revert_minOutBelowBand_bubbles() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        vm.prank(sess);
        vm.expectRevert(ProvisoSwapAdapter.MinOutBelowBand.selector);
        policy.executeSwap(p, key, true, AMOUNT, 0);
        assertEq(policy.spent(account, Currency.unwrap(currency0), block.timestamp / 1 days), 0);
    }

    function test_revert_maliciousHookPool_allowListedEverywhere() public {
        PoolKey memory hooked = _hookPool();
        _allowAdapterPool(hooked, 2);
        SwapKeyPolicy.Policy memory p = _policy(_ids(hooked), 2);
        _activate(p);
        uint256 before0 = currency0.balanceOf(account);
        vm.prank(sess);
        vm.expectRevert(ProvisoSwapAdapter.InsufficientOutput.selector);
        policy.executeSwap(p, hooked, true, AMOUNT, _band(AMOUNT));
        assertEq(currency0.balanceOf(account), before0);
        assertEq(MockERC20(Currency.unwrap(currency0)).allowance(account, address(adapter)), 0);
        assertEq(policy.spent(account, Currency.unwrap(currency0), block.timestamp / 1 days), 0);
    }

    function test_revert_skewedPool() public {
        (PoolKey memory skewed,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 10, SQRT_PRICE_1_2);
        modifyLiquidityRouter.modifyLiquidity(
            skewed, ModifyLiquidityParams({tickLower: -12000, tickUpper: 12000, liquidityDelta: 1e21, salt: 0}), ZERO_BYTES
        );
        _allowAdapterPool(skewed, 2);
        SwapKeyPolicy.Policy memory p = _policy(_ids(skewed), 2);
        _activate(p);
        vm.prank(sess);
        vm.expectRevert(ProvisoSwapAdapter.InsufficientOutput.selector);
        policy.executeSwap(p, skewed, true, AMOUNT, _band(AMOUNT));
    }

    function test_revert_allowanceLeft() public {
        LazyAdapter lazy = new LazyAdapter();
        SwapKeyPolicy lazyPolicy = new SwapKeyPolicy(address(lazy));
        vm.prank(account);
        MiniAccount7579(payable(account)).installModule(2, address(lazyPolicy), "");
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        p.adapter = address(lazy);
        bytes32 structHash = lazyPolicy.hashPolicy(p);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(mainPk, keccak256(abi.encodePacked("\x19\x01", lazyPolicy.domainSeparator(), structHash)));
        lazyPolicy.setPolicy(p, abi.encodePacked(r, s, v));
        vm.prank(sess);
        vm.expectRevert(SwapKeyPolicy.AllowanceLeft.selector);
        lazyPolicy.executeSwap(p, key, true, AMOUNT, 0);
    }

    // --- the session key has no other path to the account's funds ---

    function test_sessionKeyCannotUseAccountDirectly() public {
        MiniAccount7579 acct = MiniAccount7579(payable(account));
        address t0 = Currency.unwrap(currency0);
        bytes memory transfer = _one(Execution(t0, 0, abi.encodeCall(IERC20.transfer, (sess, 1))));
        bytes memory approveRouter =
            _one(Execution(t0, 0, abi.encodeCall(IERC20.approve, (address(swapRouter), type(uint256).max))));
        bytes memory approvePermit2 = _one(Execution(t0, 0, abi.encodeCall(IERC20.approve, (PERMIT2, 1))));
        bytes memory callRouter = _one(Execution(address(swapRouter), 0, ""));

        vm.startPrank(sess);
        vm.expectRevert(MiniAccount7579.NotSelf.selector);
        acct.execute(BATCH, transfer);
        vm.expectRevert(MiniAccount7579.NotSelf.selector);
        acct.execute(BATCH, approveRouter);
        vm.expectRevert(MiniAccount7579.NotSelf.selector);
        acct.execute(BATCH, approvePermit2);
        vm.expectRevert(MiniAccount7579.NotExecutor.selector);
        acct.executeFromExecutor(BATCH, transfer);
        vm.expectRevert(MiniAccount7579.NotExecutor.selector);
        acct.executeFromExecutor(BATCH, callRouter);
        vm.expectRevert(MiniAccount7579.NotSelf.selector);
        acct.installModule(2, sess, "");
        // no standing allowances to pull through
        vm.expectRevert();
        MockERC20(t0).transferFrom(account, sess, 1);
        vm.stopPrank();

        assertEq(MockERC20(t0).allowance(account, address(swapRouter)), 0);
        assertEq(MockERC20(t0).allowance(account, PERMIT2), 0);
        assertEq(MockERC20(t0).allowance(account, sess), 0);
    }

    /// Fuzz: whatever pool / direction / amount the session key picks, the account only ever loses
    /// tokenIn to the pool (never more than the cap), ends with zero adapter allowance, and gets the output.
    function testFuzz_sessionKeyBounded(bool zeroForOne, uint256 amountIn, uint256 minOut) public {
        amountIn = bound(amountIn, 0, 2 * TX_CAP);
        minOut = bound(minOut, 0, amountIn);
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 1);
        (Currency cin, Currency cout) = zeroForOne ? (currency0, currency1) : (currency1, currency0);
        uint256 inBefore = cin.balanceOf(account);
        uint256 outBefore = cout.balanceOf(account);
        vm.prank(sess);
        try policy.executeSwap(p, key, zeroForOne, amountIn, minOut) returns (uint256 out) {
            assertLe(amountIn, TX_CAP);
            assertEq(inBefore - cin.balanceOf(account), amountIn);
            assertEq(cout.balanceOf(account) - outBefore, out);
            assertGe(out, minOut);
        } catch {
            assertEq(cin.balanceOf(account), inBefore);
        }
        assertEq(MockERC20(Currency.unwrap(cin)).allowance(account, address(adapter)), 0);
    }

    // --- setPolicy validation ---

    function test_setPolicy_wrongSigner() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 2);
        bytes memory sig = _sign(sessPk, p);
        vm.expectRevert(SwapKeyPolicy.BadSignature.selector);
        policy.setPolicy(p, sig);
    }

    function test_setPolicy_rejectsBadShapes() public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), 2);
        p.adapter = address(swapRouter);
        _expectBadPolicy(p);

        p = _policy(_ids(key), 2);
        p.maxPerDay = new uint256[](1);
        _expectBadPolicy(p);

        p = _policy(new bytes32[](0), 2);
        _expectBadPolicy(p);

        p = _policy(_ids(key), 2);
        p.sessionKey = account;
        _expectBadPolicy(p);

        p = _policy(_ids(key), 2);
        p.expiresAt = uint64(block.timestamp);
        _expectBadPolicy(p);

        p = _policy(_ids(key), 2);
        p.tokens[1] = address(0);
        _expectBadPolicy(p);
    }

    function _expectBadPolicy(SwapKeyPolicy.Policy memory p) internal {
        bytes memory sig = _sign(mainPk, p);
        vm.expectRevert(SwapKeyPolicy.BadPolicy.selector);
        policy.setPolicy(p, sig);
    }

    function test_moduleType() public view {
        assertTrue(policy.isModuleType(2));
        assertFalse(policy.isModuleType(1));
        assertTrue(policy.isInitialized(account));
    }

    // --- fuzz: nonce windows ---

    /// Whatever nonce was signed before a revoke, it never activates afterwards (bar one pre-signed
    /// for the exact second of the revoke); lastNonce + 1 does.
    function testFuzz_revoke_voidsEveryPreRevokeNonce(uint64 nonce) public {
        vm.assume(nonce / (1 << 32) != block.timestamp);
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), nonce);
        bytes memory sig = _sign(mainPk, p);
        vm.prank(account);
        policy.revoke();
        vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p, sig);
        _activate(_policy(_ids(key), policy.lastNonce(account) + 1));
    }

    /// setPolicy takes a nonce iff it is above lastNonce and in lastNonce's 2^32 window.
    function testFuzz_setPolicy_nonceWindow(uint64 nonce) public {
        SwapKeyPolicy.Policy memory p = _policy(_ids(key), nonce);
        bytes memory sig = _sign(mainPk, p);
        if (nonce <= 1 || nonce >= 1 << 32) vm.expectRevert(SwapKeyPolicy.StaleNonce.selector);
        policy.setPolicy(p, sig);
    }
}
