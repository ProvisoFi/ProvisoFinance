# Audit Grade — ProvisoFi/ProvisoFinance (public repository)

**Grade: 8.8 / 10** (no cap binds; the 8.9 open-Medium cap is above the total) · Rubric v2
Commit `28de85e` (public main) · Mode `rescore` · 2026-10-22
Previous: 8.6 on 2026-10-22 (`rescore`, public `0eeb09f`) (+0.2) · Studio policy: 8/8 pass
Deployed build: **matches.**
- Mainnet contracts: unchanged; `post-deploy-check.ts` passed 15/15 in this run.
- Core CVM: unchanged. Live `compose_hash` e0c34a0f…6c59 = sha256(app_compose) = the only entry in `allowed-compose.ts`. The embedded compose is byte-identical to `services/core/docker-compose.yml` at 28de85e (image `proviso-core@sha256:c8370c7b…6bb0`). RTMR3 replays from the event log.
- Ops image `proviso-ops@sha256:296535b8…2f08`: Sigstore provenance shows it was built by `images.yml` from public `958b54e` (run 39695196003). 958b54e → 28de85e changes only that digest in `services/ops/docker-compose.yml`. The ops CVM itself has no public Info endpoint (not checked, as in earlier runs).

Independent check: not run (rescore, result below 9.0).

## Path to 9/10
Points are changes to the final grade, computed from the unrounded total 8.82. The 8.9 cap binds once the total passes it, and it lifts only when the last Medium is closed or accepted.

| # | Fix | Where | Points | Effort | Proof for rescore |
| --- | --- | --- | --- | --- | --- |
| 1 | NatSpec on the 21 undocumented external functions (5/26 documented) | `contracts/src/*.sol` | +0.08 (G +1.0; total 8.92, then the 8.9 cap binds) | S | 26/26 |
| 2 | Make sponsorship cost something a sybil can't reuse. A balance read at relay time is not a lock: one 1-USDG (or 0.0002 ETH) balance handed along fresh addresses passes every check. Options: sponsor setups only for swap wallets with prior swap history or a minimum age; let the user pay the session-key gas from the swap wallet; or keep a global daily count of first-time sponsored wallets, with a slice reserved for accounts that already sealed or traded. Seals already have the self-send fallback; a smaller sponsored quota per new address would also help | `services/ops/src/runtime/swaps.ts:131`, `budget.ts:91-105` | +0.20 (B +1.2; cap 8.9 → none) | M | a test in which one 1-USDG balance rotated across 16 fresh wallets (the `pocs/` PoC) leaves another user's setup sponsored |
| 3 | Tag the audited commit (the scope list is already in SECURITY.md) | git tag | +0.05 (G +0.5) | S | a tag on the audited commit |
| 4 | Freeze the Vercel install: `vercel.json` `installCommand: bun install --frozen-lockfile --ignore-scripts` | repo root | +0.05 (E +1.0) | S | the config is present |
| 5 | Bind `confirmSelfSeal` to its request: decode the tx input and require the stamp's `nonce` and `deadline` to equal the request's, and require the seal block's time ≥ the request's creation time − 5 min | `packages/api/src/routers/idea.ts:115-146` | +0.045 (B +0.3) | S | a test in which a seal mined before the request is refused |
| 6 | Scan the enclave images (Trivy or Grype step in `images.yml`) | `.github/workflows/images.yml` | +0.045 (B +0.3) | S | ledger row fixed |
| 7 | Adapter Low: require `multiplier == 1e18` and one immutable oracle per token; redeploy adapter + SwapKeyPolicy | `ProvisoSwapAdapter.sol:133` | +0.105 (A +0.3) | M | a fuzz test; the live check passes on the new addresses |
| 8 | Alerts on CallerShare outflows and Chainlink feed staleness (balance-watch exists) | `services/ops` | +0.10 (D +1.0) | M | an alert test |
| 9 | Exits require pool/reference agreement before a stop fires | `services/core/src/runtime/index.ts:158`, `rhc/runner.ts` | +0.045 (B +0.3) | M | ledger row fixed |

Projected: 8.82 → 8.92 (item 1; grade 8.9 under the cap) → 9.10 (item 2 lifts the cap) → 9.15 → 9.20 → 9.245 → 9.29 → 9.395 → 9.495 → **9.54**.
At 9.0 or more a rescore needs the independent check, and a `full`/`quick` run within 30 days (the last `quick` is f1b2fad, 2026-10-22).
Studio policy fixes: none (8/8).

