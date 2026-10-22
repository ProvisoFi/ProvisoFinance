# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 9.1 / 10** (no cap binds) · Rubric v2
Commit `0c9d47a` = tag `v1.1.0` (public main) · Mode `rescore` · 2026-10-22
Previous: 9.1 on 2026-10-22 (`rescore`, `d7be0c1` = `v1.0.0`) (±0; total 9.150 → 9.195) · Studio policy: 8/8 pass
Deployed build: **matches** (ops CVM not checked: no public Info endpoint).
- Mainnet contracts: `post-deploy-check.ts` passed 19/19 in this run, after a fresh `forge build --force` of `0c9d47a`.
  - Bytecode matches for all five live contracts, including adapter v2 `0xe215…ec0b` and SwapKeyPolicy v2 `0xf8d8…a5`.
  - The new pins match: `quoteToken()` = USDG, `oracleOf(TSLA/AMZN)` = the Chainlink feeds, `oracleOf(USDG)` = 0, and `SwapKeyPolicy.adapter()` = adapter v2.
  - Both v2 deploy transactions come from the recorded deployer `0xb2fe…1Da1`.
- Build of record for v2: flagged.
  - `mainnet.json` records commit `c7cef65`, which is not in the public history, and has **no `publicCommit` for the v2 pair**.
  - Public `5b66a52` (and `0c9d47a`) carries a byte-identical `contracts/src` tree (`0b177957…`). This report uses it as the build of record.
- Core CVM:
  - Live `compose_hash` a46d1b24…fa87 = sha256(app_compose) = the only `ALLOWED_COMPOSE_HASHES` entry.
  - The embedded compose is byte-identical to `git show 0c9d47a:services/core/docker-compose.yml` (989 bytes, image `proviso-core@sha256:df26787e…56b3`).
  - MRTD/RTMR1/RTMR2 equal the `ALLOWED_OS` pins, and RTMR3 replays from the event log.
- Images: Sigstore provenance for `proviso-core@sha256:df26787e…56b3` and `proviso-ops@sha256:0f919aaa…a4b6` names `images.yml@refs/heads/main`, source `5b66a525…f4`, run 39798936988 (success, Trivy steps green). 5b66a52 → 0c9d47a changes only the two compose digests, the allow-list entry and the attestation fixture.

Independent check: **agreed** — a fresh agent recomputed 9.1 (total 9.195), category by category identical; details at the end.

## Path to 9/10
The grade is 9.1 (total 9.195). Points are changes to the final grade. No cap binds, so every item adds its full weighted value.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | Close the retired v1 swap pair. The one account with a live v1 session key revokes it (`revoke()` on `0x7242…4a9d`), or waits for its expiry (2026-11-20 19:32 UTC). The app prompts any v1 key holder to revoke and set up again on v2 | on chain; app swap-key flow | +0.105 (A +0.3) | S | `cast logs` on `0x7242…4a9d` shows `Revoked` for every account with a `PolicySet`, or every v1 `expiresAt` is past |
| 2 | Update the README "Deployed contracts" table to adapter v2 and SwapKeyPolicy v2, with Blockscout links, and drop "fresh, single-use deployer". Add `publicCommit` 5b66a52 to the v2 entries in `mainnet.json` | `README.md:162-171,187`; `packages/chain/deployments/mainnet.json` | +0.10 (G +1.0) | S | the README links resolve to `0xe215…ec0b` / `0xf8d8…a5`; the `publicCommit` tree equals `contracts/src` |
| 3 | Sponsored-pool residual: accept it in SECURITY.md "Accepted risks" with the reason (it is now under Known issues, which is not acceptance), **or** close it by reserving part of each pool for accounts with history | `SECURITY.md`; `services/ops/src/runtime/budget.ts` | +0.03 accepted (B +0.2) / +0.045 fixed | S / M | the Accepted-risks row, or a test in which the parked-balance PoC leaves an established account sponsored |
| 4 | Make the oracle-floor properties (N-9) provable: bound the symbolic widths, or prove a `mulDiv` lemma once and the floor properties on it. Run them in the `halmos` job | `contracts/test/halmos/OracleBand.t.sol`; `.github/workflows/ci.yml` | +0.075 (C +0.5) | M | Halmos output with `check_floor_*` PASS |

