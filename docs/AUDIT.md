# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 8.8 / 10** (no cap binds) · Rubric v2
Commit `8962c42` (public main) · Mode `rescore` · 2026-10-23
Previous: 8.5 on 2026-10-23 (`rescore`, `391f2f1`) (+0.3; total 8.545 → 8.830) · Studio policy: 8/8 pass
Deployed build: **matches** (ops CVM not checked: no public Info endpoint).
- Mainnet contracts: `post-deploy-check.ts` passed 19/19 in this run, after a fresh `forge build --force` of `8962c42` (contracts unchanged since `0c9d47a`).
- Core CVM: live `compose_hash` `2ff12079…6aab` = sha256(app_compose) = the only `ALLOWED_COMPOSE_HASHES` entry. The embedded compose is byte-identical to `git show 8962c42:services/core/docker-compose.yml` (989 bytes, image `proviso-core@sha256:a0a5551d…7e36`). MRTD/RTMR1/RTMR2 equal the `ALLOWED_OS` pins; RTMR3 replays from the event log.
- Images:
  - Core `a0a5551d…7e36`: Sigstore provenance names `images.yml@refs/heads/main`, source `6f7be7d0…d5`, run 39862576372 (success). `6f7be7d → 8962c42` changes only the core compose digest, the allow-list entry and the attestation fixture.
  - Ops `25d1dc45…a183`: unchanged, source `8b74d554…f2`, run 39856715608. `services/ops` is unchanged since then.

Independent check: not required. The grade moved from 8.5 to 8.8 and does not cross 9.0. The last check, on the 391f2f1 run, agreed exactly.

**What changed since 391f2f1.** The two partial fixes from the last run are now complete:
- P-M3: the depth budget is a max-min fair split.
- L-1: the caller's entry waits a bounded time for followers, and confirms for different fires run in parallel.

The one wallet still on the retired v1 swap pair has uninstalled both SwapKeyPolicy modules on chain. That closes the adapter Low.

One new Low: a Stop pressed while an entry is still in progress is dropped. The race is old. The new entry code makes its window longer after the caller's buy, because the idea waits for the follower wave before it opens.

The five contract Lows are still open. The owner has not decided whether to accept them.

## External review (re-audit v1.1)

An independent external reviewer audited the public repository at `86e99de` (2026-10-22) and graded it 7.0. Their weighted score was 8.2, held at 7.0 only because they could not read the chain or the enclave. They reported four Medium findings, P-M1 to P-M4, and four new Low findings, L-1 to L-4, each with a passing proof of concept.

**What our 9.1 report missed.** Our published 9.1 report (`0c9d47a`) missed P-M1, P-M2 and P-M3. It had P-M4 ("follow-slot squatting") only as an unverified lead, with no deduction, and it had none of L-1 to L-4.

The rescore at `391f2f1` (8.5) found P-M3 and L-1 only partly fixed. Both are now complete.

Status at `8962c42`: **all eight are verified fixed.**

