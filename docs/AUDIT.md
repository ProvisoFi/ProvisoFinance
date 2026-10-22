# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 9.1 / 10** (no cap binds) · Rubric v2
Commit `d41f54f` (public main) · Mode `rescore` · 2026-10-23
Previous: 8.8 on 2026-10-23 (`rescore`, `8962c42`) (+0.3; total 8.830 → 9.180) · Studio policy: 8/8 pass
Deployed build: **matches** (ops CVM not checked: no public Info endpoint).
- Mainnet contracts: `post-deploy-check.ts` passed 19/19 in this run. The contracts are unchanged since `0c9d47a`.
- Core CVM: live `compose_hash` `2ff12079…6aab` = sha256(app_compose) = the only `ALLOWED_COMPOSE_HASHES` entry. The embedded compose is byte-identical to `git show d41f54f:services/core/docker-compose.yml` (image `proviso-core@sha256:a0a5551d…7e36`), and RTMR3 replays from the event log.
- Images: unchanged since the last run.
  - Core `a0a5551d…7e36` comes from `6f7be7d0…d5` (run 39862576372).
  - Ops `25d1dc45…a183` comes from `8b74d554…f2` (run 39856715608).

Independent check: **agreed**. A fresh agent recomputed 9.180 → 9.1 with every category identical. All five acceptances hold; the P-L1 row's wording is incomplete (weekend staleness is routine). Details are at the end.

**What changed since 8962c42.** Only documentation changed: README, SECURITY.md and `docs/AUDIT.md`. Apart from those three files, the tree is identical to `8962c42` (compared with `git ls-tree`).

The owner accepted the five contract Lows the external reviewer reproduced. They moved from "Known issues" to SECURITY.md "Accepted risks", dated 2026-10-23, each with a reason, mitigations and a revisit trigger.

I checked every row against the contract code. **All five hold up**, so the ledger marks them `accepted`. Each now deducts −0.1 instead of −0.3, and A goes from 8.5 to 9.5.

The three off-chain Lows stay open:
- stop during an entry;
- sponsored pools;
- exit on the raw pool price.

## Accepted-risk review (the five contract Lows)

