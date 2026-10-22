# Protocol invariants

Each invariant of the Proviso contracts, the code that enforces it, and the test that checks it.
IDs follow the audit's invariant map (`G-*` guards, `I-*` single-contract, `X-*` cross-contract,
`E-*` economic); `N-*` are invariants added with the audit fixes.

The contracts are deployed on Robinhood Chain mainnet (4663); addresses are in
`packages/chain/deployments/mainnet.json`. Every test named below is a function in this repository.

Paths: `contracts/test/...` unless noted. Run with `cd contracts && forge test`; the TypeScript
checks run with `bun run test`. The stateful suites in `test/invariant/` run 7 invariants × 64
runs × depth 250 (16k handler calls each, 112k in total) by default;
`FOUNDRY_PROFILE=deep forge test --match-path "test/invariant/*"` runs 256 × 500 (128k) each.
`test/halmos/` holds Halmos symbolic tests (`check_*`, every argument symbolic). CI job `halmos`
(halmos 0.3.3) runs `halmos --match-contract AdapterPinsSymTest` in `contracts/` (N-8, proven).
The oracle-floor checks (`OracleBandSymTest`, N-9) time out in the SMT solvers at full width and
are run by forge as fuzz tests on the deployed code instead.

## ThesisSeal

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| G-1 | A stamp can't be sealed after its deadline | `seal` | `ThesisSeal.t.sol::test_seal_revertsAfterDeadline`, `::test_seal_atDeadlineOk` |
| G-2 / I-4 | Every thesis has `sealTime < expiresAt ≤ sealTime + 30 days` | `seal` | `ThesisSeal.t.sol::testFuzz_seal_expiryWindow`, `::test_seal_revertsOnExpiryOver30Days`, `::test_seal_revertsOnPastExpiry` |
| G-3 | Commitments are never zero | `seal` | `ThesisSeal.t.sol::test_seal_revertsOnEmptyHash` |
| G-4 / I-1 | A stamp nonce is used once (unordered) | `seal` | `ThesisSeal.t.sol::test_seal_revertsOnReusedNonce`, `::test_seal_noncesAreUnordered` |
| G-5 | Only the owner's key creates a thesis in its name; anyone may relay the signed stamp | `seal` | `ThesisSeal.t.sol::test_seal_revertsOnWrongSigner`, `::test_seal_revertsOnTamperedStamp`, `::test_seal_revertsOnGarbageSig`, `::test_seal_relayedByAnyone`; `packages/chain/src/stamp.test.ts` (browser EIP-712 accepted on anvil) |
| G-6 / G-9 / I-2 | Each part is revealed once; the first entry kind is final | `revealEntry`, `revealExit` | `ThesisSeal.t.sol::test_revealEntryAndExit`, `::test_reveal_double`, `::testFuzz_revealEntry_rules` |
| G-7 / G-10 | A reveal must match the stored hash | `revealEntry`, `revealExit` | `ThesisSeal.t.sol::test_reveal_hashMismatch`, `::testFuzz_revealEntry_wrongPreimage` |
| N-1 (was G-8) | Only the revealer (the relayer) picks the entry kind, inside its window (FIRED ≤ expiry + 60 s, EXPIRED ≥ expiry, RETIRED after retire, MANUAL_NO_TRADE while live and not retired). The owner may only reveal EXPIRED once FIRED can no longer land; anyone else is refused | `revealEntry` | `ThesisSeal.t.sol::testFuzz_revealEntry_rules`, `::test_reveal_strangerCannotRevealEntry`, `::test_reveal_ownerCannotRelabelWhileFiredCanLand`, `::test_reveal_retireAfterFire_ownerCannotRevealRetired`, `::test_reveal_ownerExpiredAfterGrace`, `::test_reveal_expiredOnlyAfterExpiry`, `::test_reveal_firedGraceAfterExpiry`, `::test_reveal_manualNoTradeOnlyWhileLive`, `::test_reveal_badKindValue` |
| N-2 | Commitments are bound to the owner: `keccak256(owner ‖ canonical ‖ salt)`, so a copied hash pair sealed under another key never verifies | `revealEntry`, `revealExit`; `packages/dsl/src/commit.ts` | `ThesisSeal.t.sol::test_reveal_copiedHashesDoNotVerify`; `packages/chain/src/stamp.test.ts` ("seal and reveal a DSL commitment", copier part); `packages/dsl/src/dsl.test.ts` ("commit = keccak256(owner ‖ canonical ‖ salt)", "the same spec and salts commit differently for another owner") |
| N-3 | The DB's reveal kind equals the chain's: after `AlreadyRevealed` ops records the on-chain kind and warns if it differs | `services/ops/src/runtime/consumers.ts` `revealHandler` | `services/ops/src/runtime/onchain.test.ts` ("reveal entry and exit through the handler…") |
| G-11 / G-12 / I-3 | Only the owner retires, once, while live and before the entry reveal | `retire` | `ThesisSeal.t.sol::test_retire_ownerOnly`, `::test_retire_twice`, `::test_retire_afterExpiry`, `::test_retire_afterEntryRevealed`, `::test_retire_recordsAndUnlocksRetiredKind` |
| G-13 | Unknown ids are refused | `_get` | `ThesisSeal.t.sol::test_reveal_unknownThesis` |
| — | Exit reveals are permissionless | `revealExit` | `ThesisSeal.t.sol::test_revealExit_permissionless` |