| ID | Finding | Status | Evidence (file + test) |
| --- | --- | --- | --- |
| P-M1 (Medium) | The API stored the allow-list as an object, but core read only arrays, so Fair Copy never auto-copied | **Verified fixed** | `packages/db/src/allowlist.ts` `allowEntries`, used by `follow.ts:58`, `executor.ts:303` and `rhc/runner.ts:207`. Tests: `follow.test.ts` "P-M1: an allow-list sent to follow.create is stored as entries core can read"; `executor.test.ts` "P-M1: a follow stored in the API's object shape auto-copies on Hyperliquid"; `rhc/runner.test.ts` "P-M1: … still auto-copies (no tap-to-confirm)" |
| P-M2 (Medium) | Stop after a fire crashed core | **Verified fixed** | `runtime/ideas.ts` `hold()`; `events.ts:112-128` (hold, stop, then remove); `.catch` on `onExit` and `handle` (`runtime/index.ts`); `unhandledRejection` handler (`services/core/src/index.ts:44`). Test: `events.test.ts` "P-M2: Stop on a fired idea reports its exit (reveal + EXIT) instead of crashing, then drops the idea" |
| P-M3 (Medium) | One follower with a huge size collapsed every other follower's copy | **Verified fixed** (two steps) | Step 1, 8b74d55: confirm-only followers share only what is left. Step 2, 6f7be7d: `planner.ts:127-139` `fairShare` splits the budget max-min fairly, auto followers first (`:160-186`). Tests: `faircopy.test.ts` "P-M3: one funded follower with a $1M size can't squeeze the real auto followers below the minimum", "fairShare: smallest first, equal split of the rest, never above the cap", and "P-M3: one huge confirm-only follower no longer shrinks the auto followers' copies". The last run's PoC now **fails as intended**: the real $400 copy gets $399.99 and the $1M follower gets the rest ($1,600); before, the real copy was skipped |
| P-M4 (Medium) | Follow-slot squatting | **Verified fixed** | `executor.ts:149-163` `fireFollows(…, venue)` filters by usable key before the cap. Tests: `executor.test.ts` "P-M4: a crowd of keyless follows made before a real follower can't squat the per-fire slots"; `rhc/runner.test.ts` "P-M4: keyless follows made before the real follower can't squat its slot" |
| L-1 (Low) | A follower's key queue could delay the caller's idea; Stop while busy returned true but sold nothing | **Verified fixed** (two steps) | Step 1, 8b74d55: the exit/Stop parts. Step 2, 6f7be7d: the entry's wave 1 waits at most `followerExitWaitMs` (20 s) via `waitAtMost` (`rhc/runner.ts:167-172, 369-374`), and `pollConfirms` runs different fires in parallel, in order within a fire (`executor.ts:693-711`). Tests: `runner.test.ts` "L-1: a follower whose buy is stuck can't hold the caller's entry beyond the wait; its holding still counts", "L-1: Stop pressed while a late copy is going in waits for it, then sells everything (no silent no-op)", "L-1: a follower whose sell is stuck can't hold the caller's stop-loss beyond the wait"; `executor.test.ts` "L-1: confirms for different fires run in parallel; one fire's confirms stay in order" |
| L-2 (Low) | A nonce-race retry could buy twice | **Verified fixed** | `rhc/executor.ts` signs locally (`sendSwap`); `runner.ts` retries only `isNonceTooLow`. Tests: `rhc/executor.test.ts` "L-2: a node answering "already known" for our own broadcast returns that tx's hash; nothing is re-sent"; `runner.test.ts` "L-2: "replacement transaction underpriced" is not re-sent at a new nonce" |
| L-3 (Low) | Restore race after a restart | **Verified fixed** | `runtime/index.ts:53-65` `fireGate`. Test: `gate.test.ts` "L-3: fires wait for the restart restore, then go through in order; expiries never wait" |
| L-4 (Low) | The retired v1 SwapKeyPolicy stayed installed after a revoke | **Verified fixed, in code and on chain** | Code: `legacySwapKeyPolicies`, `checkRevokeOps`, multi-op `swapkey.prepareRevoke/revoke`, ops relay with nonce and installed checks. Tests: `swaps.test.ts` "checkRevokeOps (L-4)"; ops `budget.test.ts` "L-4: a legacy-only revoke uninstalls the retired policy module…" and "L-4: revoke ops skip what an earlier attempt relayed…". On chain at block 95448788, the affected wallet `0x6da3…75bb` has:<br>• `isModuleInstalled` = false and `activePolicy` = 0 on both v1 `0x7242…4a9d` and v2 `0xf8d8…a5`;<br>• `Revoked` events at blocks 95443567 (v1) and 95443598 (v2);<br>• `lastNonce` moved to a later window on both |

All 15 named core regression tests (P-M1 to P-M4, L-1 to L-3, fairShare) passed by name in JUnit, with 0 failures. The api, chain and ops tests named above pass in their full suites.

The reviewer's other findings stay ledger rows with source `external`. The contracts are unchanged since `0c9d47a`.

