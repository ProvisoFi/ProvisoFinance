# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 9.1 / 10** (no cap binds) · Rubric v2
Commit `d7be0c1` = tag `v1.0.0` (public main) · Mode `rescore` · 2026-10-22
Previous: 8.9 on 2026-10-22 (`rescore`, public `e33d629`) (+0.2) · Studio policy: 8/8 pass
Deployed build: **matches** (ops CVM not checked: no public Info endpoint).
- Mainnet contracts: unchanged on-chain. A fresh `forge build --force` of `d7be0c1` matches the live bytecode: `post-deploy-check.ts` passed 15/15 in this run. The NatSpec commit changes comments only, and with `bytecode_hash = "none"` the bytecode is identical.
- Core CVM: live `compose_hash` 91a12fdb…6994 = sha256(app_compose) = the only entry in `allowed-compose.ts`. The embedded compose is byte-identical to `git show d7be0c1:services/core/docker-compose.yml` (image `proviso-core@sha256:b6f61c5e…d036`). MRTD/RTMR1/RTMR2 equal the pins, and RTMR3 replays from the event log.
- Images: Sigstore provenance for `proviso-core@sha256:b6f61c5e…d036` and `proviso-ops@sha256:8b93378b…155c` shows both were built by `images.yml@refs/heads/main` from public `8884e86` (run 39769616825). 8884e86 → d7be0c1 changes only the two compose digests, the compose allow-list entry and the attestation test fixture. The ops CVM itself has no public Info endpoint (not checked, as in earlier runs).

Independent check: **reconciled** — the checker got 9.1 under the strict reading of the doc-comment line (TSDoc on off-chain exports counted) and 9.2 under the contracts-only reading. This report adopts 9.1; details at the end.

## Path to 9/10
The grade is now 9.1 (total 9.150). Points are changes to the final grade. No cap binds, so every item adds its full weighted value.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | Judge `trivially_true` from the time core first loads an idea (or from the confirm time for self-seals), not from stamped-at; or flag every idea first evaluated more than 2 min after its stamp | `services/core/src/runtime/ideas.ts:180,205-213` | +0.045 (B +0.3) | S | a test in which a self-seal confirmed 3 min after mining, whose entry already holds, is flagged (`pocs/poc-trivially-true-late-load.test.ts` inverted) |
| 2 | Sponsored-pool residual: accept it in SECURITY.md with the reason (users can self-pay; capped per day), **or** close it by reserving part of each pool for accounts that already sealed or traded | `SECURITY.md`; `services/ops/src/runtime/budget.ts` | +0.03 accepted (B +0.2) / +0.045 fixed (B +0.3) | S / M | the SECURITY.md entry, or a test in which the parked-balance PoC leaves an established account's setup sponsored |
| 3 | Adapter Low: require `multiplier == 1e18` and one immutable oracle per token; redeploy adapter + SwapKeyPolicy | `ProvisoSwapAdapter.sol` `setPolicy` | +0.105 (A +0.3) | M | a fuzz test; the live check passes on the new addresses |
| 4 | Alerts on CallerShare outflows and Chainlink feed staleness (balance-watch exists) | `services/ops` | +0.10 (D +1.0) | M | an alert test |
| 5 | Halmos `check_` on `_oracleFloor` / the fair-quote math | `contracts/test` | +0.075 (C +0.5) | M | the Halmos run output |

Projected: 9.150 → 9.195 → 9.225 (item 2 accepted) → 9.33 → 9.43 → **9.505 (9.5)**.
A rescore at 9.0 or more needs the independent check, and a `full`/`quick` run within 30 days (the last `quick` is f1b2fad, 2026-10-22, so until 2026-11-21).
Studio policy fixes: none (8/8).