## StampRoots

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| G-14 | Only the poster writes roots | `post` | `StampRoots.t.sol::test_post_onlyPoster` |
| G-15 / G-16 / I-6 | Roots are for hour-aligned hours that have ended | `post` | `StampRoots.t.sol::test_post`, `::testFuzz_post`, `::test_post_aligned`, `::test_post_hourMustBeOver` |
| G-17 / I-5 | A root is written once, non-zero, and never changes | `post` | `StampRoots.t.sol::test_post_oncePerHour`, `::test_post_emptyRoot`, `::testFuzz_post` |

## CallerShare

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| G-18 / G-19 | Only the poster posts, once per epoch, and funds it in the same call | `postEpoch` | `CallerShare.t.sol::test_postEpoch_onlyPoster`, `::test_postEpoch_once`, `::test_postEpoch_pullsFunding` |
| G-20 / G-22 | Only an exact (caller, amount) leaf of a posted root pays; relaying is harmless | `claim` | `CallerShare.t.sol::testFuzz_claim_onlyExactLeaf`, `::test_claim_badProofs`, `::test_claim_unknownEpoch`, `::test_claim_allCallers_relayedByAnyone` |
| G-21 / I-8 | Each leaf (epoch, caller) pays at most once | `claim` | `invariant/CallerShare.invariant.t.sol::invariant_perEpochFundingAndOneClaimPerLeaf`, `CallerShare.t.sol::test_claim_double` |
| G-23 / I-7 | Per epoch, claims never exceed that epoch's funding (an under-funded root can't reach other epochs) | `claim` | `invariant/CallerShare.invariant.t.sol::invariant_perEpochFundingAndOneClaimPerLeaf`, `CallerShare.t.sol::test_claim_cannotExceedEpochFunding` |
| I-9 | Total claimed ≤ total funded, and the contract holds exactly the difference (USDG without transfer fees) | `postEpoch`, `claim` | `invariant/CallerShare.invariant.t.sol::invariant_claimedNeverExceedsFunded` |
| E-2 | Every valid leaf of a fully funded epoch can be paid | — | `CallerShare.t.sol::test_claim_allCallers_relayedByAnyone` (not on-chain: one leaf per caller per epoch, no sweep) |

