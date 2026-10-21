# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 8.6 / 10** (no cap binds; the 8.9 open-Medium cap is above the total) · Rubric v2
Commit `0eeb09f` (public main) · Mode `rescore` · 2026-10-22
Previous: 8.1 on 2026-10-22 (`rescore`, public `b6d02aa`) (+0.5) · Studio policy: 8/8 pass
Deployed build: **matches.**
- Mainnet contracts: unchanged since b6d02aa; `post-deploy-check.ts` passed 15/15 in this run.
- Core CVM: unchanged. Live `compose_hash` e0c34a0f…6c59 = sha256(app_compose) = the only entry in `allowed-compose.ts`. The embedded compose is byte-identical to `services/core/docker-compose.yml` at 0eeb09f (image `proviso-core@sha256:c8370c7b…6bb0`). RTMR3 replays from the event log.
- Ops image `proviso-ops@sha256:0fe290e9…0898`: Sigstore provenance shows it was built by `images.yml` from public `936abfc` (run 39691559893). 936abfc → 0eeb09f changes only that digest in `services/ops/docker-compose.yml`. The ops CVM itself has no public Info endpoint (not checked, as in earlier runs).

Independent check: not run (rescore, result below 9.0).

## Path to 9/10
Points are changes to the final grade, computed from the unrounded total 8.665. The 8.9 cap binds once the total passes it, and it lifts only when the last Medium is closed or accepted.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | Publish this report as `docs/AUDIT.md` (or commit `.audit-grade/REPORT.md`) | docs/ | +0.10 (G +1.0) | S | the file is in the public tree |
| 2 | Record a **public** build-of-record commit for the mainnet contracts. `mainnet.json` names `9b05cdf`, which does not exist in this repository. Use the public commit, or per-contract codehashes | `packages/chain/deployments/mainnet.json`, README "Deployed contracts" | +0.10 (G +1.0) | S | the commit resolves in the public repo |
| 3 | Close the sybil budget exhaustion. (a) When sponsorship is refused, let the browser submit the signed stamp from the user's own wallet (`seal` is relayable by anyone, `test_seal_relayedByAnyone`), so sealing never stops. (b) Make sponsorship cost a sybil something: sponsor only addresses that hold funds (for example ≥ 1 USDG or an HL account value), or size the share to the real seal cost. (c) Keep the 7-day session-gas rule per swap wallet across revokes | `services/ops/src/stamper.ts:30`, `budget.ts:45-46`, `swaps.ts:94`, web seal flow | +0.18 (B +1.2; cap 8.9 → none) | M | an ops test in which 60 sign-ins × 20 stamps leave another address's stamp relayable (or self-relayable), and a swap wallet cannot be re-gassed through revoke within 7 days |
| 4 | NatSpec on the 21 undocumented external functions (5/26 documented) | `contracts/src/*.sol` | +0.10 (G +1.0) | S | 26/26 |
| 5 | Tag the audited commit (the scope list is already in SECURITY.md) | git tag | +0.05 (G +0.5) | S | a tag on the audited commit |
| 6 | Freeze the Vercel install: `vercel.json` `installCommand: bun install --frozen-lockfile --ignore-scripts` | repo root | +0.05 (E +1.0) | S | the config is present |
| 7 | Scan the enclave images (Trivy or Grype step in `images.yml`) | `.github/workflows/images.yml` | +0.045 (B +0.3) | S | ledger row fixed |
| 8 | Adapter Low: require `multiplier == 1e18` and one immutable oracle per token; redeploy adapter + SwapKeyPolicy | `ProvisoSwapAdapter.sol:133` | +0.105 (A +0.3) | M | a fuzz test; the live check passes on the new addresses |
| 9 | Alerts on CallerShare outflows and Chainlink feed staleness (balance-watch exists) | `services/ops` | +0.10 (D +1.0) | M | an alert test |
| 10 | Exits require pool/reference agreement before a stop fires | `services/core/src/runtime/index.ts:158`, `rhc/runner.ts` | +0.045 (B +0.3) | M | ledger row fixed |

Projected: 8.665 → 8.765 → 8.865 → 9.045 (item 3 lifts the cap) → 9.145 → 9.195 → 9.245 → 9.29 → 9.395 → 9.495 → **9.54**.
Studio policy fixes: none (8/8).