| Finding | Severity / status | Where |
| --- | --- | --- |
| A stale or paused oracle blocks session-key exits (P-L1) | Low, open | `ProvisoSwapAdapter.sol:327-349` |
| Adapter policy nonce shared across pools (P-L7) | Low, open | `ProvisoSwapAdapter.sol:176,271-279` |
| A 7702 re-delegation revives an old session key (P-L8) | Low, open | `SwapKeyPolicy.sol:188,217-239` |
| The day cap allows up to 2× around UTC midnight | Low, open | `SwapKeyPolicy.sol:231-234` |
| The owner can label a late FIRED reveal as EXPIRED | Low, open | `ThesisSeal.sol:211-217` |
| Fee-on-transfer or blocklisted USDG; pins per token, not per pool; multiplier hard-wired to 1e18; Trivy CRITICAL-only after the push; Halmos `OracleBand` inconclusive | Info | see the ledger |

These are not "accepted". SECURITY.md lists the first four Lows under "Known issues (open)", and the owner has not decided whether to accept them.

SECURITY.md's "External review: re-audit v1.1" table now describes P-M3 and L-1 as fixed in two steps, and L-4 as closed on the wallet. That matches this run.

## Path to 9/10
The total is 8.830. No cap binds, so every item adds its full weighted value.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | Accept the five contract Lows in SECURITY.md "Accepted risks", each with its reason and a revisit trigger. They are immutable until the next redeploy. The reasons: stale-oracle exits fail closed and the user can sell from their own wallet; the shared nonce; re-delegation; the UTC-day 2×; the late-FIRED label. Fixing them at the next redeploy is worth more (+0.105 each) | `SECURITY.md` | +0.35 (A +1.0) → 9.180 | S | five Accepted-risks rows naming the ledger ids |
| 2 | Stop during an entry: register the idea (marked busy) before the follower wave, so `stop()` joins it and sells after the entry, or queue the stop. Or accept it | `services/core/src/rhc/runner.ts:142-189, 380-385`; `executor.ts:416-428` | +0.03 accepted / +0.045 fixed (B) → 9.21 | S / M | a runner test in which Stop pressed after the caller's buy sells the position once the entry finishes |
| 3 | Sponsored-pool residual: accept it, or reserve part of each pool for accounts with history | `SECURITY.md`; `services/ops/src/runtime/budget.ts` | +0.03 / +0.045 → 9.24 | S / M | an Accepted-risks row, or a test |
| 4 | Exit on the raw pool price: accept it, or require pool/reference agreement before a stop fires | `SECURITY.md`; `runtime/index.ts:192`, `rhc/runner.ts:347-356` | +0.03 / +0.045 → 9.27 | S / M | an Accepted-risks row, or a test |
| 5 | Make the oracle-floor properties (N-9) provable, and run them in the `halmos` job | `contracts/test/halmos/OracleBand.t.sol`; `ci.yml` | +0.075 (C +0.5) → 9.345 | M | `check_floor_*` PASS |
| 6 | Negative tests on ≥90% of API mutations | `packages/api/src/routers/*.test.ts` | +0.075 (C +0.5) → 9.42 | M | per-mutation count |
| 7 | In-scope line coverage ≥85% (api 71.1%, ops 81.6%) | `packages/api`, `services/ops` | +0.06 (C +0.4) → 9.48 | M | `bun test --coverage` |
| 8 | Doc comments on ≥90% of off-chain exports and tRPC procedures | `packages/*`, `services/*` | +0.05 (G +0.5) → **9.53** | M | doc-comment count |

Projected: 8.830 → 9.180 → 9.21 → 9.24 → 9.27 → 9.345 → 9.42 → 9.48 → **9.53 (9.5)**.

A rescore at 9.0 or more also needs a `full`/`quick` run within 30 days (the last is `quick` f1b2fad, 2026-10-22, so that holds until 2026-11-21) and the independent check.

Studio policy fixes: none (8/8).

Later:
- A tested CallerShare pause that leaves claims open (needs a redeploy; D +1.0, +0.10, L).
- Re-measure mutation on all contracts to ≥80% (C +0.5).
- Housekeeping, no points:
  - Update the README "Audit" line and `docs/AUDIT.md`. Both still present the 9.1 report, which missed P-M1 to P-M3.
  - Tag the audited commit.

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.5 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 8.5 | 35% | 2.975 | +0.3 | 5 open contract Lows (P-L1, P-L7, P-L8, UTC-day 2×, late-FIRED label); the v1-pair row is closed |
| B Off-chain security | 8.9 | 15% | 1.335 | +1.2 | 3 open Lows (stop during entry [new], sponsored pools, exit on raw pool); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band (api 71.1); negative tests 60–90%; mutation 63.6% (carried); floor-math Halmos does not prove |
| D Privileged ops, deploy & ops | 9.0 | 10% | 0.900 | 0 | no CallerShare pause |
| E Dependencies & supply chain | 10.0 | 5% | 0.500 | 0 | none |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 9.5 | 10% | 0.950 | 0 | doc comments 0.5 |
| **Total before caps** | | | **8.830 → 8.8** | | |
| **Cap** | | | **none** | | |