Later:
- Doc comments on the off-chain exported functions and tRPC procedures (pooled coverage 61% → ≥90%; api 22/64 and seal 6/13 are the gaps) (G +0.5, +0.05, M).
- Exits require pool/reference agreement before a stop fires (`services/core/src/runtime/index.ts`, `rhc/runner.ts`; B +0.3, +0.045).
- A tested CallerShare pause that leaves claims open (D +1.0).
- Re-measure mutation on all 4 contracts to ≥80% (C +0.5).
- Off-chain line coverage ≥85% (api 70.7%, ops 82.4%, core 83.6%) (C +0.4); negative tests on ≥90% of API mutations (C +0.5).
- Housekeeping, no points: SECURITY.md "Known issues" still lists the image scan as open and omits the two open off-chain Lows (sponsored pools, self-seal flag); add `apk upgrade --no-cache` (or the next base) to clear the 4 fixable HIGH OpenSSL rows Trivy reports.

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.9 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.7 | 35% | 3.395 | 0 | 1 Low: adapter policy oracle/multiplier unbounded |
| B Off-chain security | 8.9 | 15% | 1.335 | +0.3 | 3 open Lows (sponsored-pool residual; self-seal `trivially_true` skip; exit on raw pool); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band; negative tests in the 60–90% band; mutation 63.6% (carried); no symbolic checks |
| D Privileged ops, deploy & ops | 8.0 | 10% | 0.800 | 0 | no CallerShare pause; no outflow/staleness alerts |
| E Dependencies & supply chain | 10.0 | 5% | 0.500 | +1.0 | none |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 9.5 | 10% | 0.950 | +1.0 | doc comments at 61% of in-scope externals (contracts 32/32, off-chain 144/256) |
| **Total before caps** | | | **9.150 → 9.1** | | |
| **Cap** | | | **none** | | |