Later:
- A tested CallerShare pause that leaves claims open (D +1.0).
- Halmos on `_oracleFloor` (C +0.5); re-measure mutation on all 4 contracts (C +0.5).
- Off-chain line coverage ≥85% (api 68.7%, ops 82.5%, core 83.6%).
- Info: the README test counts lag the suites (ops 106, api 33).

## Score breakdown
| Category | Score | Weight | Weighted | Change vs 8.6 | Main deductions |
| --- | --- | --- | --- | --- | --- |
| A Core security | 9.7 | 35% | 3.395 | 0 | 1 Low: adapter policy oracle/multiplier unbounded |
| B Off-chain security | 7.7 | 15% | 1.155 | −0.3 | 1 Medium (budget exhaustion, narrowed again); 3 open Lows (one new: self-seal import); 2 accepted Lows |
| C Testing & verification | 7.8 | 15% | 1.170 | 0 | coverage in the ≥70% band; negative tests in the 60–90% band; mutation 63.6% (carried); no symbolic checks |
| D Privileged ops, deploy & ops | 8.0 | 10% | 0.800 | 0 | no CallerShare pause; no outflow/staleness alerts |
| E Dependencies & supply chain | 9.0 | 5% | 0.450 | 0 | Vercel install not frozen |
| F Hygiene & CI | 10.0 | 10% | 1.000 | 0 | none |
| G Docs & threat model | 8.5 | 10% | 0.850 | +2.0 | no NatSpec; no tag |
| **Total before caps** | | | **8.82 → 8.8** | | |
| **Cap** | | | **8.9 (one open Medium), not binding** | | |

Arithmetic:
- Total: 0.35×9.7 + 0.15×7.7 + 0.15×7.8 + 0.10×8.0 + 0.05×9.0 + 0.10×10.0 + 0.10×8.5 = 3.395 + 1.155 + 1.170 + 0.800 + 0.450 + 1.000 + 0.850 = 8.82 → **8.8**.
- A = 10 − 0.3 (adapter Low).
- B = 10 − 1.2 (Medium) − 3×0.3 (image scan, exit-on-raw-pool, self-seal import) − 2×0.1 (accepted: hot relayer, FILL leaf).
- Sensitivity: with the residual read as Low, B = 8.6 and the total is 8.955 → 8.9 (no Medium cap). With it fixed, B = 8.9 and the grade is 9.0 (9.00).

Caps that do not apply:
- No Critical or High, no secrets, and build and tests pass.
- Invariants cover every fund-holding module.
- The deploy verdict is from this run.
- A `quick` run is on record today (f1b2fad), so a rescore may report 9+ once the totals allow it.

## Scope
**Mode `rescore`:**
- Every open ledger row was re-verified against 28de85e.
- Step 2 scripts and all test suites were re-run, and CI was re-checked.
- The fix diff 0eeb09f..28de85e was read line by line for new bugs: `idea.ts` (`confirmSelfSeal`), `selfseal.test.ts`, `trpc.ts`, `packages/db/src/seal.ts`, `stamper.ts`, `budget.ts` (`sponsorRule`), `budget.test.ts`, `consumers.ts`, `start.ts`, `swaps.ts`, the ops compose and `mainnet.json`. The web seal flow (`sealer.ts`, `seal.tsx`) was read only to trace the self-send path; the frontend is out of scope. No new hunting outside those lines.

**Stack / lanes:** unchanged (EVM, TEE, oracle, Bun/TS backend, AI writer, RWA). The frontend is out of scope.