Arithmetic:
- Total: 0.35×8.5 + 0.15×8.9 + 0.15×7.8 + 0.10×9.0 + 0.05×10.0 + 0.10×10.0 + 0.10×9.5 = 2.975 + 1.335 + 1.170 + 0.900 + 0.500 + 1.000 + 0.950 = 8.830 → **8.8**.
- A = 10 − 5×0.3.
- B = 10 − 3×0.3 − 2×0.1.
- Sensitivity:
  - Without the new stop-during-entry Low, B = 9.2 and the total 8.875, still 8.8.
  - With the five contract Lows accepted, A = 9.5 and the total 9.18 (9.1).

Caps that do not apply:
- No Critical, High or open Medium; no secrets.
- The build and all tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record within 30 days.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against `8962c42`.
- The Step 2 scripts and every test suite were re-run, and CI and the images were re-checked.
- The diff `391f2f1..8962c42` (10 files) was read line by line:
  - `planner.ts` (`fairShare`), `rhc/runner.ts` (`waitAtMost`), `executor.ts` (`pollConfirms`);
  - their tests;
  - the core compose, `allowed-compose.ts`, the fixture and SECURITY.md.
- The last run's three PoCs were re-run. One more PoC checked a race the new entry wait touches: Stop during an entry. There was no other new hunting.
- Contracts, CI workflows, `bun.lock`, `bunfig.toml`, `services/Dockerfile` and `services/ops` are unchanged since `391f2f1`.

| Tool | Result | Output (private run folder) |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh / hygiene_scan.sh | same lanes and hits as the last run (the labelled Anvil test key only; version gates pass) | detect.txt, studio.txt, hygiene.txt |
| gitleaks 8.30.1 (history, 103 commits) | no leaks found | gitleaks-history.txt |
| bun install --frozen-lockfile --ignore-scripts | lockfile honoured. 17 web-only packages failed to link on a Windows path-length limit (not in scope) | install.txt |
| bun test --coverage | all pass:<br>• api 39 (+1 skip)<br>• chain 29<br>• db 4<br>• dsl 22<br>• hl 49 (+8 skips)<br>• seal 10<br>• core 247 (+4)<br>• ops 125<br>Lines: api 71.1, chain 82.7, core 84.0, ops 81.6, hl 89.1. A Bun segfault on the first ops run went away on re-run | bun-*.txt |
| Named regression tests (JUnit) | 15 core P-M/L/fairShare tests ran and passed, 0 failures | junit-ext-core.xml |
| forge build --force / test 1.5.1 | 174/174 across 10 suites | forge-build.txt, forge-test.txt |
| Deep invariants, Halmos, forge coverage, osv-scanner, mutation | not re-run (the contracts and lockfile are unchanged). Carried: 7/7 deep invariants at 128k calls; 99.21% line coverage; `check_setPolicy_onlyPinned` PASS; floor checks time out; mutation 63.6%. CI `halmos` job green at 8962c42 | earlier run folders |
| PoC: P-M3 auto-follower variant (from the last run) | now **fails as intended**: the real copy gets $399.99 (was skipped below the minimum) and the $1M follower gets $1,600 | zz-poc-pm3.txt |
| PoC: L-1 entry wait (from the last run) | the caller's entry waited 1.3 s for the follower's three queued swaps, which is now under the 20 s limit; the new repo test checks the limit itself | zz-poc-l1.txt |
| PoC: Stop during an entry (new) | the follower's buy is stuck, so the caller buys after the wait; Stop pressed then returns false and sells nothing, and the idea is held once the entry finishes | zz-poc-stop-entry.txt |
| On-chain reads (cast, public RPC) | the wallet `0x6da3…75bb` has both SwapKeyPolicy modules uninstalled and both active policies at zero; `Revoked` events on both | chain-reads.txt |
| CI (GitHub API) | 8962c42: CI 39862976894 success (test, halmos, slither, semgrep, gitleaks); images 39862977077 success | ci-runs.txt, attestations.txt |