Projected: 9.195 → 9.30 → 9.40 → 9.43 → **9.505 (9.5)**.
A rescore at 9.0 or more needs the independent check and a `full`/`quick` run within 30 days. The last `quick` is f1b2fad (2026-10-22), so that holds until 2026-11-21.
Studio policy fixes: none (8/8).

Later:
- Exits require pool/reference agreement before a stop fires (`services/core/src/runtime/index.ts`, `rhc/runner.ts`; B +0.3, +0.045, M).
- A tested CallerShare pause that leaves claims open (needs a redeploy; D +1.0, +0.10, L).
- Doc comments on off-chain exports and tRPC procedures to ≥90% pooled (G +0.5, +0.05, M).
- Re-measure mutation on all contracts to ≥80% (C +0.5).
- Off-chain line coverage ≥85% (api 70.6%) (C +0.4).
- Negative tests on ≥90% of API mutations (C +0.5).
- Housekeeping, no points:
  - Remove the stray `| ` row that ends the SECURITY.md "Known issues" table.
  - Re-run the failed `images.yml` run at 0c9d47a (Docker Hub 500; see Scope).
  - Add `apk upgrade --no-cache` for the OpenSSL HIGH rows (lead carried).

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 9.1 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.7 | 35% | 3.395 | 0 | 1 Low: the adapter oracle/multiplier gap. Fixed in v2; the retired v1 pair still serves one live session key |
| B Off-chain security | 9.2 | 15% | 1.380 | +0.3 | 2 open Lows (sponsored-pool residual; exit on raw pool); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band (api 70.6); negative tests in the 60–90% band; mutation 63.6% (carried); floor-math Halmos checks time out |
| D Privileged ops, deploy & ops | 9.0 | 10% | 0.900 | +1.0 | no CallerShare pause |
| E Dependencies & supply chain | 10.0 | 5% | 0.500 | 0 | none |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 8.5 | 10% | 0.850 | −1.0 | README lists the retired adapter/SwapKeyPolicy as live, and v2 has no public build-of-record hash (−1.0); doc comments 0.5 |
| **Total before caps** | | | **9.195 → 9.1** | | |
| **Cap** | | | **none** | | |

Arithmetic:
- Total: 0.35×9.7 + 0.15×9.2 + 0.15×7.8 + 0.10×9.0 + 0.05×10.0 + 0.10×10.0 + 0.10×8.5 = 3.395 + 1.380 + 1.170 + 0.900 + 0.500 + 1.000 + 0.850 = 9.195 → **9.1**.
- A = 10 − 0.3 (the adapter row, narrowed to the retired v1 pair).
- B = 10 − 2×0.3 (sponsored-pool residual, exit on raw pool) − 2×0.1 (accepted: hot relayer, FILL leaf).
- Sensitivity:
  - If the adapter row were read as fixed (its last proof, "a fuzz test; the live check passes on the new addresses", is met), A = 10.0 and the total 9.300 → 9.3. This run keeps it open because the retired pair still serves a live, unrevoked session key with v1 policies (Findings).
  - If the passing Halmos pin proof counted for the symbolic line, C = 8.3 and the total 9.270 (9.2); with the adapter row also read as fixed, 9.375 (9.3).
- Doc-comment basis: the same as the last run (contracts plus the off-chain in-scope exports and tRPC procedures, pooled). Contracts-only would give G 9.0 and a total of 9.245 (9.2).