| Ledger id | SECURITY.md row | Reason vs code | Mitigations | Revisit trigger | Verdict |
| --- | --- | --- | --- | --- | --- |
| `external\|contracts/src/ProvisoSwapAdapter.sol\|stale-oracle-blocks-exit` (P-L1) | "A stale or paused oracle blocks session-key exits" | Accurate. `_oracleFloor` (`ProvisoSwapAdapter.sol:327-349`) reverts `StaleOracle` past `maxOracleAge` (90000 s, live value checked by `post-deploy-check.ts`) and `OraclePaused`, in both directions. The tokens stay in the user's wallet | Hold:<br>• the user can sell from their own wallet;<br>• `services/ops/src/runtime/alerts.ts` alerts on a stale feed, an answer ≤ 0 or `oraclePaused`;<br>• an incomplete exit keeps the idea open (`rhc/runner.ts:421-424`), so later price ticks retry it | At the next adapter redeploy, or the first exit blocked in practice | **Accepted**, wording incomplete. The contract's NatSpec (`:106-108`) says the 24/5 feeds go stale **every weekend**, so session-key exits are routinely blocked from about Saturday to the Monday open and on holidays. Also:<br>• the ops stale alert runs only in the NYSE session (`alerts.ts:152`);<br>• `MultiplierChangeUnpriced` is a third exit-blocking revert;<br>• an owner Stop during staleness is dropped after 5 reads.<br>Low still holds (fail-closed; the tokens are in the user's wallet; the market is closed then). The revisit trigger will fire on the first weekend stop |
| `external\|contracts/src/ProvisoSwapAdapter.sol\|shared-policy-nonce` (P-L7) | "Adapter policy nonces are shared across an account's pools" | Accurate. `lastPolicyNonce` is per account (`:176, :271-279`). Policies are keyed by `msg.sender` (`swap`, `:313`), so only the account can swap with them | Hold: setup builds its adapter policies at `lastPolicyNonce + 1 + i` (`packages/chain/src/swaps.ts:516`) and submits them in order. Nit: an out-of-order relay leaves a partial setup rather than a failed one (ops skips used nonces) | Next adapter redeploy (per-pool nonces) | **Accepted** |
| `external\|contracts/src/SwapKeyPolicy.sol\|redelegation-revives-key` (P-L8) | "A 7702 re-delegation back to Kernel revives an old session key" | Accurate. `activePolicy` is keyed by account (declared at `SwapKeyPolicy.sol:104`, written at `:188`) and checked in `executeSwap` (`:217-239`). Only the EOA's key signs a 7702 authorization | Hold:<br>• revoke uninstalls every SwapKeyPolicy module (L-4), and `onUninstall` → `_revoke` clears the policy (`:284-285`);<br>• policies expire. The 30-day limit (30 days + 1 h) is enforced by the app (`swaps.ts:226`, `:564`), not by the contract, which only requires a future expiry | Next SwapKeyPolicy redeploy, or if wallets start re-delegating | **Accepted** |
| `external\|contracts/src/SwapKeyPolicy.sol\|utc-day-cap-2x` | "The per-day swap cap allows up to 2x around UTC midnight" | Accurate. The day is `block.timestamp / 1 days` (`:231-234`); the worst case is 2× a user-signed cap, with the per-trade cap still applied | Hold: default USDG caps are $100 per trade and $500 per day (`swaps.ts:225`), plus the per-trade cap. Wording note: the session key also trades the account's Fair Copy copies of callers it follows, not only "its own signed ideas" | Next SwapKeyPolicy redeploy (rolling window) | **Accepted** (with the wording note) |
| `external\|contracts/src/ThesisSeal.sol\|owner-relabels-late-fired` | "The owner can label a late FIRED reveal as EXPIRED" | Accurate. The revealer may reveal FIRED until `expiresAt + FIRE_REVEAL_GRACE` (1 min); the owner may reveal only EXPIRED, and only after that (`ThesisSeal.sol:77-79, 211-217`) | Hold: the FIRE stamp leaf in the hourly roots (and FILL leaves and on-chain trades when a position opened) still records the fire. Wording note: the window opens for any FIRED reveal delayed past `expiresAt` + 60 s (for example an ops outage spanning the expiry), not only for an idea that fires in its last moments | ThesisSeal v2 (reveal kind and fire evidence on chain) | **Accepted** |

None was rejected. The wording corrections have no grade effect:
- **P-L1** (most important): say that weekend and holiday staleness is routine.
- **UTC-day:** the session key also trades Fair Copy copies of callers the account follows.
- **Late-FIRED:** the window opens for any FIRED reveal delayed past `expiresAt` + 60 s.

## External review (re-audit v1.1)

An independent external reviewer audited the public repository at `86e99de` (2026-10-22) and graded it 7.0. Their weighted score was 8.2, held at 7.0 only because they could not read the chain or the enclave. They reported four Medium findings, P-M1 to P-M4, and four new Low findings, L-1 to L-4, each with a passing proof of concept.

**What our 9.1 report missed.** Our published 9.1 report (`0c9d47a`) missed P-M1, P-M2 and P-M3. It had P-M4 ("follow-slot squatting") only as an unverified lead, with no deduction, and it had none of L-1 to L-4.

The rescore at `391f2f1` (8.5) found P-M3 and L-1 only partly fixed. The rescore at `8962c42` (8.8) verified all eight fixed. The code is unchanged since then, and every status below was re-confirmed by this run's test suites.

| ID | Finding | Status | Evidence (file + test) |
| --- | --- | --- | --- |
| P-M1 (Medium) | The API stored the allow-list as an object, but core read only arrays, so Fair Copy never auto-copied | **Verified fixed** | `packages/db/src/allowlist.ts` `allowEntries` (used by `follow.ts:58`, `executor.ts:303`, `rhc/runner.ts:207`). Tests: `follow.test.ts` "P-M1: an allow-list sent to follow.create is stored as entries core can read"; `executor.test.ts` "P-M1: a follow stored in the API's object shape auto-copies on Hyperliquid"; `rhc/runner.test.ts` "P-M1: … still auto-copies (no tap-to-confirm)" |
| P-M2 (Medium) | Stop after a fire crashed core | **Verified fixed** | `runtime/ideas.ts` `hold()`; `events.ts:112-128`; `.catch` on exit and event callbacks; `unhandledRejection` handler (`services/core/src/index.ts:44`). Test: `events.test.ts` "P-M2: Stop on a fired idea reports its exit (reveal + EXIT) instead of crashing, then drops the idea" |
| P-M3 (Medium) | One follower with a huge size collapsed every other follower's copy | **Verified fixed** (two steps) | 8b74d55 (confirm-only path) and 6f7be7d: `planner.ts:127-139` `fairShare`, a max-min fair split with auto followers first. Tests: `faircopy.test.ts` "P-M3: one funded follower with a $1M size can't squeeze the real auto followers below the minimum", "fairShare: smallest first, equal split of the rest, never above the cap", and "P-M3: one huge confirm-only follower no longer shrinks the auto followers' copies" |
| P-M4 (Medium) | Follow-slot squatting | **Verified fixed** | `executor.ts:149-163` `fireFollows(…, venue)`. Tests: `executor.test.ts` "P-M4: a crowd of keyless follows made before a real follower can't squat the per-fire slots"; `rhc/runner.test.ts` "P-M4: keyless follows made before the real follower can't squat its slot" |
| L-1 (Low) | A follower's key queue could delay the caller's idea; Stop while busy returned true but sold nothing | **Verified fixed** (two steps) | 8b74d55 (exit and Stop) and 6f7be7d (the entry `waitAtMost`, `rhc/runner.ts:167-172, 369-374`; parallel confirms per fire, `executor.ts:693-711`). Tests: `runner.test.ts` "L-1: a follower whose buy is stuck can't hold the caller's entry beyond the wait; its holding still counts", "L-1: Stop pressed while a late copy is going in waits for it, then sells everything (no silent no-op)", "L-1: a follower whose sell is stuck can't hold the caller's stop-loss beyond the wait"; `executor.test.ts` "L-1: confirms for different fires run in parallel; one fire's confirms stay in order" |
| L-2 (Low) | A nonce-race retry could buy twice | **Verified fixed** | `rhc/executor.ts` signs locally; `runner.ts` retries only `isNonceTooLow`. Tests: `rhc/executor.test.ts` "L-2: a node answering "already known" … nothing is re-sent"; `runner.test.ts` "L-2: "replacement transaction underpriced" is not re-sent at a new nonce" |
| L-3 (Low) | Restore race after a restart | **Verified fixed** | `runtime/index.ts:53-65` `fireGate`. Test: `gate.test.ts` "L-3: fires wait for the restart restore, then go through in order; expiries never wait" |
| L-4 (Low) | The retired v1 SwapKeyPolicy stayed installed after a revoke | **Verified fixed, in code and on chain** | `legacySwapKeyPolicies`, `checkRevokeOps`, multi-op revoke, and the ops relay checks. Tests: `swaps.test.ts` "checkRevokeOps (L-4)"; ops `budget.test.ts` "L-4: …" (2 tests). On chain at block 95465749 the affected wallet `0x6da3…75bb` has `isModuleInstalled` = false and `activePolicy` = 0 on both v1 and v2 (`Revoked` at blocks 95443567 and 95443598) |

The reviewer's other findings:
- **Five contract Lows:** accepted (see the review above).
- **Info rows:** fee-on-transfer or blocklisted USDG; pins per token, not per pool; the multiplier hard-wired to 1e18; Trivy CRITICAL-only after the push; Halmos `OracleBand` inconclusive. These carry no deduction. The pin, Trivy and Halmos items remain under "Known issues".

## Path to 9/10
The grade is 9.1 (total 9.180). No cap binds, so every item adds its full weighted value.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | Stop during an entry: register the idea (marked busy) before the follower wave, so `stop()` joins it and sells after the entry, or queue the stop. Or accept it | `services/core/src/rhc/runner.ts:142-189, 380-385`; `executor.ts:416-428` | +0.03 accepted / +0.045 fixed (B) → 9.21 | S / M | a runner test in which Stop pressed after the caller's buy sells the position once the entry finishes |
| 2 | Sponsored-pool residual: accept it, or reserve part of each pool for accounts with history | `SECURITY.md`; `services/ops/src/runtime/budget.ts` | +0.03 / +0.045 → 9.24 | S / M | an Accepted-risks row, or a test |
| 3 | Exit on the raw pool price: accept it, or require pool/reference agreement before a stop fires | `SECURITY.md`; `runtime/index.ts:192`, `rhc/runner.ts:347-356` | +0.03 / +0.045 → 9.27 | S / M | an Accepted-risks row, or a test |
| 4 | Make the oracle-floor properties (N-9) provable, and run them in the `halmos` job | `contracts/test/halmos/OracleBand.t.sol`; `ci.yml` | +0.075 (C +0.5) → 9.345 | M | `check_floor_*` PASS |
| 5 | Negative tests on ≥90% of API mutations | `packages/api/src/routers/*.test.ts` | +0.075 (C +0.5) → 9.42 | M | per-mutation count |
| 6 | In-scope line coverage ≥85% (api 71.1%, ops 81.6%) | `packages/api`, `services/ops` | +0.06 (C +0.4) → 9.48 | M | `bun test --coverage` |
| 7 | Doc comments on ≥90% of off-chain exports and tRPC procedures | `packages/*`, `services/*` | +0.05 (G +0.5) → **9.53** | M | doc-comment count |

Projected: 9.180 → 9.21 → 9.24 → 9.27 → 9.345 → 9.42 → 9.48 → **9.53 (9.5)**.

Keeping a grade of 9.0 or more on a rescore needs a `full`/`quick` run within 30 days. The last one is `quick` f1b2fad (2026-10-22), so that holds until 2026-11-21. Plan a `quick` or `full` run before then.

Studio policy fixes: none (8/8).

Later:
- A tested CallerShare pause that leaves claims open (needs a redeploy; D +1.0, +0.10, L).
- Fix the accepted contract Lows at the next redeploy (A +0.2 each, +0.07 each).
- Re-measure mutation on all contracts to ≥80% (C +0.5).
- Housekeeping, no points:
  - Tag the audited commit.
  - Amend the P-L1 row in SECURITY.md:
    - weekend and holiday staleness is routine;
    - the ops stale alert runs only in session;
    - `MultiplierChangeUnpriced` also blocks exits;
    - an owner Stop during staleness is not retried after 5 reads.
  - Amend the UTC-day row: the session key also trades followed callers' copies.
  - Amend the late-FIRED row: any FIRED reveal delayed past `expiresAt` + 60 s opens the window.

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.8 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.5 | 35% | 3.325 | +1.0 | 5 accepted contract Lows (−0.1 each) |
| B Off-chain security | 8.9 | 15% | 1.335 | 0 | 3 open Lows (stop during entry, sponsored pools, exit on raw pool); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band (api 71.1); negative tests 60–90%; mutation 63.6% (carried); floor-math Halmos does not prove |
| D Privileged ops, deploy & ops | 9.0 | 10% | 0.900 | 0 | no CallerShare pause |
| E Dependencies & supply chain | 10.0 | 5% | 0.500 | 0 | none |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 9.5 | 10% | 0.950 | 0 | doc comments 0.5 |
| **Total before caps** | | | **9.180 → 9.1** | | |
| **Cap** | | | **none** | | |

Arithmetic:
- Total: 0.35×9.5 + 0.15×8.9 + 0.15×7.8 + 0.10×9.0 + 0.05×10.0 + 0.10×10.0 + 0.10×9.5 = 3.325 + 1.335 + 1.170 + 0.900 + 0.500 + 1.000 + 0.950 = 9.180 → **9.1**.
- A = 10 − 5×0.1.
- B = 10 − 3×0.3 − 2×0.1.
- Sensitivity: if any one accepted row were rejected, A would be 9.3 and the total 9.11 (9.1). If all five were rejected, the total would be 8.83 (8.8).

Caps that do not apply:
- No Critical, High or open Medium; no secrets.
- The build and all tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record within 30 days (f1b2fad, 2026-10-22), so a rescore may report 9+.

## Scope
**Mode `rescore`:**
- Every open and accepted ledger row was re-verified against `d41f54f`.
- The diff `8962c42..d41f54f` is three documentation files. Every new Accepted-risks row was checked against the contract and app code it cites.
- The Step 2 scripts and every test suite were re-run, and the deploy checks were repeated.
- There was no new hunting.

| Tool | Result | Output (private run folder) |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh / hygiene_scan.sh | same lanes and hits as the last run (only the labelled Anvil test key; P5 hits are a UI generator `yield` and the published audit table) | detect.txt, studio.txt, hygiene.txt |
| gitleaks 8.30.1 (history, 105 commits) | no leaks found | gitleaks-history.txt |
| bun test --coverage | all pass:<br>• api 39 (+1 skip)<br>• chain 29<br>• db 4<br>• dsl 22<br>• hl 49 (+8 live skips)<br>• seal 10<br>• core 247<br>• ops 125<br>Lines: api 71.1, chain 82.7, core 84.0, ops 81.6, hl 89.1 | bun-*.txt |
| forge test 1.5.1 | 174/174 across 10 suites | forge-test.txt |
| Deep invariants, Halmos, forge coverage, osv-scanner, mutation | not re-run (the contracts and lockfile are unchanged). Carried: 7/7 deep invariants at 128k calls; 99.21% line coverage; `check_setPolicy_onlyPinned` PASS; floor checks time out; mutation 63.6% | earlier run folders |
| On-chain reads (cast, public RPC) | wallet `0x6da3…75bb`: both SwapKeyPolicy modules uninstalled, `activePolicy` 0 on both (block 95465749) | chain-reads.txt |
| CI (GitHub API) | d41f54f: CI 39866533924 success (test, halmos, slither, semgrep, gitleaks) | ci-runs.txt |

## Deploy verification
**Robinhood Chain mainnet (4663).** `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` returned **19/19 ok** (post-deploy-check-mainnet.txt). It checks:
- bytecode, with immutables masked, for all five live contracts;
- the relayer roles;
- USDG, poolManager and `maxOracleAge` 90000;
- the oracle and quote pins;
- `SwapKeyPolicy.adapter()`;
- the EIP-712 domains.

**Build of record.**
- Adapter v2 and SwapKeyPolicy v2: `publicCommit` 5b66a52 (its `contracts/src` tree equals d41f54f's).
- The other three contracts: `publicCommit` 71e1fd3, which differs from d41f54f in comments and NatSpec only; `bytecode_hash = "none"`.

**Core CVM** (`/prpc/Info`, app-id `897c44e8…57a3`), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = `2ff12079…6aab` = the single allow-list entry;
- the embedded compose == `git show d41f54f:services/core/docker-compose.yml`;
- MRTD/RTMR1/RTMR2 = `ALLOWED_OS`; RTMR3 replays;
- `allowed_envs` unchanged.

**Images.** The provenance checked in the last run still covers both deployed digests. `services/` is unchanged since then.

**Not checked:** the ops CVM compose (no public Info endpoint). It sits outside the 7.0 cap's wording (a known address or program ID), as in earlier runs.

## Findings

### [Low] A Stop pressed while an entry is still in progress is dropped (open, unchanged)
- id: offchain|services/core/src/rhc/runner.ts|stop-during-entry-dropped
- The idea enters the runner's open map only when `run()` ends (`rhc/runner.ts:189`).
- `stop()` returns false before that (`:380-385`), and `Executor.stop` ignores the result (`executor.ts:416-428`). The thesis is then marked stopped and dropped from memory.
- The position opens anyway and keeps its own stop/take exits. But the owner's Stop sold nothing, and the exit is not revealed.
- The PoC from the last run is unchanged (the code is unchanged).
- fix: Path item 1.

### [Low] Parked balances still spend the sponsored pools; victims self-pay (open, unchanged)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion. Fix: Path item 2.

### [Low] Swap exits trigger on the raw pool price (open, unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. Fix: Path item 3.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes are never budget- or age-gated. The accepted stale-oracle risk is a fail-closed swap path; the user's own wallet exit is never gated |
| P2 | Non-upgradeable | PASS | contracts unchanged; no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | deployer unchanged and holds no role |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | false-positive hits only |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits |
| P8 | Honest boundaries | PASS | Accepted risks carry reasons, mitigations and revisit triggers; the external-review section and the README audit line name the external review and the fixes |

## Fixed since last run
- No findings changed status to fixed.
- Five Lows changed from `open` to `accepted` (review above).
- `docs/AUDIT.md` now carries the 8.8 report, and the README audit line names the external review.

Leads (no deduction, carried):
- **P-M3 residual:** about cap/10 funded sybil followers would be needed to push a real copy under the minimum.
- **L-1 residual:** a follower who misses the 20 s entry limit buys after the caller.
- **P-M4 residual:** squatting needs 1,000 onboarded accounts.
- The untracked holding after `nonce_conflict` (L-2).
- `swapkey.status` RPC read per call.
- A stop dropped after 5 reads stays held.
- The self-seal "stamped at" ~2 h.
- Carried infrastructure leads: public RHC RPC, app-scoped dstack keys, images.yml `ref: main`, the OpenSSL HIGH rows, and the others listed in earlier reports.

## Accepted risks
From SECURITY.md "Accepted risks":
- `deploy|contracts|deploy-path-and-hot-key` (Low, 2026-10-22): one hot relayer key holds every immutable role.
- `offchain|supabase/migrations/20261021190000_orders_fill_stamp.sql|fill-leaf-follower-linkage` (Low, 2026-10-22): FILL leaves can link a follower's trades to a caller.
- The five contract Lows (2026-10-23): stale or paused oracle blocks exits (P-L1); shared adapter policy nonce (P-L7); 7702 re-delegation revives a key (P-L8); UTC-day 2× cap; late-FIRED label. The review is in the table above.

## Checklist detail (C, D, E, F, G)
**C 7.8** = 1.5 + 0.8 + 0.5 + 1.0 + 2.0 + 0.5 + 1.0 + 0 + 0.5:
- 1.5: tests pass.
- 0.8: coverage in the ≥70% band (contracts 99.21% carried; core 84.0, ops 81.6, chain 82.7, api 71.1).
- 0.5: negative tests in the 60–90% band.
- 1.0: fuzz.
- 2.0: invariants (7 pass in this run's default profile; the 128k deep run is carried because the contracts are unchanged).
- 0.5: mutation 63.6% (carried).
- 1.0: integration.
- 0: symbolic.
- 0.5: CI on every push.

**D 9.0:** roles 1.5, no admin 1.5, not upgradeable 1.5, pause 0, setters 1.0, deploy scripts 1.0, post-deploy check 1.5 (19/19 this run), monitoring 1.0.

**E 10.0, F 10.0:** unchanged (gitleaks clean over 105 commits; workflows and lockfile unchanged).

**G 9.5** = 1.5 README + 1.5 architecture + 2.0 invariants + 1.5 threat model (Accepted risks now covers every contract Low with reason, mitigation and revisit trigger) + 0.5 doc comments + 1.0 deployed addresses and build of record + 1.0 audit history (`docs/AUDIT.md` 8.8, external review in SECURITY.md and README) + 0.5 readiness.

## Independent check
A fresh agent that had not seen the audit was given this report, the ledger, the rubric, the clone at d41f54f and the run folders, read-only.
- **(a) Recompute:** A 9.5, B 8.9, C 7.8, D 9.0, E 10.0, F 10.0, G 9.5 → 9.180 → **9.1**, no cap binds. It confirmed:
  - the rescore 9+ rule (quick f1b2fad within 30 days);
  - the deploy verdict (19/19; the compose hash and RTMR3 replay);
  - every suite passing.
- **(b) Refutation attempts:**
  - All five acceptances hold.
    - **P-L1:** valid, but its row omits that the 24/5 feeds go stale every weekend (the adapter's own NatSpec). The ops stale alert also runs only in session, `MultiplierChangeUnpriced` is a third blocking revert, and an owner Stop during staleness is dropped after 5 reads. It stays Low: fail-closed, tokens in the user's wallet, market closed.
    - **P-L7, P-L8, UTC-day and late-FIRED:** accurate, with wording nits. The nits and line corrections are now in the review table above.
  - The three open Lows were confirmed Low and none is worse.
    - **Exit-on-raw-pool:** every sell is bounded by the oracle floor (3% band) and the `pool_outside_band` refusal, on positions capped at $100 per trade.
- **(c) Spot-checks, all hold:**
  - G threat model (1.5);
  - D post-deploy verification (1.5; exits 1 on any mismatch);
  - F no secrets (3.0; gitleaks 105 commits = `git rev-list --count`).
  - The agent noted that the only `.env.example` is under the out-of-scope web app. Docking that 0.5 would give 9.13, still 9.1. It recommends keeping the point, as earlier runs did.
- **Corrections applied here, no score change:**
  - the P-L1 and late-FIRED wording;
  - the `activePolicy` declaration line;
  - the CI line (confirmed green after capture);
  - the ops-CVM cap note.

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