## Deploy verification
**Robinhood Chain mainnet (4663).** `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` returned **19/19 ok** (post-deploy-check-mainnet.txt). It checks:
- bytecode, with immutables masked, for all five live contracts;
- revealer and poster = the relayer `0xb257…80f1`;
- USDG, poolManager and `maxOracleAge`;
- the `quoteToken` / `oracleOf` pins;
- `SwapKeyPolicy.adapter()`;
- the EIP-712 domains.

**Build of record.**
- Adapter v2 and SwapKeyPolicy v2: `publicCommit` 5b66a52, whose `contracts/src` tree is identical to 8962c42's.
- ThesisSeal, StampRoots and CallerShare: `publicCommit` 71e1fd3, which differs only in comments and NatSpec; `bytecode_hash = "none"`.

**Retired v1 pair.** Immutable and on chain, but no account has it installed any more (on-chain reads above).

**Core CVM** (`/prpc/Info`, app-id `897c44e8…57a3`), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = `2ff12079…6aab` = the single allow-list entry, and the `compose-hash` event in RTMR3;
- the embedded compose == `git show 8962c42:services/core/docker-compose.yml`;
- MRTD/RTMR1/RTMR2 = `ALLOWED_OS` (`dstack-0.5.12`); RTMR3 replays;
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER (unchanged).

**Images.** `gh attestation verify`:
- core `a0a5551d…7e36` → `images.yml@refs/heads/main`, source `6f7be7d0…d5`;
- ops `25d1dc45…a183` → source `8b74d554…f2`.

**Not checked:** the ops CVM compose (no public Info endpoint). The repo pins `25d1dc45…a183`, which the provenance above covers.

## Findings