Later:
- A tested CallerShare pause that leaves claims open (D +1.0).
- Halmos on `_oracleFloor` (C +0.5); re-measure mutation on all 4 contracts (C +0.5).
- Off-chain line coverage ≥85% (api 67.1%, ops 82.1%, core 84.6%).
- Info: the README test counts lag the suites (ops 104, README says 101).

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.1 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.7 | 35% | 3.395 | 0 | 1 Low: adapter policy oracle/multiplier unbounded |
| B Off-chain security | 8.0 | 15% | 1.200 | +0.4 | 1 Medium (budget exhaustion, narrowed); 2 open Lows; 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band; negative tests in the 60–90% band; mutation 63.6% (carried); no symbolic checks |
| D Privileged ops, deploy & ops | 8.0 | 10% | 0.800 | +0.75 | no CallerShare pause; no outflow/staleness alerts |
| E Dependencies & supply chain | 9.0 | 5% | 0.450 | 0 | Vercel install not frozen |
| F Hygiene & CI | 10.0 | 10% | 1.000 | +0.5 | none |
| G Docs & threat model | 6.5 | 10% | 0.650 | +3.5 | no NatSpec, public build hash, audit history or tag |
| **Total before caps** | | | **8.665 → 8.6** | | |
| **Cap** | | | **8.9 (one open Medium), not binding** | | |

Arithmetic:
- Total: 0.35×9.7 + 0.15×8.0 + 0.15×7.8 + 0.10×8.0 + 0.05×9.0 + 0.10×10.0 + 0.10×6.5 = 3.395 + 1.200 + 1.170 + 0.800 + 0.450 + 1.000 + 0.650 = 8.665 → **8.6**.
- A = 10 − 0.3 (adapter Low).
- B = 10 − 1.2 (Medium) − 2×0.3 (image scan, exit-on-raw-pool) − 2×0.1 (accepted: hot relayer, FILL leaf).
- Sensitivity: with the narrowed finding read as Low, B = 8.9 and the grade is 8.8. With it fixed, B = 9.2 and the grade is 8.8 (8.845).

Caps that do not apply:
- No Critical or High, no secrets, and build and tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record today (f1b2fad), so a rescore may report 9+ once the totals allow it.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against 0eeb09f.
- Step 2 scripts and all test suites were re-run, and CI was re-checked.
- The fix diff b6d02aa..0eeb09f was read line by line for new bugs: `budget.ts`, `swaps.ts`, `stamper.ts`, `start.ts`, the ops compose, `budget.test.ts`, SECURITY.md, docs/INVARIANTS.md and README. No new hunting outside those lines.

**Stack / lanes:** unchanged (EVM, TEE, oracle, Bun/TS backend, AI writer, RWA). The frontend is out of scope.

| Tool | Result | Output |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh | ran on a `git archive` of 0eeb09f; identical to the last run; 0 policy hits | runs/20261022-021314/detect.txt, studio.txt |
| hygiene_scan.sh | ran; the only change is SECURITY.md now present; history scan: only the known Anvil test key | hygiene.txt |
| gitleaks 8.30.1 (history, 76 commits) | no leaks found | gitleaks-history.txt |
| bun install --frozen-lockfile --ignore-scripts | no changes (lockfile unchanged) | install.txt |
| bun test --coverage | all pass: api 31 (+1 skip), chain 24, db 3, dsl 22, hl 49 (+8 live skips), seal 10, core 227, ops 104. Lines: api 67.1, chain 83.0, core 84.6, ops 82.1, hl 89.1; `budget.ts` 100%, `swaps.ts` 88.9% | bun-*.txt |
| forge build / test v1.5.1 | 160/160 across 9 suites (contracts unchanged) | forge-build.txt, forge-test.txt |
| PoC: stamp pool with sybils | reproduces: 49 addresses × 20 stamps at the observed mainnet seal cost refuse a victim's first stamp | pocs/poc-stamp-pool-sybil.test.ts, pocs.txt |
| INVARIANTS link check | 139 cited `File.t.sol::test` names, all resolve to functions; every quoted TS test name resolves | (script output in this report) |
| CI (GitHub API) | CI 39691857206 on 0eeb09f: slither, semgrep, gitleaks, test all success; images 39691559893 (936abfc) success | ci-runs.txt, ci-jobs.json |
| osv-scanner, actionlint, zizmor, Pashov | not re-run: lockfiles, `.github/` and `contracts/` are unchanged since f1b2fad; last results carried | runs/20261022-000801/ |

## Deploy verification
**Robinhood Chain mainnet (4663).** `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` from the clone: **15/15 ok**. It checks:
- bytecode (immutables masked) for ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter and SwapKeyPolicy;
- revealer/poster = relayer `0xb257…80f1`;
- USDG, poolManager, `maxOracleAge` 90000, the adapter link, and the EIP-712 domains on 4663.