Caps that do not apply:
- No Critical, High or open Medium; no secrets; build and tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record today (f1b2fad, within 30 days), so a rescore may report 9+.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against 0c9d47a.
- Step 2 scripts and all test suites were re-run, and CI (including the new `halmos` job) and the image workflow were re-checked.
- The diff d7be0c1..0c9d47a (34 files) was read line by line:
  - contracts: `ProvisoSwapAdapter.sol` (pins, `OracleBand`), the adapter, invariant and Halmos tests, `Deploy.s.sol`;
  - deploy: `deploy-mainnet.ts` (`ADAPTER_V2`), `post-deploy-check.ts`, `swaps.ts` (`adapterPins`), `mainnet.json`;
  - services: `ideas.ts`, `alerts.ts`/`start.ts`, the `ops_watch` migration, both compose files, `allowed-compose.ts`;
  - CI and docs: `ci.yml`, SECURITY.md, `docs/INVARIANTS.md`, README.
- No new hunting outside those lines.

**Stack / lanes:** unchanged (EVM, TEE, oracle, Bun/TS backend, AI writer, RWA). The frontend is out of scope.

| Tool | Result | Output |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh | ran on a `git archive` of 0c9d47a. Detect differs only in test counts (evm tests 9→11, fuzz/invariant 9→10). Studio hits differ only by line numbers and the new `adapterPins` multiplier guard. The P5 hit is the published audit table, a false positive | runs/20261022-180845/detect.txt, studio.txt |
| hygiene_scan.sh | ran on the clone; unchanged apart from the new `halmos` CI job line (only labelled test keys and vendored forge-std strings) | hygiene.txt |
| gitleaks 8.30.1 (history, 88 commits) | no leaks found | gitleaks-history.txt |
| actionlint 1.7.12 / zizmor 1.31.1 | clean / no findings (7 suppressed; the new one is an `anonymous-definition` info on the `halmos` job) | actionlint.txt, zizmor.txt |
| bun install --frozen-lockfile --ignore-scripts | no changes (lockfile unchanged since d7be0c1) | install.txt |
| bun test --coverage | all pass: api 38 (+1 skip), chain 27 (+3, `adapterPins`), db 3, dsl 22, hl 49 (+8 live skips), seal 10, core 228 (+1, late-confirm flag), ops 122 (+14, alerts). Lines: api 70.6, chain 82.9, core 83.6, ops 82.8, hl 89.1 | bun-*.txt |
| forge build --force / test v1.5.1 | 174/174 across 10 suites | forge-build.txt, forge-test.txt |
| forge coverage --ir-minimum | contracts 99.21% lines (250/252); adapter 82/82 | forge-coverage.txt |
| Deep invariants (`FOUNDRY_PROFILE=deep`, 256×500) | 7/7 invariants PASS at 128,000 calls each (adapter ×2, SwapKeyPolicy ×3, CallerShare ×2) | invariants-deep.txt |
| Halmos 0.3.3 + yices 2.6.4 | `check_setPolicy_onlyPinned` PASS (66 paths, 2.9 s). `OracleBandSymTest`: 6 of 7 `check_floor_*` TIMEOUT (120 s solver limit); the 7th was cut off by the 900 s run limit. This matches INVARIANTS.md ("not proven") | halmos-pins.txt, halmos-oracleband.txt |
| Invariant doc links | 156/156 test references in `docs/INVARIANTS.md` resolve (including the new N-8/N-9 and `halmos/` paths) | invariants-check.txt |
| Doc-comment count | contracts: every external/public function in `contracts/src` is documented, including adapter v2's constructor, getters and `OracleBand.floor`. Off-chain exports and procedures (same five packages, counter re-implemented): 138/230 commented. Pooled with the contracts ≈ 65% (the last run reported 61% with its own counter; both in the 60–90% band) | tsdoc-count.txt |
| PoC: `trivially_true` late load (inverted) | relayed idea flagged; self-seals confirmed +3 min and +59 min after mining are now flagged; a row recorded 3 min before core loads it (core down) is not | pocs/poc-trivially-true-late-load.test.ts, pocs-trivially-true.txt |
| PoC: self-seal grace | API unchanged: the 20-day confirm is refused; the widest window confirms 119 min after the seal | pocs/poc-self-seal-grace.test.ts, pocs-selfseal.txt |
| PoC: sponsored pools, parked balances | unchanged (`budget.ts` and `swaps.ts` unchanged): 16 session keys from 16 USDG parked 65 min; one balance in 17.3 h; 49 sybils spend the stamp pool | pocs/poc-funded-age-parked.test.ts, pocs-funded-age.txt |
| Adapter v1 attack paths on v2 | multiplier 2e18 or 1e18−1 → `BadPolicy`. An attacker oracle or oracle 0 → `OracleNotPinned`. A flipped `baseIsCurrency0` or a junk quote → `OracleNotPinned`. Fuzz `testFuzz_setPolicy_pins`. The Halmos proof covers every policy and signature | forge-test.txt, halmos-pins.txt |
| On-chain reads (cast, public RPC) | feeds "RHTSLA / USD" and "Robinhood AMZN / USD": 8 decimals, fresh. TSLA/AMZN `oraclePaused()` = false, `effectiveAt()` = 0. Retired pair: 2 `PolicySet` on adapter v1; 1 session key and 2 swaps on SwapKeyPolicy v1; no `Revoked`. SwapKeyPolicy v2 has no logs yet | chain-reads.txt |
| CI (GitHub API) | 0c9d47a: CI 39801630269 success (test, halmos, slither, semgrep, gitleaks). Images 39801630140 **failure**: both builds failed to resolve the pinned `oven/bun` digest (Docker Hub HTTP 500), so nothing was pushed. 5b66a52: CI 39798937011 success, and images 39798936988 success (Trivy steps green); that run built both deployed digests | ci-runs.txt, ci-jobs.txt |
| osv-scanner, Pashov | not re-run: lockfiles unchanged since f1b2fad. The adapter change was reviewed by reading and by the tests and Halmos above (rescore: no new hunting) | runs/20261022-000801/ |