Arithmetic:
- Total: 0.35×9.7 + 0.15×8.9 + 0.15×7.8 + 0.10×8.0 + 0.05×10.0 + 0.10×10.0 + 0.10×9.5 = 3.395 + 1.335 + 1.170 + 0.800 + 0.500 + 1.000 + 0.950 = 9.150 → **9.1**.
- A = 10 − 0.3 (adapter Low).
- B = 10 − 3×0.3 (sponsored-pool residual, self-seal residual, exit-on-raw-pool) − 2×0.1 (accepted: hot relayer, FILL leaf).
- Sensitivity: if the self-seal row were read as fixed (the 8.9 report's proof, "refused after the deadline plus a small grace period", is met), B = 9.2 and the total 9.195, still 9.1. The grade does not turn on it. This run keeps it open because the `trivially_true` skip, step 4 of the original finding, still works after a 2-minute wait (PoC below).
- Doc-comment basis: counted on contracts only, as in earlier runs, G = 10.0 and the total 9.200 (9.2). This run counts the off-chain in-scope code too (see Checklist G) and scores 9.1.

Caps that do not apply:
- No Critical, High or open Medium; no secrets; build and tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record today (f1b2fad, within 30 days), so a rescore may report 9+.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against d7be0c1.
- Step 2 scripts and all test suites were re-run, and CI and the image workflow were re-checked.
- The diff e33d629..d7be0c1 was read line by line: `images.yml` (Trivy steps), `apps/web/vercel.json`, `services/Dockerfile`, both compose files, `allowed-compose.ts`, `idea.ts` (`SELF_SEAL_GRACE_S`), `selfseal.test.ts`, and every contract comment change (a comment-stripped diff of `contracts/src` is empty). No new hunting outside those lines.

**Stack / lanes:** unchanged (EVM, TEE, oracle, Bun/TS backend, AI writer, RWA). The frontend is out of scope.

| Tool | Result | Output |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh | ran on a `git archive` of d7be0c1; detect identical to e33d629; studio hits differ only by line numbers (the P5 row of the published `docs/AUDIT.md` table, a false positive; the adapter multiplier math, carried) | runs/20261022-142907/detect.txt, studio.txt |
| hygiene_scan.sh | ran; unchanged apart from output encoding (only labelled test keys and vendored forge-std strings) | hygiene.txt |
| gitleaks 8.30.1 (history, 85 commits) | no leaks found | gitleaks-history.txt |
| actionlint 1.7.12 / zizmor 1.31.1 | clean / no findings (6 suppressed, as before) with the changed `images.yml` | actionlint.txt, zizmor.txt |
| bun install --frozen-lockfile --ignore-scripts | no changes, from the root and from `apps/web` (the Vercel root) | install.txt, install-apps-web.txt |
| bun test --coverage | all pass: api 38 (+1 skip; +1 test, the grace window), chain 24, db 3, dsl 22, hl 49 (+8 live skips), seal 10, core 227, ops 108. Lines: api 70.7, chain 82.8, core 83.6, ops 82.4, hl 89.1 | bun-*.txt |
| forge build --force / test v1.5.1 | 160/160 across 9 suites | forge-build.txt, forge-test.txt |
| NatSpec count | 32/32 external/public functions in `contracts/src` documented (incl. `ProvisoTestFeed`) | natspec-check.txt |
| Doc-comment count, off-chain | exported functions and tRPC procedures in api, seal, chain, ops, core: 144/256 with a preceding comment (113 TSDoc-style); api 22/64, seal 6/13, chain 23/31, ops 36/60, core 57/88 | tsdoc-check.txt |
| Trivy reports (CI artifacts, run 39769616825) | both deployed digests: alpine 3.22.4, 0 CRITICAL, 4 fixable HIGH (OpenSSL `libcrypto3`/`libssl3` 3.5.6-r0: CVE-2026-14456, CVE-2026-45447), 0 in Node.js packages | trivy-artifacts/ |
| PoC: self-seal | the 8.8 import stays refused; the 8.9 residual (confirm 20 days later) is now refused; the widest accepted window confirms 119 min after the seal | pocs/poc-self-seal-grace.test.ts, pocs-selfseal.txt |
| PoC: `trivially_true` late load | same rule, entry already true: relayed idea flagged, self-seal confirmed 3 min after mining not flagged | pocs/poc-trivially-true-late-load.test.ts, pocs-trivially-true.txt |
| PoC: sponsored pools, parked balances | unchanged (ops source unchanged): 16 session keys funded by 16 USDG parked 65 min; one balance in 17.3 h; 49 sybils spend the stamp pool | pocs/poc-funded-age-parked.test.ts, pocs-funded-age.txt |
| CI (GitHub API) | d7be0c1: CI 39770560707 (slither, semgrep, gitleaks, test) success; images 39770560692 success. 8884e86: CI 39769616677 and images 39769616825 success, Trivy steps green for core and ops | ci-runs.txt, ci-jobs.txt |
| osv-scanner, Pashov | not re-run: lockfiles unchanged since f1b2fad, contract bytecode unchanged; last results carried | runs/20261022-000801/ |

## Deploy verification
**Robinhood Chain mainnet (4663).** After `forge build --force` at d7be0c1, `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts`: **15/15 ok**. It checks:
- bytecode (immutables masked) for ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter and SwapKeyPolicy;
- revealer/poster = relayer `0xb257…80f1`;
- USDG, poolManager, `maxOracleAge` 90000, the adapter link, and the EIP-712 domains on 4663.

**Build of record.** `mainnet.json` names `publicCommit` 71e1fd3 (an ancestor of d7be0c1). `contracts/src` at d7be0c1 differs from it only in comments, and the fresh build matches live.

**Core CVM** (`/prpc/Info`, app-id 897c44e8…57a3), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = 91a12fdb…6994, the single `ALLOWED_COMPOSE_HASHES` entry.
- Embedded compose == `git show d7be0c1:services/core/docker-compose.yml` (989 bytes each), image `b6f61c5e…d036`.
- MRTD/RTMR1/RTMR2 equal the pins in `allowed-compose.ts`; RTMR3 replays (compose-hash, app-id, instance-id, os-image-hash, key-provider events).
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER (unchanged).

**Images.** `gh attestation verify` on both deployed digests → `images.yml@refs/heads/main`, source digest `8884e869…9c7c`, run 39769616825. The base `oven/bun:1.3.14-alpine@sha256:5acc90a9…83c0` matches Docker Hub's digest for that tag. The Trivy tarball's SHA-256 pin matches the `trivy_0.75.0_checksums.txt` of the official release.

**Not checked:** the ops CVM compose (no public Info endpoint).

**Monitoring:** balance-watch, plus a runbook with contacts in SECURITY.md (unchanged).

## Findings

### [Low] Self-seals confirmed more than 2 minutes after mining skip the `trivially_true` check (narrowed again)
- id: offchain|packages/api/src/routers/idea.ts|self-seal-unbound-import
- location: packages/api/src/routers/idea.ts:41-43,125-127 (`SELF_SEAL_GRACE_S`); services/core/src/runtime/ideas.ts:33,180
- category: B
- what changed (verified): `confirmSelfSeal` now refuses once `now > deadline + 3600 s`, before any RPC call. The API caps a deadline at 3600 s out (`idea.ts:77`), so the latest accepted confirm is about 2 hours after the request. The 8.9 residual, a seal confirmed 20 days later, is refused (`selfseal.test.ts`, "refuses to confirm a self-sent seal after the stamp's deadline plus the grace period"; PoC test 2).
- residual attack (PoCs):
  1. The owner submits a stamp while holding under the sponsor floor, so the relay is refused, and self-sends the seal at once.
  2. Hindsight window: the owner can wait up to deadline + 3600 s (about 2 h with the furthest deadline) and confirm only if the market went their way. The record shows a stamped-at about 2 h before publication (PoC test 3: 119 min).
  3. Flag evasion: core judges `trivially_true` only for ideas whose stamped-at is under 2 min old when loaded (`ideas.ts:180`). Any self-seal confirmed 2+ minutes after mining is never judged. An idea whose entry already holds fires on the next tick with no `trivially_true` flag on the public record, while the same idea relayed is flagged (`poc-trivially-true-late-load.test.ts`).
- impact: record integrity only. A caller can publish an instant fire without the integrity flag that the public record shows, and gets up to about 2 h of selection. No funds move. P&L runs from the fire. Low (unchanged).
- fix: Path item 1.
- proof for rescore: a test in which a late-confirmed self-seal whose entry already holds is flagged.

### [Low] Parked balances still spend the sponsored pools; victims self-pay (unchanged)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion. `services/ops/src` is unchanged. The PoC re-ran with the same result. Fix: Path item 2.

### [Low] The adapter policy accepts any oracle and multiplier (unchanged)
- id: pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier. The bytecode is unchanged. The contract's NatSpec now states the gap plainly ("What is NOT bound on-chain is that reference"), and the old claim that a compromised front-end "can't sign away the band" is gone. Listed under SECURITY.md "Known issues (open)", not accepted. Fix: Path item 3.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. `services/core/src` is unchanged. Listed under Known issues. Fix: Later.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes are never budget- or age-gated (unchanged) |
| P2 | Non-upgradeable | PASS | no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | unchanged deployer/relayer |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | the only hit is the P5 row of the published audit table |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits (studio.txt) |
| P8 | Honest boundaries | PASS | README "Honest boundaries"; SECURITY.md accepted risks and known issues; adapter NatSpec states the unbound reference |

## Fixed since last run
- `supply|services/Dockerfile|base-image-tag-only` (Low), fixed 2026-10-22 in 8884e86. `images.yml` installs Trivy 0.75.0 from the official release, verified by SHA-256, and scans each pushed digest (OS and library packages, fixable only). Fixable CRITICAL fails the job, and HIGH/CRITICAL reports are uploaded as artifacts. `upload-artifact` is pinned to the v6.0.0 commit. The base moved to `oven/bun:1.3.14-alpine` by digest. The latest image runs (8884e86, d7be0c1) passed with the scan.
- `self-seal-unbound-import` was narrowed (no confirm after deadline + 1 h). It stays open; see Findings.

Fix-line sanity check. Checked and found sound:
- The grace check runs after the owner and status checks and before any RPC call. It compares server time with the stamp's deadline (chain time), with an hour of slack. The relay path (`services/ops/src/stamper.ts`) is unaffected.
- `vercel.json` sits in `apps/web`, the Vercel root named in the README. The same command, run from `apps/web`, installs the workspace from the root lockfile with no changes.
- The Trivy steps get no secret through `env`. They pass only the matrix name and the step's digest output, both through env vars, not inlined in `run:`. The job stays limited to main in the public repo.
- The alpine base runs as `USER bun`, and the CI-built images were verified to match what runs (core) and what is pinned (ops).
- The contract changes are comments only. Two claims were corrected for the better: the adapter no longer claims a compromised front-end can't move the band, and `ProvisoTestFeed` no longer states a fixed 60 s age.

New issues: none at finding level.

Leads (no deduction):
- The scan fails only on CRITICAL. Both deployed images carry 4 fixable HIGH rows in Alpine's OpenSSL (`libcrypto3`/`libssl3` 3.5.6-r0: a QUIC-server DoS and a `PKCS7_verify` use-after-free). Neither is reachable: Bun ships its own TLS (BoringSSL), and the services run no QUIC server and no PKCS7. Fix: `apk upgrade --no-cache` in the Dockerfile.
- The scan runs after push and attestation in the job that holds the GHCR write login. A compromised scanner binary would reach that credential. The SHA-256 pin to the official release is the control; a separate read-only scan job would remove the exposure.
- A self-sender whose confirm keeps failing (RPC down) for more than an hour past the deadline cannot record that seal and must sign a new stamp. This is liveness only, for their own idea.
- SECURITY.md "Known issues" still lists the image scan as open (stale doc).
- Carried from 8.9: `swapSetupProgress` compares the adapter-policy nonce, not its content; the ops `setup.failed` write can overwrite a racing re-prepare; the re-check loop runs blind while its RPC is down; `confirmSelfSeal` accepts a receipt with no confirmation depth; `session_gas:<wallet>` pruning.

## Accepted risks
From SECURITY.md "Accepted risks" (2026-10-22, unchanged):
- `deploy|contracts|deploy-path-and-hot-key` (Low). One hot relayer key holds every immutable mainnet role. Reason: the contracts are ownerless and non-upgradeable, so roles are fixed at deploy. The relayer can delay but not forge reveals, and cannot move user funds. Every user exit works without it.
- `offchain|supabase/migrations/20261021190000_orders_fill_stamp.sql|fill-leaf-follower-linkage` (Low). FILL leaves can link a follower's trades to a caller. Reason: the public record exists to prove Fair Copy ordering. Leaves carry no account, and the trades are already public.

## Unverified leads
Carried (code unchanged, no deduction):
- follow-slot squatting (oldest 1000 follows copied);
- budget check-then-spend overshoot (documented `ponytail:` ceiling);
- core on the public RHC RPC (liveness only);
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
- Info: package.json "Unlicense" vs the MIT LICENSE; next 16.3.7 Medium advisories (frontend, out of scope); README test counts lag the suites.

## Checklist detail (C, D, E, F, G)

**C 7.8**
- 1.5 build and tests pass: forge 160/160; every bun suite EXIT=0 (bun-*.txt).
- 0.8 coverage in the ≥70% band: contracts 98.35% (carried, bytecode unchanged); core 83.6, ops 82.4, chain 82.8, api 70.7.
- 0.5 negative tests: refusal tests on the self-seal path (now including the grace window), the funded-age and sponsor rules, and selfPaid register; the API overall is still in the 60–90% band.
- 1.0 fuzz: Foundry `testFuzz_*` plus fast-check.
- 2.0 invariants: 7 invariants at 128k calls each (deep profile, carried, contracts unchanged); the default-run invariants pass in forge-test.txt.
- 0.5 mutation: 63.6% (carried).
- 1.0 integration: real v4 PoolManager; ops `onchain.test.ts` on anvil.
- 0 symbolic.
- 0.5 CI on every push (39770560707).

**D 8.0**
- 1.5 roles: the SECURITY.md "Privileged roles" table.
- 1.5 no admin.
- 1.5 not upgradeable.
- 0 pause: CallerShare holds USDG and has no pause.
- 1.0 no setters.
- 1.0 `deploy-mainnet.ts`.
- 1.5 post-deploy check passed live in this run, against a fresh build.
- 0 monitoring: runbook with contacts, but only relayer balance is alerted.

**E 10.0**
- 2.0 frozen installs: CI, Docker and now Vercel (`apps/web/vercel.json` `installCommand: bun install --frozen-lockfile --ignore-scripts`).
- 1.5 exact pins.
- 2.5 no reachable advisories (lockfile unchanged; osv carried). The image's OpenSSL HIGH rows are OS packages that are not reachable (Leads), not library advisories.
- 1.5 `trustedDependencies` [] + `minimumReleaseAge`.
- 1.0 no forks.
- 0.5 no submodules.
- 1.0 toolchains: Bun 1.3.13 (dev) / 1.3.14 (images), not on an advisory list.

**F 10.0**
- 3.0 no secrets (gitleaks history clean, 85 commits).
- 0.5 env handling.
- 1.5 CI.
- 1.0 Slither + Semgrep.
- 1.5 hardened Actions: every `uses:` SHA-pinned (incl. the new `upload-artifact`), `permissions: {}` at top level, zizmor clean; gitleaks in CI.
- 1.0 LICENSE + SECURITY.md.
- 1.0 toolchain pins.
- 0.5 dev environment.

**G 9.5**
- 1.5 README: build, test, "Deploy and verify".
- 1.5 architecture: README "Architecture" plus the SECURITY.md roles matrix and trust assumptions.
- 2.0 invariants: `docs/INVARIANTS.md`; cited tests unchanged since the 8.9 link check (139/139 resolved).
- 1.5 threat model: README "Security model" and "Honest boundaries"; SECURITY.md accepted risks and known issues.
- 0.5 doc comments: contracts 32/32 external/public functions (natspec-check.txt: the 26 production-contract functions counted in the 8.9 report, 5/26 then, plus 3 adapter interface declarations and 3 in `ProvisoTestFeed`). Off-chain in-scope exports and tRPC procedures (api, seal, chain, ops, core): 144/256 with a preceding comment, 113/256 TSDoc-style (tsdoc-check.txt). Pooled 176/288 = 61% → half points. Basis change: the 8.9 and earlier reports counted contracts only; the rubric line names TSDoc and the in-scope core includes the off-chain signers and settlement services, so this run counts both (raised by the independent check).
- 1.0 build hash: README addresses with Blockscout links; `mainnet.json` `publicCommit` 71e1fd3.
- 1.0 audit history: `docs/AUDIT.md` (the 8.9 report) committed and linked from the README.
- 0.5 readiness: scope list in SECURITY.md, and tag `v1.0.0` on the audited commit d7be0c1 (`git ls-remote --tags`).

## Independent check
Fresh agent, given this report, the ledger, the rubric and read access to the clone; it ran nothing that writes.
- (a) Recompute: C 7.8, D 8.0, E 10.0, F 10.0 and the A/B deductions all confirmed. Its G was 9.5 (strict, TSDoc on off-chain exports counted: ~56% off-chain, 61% pooled) or 10.0 (contracts-only, as earlier runs scored). It gave 9.1 strict, 9.2 lenient. Reconciled: the rubric line names TSDoc and the in-scope core includes off-chain services, so this report adopts the strict reading (re-counted here: tsdoc-check.txt, pooled 61%) → **9.1**.
- (b) Refutation attempts: the self-seal/`trivially_true` row is real, Low and correctly open (`idea.ts:126-127`, `ideas.ts:180,207`); the sponsored-pool row is real and Low is defensible (the gates' "pick the lower" rule; Medium on the bare matrix would trigger the 8.9 cap); the adapter row is real and Low (`ProvisoSwapAdapter.sol:200-201`); the image-scan row is truly fixed (`images.yml:77-107`, 0 CRITICAL in the artifacts).
- (c) Spot-checks: E frozen installs (incl. `apps/web/vercel.json`), G tag `v1.0.0` → d7be0c1, D post-deploy check (exits 1 on mismatch), F Actions hardening: all confirmed. G doc comments: over-awarded at 1.0, corrected to 0.5 above.
- Also raised, no score change: the header now says the ops CVM was not checked (no ops app-id is published, so the 7.0 cap's "known address" condition does not apply; the operator supplies the relayer key either way, SECURITY.md); SECURITY.md Known issues is stale (image scan listed, two off-chain Lows missing).

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