**Core CVM** (`/prpc/Info`, app-id 897c44e8…57a3), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = e0c34a0f…6c59, the single `ALLOWED_COMPOSE_HASHES` entry.
- Embedded compose == `git show 0eeb09f:services/core/docker-compose.yml` (989 bytes each).
- MRTD/RTMR1/RTMR2 equal the pins, and RTMR3 replays.
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER.

**Images.** `gh attestation verify` on `proviso-ops@sha256:0fe290e9…0898` → `images.yml@refs/heads/main`, source digest `936abfce…b17b`, run 39691559893. The core image is unchanged and attested in the last run (716b14d).

**Not checked:** the ops CVM compose (no public Info endpoint). The new literals `RELAYER_DAILY_STAMP_BUDGET_ETH=0.003`, `RELAYER_DAILY_SETUP_BUDGET_ETH=0.005` and `SETUP_MIN_USDG=1000000` were verified in the repo only.

**Monitoring:** balance-watch, plus a runbook with contacts in SECURITY.md.

## Findings

### [Medium] Sybils can still exhaust the stamp pool, so nobody can seal an idea for the rest of the day (narrowed)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion
- location: budget.ts:45-46,71; stamper.ts:30; trpc.ts:30; swaps.ts:94,130-137; swapkey.ts:56
- category: B
- what changed: stamps and setups now have separate pools, so the reported path is closed: 20 setups cannot block a stamp (`budget.test.ts` "20 sybil setups exhaust only the setup pool"). Setups also need ≥ 1 USDG in the swap wallet, at most 2 fundings per owner per day, and one funding per swap wallet per 7 days. Revoke is never gated.
- attack (stamp pool):
  1. Sign in ~49 fresh addresses. Sign-in is free; it is a Web3 wallet signature.
  2. Each address submits 20 owner-signed stamps (`LIMITS.stamp` 20/day). The spec is checked only for length and the stamp only for its signature, so junk ideas are accepted.
  3. A mainnet seal costs ~151k gas at ~0.0203 gwei ≈ 3.1e-6 ETH (observed receipts, e.g. tx 0x6119…ecfd). One address therefore spends ~6.2e-5 ETH a day. That is a fifth of its 0.0003 ETH share, so the share never binds.
  4. 49 × 20 ≈ 980 seals spend the 0.003 ETH pool (PoC: 49). Every later stamp that UTC day is marked failed: "Sponsored stamps are paused for today".
- attack (setup pool, secondary): one swap wallet holding 1 USDG is reused across sign-ins.
  1. Owner A sets it up; the session key is funded.
  2. A revokes, which deletes the wallet's 7-day gas row (swaps.ts:94).
  3. Owner B binds the same wallet: revoked rows don't count (swapkey.ts:56).
  4. Each cycle sends 0.0003 ETH and some gas. About 8 owners × 2 setups spend the 0.005 ETH setup pool, and other users' swap setups are refused for the day.
- impact: idea sealing, the product's core write, stops for every user until UTC midnight. It is repeatable daily at no cost beyond sign-ins (setup path: 1 USDG, recoverable). Reveals, roots, epochs and revokes are not gated, and the float cannot be drained. Griefing × Likely = Medium.
- fix: Path item 3.
- proof for rescore: an ops test in which 60 addresses × 20 stamps leave another address able to seal (sponsored or self-relayed). A second test: a swap wallet cannot be re-gassed through revoke within 7 days.

### [Low] The adapter policy accepts any oracle and multiplier (unchanged)
- id: pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier. `contracts/` is unchanged. It is listed under SECURITY.md "Known issues (open)" with a planned fix, not accepted. Fix: Path item 8.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. `services/core` is unchanged. It is listed under Known issues. Fix: Path item 10.

### [Low] Enclave images are never vulnerability-scanned (unchanged)
- id: supply|services/Dockerfile|base-image-tag-only. `.github/` is unchanged. It is listed under Known issues. Fix: Path item 7.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revoke relays are now never budget-gated (`swaps.ts` revoke, `budget.test.ts` "revoke is never refused") |
| P2 | Non-upgradeable | PASS | no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | unchanged deployer/relayer |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | 0 hits |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits (studio.txt) |
| P8 | Honest boundaries | PASS | README "Honest boundaries"; SECURITY.md accepted risks and known issues |

## Fixed since last run
None fully fixed. `sybil-budget-exhaustion` was narrowed (see Findings).