## Deploy verification
**Robinhood Chain mainnet (4663).** After `forge build --force` at 0c9d47a, `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` returned **19/19 ok** (post-deploy-check-mainnet.txt). It checks:
- bytecode (immutables masked) for ThesisSeal, StampRoots, CallerShare, adapter v2 and SwapKeyPolicy v2;
- revealer/poster = relayer `0xb257…80f1`;
- USDG, poolManager, `maxOracleAge` 90000, the `quoteToken` and `oracleOf` pins, `SwapKeyPolicy.adapter()` = `0xe215…ec0b`, and the EIP-712 domains on 4663.

**Build of record.**
- ThesisSeal, StampRoots and CallerShare: `publicCommit` 71e1fd3 (unchanged).
- Adapter v2 and SwapKeyPolicy v2: `mainnet.json` names only the non-public commit `c7cef65`. Public `5b66a52` carries the identical `contracts/src` tree (`0b177957…`), and the fresh build of `0c9d47a` matches live. The record should name 5b66a52 (Path item 2).

**Retired pair.**
- Adapter v1 `0xcb0b…3c0d` and SwapKeyPolicy v1 `0x7242…4a9d` stay on chain (immutable).
- One account installed a v1 session key (`PolicySet` nonce 1, expires 1795203160 = 2026-11-20 19:32 UTC), set two v1 pool policies with the same expiry, and swapped twice.
- It has not revoked. See Findings.

**Core CVM** (`/prpc/Info`, app-id 897c44e8…57a3), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = a46d1b24…fa87, the single allow-list entry.
- The embedded compose == `git show 0c9d47a:services/core/docker-compose.yml`, image `df26787e…56b3`.
- MRTD/RTMR1/RTMR2 equal the `ALLOWED_OS` pins; RTMR3 replays.
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER (unchanged).