## ProvisoSwapAdapter

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| G-24 / I-11 | Stored policies have `maxSlipBps ≤ MAX_SLIP_BPS` (1000 = 10%, a constant) and `multiplier == MULTIPLIER` (1e18: every pinned feed embeds the Stock Token multiplier) | `setPolicy` | `ProvisoSwapAdapter.t.sol::test_setPolicy_badSlip`, `::test_setPolicy_zeroMultiplier`, `::test_setPolicy_multiplierPinned`, `::testFuzz_setPolicy_pins` |
| N-8 | The price reference is pinned in the adapter, not taken from the signature: a stored policy's base token (`baseIsCurrency0` side) has a feed in `oracleOf`, its `oracle` is exactly that feed, and its other side is `quoteToken` (USDG). `oracleOf` / `quoteToken` are written once by the constructor (no setter, no admin; zero, repeated or quote-token pins revert `BadPins`). Mainnet pins: TSLA → Chainlink `0x4A11…7C38`, AMZN → `0xD5a1…651C`, from `MAINNET_SWAP` | `constructor`, `setPolicy` | `ProvisoSwapAdapter.t.sol::test_pins_stored`, `::test_setPolicy_wrongOracle`, `::test_setPolicy_unpinnedBase`, `::test_setPolicy_wrongQuote`, `::testFuzz_setPolicy_pins`, `::test_constructor_badPins`; Halmos `halmos/AdapterPins.t.sol::check_setPolicy_onlyPinned` (all policy fields and signature symbolic; proven, and fails on a mutant without the quote check); `packages/chain/src/swaps.test.ts` ("adapterPins"); `post-deploy-check.ts` (`quoteToken()`, `oracleOf(TSLA / AMZN / USDG)`) |
| G-25 / I-10 | The per-account policy nonce strictly increases | `setPolicy` | `ProvisoSwapAdapter.t.sol::test_setPolicy_replayAndStaleNonce` |
| G-26 | Only the account's main key allow-lists a pool | `setPolicy` | `ProvisoSwapAdapter.t.sol::test_setPolicy_wrongSigner` |
| G-27 / G-28 / G-29 | Swaps only on the caller's own unexpired pools, within the per-tx cap, in both directions | `swap` | `ProvisoSwapAdapter.t.sol::test_swap_zeroForOne_outputToAccount`, `::test_swap_oneForZero`, `::test_revert_poolNotAllowListed`, `::test_revert_maliciousHookPool_notAllowListed`, `::test_revert_policyIsPerAccount`, `::test_revert_policyExpired`, `::test_revert_overPerTxCap` |
| G-30 | `minOut` is never below the oracle floor `fair × (1 − maxSlipBps)` | `swap`, `_oracleFloor` | `invariant/ProvisoSwapAdapter.invariant.t.sol::invariant_minOutHonoured`, `ProvisoSwapAdapter.t.sol::testFuzz_swap_minOutHonoured`, `::testFuzz_oracleFloor_math`, `::test_revert_minOutBelowBand`, `::test_swap_mixedDecimals`; N-9 |
| N-9 | The floor math (`OracleBand.floor`, used by `_oracleFloor`) in range (multiplier 1e18, 8-decimal feed, stock 18 / USDG 6 decimals, 0 < answer ≤ 1e20, amountIn ≤ 1e28, slipBps ≤ 1000, both directions): it never reverts; it never exceeds the exact fair value; it equals ⌊⌊fair⌋ × (10000 − slip) / 10000⌋ (fair − floor ≤ fair × slip / 10000 + 1, floor = fair at slip 0); it is never more than 10% (+2 units of rounding) below fair; a higher price never lowers the floor when selling the stock and never raises it when buying; a larger trade never lowers it; a wider band never raises it | `OracleBand.floor` | stated as Halmos checks `halmos/OracleBand.t.sol::check_floor_noRevert`, `::check_floor_atMostFair`, `::check_floor_slipBounds`, `::check_floor_atLeast90PctOfFair`, `::check_floor_monotoneInPrice`, `::check_floor_monotoneInAmount`, `::check_floor_monotoneInSlip` (SMT timeout at full width with yices, z3, bitwuzla, bitwuzla-abs: not proven); run by forge as `::testFuzz_floor_properties` (2000 runs) and `::test_floor_rangeCorners` |
| G-31 | The account receives at least `minOut` (skewed pools, skimming hooks) | `swap` | `invariant/ProvisoSwapAdapter.invariant.t.sol::invariant_minOutHonoured`, `ProvisoSwapAdapter.t.sol::testFuzz_swap_minOutHonoured`, `::test_revert_skewedPool`, `::test_revert_maliciousHookPool_evenIfAllowListed` |
| G-32 / I-12 | Prices are at most `maxOracleAge` old and positive; `maxOracleAge` is immutable, set at deploy within 1 s – `MAX_ORACLE_AGE_LIMIT` (2 days). Mainnet: 90000 s (Chainlink's 86400 s heartbeat + 1 h) | `constructor`, `_oracleFloor` | `ProvisoSwapAdapter.t.sol::test_revert_staleOracle`, `::test_revert_nonPositiveOracle`, `::test_constructor_oracleAgeBounds`, `::testFuzz_constructor_oracleAge`, `::testFuzz_maxOracleAge_staleness`, `::test_mainnetAge_dayOldFeedSwaps`, `ProvisoTestFeed.t.sol::test_adapter_rejectsStaleTestFeed`, `::test_adapter_rejectsNeverPushedFeed` |
| G-32b | No swap while the priced stock token reports `oraclePaused()`, or while a multiplier change is effective (`effectiveAt ≤ now`) but the feed hasn't updated since (`updatedAt < effectiveAt`). Tokens without these views are skipped. No L2 sequencer-uptime check: Chainlink has no sequencer feed for Robinhood Chain | `_checkCorporateAction` | `ProvisoSwapAdapter.t.sol::test_revert_oraclePaused_bothDirections`, `::test_oraclePaused_onQuoteSideIgnored`, `::test_revert_multiplierChangeUnpriced`, `::test_multiplierChangeScheduled_stillSwaps`, `::testFuzz_multiplierGuard`, `::test_tokensWithoutStockViews_swap` |
| G-33 | Only the PoolManager drives settlement | `unlockCallback` | `ProvisoSwapAdapter.t.sol::test_unlockCallback_onlyPoolManager` |
| G-34 | The account never pays more than `amountIn`, and only through an exact approval | `unlockCallback` | `invariant/ProvisoSwapAdapter.invariant.t.sol::invariant_minOutHonoured`, `ProvisoSwapAdapter.t.sol::testFuzz_swap_minOutHonoured`, `::test_revert_withoutExactApproval` |
| — | The adapter holds no tokens between calls | `swap` | `invariant/ProvisoSwapAdapter.invariant.t.sol::invariant_adapterHoldsNothing` |
| N-4 | Off-chain sizing (`amountInForUsd`, `quoteMinOut`) matches the adapter's floor: minOut is never below it, never above fair value, and the input is the largest worth ≤ the USD size | `services/core/src/rhc/executor.ts` | `services/core/src/rhc/amounts.test.ts` |

## SwapKeyPolicy

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| G-35 | Every policy names the deploy-time adapter, has a sane shape, and is signed by the account's main key over the same EIP-712 encoding the browser uses | `setPolicy` | `SwapKeyPolicy.t.sol::test_setPolicy_rejectsBadShapes`, `::test_setPolicy_wrongSigner`, `::test_hashMatchesBrowserEncoding`, `::test_moduleType`, `::test_7702_accountIsDelegatedEoa` |
| G-36 / I-13 | The nonce strictly increases; a newer policy voids older ones; only the account clears its own policy | `setPolicy`, `revoke` | `SwapKeyPolicy.t.sol::test_revert_newPolicyVoidsOld`, `::test_revert_afterRevoke_andCannotReapply`, `::test_revert_sessionKeyCannotRevokeForAccount`, `::testFuzz_setPolicy_nonceWindow`, `::test_setPolicy_rejectsNonceOutsideWindow` |
| G-37 | The session key acts only through the one active, unexpired signed policy | `executeSwap` | `SwapKeyPolicy.t.sol::test_revert_notSessionKey`, `::test_revert_forgedPolicy`, `::test_revert_expired`, `::test_sessionKeyCannotUseAccountDirectly` |
| I-14 / X-4 | After `revoke()` or uninstall no policy signed before it can become active; only a fresh main-key setup (`lastNonce + 1`) re-arms the key | `_revoke` (moves `lastNonce` to a window numbered by the revoke time) | `invariant/SwapKeyPolicy.invariant.t.sol::invariant_revokeIsFinal`, `SwapKeyPolicy.t.sol::test_revoke_voidsSignedUnappliedPolicies`, `::test_uninstall_voidsSignedUnappliedPolicy_reinstallWorks`, `::testFuzz_revoke_voidsEveryPreRevokeNonce`, `::test_revoke_saturatesInLastWindow`, `::test_revert_afterUninstall` |
| G-38 / I-15 | Per token and UTC day, spent ≤ `maxPerDay`; no swap exceeds `maxPerTx` | `executeSwap` | `invariant/SwapKeyPolicy.invariant.t.sol::invariant_spentWithinDayCap`, `SwapKeyPolicy.t.sol::test_swap_oneForZero`, `::test_revert_overTxCap`, `::test_revert_overDayCap_resetsNextDay`, `::test_revert_daySpendSurvivesResign`, `::testFuzz_sessionKeyBounded` |
| I-16 | The day window is the fixed UTC day (2 × cap possible across midnight) | `executeSwap` | `SwapKeyPolicy.t.sol::test_revert_overDayCap_resetsNextDay` (property statement, by design) |
| G-38 / I-17 / X-1 | After every module swap the adapter allowance is zero | `executeSwap` | `invariant/SwapKeyPolicy.invariant.t.sol::invariant_noLeftoverAllowance`, `SwapKeyPolicy.t.sol::test_revert_allowanceLeft`, `::test_swap_outputToAccount_exactApprovalConsumed` |
| X-2 | The pool must be in both the session policy and the adapter policy, and the adapter's oracle band applies to module swaps | `executeSwap`, adapter `swap` | `SwapKeyPolicy.t.sol::test_revert_poolNotAllowListed`, `::test_revert_tokenNotAllowListed`, `::test_revert_maliciousHookPool_allowListedEverywhere`, `::test_revert_minOutBelowBand_bubbles`, `::test_revert_skewedPool` |
| N-5 | Exits are never gated: a Stock Token's signed caps cover everything the USDG caps can buy over a whole policy down to a floor share price ($25 on mainnet), so selling holdings back can't hit `OverTxCap` / `OverDayCap` / the adapter's `maxIn` | `packages/chain/src/swaps.ts` `MAINNET_SWAP.caps` | `packages/chain/src/swaps.test.ts` ("mainnet: the same holds down to a $25 share price", "a Stock Token's caps cover every buy the USDG caps allow") |
| E-1 | A compromised session key loses at most ≈ `maxSlipBps` per leg within the day caps until expiry or revoke | composition of the above | `invariant/SwapKeyPolicy.invariant.t.sol::*`, `invariant/ProvisoSwapAdapter.invariant.t.sol::invariant_minOutHonoured`, `SwapKeyPolicy.t.sol::testFuzz_sessionKeyBounded` (not on-chain as a single check; depends on feed trust, X-3) |

## Oracles

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| X-3 | Feed answers track the market. The mainnet adapter pins Chainlink Stock Token feeds at deploy (N-8, from `packages/chain/src/swaps.ts` `MAINNET_SWAP.markets`); their correctness is a trust assumption, bounded on-chain only by G-32 / G-32b | not enforced on-chain (which feed is, N-8) | — |

### ProvisoTestFeed (testnet history, not deployed on mainnet)

| ID | Invariant | Enforced at | Checked by |
|---|---|---|---|
| I-18 | Only the updater pushes, answers are positive, rounds count up by one, unknown rounds revert | `push`, `getRoundData` | `ProvisoTestFeed.t.sol::testFuzz_feed_push`, `::test_feed_onlyUpdater`, `::test_feed_rejectsNonPositive`, `::test_feed_pushRecordsRounds`, `::test_feed_unknownRound` |
| I-19 | The adapter prices off a pushed test feed like any Chainlink feed | adapter `_oracleFloor` | `ProvisoTestFeed.t.sol::test_adapter_swapsOffTestFeed`, `::test_adapter_followsPushedPrice` |

## Deployment

| ID | Invariant | Checked by |
|---|---|---|
| N-6 | Every deployed contract runs the local build (immutables masked) and has the expected immutables, roles (revealer and posters = the relayer), USDG, PoolManager, `maxOracleAge` (90000 on mainnet), adapter oracle pins (`quoteToken`, `oracleOf` per stock token), adapter link (`SwapKeyPolicy.adapter()` = the recorded adapter) and EIP-712 domain | `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` (read-only; exits 1 on mismatch) |
| N-7 | The mainnet deployer is a fresh key distinct from the relayer, the relayer matches `chains.ts`, the RPC is on chain 4663, and every deployment is recorded (tx, block, args) in `mainnet.json`. `ADAPTER_V2=1` redeploys only the swap pair, from the recorded deployer, with the pins from `MAINNET_SWAP`, and moves the replaced entries to `previous` (address, tx, block, retiredAt) | `packages/chain/scripts/deploy-mainnet.ts` (refuses to run otherwise) |