Fix-line sanity check: no new bug beyond the residual above. Checked:
- the `relayer_setup_%` LIKE prune cannot match `relayer_stamp_*` keys;
- the share key lower-cases the address, and the per-owner count key is written and read with the same string;
- a refusal (budget, count, USDG, 7-day) is recorded on the first attempt and sends no transaction;
- `needsGas` is computed before the install, and a retried partial setup skips the gas;
- revoke failures still retry up to 3 attempts;
- the testnet path skips the USDG floor (`minUsdg` 0).

Lead (no deduction): `session_gas:<wallet>` rows of wallets that never come back are pruned only on that wallet's next funding. Table growth is bounded by setups.

## Accepted risks
From SECURITY.md "Accepted risks" (2026-10-22):
- `deploy|contracts|deploy-path-and-hot-key` (Low). One hot relayer key holds every immutable mainnet role. Reason: the contracts are ownerless and non-upgradeable, so roles are fixed at deploy. The relayer can delay but not forge reveals, and cannot move user funds. Every user exit works without it. Revisit when a multisig or threshold poster is practical, or on any redeploy.
- `offchain|supabase/migrations/20261021190000_orders_fill_stamp.sql|fill-leaf-follower-linkage` (Low). FILL leaves can link a follower's trades to a caller. Reason: the public record exists to prove Fair Copy ordering and needs per-fill size, price and time. Leaves carry no account, and the trades are already public. Revisit if users ask for follower privacy: aggregate per wave.

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
- Info: package.json "Unlicense" vs the MIT LICENSE; next 16.3.7 Medium advisories (frontend, out of scope).

## Checklist detail (C, D, E, F, G)

**C 7.8**
- 1.5 build and tests pass: forge 160/160; every bun suite EXIT=0 (bun-*.txt).
- 0.8 coverage in the ≥70% band: contracts 98.35% (carried, unchanged); core 84.6, ops 82.1, chain 83.0, api 67.1.
- 0.5 negative tests: the new budget/setup refusals have negatives (`budget.test.ts`, 6 tests); the API is still in the 60–90% band.
- 1.0 fuzz: Foundry `testFuzz_*` plus fast-check.
- 2.0 invariants: 7 invariants at 128k calls each (deep profile, carried, contracts unchanged); the default-run invariants pass in forge-test.txt.
- 0.5 mutation: 63.6% (carried).
- 1.0 integration: real v4 PoolManager; ops `onchain.test.ts` on anvil.
- 0 symbolic.
- 0.5 CI on every push (39691857206).

**D 8.0**
- 1.5 roles: the SECURITY.md "Privileged roles" table lists every role, its holder on mainnet, and its bound.
- 1.5 no admin.
- 1.5 not upgradeable.
- 0 pause: CallerShare holds USDG and has no pause.
- 1.0 no setters.
- 1.0 `deploy-mainnet.ts`.
- 1.5 the post-deploy check passed live in this run.
- 0 monitoring: a runbook with contacts is now in SECURITY.md, but only relayer balance is alerted; there are no CallerShare outflow or feed-staleness alerts.

**E 9.0**
- 1.0 frozen installs: CI and Docker yes, Vercel no.
- 1.5 exact pins.
- 2.5 no reachable advisories (lockfile unchanged; osv carried).
- 1.5 `trustedDependencies` [] + `minimumReleaseAge`.
- 1.0 no forks.
- 0.5 no submodules.
- 1.0 toolchains.

**F 10.0**
- 3.0 no secrets (gitleaks history clean; the rotation log is in SECURITY.md).
- 0.5 env handling.
- 1.5 CI.
- 1.0 Slither + Semgrep.
- 1.5 hardened Actions (unchanged; zizmor carried).
- 1.0 LICENSE + SECURITY.md (disclosure contact, accepted risks).
- 1.0 toolchain pins.
- 0.5 dev environment.

**G 6.5**
- 1.5 README: build, test and now "Deploy and verify" (contracts, images, Phala, Vercel/Supabase).
- 1.5 architecture: README "Architecture" plus the SECURITY.md roles matrix and trust assumptions.
- 2.0 invariants: `docs/INVARIANTS.md`; all 139 cited test names resolve. X-3 is stated as a trust assumption.
- 1.5 threat model: README "Security model" and "Honest boundaries"; SECURITY.md accepted risks and known issues.
- 0 NatSpec: 5/26.
- 0 build hash: `mainnet.json` commit `9b05cdf` is not in the public history.
- 0 audit history: no committed report yet.
- 0 readiness: the scope list is in SECURITY.md, but there is no tag.

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