**Images.** `gh attestation verify` on both deployed digests → `images.yml@refs/heads/main`, source `5b66a525…f4`, run 39798936988. `services/Dockerfile` is unchanged.

**Retired v1 pair, no verdict this run:** its bytecode last matched in the v1.0.0 run (d7be0c1); it is immutable and no longer the build of record, so the 7.0 "not checked" cap is not applied to it (its residual is scored in Findings instead).

**Not checked:** the ops CVM compose (no public Info endpoint, as in earlier runs). The repo's ops compose pins `0f919aaa…a4b6`, which the provenance above covers.

**Monitoring:** new `services/ops/src/runtime/alerts.ts`, mainnet only. It alerts the operator address through the notify queue:
- CallerShare:
  - a claim above 100 USDG, or above 500 USDG in a rolling 24 h;
  - an epoch or claim root ops did not post;
  - a balance below what posted epochs still owe.
  - The log cursor is kept in `ops_watch`.
- Feeds, per market:
  - answer ≤ 0 or `oraclePaused()`, at any time;
  - in the NYSE session, no update for 3 h, or the pool more than 2% off the feed.
- Thresholds are literals in `services/ops/docker-compose.yml`.
- The relayer balance watch and the SECURITY.md runbook with contacts remain.

## Findings

### [Low] Adapter v2 pins the price reference; the retired v1 pair still serves one live session key (narrowed)
- id: pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier
- location: contracts/src/ProvisoSwapAdapter.sol:238-257,271-283 (v2); retired v1 pair under `previous` in packages/chain/deployments/mainnet.json
- category: A
- what changed (verified):
  - The constructor pins `oracleOf[token]` and `quoteToken` once, with no setter. It rejects zero, repeated and quote-token pins.
  - `setPolicy` reverts unless `multiplier == 1e18`, `oracle == oracleOf[base]` (non-zero) and the other side is `quoteToken`.
  - The base side cannot be flipped to USDG, because the quote is never pinned.
  - Each v1 attack path has a passing test, the Halmos proof covers every policy and signature, and `post-deploy-check.ts` checks the live pins.
- residual:
  - The v1 contracts cannot be retired on chain.
  - One mainnet account still has a v1 session key on SwapKeyPolicy v1 and v1 pool policies on adapter v1. All stay valid until 2026-11-20 19:32 UTC, and no `Revoked` event exists.
  - For that account the original path still works: a policy signed through a compromised front-end can name any oracle or multiplier on adapter v1, and the v1 session key can then swap against that floor.
  - Core now routes swaps to the v2 pair (`mainnet.json` → `deployment()`), so the attack also needs a holder of the v1 session key.
- impact: as the original Low, limited to one account for the next 29 days.
- fix: Path item 1 (revoke, or let it expire; prompt v1 key holders to revoke).
- proof for rescore: no unrevoked, unexpired `PolicySet` on `0x7242…4a9d`.

### [Low] Parked balances still spend the sponsored pools; victims self-pay (unchanged)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion
- `budget.ts` and `swaps.ts` are unchanged, and the PoC re-ran with the same result.
- It is now listed in SECURITY.md "Known issues (open)" with a planned fix, which is not acceptance.
- Fix: Path item 3.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool
- The cited code is unchanged; listed under Known issues.
- Fix: Later.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes on both SwapKeyPolicy versions are never budget- or age-gated (unchanged) |
| P2 | Non-upgradeable | PASS | no proxy, no owner; v2 is a new immutable pair |
| P3 | Fresh deployer per brand | PASS | the same brand deployer `0xb2fe…1Da1` deployed v2 and holds no role (SECURITY.md now says "dedicated deploy key") |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | the only hit is the P5 row of the published audit table |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits (studio.txt) |
| P8 | Honest boundaries | PASS | README "Honest boundaries"; SECURITY.md accepted risks and known issues; INVARIANTS.md says N-9 is not proven |