| Tool | Result | Output |
| --- | --- | --- |
| detect_stack.sh / studio_checks.sh | ran on a `git archive` of 28de85e; detect differs only by +1 test file; 1 studio hit, a false positive (the P5 row of the published `docs/AUDIT.md` table) | runs/20261022-024852/detect.txt, studio.txt |
| hygiene_scan.sh | ran; unchanged apart from the head and commit count | hygiene.txt |
| gitleaks 8.30.1 (history, 79 commits) | no leaks found | gitleaks-history.txt |
| bun install --frozen-lockfile --ignore-scripts | no changes (lockfile unchanged) | install.txt |
| bun test --coverage | all pass: api 33 (+1 skip), chain 24, db 3, dsl 22, hl 49 (+8 live skips), seal 10, core 227, ops 106. Lines: api 68.7, chain 83.0, core 83.6, ops 82.5, hl 89.1; `budget.ts` 100%, `stamper.ts` 100%, `swaps.ts` 88.8%, `idea.ts` 62.7% | bun-*.txt |
| forge build / test v1.5.1 | 160/160 across 9 suites (contracts unchanged) | forge-build.txt, forge-test.txt |
| PoC: stamp pool, funded sybils | reproduces: 49 addresses holding 0.0002 ETH each, or one 0.0002 ETH balance handed along 49 addresses, spend the stamp pool; a funded victim's sponsored seal is refused ("paused for today") | pocs/poc-stamp-pool-funded-sybil.test.ts, pocs.txt |
| PoC: setup pool, rotated 1 USDG | reproduces: one 1-USDG balance handed along 16 fresh swap wallets funds 16 session keys and spends the setup pool; a victim's setup is refused (`relayer_budget`) | pocs/poc-setup-pool-usdg-rotation.test.ts, pocs-setup.txt |
| PoC: self-seal import of an old seal | reproduces: a fresh request imports a seal mined 20 days earlier; the record shows stamped-at 20 days before signed-at | pocs/poc-self-seal-backdated-import.test.ts, pocs-selfseal.txt |
| INVARIANTS link check | 139 cited `File.t.sol::test` names, all resolve to functions; every quoted TS test name resolves | invariants-check.txt |
| CI (GitHub API) | CI 39695487563 on 28de85e: slither, semgrep, gitleaks, test all success (958b54e's CI run was cancelled by the next push); images 39695196003 (958b54e) success | ci-runs.txt, ci-jobs.json |
| osv-scanner, actionlint, zizmor, Pashov | not re-run: lockfiles, `.github/` and `contracts/` are unchanged since f1b2fad; last results carried | runs/20261022-000801/ |

## Deploy verification
**Robinhood Chain mainnet (4663).** `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` from the clone: **15/15 ok**. It checks:
- bytecode (immutables masked) for ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter and SwapKeyPolicy;
- revealer/poster = relayer `0xb257…80f1`;
- USDG, poolManager, `maxOracleAge` 90000, the adapter link, and the EIP-712 domains on 4663.

**Build of record.** `mainnet.json` now names `publicCommit` 71e1fd3. It is in the public history (an ancestor of 28de85e). Its `contracts/src` tree (7a174f25) is identical to the private deploy commit's and to 28de85e's.

**Core CVM** (`/prpc/Info`, app-id 897c44e8…57a3), core-info-check.txt:
- `compose_hash` = sha256(app_compose) = e0c34a0f…6c59, the single `ALLOWED_COMPOSE_HASHES` entry.
- Embedded compose == `git show 28de85e:services/core/docker-compose.yml` (989 bytes each).
- MRTD/RTMR1/RTMR2 equal the pins, and RTMR3 replays.
- `allowed_envs` = DATABASE_URL, HL_PERPS_BUILDER, HL_SPOT_BUILDER.

**Images.** `gh attestation verify` on `proviso-ops@sha256:296535b8…2f08` → `images.yml@refs/heads/main`, source digest `958b54e6…c725`, run 39695196003. The core image is unchanged and attested in an earlier run (716b14d).

**Not checked:** the ops CVM compose (no public Info endpoint). The new literals `SPONSOR_MIN_USDG=1000000` and `SPONSOR_MIN_ETH=0.0002` (with `CHAIN_NETWORK=mainnet`) were verified in the repo only.

**Monitoring:** balance-watch, plus a runbook with contacts in SECURITY.md.

## Findings

### [Medium] Sybils can still spend the sponsored pools for the day (narrowed again)
- id: offchain|services/ops/src/runtime/budget.ts|sybil-budget-exhaustion
- location: services/ops/src/runtime/budget.ts:91-105 (`sponsorRule`); services/ops/src/runtime/swaps.ts:127-135; services/ops/src/stamper.ts:39-46; packages/api/src/trpc.ts:30
- category: B
- what changed (verified):
  - Seals: when sponsorship is refused, the web offers to send the same signed stamp from the owner's wallet (~3e-6 ETH), and `idea.confirmSelfSeal` records it. Sealing no longer stops for users who hold a little ETH.
  - Seals on mainnet need ≥ 1 USDG or ≥ 0.0002 ETH in the owner's wallet or its live swap wallet. Unfunded sybils are refused before any relay (`budget.test.ts`, "49 unfunded sybils x 20 stamps are refused before any relay").
  - A revoke no longer resets the swap wallet's 7-day gas rule (`budget.test.ts`, "…a revoke doesn't reset that"). The revoke cycle from the last report is closed.
- attack (setup pool, the part that still matters):
  1. Sign in ~16 fresh addresses. Sign-in is free.
  2. Give each a fresh swap wallet. Before each setup, move the single 1 USDG to that wallet. `swaps.ts:131` only reads `balanceOf` at relay time.
  3. Each setup funds a new session key with 0.0003 ETH plus gas. The 7-day rule is per wallet, and every wallet is new. 16 setups spend the 0.005 ETH pool (PoC: 16 fundings, 15 hand-offs).
  4. Every other user's swap setup that UTC day is refused with `relayer_budget`. Setups have no self-pay fallback.
- attack (stamp pool, reduced): 49 addresses each holding 0.0002 ETH (0.0098 ETH in total, recoverable), or one 0.0002 ETH balance handed along, each send 20 stamps. Together they spend the 0.003 ETH stamp pool (PoC). Other users can still self-send their seal. Users who hold USDG but no ETH on Robinhood Chain cannot seal until UTC midnight, although the rule counts them as funded.
- impact: new Stock Token swap setups are refused for every other user until UTC midnight, and sponsored seals pause. The attack repeats daily for gas and recoverable capital. Revokes, reveals, roots, epochs and existing keys are not gated, and the relayer float cannot be drained. Griefing × Likely = Medium.
- fix: Path item 2.
- proof for rescore: a test in which the rotated-balance PoC leaves another user's setup sponsored, plus a matching test for the stamp pool (or a sponsored quota that a rotated balance cannot multiply).

### [Low] `confirmSelfSeal` imports any earlier seal with matching hashes, so stamped-at can predate the request by up to 30 days (new)
- id: offchain|packages/api/src/routers/idea.ts|self-seal-unbound-import
- location: packages/api/src/routers/idea.ts:115-146; services/core/src/runtime/ideas.ts:180
- category: B
- attack:
  1. The owner signs stamps for several ideas and seals them on-chain from their own wallet. `ThesisSeal.seal` is permissionless, and the platform never sees these seals.
  2. Days later, for an idea whose entry condition now holds, the owner signs a fresh stamp with the same `entryHash`, `exitHash`, `isSealed` and `expiresAt`, a new nonce and a near deadline, and submits it with `idea.stamp`. The API accepts it.
  3. The owner calls `confirmSelfSeal(requestId, oldTxHash)`. The match at idea.ts:127-137 compares only owner, hashes, `isSealed` and `expiresAt`. The Sealed event has no nonce, the tx input is not decoded, and the block time is not compared with the request. `recordSeal` stores the old seal with stamped-at = the old block time and signed-at = now. If ops relays the fresh stamp first, the attempt fails. The owner avoids that by confirming at once, or by holding under the sponsor floor so the relay is refused.
  4. Core runs the trivially-true check only for ideas stamped under 2 minutes ago (`ideas.ts:180`). It skips this idea, which fires on the next poll.
- impact: the public record shows a call "stamped" up to 30 days before the platform saw it, with no trivially-true flag. The owner picks which hidden commitments to import after watching the market. The commitment itself is genuine and its time is real, so this is selective disclosure plus a skipped check, not a forged time. No funds move. No ranking or payout reads stamped-at; it is used for ordering and expiry only. Record integrity, Low — the same class as the earlier owner-binding row. It would rise to Medium if caller ranking, copy sizing or CallerShare used stamped-at or lead time.
- fix: Path item 5.
- proof for rescore: `selfseal.test.ts` refuses a seal whose nonce differs from the request's, and one mined before the request.

### [Low] The adapter policy accepts any oracle and multiplier (unchanged)
- id: pashov|contracts/src/ProvisoSwapAdapter.sol|unbounded-policy-oracle-multiplier. `contracts/` is unchanged. It is listed under SECURITY.md "Known issues (open)" with a planned fix, not accepted. Fix: Path item 7.

### [Low] Swap exits trigger on the raw pool price (unchanged)
- id: rwa|services/core/src/runtime/index.ts|exit-on-raw-pool. `services/core` is unchanged. It is listed under Known issues. Fix: Path item 9.

### [Low] Enclave images are never vulnerability-scanned (unchanged)
- id: supply|services/Dockerfile|base-image-tag-only. `.github/` is unchanged. It is listed under Known issues. Fix: Path item 6.

## Studio policy
| # | Rule | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Exit never gated | PASS | no pause; revokes are never budget-gated (`budget.test.ts` "revoke is never refused…") |
| P2 | Non-upgradeable | PASS | no proxy, no owner |
| P3 | Fresh deployer per brand | PASS | unchanged deployer/relayer |
| P4 | Tokenomics | PASS (N/A) | no token |
| P5 | No yield language | PASS | the only hit is the P5 row of the published audit table |
| P6 | No endorsement | PASS | disclaimers only |
| P7 | No sibling brands | PASS | 0 hits (studio.txt) |
| P8 | Honest boundaries | PASS | README "Honest boundaries"; SECURITY.md accepted risks and known issues |

## Fixed since last run
- G items, not ledger rows: the public build-of-record commit (`mainnet.json` `publicCommit` 71e1fd3) and the published report (`docs/AUDIT.md`).
- `sybil-budget-exhaustion` was narrowed again but is not fixed (see Findings).

Fix-line sanity check. Checked and found sound:
- `confirmSelfSeal` loads only the caller's own request. The Sealed event must come from ThesisSeal, in a successful tx sent to ThesisSeal, with the caller as owner. A reverted tx, another contract, another owner, other hashes or another expiry are refused (`selfseal.test.ts`).
- A twin request reusing the same tx gets a conflict, and a replay changes nothing.
- `recordSeal` updates the request only while it is not sealed, in one transaction. Every stamper status write is now guarded with `status <> 'sealed'`, so a relay racing a self-sent seal cannot overwrite it. The losing tx reverts `NonceUsed` on-chain.
- `sponsorRule` runs only when the ops client's chain is mainnet 4663 (`chainFromEnv` sets the chain). An RPC error there throws a retryable error rather than sponsoring.
- The swap-wallet branch counts only a registered, unrevoked key. The `swap_keys_account_live` partial unique index keeps that to one live account per wallet.

The only new issue is the Low above.

Leads (no deduction):
- `confirmSelfSeal` accepts a receipt with no confirmation depth. The relay path does the same; it matters only on a sequencer reorg.
- Seals sent through a smart account (`receipt.to` ≠ ThesisSeal) cannot be confirmed. This is liveness only.
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
- `deployment()` env overrides in the Vercel API (now also the RPC that `confirmSelfSeal` trusts);
- sshd/user_config, the KMS id not pinned, quotes without a nonce;
- images.yml `ref: main`;
- FILL stamps attested only by the DB;
- executeSwap has no deadline; swapWalletProofMessage has no nonce;
- fee-on-transfer USDG;
- Info: package.json "Unlicense" vs the MIT LICENSE; next 16.3.7 Medium advisories (frontend, out of scope).

## Checklist detail (C, D, E, F, G)

**C 7.8**
- 1.5 build and tests pass: forge 160/160; every bun suite EXIT=0 (bun-*.txt).
- 0.8 coverage in the ≥70% band: contracts 98.35% (carried, unchanged); core 83.6, ops 82.5, chain 83.0, api 68.7.
- 0.5 negative tests: `confirmSelfSeal` has 10 negative cases and the sponsor rule has refusal tests; the API overall is still in the 60–90% band.
- 1.0 fuzz: Foundry `testFuzz_*` plus fast-check.
- 2.0 invariants: 7 invariants at 128k calls each (deep profile, carried, contracts unchanged); the default-run invariants pass in forge-test.txt.
- 0.5 mutation: 63.6% (carried).
- 1.0 integration: real v4 PoolManager; ops `onchain.test.ts` on anvil.
- 0 symbolic.
- 0.5 CI on every push (39695487563).

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
- 3.0 no secrets (gitleaks history clean, 79 commits; the rotation log is in SECURITY.md).
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
- 1.0 audit history: `docs/AUDIT.md` (the 8.6 report) is committed and linked from the README.
- 0 readiness: the scope list is in SECURITY.md, but there is no tag (`git ls-remote --tags` is empty).

---
AI audit grade — a strong pre-audit signal, not a substitute for a human audit before large TVL.