### [Low] A Stop pressed while an entry is still in progress is dropped (new)
- id: offchain|services/core/src/rhc/runner.ts|stop-during-entry-dropped
- location: `services/core/src/rhc/runner.ts:189` (the idea enters `open` only when `run()` ends), `:380-385` (`stop()` returns false when the idea is not in `open`); `executor.ts:416-428` (the result of `swaps.stop` is ignored); `runtime/events.ts:112-128`.
- category: B
- gate trace:
  - The owner presses Stop after the fire, while the swap entry is still running. The caller has bought, and since 6f7be7d the idea is waiting for a slow follower wave before it opens.
  - `SwapRunner.stop` finds no open idea and returns false. `Executor.stop` carries on, and `EventSink.stop` marks the thesis `stopped` and drops it from memory.
  - `run()` then finishes and opens the position. It still exits on its stop/take levels, but:
    - the owner's Stop sold nothing;
    - the later exit report fails (the idea is not in memory; the error is caught and logged), so the exit part is not revealed.
  - A follower whose key is backed up makes the window longer.
  - PoC: `stop()` → false, and the idea is held after the entry.
  - The race itself is older (a Stop before the caller's buy was dropped in the same way). The new `await followers` after the caller's buy makes the window longer once the caller already holds tokens.
- impact: the owner's Stop is ignored during a window of seconds, which a follower with a busy key can lengthen. The position stays protected by its own exits. The record misses the exit reveal. Broken function × specific timing → Low.
- fix: Path item 2.

### [Low] Five contract Lows reproduced by the external reviewer (open, under Known issues)
- ids: the `external|contracts/…` Low rows. Severities and reasons are unchanged from the last run, and the contracts are unchanged.
- fix: Path item 1 (accept), or the contract batch at the next redeploy.

### [Low] Parked balances still spend the sponsored pools; victims self-pay (unchanged)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion. Fix: Path item 3.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. Fix: Path item 4.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes are never budget- or age-gated |
| P2 | Non-upgradeable | PASS | contracts unchanged; no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | the deployer is unchanged and holds no role |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | hits are a UI generator `yield` and the published audit table |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits |
| P8 | Honest boundaries | PASS | SECURITY.md's external-review table records the two-step fixes and that our earlier report missed P-M1 to P-M3; Known issues lists the contract Lows |

## Fixed since last run
- `external|services/core/src/faircopy/planner.ts|confirm-follower-depth-collapse` (Medium): `fairShare` (6f7be7d).
- `external|services/core/src/rhc/runner.ts|key-queue-delay` (Low): the entry `waitAtMost` and parallel confirms per fire (6f7be7d).
- `pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier` (Low): closed on chain. The last v1 wallet uninstalled both modules, so no session key can reach adapter v1.

Fix-line sanity checks, all sound:
- `fairShare` is standard max-min water-filling. The sum never exceeds the cap, and the smallest wants are filled first.
- Confirm-only followers share only what auto followers leave. `plan.scale` is now only a logged aggregate.
- `waitAtMost` clears its timer. The caller buys after the limit, and the late follower holding still joins the leg before it opens (repo test).
- `pollConfirms` groups by `fireId`. Confirms on the same follower key stay serialized by the runner's per-key queue, and Hyperliquid nonces are monotonic per signer in process.

Leads (no deduction):
- **P-M3 residual:** with max-min sharing, pushing a real copy under $10 needs about cap/10 funded follower accounts with approved agents among the 1,000 oldest follows. On books with a cap above $10,000 it cannot be done within the follow limit.
- **L-1 residual:** a follower who misses the 20 s entry limit buys after the caller. This is the follower's own delay, and the ordering is logged.
- Carried from the last run: P-M4 residual; the untracked holding after `nonce_conflict` (L-2); `swapkey.status` RPC read per call; a stop dropped after 5 reads stays held; the self-seal "stamped at" ~2 h; the carried infrastructure leads (public RHC RPC, app-scoped dstack keys, images.yml `ref: main`, the OpenSSL HIGH rows, and the others listed earlier).

## Accepted risks
From SECURITY.md "Accepted risks" (2026-10-22), unchanged:
- `deploy|contracts|deploy-path-and-hot-key` (Low): one hot relayer key holds every immutable role. The contracts are ownerless, and the relayer cannot move user funds.
- `offchain|supabase/migrations/20261021190000_orders_fill_stamp.sql|fill-leaf-follower-linkage` (Low): FILL leaves can link a follower's trades to a caller. The record exists to prove Fair Copy ordering.

## Checklist detail (C, D, E, F, G)
**C 7.8** = 1.5 + 0.8 + 0.5 + 1.0 + 2.0 + 0.5 + 1.0 + 0 + 0.5:
- 1.5: tests pass (forge 174/174; every bun suite EXIT=0).
- 0.8: coverage in the ≥70% band (contracts 99.21% carried; core 84.0, ops 81.6, chain 82.7, api 71.1).
- 0.5: negative tests (API 60–90% band).
- 1.0: fuzz.
- 2.0: invariants (7 pass at 16k calls in this run; the 128k deep run is carried because the contracts are unchanged).
- 0.5: mutation 63.6% (carried).
- 1.0: integration.
- 0: symbolic (the floor math does not prove).
- 0.5: CI on every push (39862976894).

**D 9.0:** unchanged. Roles 1.5, no admin 1.5, not upgradeable 1.5, pause 0, setters 1.0, deploy scripts 1.0, post-deploy check 1.5 (19/19 live this run), monitoring 1.0.

**E 10.0, F 10.0:** unchanged (the lockfile, workflows and toolchains are unchanged; gitleaks is clean over 103 commits).

**G 9.5** = 1.5 README + 1.5 architecture + 2.0 invariants (160/160 references) + 1.5 threat model + 0.5 doc comments (pooled ≈ 65%) + 1.0 deployed addresses and build of record + 1.0 audit history + 0.5 readiness (scope list; frozen commit 8962c42).

## Independent check
Not run this time. The skill requires it for `full` runs and for runs that cross 9.0, and this run moved from 8.5 to 8.8.

The last check, at 391f2f1, recomputed 8.545 exactly and could not refute any finding. Since then, every category score change comes from verified fixes (repo tests, a re-run PoC that now fails, and on-chain reads) and from one new Low that has a passing PoC.

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