## Fixed since last run
- `offchain|packages/api/src/routers/idea.ts|self-seal-unbound-import` (Low), fixed 2026-10-22 in 5b66a52.
  - Core judges `trivially_true` from max(`stamped_at`, `created_at`) (`ideas.ts:184-185`, `checkStampFlags`).
  - The `theses` row is inserted when the seal is recorded (`packages/db/src/seal.ts` `recordSeal`), so a late self-seal is judged on the first state core sees after the confirm.
  - Proof: the repo test "a seal confirmed 5 min after its stamp is judged…" and the inverted PoC (+3 and +59 min flagged).
  - The remaining confirm delay (≤ deadline + 1 h) credits nothing. Fires and P&L run from after registration, and a condition that turned true before registration and still holds is flagged.
- The adapter row was narrowed (v2 deployed). It stays open for the retired pair (Findings).

Fix-line sanity check. Checked and found sound:
- `OracleBand.floor` is the same formula as v1, now with `multiplier` fixed at 1e18. For the mainnet ranges (8-decimal feed, 18/6 decimals), the products stay far below 2^256. Fuzz `testFuzz_floor_properties` (2000 runs) and `test_floor_rangeCorners` pass.
- `swap` is unchanged except that `_oracleFloor` reads the stored, pinned policy. `unlockCallback` is unchanged.
- `deploy-mainnet.ts` `ADAPTER_V2`:
  - deploys only the swap pair, and redeploys `SwapKeyPolicy` whenever the adapter is redeployed;
  - refuses a v1 adapter as current;
  - moves old entries to `previous`.
- `adapterPins` refuses a non-USDG quote, a non-1e18 multiplier and two oracles for one token (tests in `swaps.test.ts`).
- `alerts.ts`: the log cursor advances per 2000-block range and is persisted after each range, so a failed tick re-reads at most one range. The only effect is a repeated large-claim alert.
- Both stock tokens implement `oraclePaused()` on mainnet (cast), so the combined `Promise.all` read does not fail on them.
- `ops_watch` has RLS enabled and no policies (service role only).
- The new CI job pins its actions by SHA, uses `persist-credentials: false`, pins `halmos==0.3.3` and `yices-solver`, and uses no secrets.

New issues: none at finding level.

Leads (no deduction):
- README "Deployed contracts" still shows the retired adapter and SwapKeyPolicy as live, and says "fresh, single-use deployer". Anyone verifying from the README checks the wrong contracts. This is the G deduction; Path item 2.
- The `images.yml` run at the release commit failed (Docker Hub 500 on the pinned base digest). Nothing was published from 0c9d47a; the deployed digests come from the green 5b66a52 run. Re-run it to keep the tag's image workflow green.
- `feedWatch` combines its three reads in one `Promise.all`. If one read fails (RPC down), that market's checks are skipped with only a log line, and there is no "watch down" alert. NYSE holidays are not handled (a false stale alert after 3 h).
- `trivially_true`: an idea recorded while core is down for more than 2 min is not judged. This is a documented `ponytail:` ceiling, and a self-sender cannot choose it.
- The pinned feeds price in USD and the quote token is USDG: a 1:1 peg assumption, as before (X-3).
- SECURITY.md "Known issues" ends with a stray `| ` row.
- Carried:
  - 4 fixable HIGH OpenSSL rows in the alpine base (not reachable; fix with `apk upgrade`);
  - the scan runs in the job that holds the GHCR login;
  - the self-seal confirm liveness edge;
  - `swapSetupProgress` compares only the nonce;
  - the ops `setup.failed` race;
  - the re-check loop runs blind while its RPC is down;
  - `confirmSelfSeal` takes a receipt with no confirmation depth;
  - `session_gas:<wallet>` pruning.

