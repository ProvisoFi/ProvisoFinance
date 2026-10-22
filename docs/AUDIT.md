# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 8.9 / 10** (no cap binds) · Rubric v2
Commit `e33d629` (public main) · Mode `rescore` · 2026-10-22
Previous: 8.8 on 2026-10-22 (`rescore`, public `28de85e`) (+0.1) · Studio policy: 8/8 pass
Deployed build: **matches.**
- Mainnet contracts: unchanged; `post-deploy-check.ts` passed 15/15 in this run.
- Core CVM: unchanged. Live `compose_hash` e0c34a0f…6c59 = sha256(app_compose) = the only entry in `allowed-compose.ts`. The embedded compose is byte-identical to `git show e33d629:services/core/docker-compose.yml` (image `proviso-core@sha256:c8370c7b…6bb0`). RTMR3 replays from the event log.
- Ops image `proviso-ops@sha256:b6841c9d…9c34`: Sigstore provenance shows it was built by `images.yml` from public `5044284` (run 39702983804). 5044284 → e33d629 changes only that digest in `services/ops/docker-compose.yml`. The ops CVM itself has no public Info endpoint (not checked, as in earlier runs).

Independent check: not run (rescore, result below 9.0).

## Path to 9/10
Points are changes to the final grade, computed from the unrounded total 8.955. No cap binds any more, so every item adds its full weighted value.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | NatSpec on the 21 undocumented external functions (5/26 documented) | `contracts/src/*.sol` | +0.10 (G +1.0; total 9.055 → **9.0**) | S | 26/26 |
| 2 | Tag the audited commit (the scope list is already in SECURITY.md) | git tag | +0.05 (G +0.5) | S | a tag on the audited commit |
| 3 | Freeze the Vercel install: `vercel.json` `installCommand: bun install --frozen-lockfile --ignore-scripts` | repo root | +0.05 (E +1.0) | S | the config is present |
| 4 | Bound when a self-seal can be confirmed: refuse `confirmSelfSeal` once the stamp's deadline has passed by more than a few minutes, or have core judge `trivially_true` from the time it first sees the idea rather than from stamped-at | `packages/api/src/routers/idea.ts:160-163` or `services/core/src/runtime/ideas.ts:180` | +0.045 (B +0.3) | S | a test in which a seal mined inside its request but confirmed a day later is refused (or flagged) |
| 5 | Scan the enclave images (Trivy or Grype step in `images.yml`) | `.github/workflows/images.yml` | +0.045 (B +0.3) | S | ledger row fixed |
| 6 | Sponsored-pool residual: accept it in SECURITY.md with the reason (users can self-pay; capped per day), **or** close it by reserving part of each pool for accounts that already sealed or traded (or a per-account sponsored quota a fresh sybil can't reach) | `SECURITY.md`; `services/ops/src/runtime/budget.ts` | +0.03 accepted (B +0.2) / +0.045 fixed (B +0.3) | S / M | the SECURITY.md entry, or a test in which the parked-balance PoC leaves another account's setup sponsored |
| 7 | Adapter Low: require `multiplier == 1e18` and one immutable oracle per token; redeploy adapter + SwapKeyPolicy | `ProvisoSwapAdapter.sol:133` | +0.105 (A +0.3) | M | a fuzz test; the live check passes on the new addresses |
| 8 | Alerts on CallerShare outflows and Chainlink feed staleness (balance-watch exists) | `services/ops` | +0.10 (D +1.0) | M | an alert test |
| 9 | Exits require pool/reference agreement before a stop fires | `services/core/src/runtime/index.ts:158`, `rhc/runner.ts` | +0.045 (B +0.3) | M | ledger row fixed |

Projected: 8.955 → 9.055 (item 1, grade **9.0**) → 9.105 → 9.155 → 9.20 → 9.245 → 9.275 (item 6 accepted) → 9.38 → 9.48 → **9.525**.
At 9.0 or more a rescore needs the independent check, and a `full`/`quick` run within 30 days (the last `quick` is f1b2fad, 2026-10-22, so until 2026-11-21).
Studio policy fixes: none (8/8).

Later:
- A tested CallerShare pause that leaves claims open (D +1.0).
- Halmos on `_oracleFloor` (C +0.5); re-measure mutation on all 4 contracts (C +0.5).
- Off-chain line coverage ≥85% (api 70.7%, ops 82.4%, core 83.6%).
- Info: the README test counts lag the suites (ops 108, api 37).

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.8 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.7 | 35% | 3.395 | 0 | 1 Low: adapter policy oracle/multiplier unbounded |
| B Off-chain security | 8.6 | 15% | 1.290 | +0.9 | 4 open Lows (sponsored-pool residual, now Low; self-seal late confirm; image scan; exit on raw pool); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band; negative tests in the 60–90% band; mutation 63.6% (carried); no symbolic checks |
| D Privileged ops, deploy & ops | 8.0 | 10% | 0.800 | 0 | no CallerShare pause; no outflow/staleness alerts |
| E Dependencies & supply chain | 9.0 | 5% | 0.450 | 0 | Vercel install not frozen |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 8.5 | 10% | 0.850 | 0 | no NatSpec; no tag |
| **Total before caps** | | | **8.955 → 8.9** | | |
| **Cap** | | | **none** | | |

Arithmetic:
- Total: 0.35×9.7 + 0.15×8.6 + 0.15×7.8 + 0.10×8.0 + 0.05×9.0 + 0.10×10.0 + 0.10×8.5 = 3.395 + 1.290 + 1.170 + 0.800 + 0.450 + 1.000 + 0.850 = 8.955 → **8.9**.
- A = 10 − 0.3 (adapter Low).
- B = 10 − 4×0.3 (sponsored-pool residual, self-seal late confirm, image scan, exit-on-raw-pool) − 2×0.1 (accepted: hot relayer, FILL leaf).
- Sensitivity: the grade turns on the sponsored-pool row. Read as Medium (the 8.8 rating), B = 7.7, the total is 8.82 and the grade 8.8 (the 8.9 cap would not bind). Read as fixed, B = 8.9 and the total is 9.00. This run keeps it open as Low; the reasons are in Findings.

Caps that do not apply:
- No Critical, High or open Medium; no secrets; build and tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record today (f1b2fad), so a rescore may report 9+ once the totals allow it.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against e33d629.
- Step 2 scripts and all test suites were re-run, and CI was re-checked.
- The fix diff 28de85e..e33d629 was read line by line for new bugs: `budget.ts` (`fundedAge`, `sponsorRule`), `budget.test.ts`, `swaps.ts` (ops), `start.ts`, the `sponsor_funding` migration, the ops compose, `packages/chain/src/swaps.ts` (`swapSetupProgress`), `swapkey.ts` (`register` selfPaid, `status`), `swapkey.test.ts`, `idea.ts` (`confirmSelfSeal`) and `selfseal.test.ts`. The web self-pay flow (`rhc-connect.tsx`) was read only to trace the fallback; the frontend is out of scope. No new hunting outside those lines.

**Stack / lanes:** unchanged (EVM, TEE, oracle, Bun/TS backend, AI writer, RWA). The frontend is out of scope.

| Tool | Result | Output |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh | ran on a `git archive` of e33d629; detect differs only by +1 test file; 1 studio hit, a false positive (the P5 row of the published `docs/AUDIT.md` table) | runs/20261022-040529/detect.txt, studio.txt |
| hygiene_scan.sh | ran; unchanged apart from output encoding | hygiene.txt |
| gitleaks 8.30.1 (history, 82 commits) | no leaks found | gitleaks-history.txt |
| bun install --frozen-lockfile --ignore-scripts | no changes (lockfile unchanged) | install.txt |
| bun test --coverage | all pass: api 37 (+1 skip), chain 24, db 3, dsl 22, hl 49 (+8 live skips), seal 10, core 227, ops 108. Lines: api 70.7, chain 82.8, core 83.6, ops 82.4, hl 89.1; `budget.ts` 93.2% (only the re-check loop's timer is unrun), ops `swaps.ts` 89.0%, `idea.ts` 65.8%, `swapkey.ts` 47.6% | bun-*.txt |
| forge build / test v1.5.1 | 160/160 across 9 suites (contracts unchanged) | forge-build.txt, forge-test.txt |
| PoC: sponsored pools, parked balances | the 8.8 rotation no longer works (the repo's own test). Parking still does: 16 USDG parked 65 min in 16 fresh swap wallets funds 16 session keys; one 1-USDG balance parked an hour in each wallet in turn funds 16 in 17.3 h (same UTC day); 49 sybils parking 0.0002 ETH for 65 min spend the stamp pool. The victim is refused with `relayer_budget`, and the refusal stays on the row (`setup.failed`), so the self-paid path is offered | pocs/poc-funded-age-parked.test.ts, pocs-funded-age.txt |
| PoC: self-seal import | the 8.8 attack (a 20-day-old seal through a fresh request) is refused. A seal mined 30 s into its own request is confirmed 20 days later | pocs/poc-self-seal-late-confirm.test.ts, pocs-selfseal.txt |
| INVARIANTS link check | 139 cited `File.t.sol::test` names, all resolve to functions; every quoted TS test name resolves | invariants-check.txt |
| CI (GitHub API) | CI 39703292638 on e33d629: slither, semgrep, gitleaks, test all success (5044284's CI run was cancelled by the next push); images 39702983804 (5044284) success | ci-runs.txt, ci-jobs.json |
| osv-scanner, actionlint, zizmor, Pashov | not re-run: lockfiles, `.github/` and `contracts/` are unchanged since f1b2fad; last results carried | runs/20261022-000801/ |

## Deploy verification
**Robinhood Chain mainnet (4663).** `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` from the clone: **15/15 ok**. It checks:
- bytecode (immutables masked) for ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter and SwapKeyPolicy;
- revealer/poster = relayer `0xb257…80f1`;
- USDG, poolManager, `maxOracleAge` 90000, the adapter link, and the EIP-712 domains on 4663.

**Build of record.** `mainnet.json` names `publicCommit` 71e1fd3 (an ancestor of e33d629). `contracts/` is unchanged since 28de85e, where its `contracts/src` tree was shown identical to the deploy commit's.

**Core CVM** (`/prpc/Info`, app-id 897c44e8…57a3), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = e0c34a0f…6c59, the single `ALLOWED_COMPOSE_HASHES` entry.
- Embedded compose == `git show e33d629:services/core/docker-compose.yml` (989 bytes each; the Windows checkout differs only by line endings).
- MRTD/RTMR1/RTMR2 equal the pins, and RTMR3 replays.
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER.

**Images.** `gh attestation verify` on `proviso-ops@sha256:b6841c9d…9c34` → `images.yml@refs/heads/main`, source digest `5044284…5301`, run 39702983804. The core image is unchanged and attested in an earlier run (716b14d).

**Not checked:** the ops CVM compose (no public Info endpoint). The new literal `SPONSOR_MIN_AGE_S=3600` (with the existing `SPONSOR_MIN_USDG`, `SPONSOR_MIN_ETH`, `CHAIN_NETWORK=mainnet`) was verified in the repo only. Whether the `sponsor_funding` migration is applied to the production database cannot be checked from the public repo; if it were missing, `fundedAge` would throw and setups and sponsored seals would be refused (fail-safe), not sponsored.

**Monitoring:** balance-watch, plus a runbook with contacts in SECURITY.md.

## Findings

### [Low] Parked balances still spend the sponsored pools; victims self-pay (downgraded from Medium)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion
- location: services/ops/src/runtime/budget.ts:107-176 (`fundedAge`, `sponsorRule`); services/ops/src/runtime/swaps.ts:131-137; packages/api/src/routers/swapkey.ts:128-137 (`register` selfPaid)
- category: B
- what changed (verified):
  - Funded-age rule (mainnet): sponsorship needs a wallet that ops has seen holding 1 USDG or 0.0002 ETH for `SPONSOR_MIN_AGE_S` = 3600 s (literal in the ops compose). The clock starts on the first attempt, and a dip clears it. A jittered re-check (every 2.5–7.5 min) reads every running clock at one block, so one balance cannot sit in several wallets at once. The 8.8 PoC (one 1-USDG balance handed along 16 fresh wallets) now gets no sponsored setup (`budget.test.ts`, "one 1-USDG balance handed along 16 fresh swap wallets within an hour gets no sponsored setup…").
  - Self-paid setups: a refused setup keeps its reason on the row (`setup.failed`). `swapKey.status` reports `failed`, and the browser offers to send the same transactions from the swap wallet. `register({ selfPaid: true })` records the setup only when the Kernel v3.3 delegation, SwapKeyPolicy module, each adapter policy at its nonce, the active swap-key policy hash and the session key's gas are all on-chain (`swapSetupProgress`; `swapkey.test.ts`, "with the sponsored pool spent, a setup the user sent itself registers…" and "a half-done self-paid setup is refused…"). Seals already had the self-send fallback.
- residual attack (PoC `pocs/poc-funded-age-parked.test.ts`):
  1. Setup pool: park 1 USDG in each of 16 fresh swap wallets for an hour (16 USDG, recoverable), then register all 16. They fund 16 session keys (0.0003 ETH each plus gas) and spend the 0.005 ETH pool. With one 1-USDG balance parked an hour per wallet in turn, the same takes about 17 hours, inside one UTC day.
  2. Stamp pool: 49 sybils each park 0.0002 ETH (0.0098 ETH, recoverable) for an hour, then send 20 stamps each.
- impact: until UTC midnight, other users get no sponsored setups or seals. Nothing is denied: they can send the setup (about 0.0004 ETH) or the seal (about 3e-6 ETH) themselves. Users who hold USDG but no ETH on Robinhood Chain must first get some ETH, or wait for midnight. The relayer float cannot be drained, and revokes, reveals, roots and epochs are never gated.
- severity: Low. The 8.8 rating was Medium because setups were refused with no fallback. Now the harm is a small, capped gas cost shifted to victims, plus a delay for the subset with no ETH. That is griefing of a subsidy, with the denial possible only in a specific state (pool spent and the victim holds no ETH) → Low.
- fix: Path item 6 (accept, or reserve part of each pool for accounts with history).
- proof for rescore: the SECURITY.md entry, or a test in which the parked-balance PoC leaves an established account's setup sponsored.

### [Low] `confirmSelfSeal` has no time limit, so hidden self-seals can be confirmed days later (narrowed)
- id: offchain|packages/api/src/routers/idea.ts|self-seal-unbound-import
- location: packages/api/src/routers/idea.ts:115-166; services/core/src/runtime/ideas.ts:180
- category: B
- what changed (verified): the tx must be a direct `seal(stamp, sig)` call to ThesisSeal. Its decoded stamp must equal the request's (owner, hashes, `isSealed`, `expiresAt`, `nonce`, `deadline`). The block time must lie between the request's creation (−120 s) and its deadline. The API caps a deadline at one hour out. The 8.8 attack, importing a seal mined up to 30 days earlier through a fresh request, is refused (`selfseal.test.ts` "refuses to import an old seal…"; PoC test 1). Stamped-at can no longer predate signed-at.
- residual attack (PoC test 2):
  1. The owner submits stamps for several ideas while holding under the sponsor floor, so each sponsored relay is refused.
  2. The owner self-sends each seal at once, inside its request window, and confirms none of them.
  3. Days later the owner confirms only the ideas whose entry condition holds now. Nothing compares the confirm time with the deadline. The record shows signed-at and stamped-at 20 days ago, both genuine.
  4. Core runs the trivially-true check only for ideas stamped under 2 minutes ago (`ideas.ts:180`). It skips this idea, which fires on the next poll with no `trivially_true` flag.
- impact: the caller decides which hidden commitments to publish after watching the market, and an instant fire is not flagged. The commitment and its time are genuine, and no funds move. P&L runs from the fire, which happens at confirm time. Record integrity, Low (unchanged). It would rise if ranking, copy sizing or CallerShare used stamped-at or lead time.
- fix: Path item 4.
- proof for rescore: a test in which a seal mined inside its request but confirmed after the deadline (plus a small grace period) is refused, or is flagged by core.

### [Low] The adapter policy accepts any oracle and multiplier (unchanged)
- id: pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier. `contracts/` is unchanged. It is listed under SECURITY.md "Known issues (open)" with a planned fix, not accepted. Fix: Path item 7.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. `services/core` is unchanged. It is listed under Known issues. Fix: Path item 9.

### [Low] Enclave images are never vulnerability-scanned (unchanged)
- id: supply|services/Dockerfile|base-image-tag-only. `.github/` is unchanged. It is listed under Known issues. Fix: Path item 5.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes are never budget- or age-gated (`budget.test.ts` "revoke is never refused…") |
| P2 | Non-upgradeable | PASS | no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | unchanged deployer/relayer |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | the only hit is the P5 row of the published audit table |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits (studio.txt) |
| P8 | Honest boundaries | PASS | README "Honest boundaries"; SECURITY.md accepted risks and known issues |

## Fixed since last run
- No ledger row moved to `fixed`. `sybil-budget-exhaustion` went from Medium to Low (no function is denied any more), and `self-seal-unbound-import` was narrowed (old seals can't be imported). Both remain open (see Findings).

Fix-line sanity check. Checked and found sound:
- `fundedAge` runs only on mainnet (`start.ts` `onMainnet`). The seal rule and the setup handler share one `sponsor_funding` table, and the one re-check loop covers both. A non-numeric `SPONSOR_MIN_AGE_S` would make every wallet "young" (fail-safe). RPC errors in `check` propagate and are retried. The table has RLS on and no policies (service role only).
- In the setup handler the age check runs first, so the clock starts even when another rule refuses. The 1-USDG floor is still read at relay time, and a "young" refusal is recorded once, with no retry.
- `register` selfPaid: the main-key signatures are still verified against the server-built setup. The delegation is checked on-chain (code = Kernel v3.3 designator, module installed) instead of by its signature. Registration needs every part on-chain, and the stored `signedPolicy` is the server-built policy, whose hash must be the active one.
- `confirmSelfSeal`: calldata decoding and the window check behave as described. A seal through another contract or a smart account is refused (liveness only, as before).

New issues: none at finding level.

Leads (no deduction):
- `swapSetupProgress` compares each adapter policy's nonce, not its content. A self-paid setup could set a different adapter policy the wallet signed at that nonce. This only affects the user's own wallet, and whoever controls the embedded wallet's signing already controls the wallet.
- The ops `setup.failed` write (`swaps.ts`, catch block) replaces the whole `setup` of any unregistered row. A re-prepare racing a failing attempt can be overwritten by the old setup, so the next register fails and the user starts again (liveness only).
- If the re-check loop's RPC fails, the clocks keep running unchecked until it recovers. This widens the documented "moved away and back between re-checks" blind spot (`ponytail:` note in `budget.ts`).
- `confirmSelfSeal` accepts a receipt with no confirmation depth (carried; the relay path does the same).
- `session_gas:<wallet>` rows of wallets that never come back are pruned only on that wallet's next funding (carried).

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
- `deployment()` env overrides in the Vercel API (also the RPC that `confirmSelfSeal` and selfPaid `register` trust);
- sshd/user_config, the KMS id not pinned, quotes without a nonce;
- images.yml `ref: main`;
- FILL stamps attested only by the DB;
- executeSwap has no deadline; swapWalletProofMessage has no nonce;
- fee-on-transfer USDG;
- Info: package.json "Unlicense" vs the MIT LICENSE; next 16.3.7 Medium advisories (frontend, out of scope).

## Checklist detail (C, D, E, F, G)

**C 7.8**
- 1.5 build and tests pass: forge 160/160; every bun suite EXIT=0 (bun-*.txt).
- 0.8 coverage in the ≥70% band: contracts 98.35% (carried, unchanged); core 83.6, ops 82.4, chain 82.8, api 70.7.
- 0.5 negative tests: the selfPaid register and `confirmSelfSeal` have refusal tests, and so do the funded-age rule and the sponsor rule; the API overall is still in the 60–90% band.
- 1.0 fuzz: Foundry `testFuzz_*` plus fast-check.
- 2.0 invariants: 7 invariants at 128k calls each (deep profile, carried, contracts unchanged); the default-run invariants pass in forge-test.txt.
- 0.5 mutation: 63.6% (carried).
- 1.0 integration: real v4 PoolManager; ops `onchain.test.ts` on anvil.
- 0 symbolic.
- 0.5 CI on every push (39703292638).

**D 8.0**
- 1.5 roles: the SECURITY.md "Privileged roles" table lists every role, its holder on mainnet, and its bound.
- 1.5 no admin.
- 1.5 not upgradeable.
- 0 pause: CallerShare holds USDG and has no pause.
- 1.0 no setters.
- 1.0 `deploy-mainnet.ts`.
- 1.5 the post-deploy check passed live in this run.
- 0 monitoring: a runbook with contacts is in SECURITY.md, but only relayer balance is alerted; there are no CallerShare outflow or feed-staleness alerts.

**E 9.0**
- 1.0 frozen installs: CI and Docker yes, Vercel no (`vercel.json` absent).
- 1.5 exact pins.
- 2.5 no reachable advisories (lockfile unchanged; osv carried).
- 1.5 `trustedDependencies` [] + `minimumReleaseAge`.
- 1.0 no forks.
- 0.5 no submodules.
- 1.0 toolchains.

**F 10.0**
- 3.0 no secrets (gitleaks history clean, 82 commits; the rotation log is in SECURITY.md).
- 0.5 env handling.
- 1.5 CI.
- 1.0 Slither + Semgrep.
- 1.5 hardened Actions (unchanged; zizmor carried).
- 1.0 LICENSE + SECURITY.md (disclosure contact, accepted risks).
- 1.0 toolchain pins.
- 0.5 dev environment.

**G 8.5**
- 1.5 README: build, test, "Deploy and verify".
- 1.5 architecture: README "Architecture" plus the SECURITY.md roles matrix and trust assumptions.
- 2.0 invariants: `docs/INVARIANTS.md`; all 139 cited test names resolve. X-3 is stated as a trust assumption.
- 1.5 threat model: README "Security model" and "Honest boundaries"; SECURITY.md accepted risks and known issues.
- 0 NatSpec: 5/26.
- 1.0 build hash: README addresses with Blockscout links, and `mainnet.json` `publicCommit` 71e1fd3 resolves in the public history with a `contracts/src` tree identical to the deploy commit's.
- 1.0 audit history: `docs/AUDIT.md` (the 8.8 report) is committed and linked from the README.
- 0 readiness: the scope list is in SECURITY.md, but there is no tag (`git ls-remote --tags` is empty).

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