## Accepted risks
From SECURITY.md "Accepted risks" (2026-10-22):
- `deploy|contracts|deploy-path-and-hot-key` (Low). One hot relayer key holds every immutable mainnet role.
  - Reason: the contracts are ownerless and non-upgradeable, so roles are fixed at deploy.
  - The relayer can delay but not forge reveals, and cannot move user funds. Every user exit works without it.
  - The text now calls the deployer a "deploy-only key" (it deployed v2 too).
- `offchain|supabase/migrations/20261021190000_orders_fill_stamp.sql|fill-leaf-follower-linkage` (Low). FILL leaves can link a follower's trades to a caller.
  - Reason: the public record exists to prove Fair Copy ordering.
  - Leaves carry no account, and the trades are already public.

## Unverified leads
Carried (code unchanged, no deduction):
- follow-slot squatting;
- budget check-then-spend overshoot;
- core on the public RHC RPC;
- app-scoped dstack keys across compose upgrades;
- the corporate-action guard;
- oracle staleness blocking session-key exits;
- the adapter policy nonce shared across pools;
- ThesisSeal record labels;
- SwapKeyPolicy re-delegation and the UTC-day 2×;
- `deployment()` env overrides in the Vercel API;
- sshd/user_config, the KMS id not pinned, quotes without a nonce;
- images.yml `ref: main`;
- FILL stamps attested only by the DB;
- executeSwap has no deadline; swapWalletProofMessage has no nonce;
- fee-on-transfer USDG;
- Info: package.json "Unlicense" vs the MIT LICENSE; README test counts lag the suites.

## Checklist detail (C, D, E, F, G)

**C 7.8**
- 1.5 build and tests pass: forge 174/174; every bun suite EXIT=0.
- 0.8 coverage, in the ≥70% band: contracts 99.21% (re-measured, `--ir-minimum`); core 83.6, ops 82.8, chain 82.9, api 70.6.
- 0.5 negative tests: the API is still in the 60–90% band. Every new adapter revert has a test (`test_constructor_badPins`, `test_setPolicy_*`).
- 1.0 fuzz: Foundry `testFuzz_*` (including `testFuzz_setPolicy_pins` and `testFuzz_floor_properties`) plus fast-check.
- 2.0 invariants: 7 invariants. The default run passes (16k calls each, forge-test.txt). The deep profile was re-run because the adapter changed: 7/7 pass at 128k calls each (invariants-deep.txt).
- 0.5 mutation: 63.6% (carried; not measured in `rescore`).
- 1.0 integration: real v4 PoolManager; ops `onchain.test.ts` and core `executor.test.ts` on anvil against the v2 constructor.
- 0 symbolic: the only proven Halmos check (`check_setPolicy_onlyPinned`, run in CI) covers pin and access logic, not math. The core math (`OracleBand.floor`) has seven `check_floor_*` properties, and all time out (INVARIANTS.md N-9; halmos-oracleband.txt).
- 0.5 CI on every push (39801630269).

**D 9.0**
- 1.5 roles: the SECURITY.md "Privileged roles" table (deployer row updated for v2).
- 1.5 no admin.
- 1.5 not upgradeable.
- 0 pause: CallerShare holds USDG and has no pause.
- 1.0 no setters (the pins are set only in the constructor).
- 1.0 deploy scripts: `deploy-mainnet.ts` (with `ADAPTER_V2`).
- 1.5 post-deploy check: passed live in this run against a fresh build (19/19, including the pins).
- 1.0 monitoring, now present:
  - large outflows: CallerShare claims per claim and per 24 h, plus unknown roots and underfunding;
  - oracle health: staleness, a ≤0 answer, `oraclePaused` and pool divergence;
  - keeper balance: the balance watch;
  - there are no role changes or contract pauses to alert on (immutable, ownerless);
  - a runbook with contacts in SECURITY.md;
  - tests: `alerts.test.ts` (14).

**E 10.0**
- 2.0 frozen installs (CI, Docker, Vercel).
- 1.5 exact pins.
- 2.5 no reachable advisories (lockfile unchanged; osv carried).
- 1.5 `trustedDependencies` [] + `minimumReleaseAge`.
- 1.0 no forks.
- 0.5 no submodules.
- 1.0 toolchains not on an advisory list (Bun 1.3.13/1.3.14, forge 1.5.1, halmos 0.3.3).

**F 10.0**
- 3.0 no secrets (gitleaks history clean, 88 commits).
- 0.5 env handling.
- 1.5 CI.
- 1.0 Slither + Semgrep.
- 1.5 hardened Actions: every `uses:` SHA-pinned (including the `halmos` job), top-level `permissions` least-privilege (`contents: read` in `ci.yml`, `{}` in `images.yml`), zizmor clean, gitleaks in CI.
- 1.0 LICENSE + SECURITY.md.
- 1.0 toolchain pins.
- 0.5 dev environment.

**G 8.5**
- 1.5 README: build, test, "Deploy and verify".
- 1.5 architecture.
- 2.0 invariants: `docs/INVARIANTS.md` with N-8 (pins) and N-9 (floor math, honestly marked not proven); 156/156 references resolve.
- 1.5 threat model: README "Security model" and "Honest boundaries"; SECURITY.md accepted risks and known issues (updated: adapter and self-seal closed, sponsored pools listed).
- 0.5 doc comments: same basis as the last run (contracts plus off-chain exports, pooled ≈ 65% → half).
- 0 deployed addresses and build of record:
  - The README table, the only one with explorer links, lists the retired v1 adapter and SwapKeyPolicy as the live contracts.
  - The v2 entries in `mainnet.json` record only a non-public commit and no `publicCommit`.
  - The other three contracts still meet the line, but the item is not partial.
- 1.0 audit history: `docs/AUDIT.md` (the 9.1 report), linked from the README.
- 0.5 readiness: scope list in SECURITY.md; tag `v1.1.0` on the audited commit 0c9d47a.

## Independent check
A fresh agent (had not seen the audit) was given this report, the ledger, the rubric and read access to the clone and the run folder.
- (a) Recompute: A 9.7, B 9.2, C 7.8, D 9.0, E 10.0, F 10.0, G 8.5 → 9.195 → **9.1**, no cap. It confirmed the cited evidence (forge 174/174, coverage 99.21%, bun EXIT=0, post-deploy 19/19, Halmos 1 PASS / floor checks TIMEOUT, deep invariants 128k, CI and images status, compose `cmp` against `git show`).
- (b) Refutation attempts, none refuted: the adapter residual is real (re-read on chain: one SwapKeyPolicy v1 `PolicySet`, `activePolicy` non-zero, no `Revoked`; v1 `setPolicy` checks only `multiplier != 0` and slip) and Low, since it needs the enclave-held session key; the sponsored-pool row is real, Low and correctly open (Known issues is not Accepted risks); exit-on-raw-pool is real and Low. It agrees the self-seal row is fixed (`theses` rows are inserted only in `recordSeal` at confirm; `stampedAt` drives expiry only, nothing fires back-dated).
- (c) Spot-checks: D monitoring 1.0, D post-deploy check 1.5 (exits 1 on mismatch, checks the v2 pins), F Actions hardening 1.5 (every `uses:` SHA-pinned; the `halmos` job has no secrets): all confirmed. Judgment calls C symbolic = 0, G deployed addresses = 0 and doc comments 0.5 (same pooled basis): agreed.
- Corrections applied here, no score change: `ci.yml` uses `permissions: contents: read` (not `{}`); the "embedded == repo compose: false" line in core-info-check.txt compares against a CRLF working tree, the `git show` comparison is the one that matches; the retired v1 pair has no deploy verdict this run (now stated under Deploy verification). Noted: alerts run only when `RELAYER_ALERT_ADDRESS` is set in the ops CVM's encrypted env, which cannot be checked from outside.

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
