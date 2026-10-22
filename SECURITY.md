# Security policy

Proviso is **live on Robinhood Chain mainnet (chain ID 4663) and Hyperliquid mainnet** since 2026-10-21. On-chain actions move real funds. Read the [Security model](README.md#security-model) in the README for what the system does and does not protect against, and [docs/INVARIANTS.md](docs/INVARIANTS.md) for every contract invariant and the test that checks it.

## Reporting a vulnerability

Email **security@provisofi.com**, or DM [@ProvisoFi](https://x.com/ProvisoFi) on X, with a description, the affected component and, if you can, a reproduction. Please do not open a public issue for anything exploitable.

- We acknowledge within 3 business days and keep you updated until the issue is fixed or declined.
- Please give us 90 days (or until a fix ships, if sooner) before public disclosure.
- Prefer a local fork (anvil, Foundry) for anything that moves funds. Testing against the live deployment is fine only with your own accounts and small amounts, and only if it does not degrade the service for others (no spam, no draining the shared relayer, no denial of service) and does not touch other users' data or funds.

There is no bug bounty yet.

## Scope

In scope:

| Component | Path |
| --- | --- |
| Contracts on Robinhood Chain | `contracts/src` (ThesisSeal, StampRoots, CallerShare, ProvisoSwapAdapter, SwapKeyPolicy; ProvisoTestFeed is testnet only) |
| Mainnet deploy record and checks | `packages/chain/deployments/mainnet.json`, `packages/chain/scripts/deploy-mainnet.ts`, `packages/chain/scripts/post-deploy-check.ts` |
| tRPC API (Vercel) | `packages/api`, `apps/web/src/app/api` |
| Enclave workers (Phala Cloud, Intel TDX) | `services/core`, `services/ops`, `services/Dockerfile`, `.github/workflows/images.yml` |
| Shared libraries | `packages/dsl`, `packages/seal`, `packages/hl`, `packages/chain`, `packages/db` |
| Database policies | `supabase/migrations` (RLS, queues, cron) |
| Browser sealing path | `apps/web/src/lib/backend`, `packages/seal` |

Out of scope: the marketing site's UI, third-party services themselves (Phala, Privy, Supabase, Vercel, Hyperliquid, Robinhood Chain, Uniswap v4, Chainlink, ZeroDev Kernel), and findings that need a compromised user device or wallet.

## Privileged roles

Mainnet addresses, transactions and constructor arguments are in [`packages/chain/deployments/mainnet.json`](packages/chain/deployments/mainnet.json); `CHAIN_NETWORK=mainnet bun packages/chain/scripts/post-deploy-check.ts` checks every role below against the chain.

No contract has an owner, admin, proxy, upgrade path or pause. Every privileged address is an `immutable` set in the constructor, so changing a holder means redeploying the contract.

| Role | Where | Holder (mainnet) | Can do | Bound |
| --- | --- | --- | --- | --- |
| Deployer | `packages/chain/scripts/deploy-mainnet.ts` | `0xb2fe7C5281C99Cb55e4AbA2b7ef47F26bE431Da1`, a dedicated deploy key (never the relayer) | deployed the five contracts (2026-10-21) and adapter v2 + SwapKeyPolicy (2026-10-22); every deploy is recorded in `deployments/mainnet.json` | holds no role in any contract afterwards |
| `ThesisSeal.revealer` | `contracts/src/ThesisSeal.sol` | relayer `0xb257791e8c789Bc792EF4794A02Aa9B17BA080f1` | choose the entry reveal kind (FIRED, EXPIRED, RETIRED, MANUAL_NO_TRADE) within each kind's time window | reveals must match the sealed hash; the owner keeps the late EXPIRED fallback |
| `StampRoots.poster` | `contracts/src/StampRoots.sol` | relayer (same) | post one Merkle root per finished hour | hour-aligned, write-once, non-zero; may also fill a never-posted past hour |
| `CallerShare.poster` | `contracts/src/CallerShare.sol` | relayer (same) | post an epoch root and fund it (pulls `totalUsdg` from itself) | one root per epoch; claims per epoch capped at that epoch's funding |
| `ProvisoSwapAdapter.maxOracleAge` | `contracts/src/ProvisoSwapAdapter.sol` | fixed at deploy: **90000 s** (Chainlink's 86400 s heartbeat + 1 h) | not a key: the age limit on every oracle read | immutable; constructor accepts 1 s – 2 days |
| Adapter policies | `ProvisoSwapAdapter.setPolicy` | each account's own main key | allow-list a pool with its oracle, multiplier, slippage band, caps and expiry | per account; nonce strictly increases; `maxSlipBps ≤ 1000` |
| Session-key policies | `SwapKeyPolicy.setPolicy` / `executeSwap` | each account's own main key signs the policy; the session key is generated and sealed inside the **core enclave** (dstack key `proviso/swap-keys/v1`) | fire swaps for that account | the account's signed policy: pool and token allow-list, per-trade and per-UTC-day caps, expiry, oracle band (`minOut` ≥ oracle floor); `revoke()` voids every policy signed before it |
| Hyperliquid agent keys | `services/core/src/executor` | one per user, generated and sealed in the **core enclave** (`proviso/agent-keys/v1`) | place and cancel orders for that user on Hyperliquid | the core signer policy (`services/core/src/signer/policy.ts`): leverage and size caps, ±2% price band, protective triggers only. Hyperliquid agents cannot withdraw |
| Spec-sealing key | `services/core/src/enclave.ts` | derived in the core enclave by Phala dstack KMS (`proviso/spec/v1`) | open every sealed spec and its salts | app-scoped: bound to the Phala application, not to one compose hash; the browser seals only to an attested, allow-listed compose |
| Relayer EOA | ops enclave env (Phala encrypted env, operator-supplied, not KMS-derived) | `0xb257791e8c789Bc792EF4794A02Aa9B17BA080f1` | the three contract roles above, plus relaying `ThesisSeal.seal`, sending reveals, sponsoring swap-setup and revoke UserOps (EntryPoint v0.7), and topping up new session keys with gas | the contract bounds above; user-triggered relays are capped per UTC day and stop at a gas reserve, so reveals, roots and epochs keep gas |
| Supabase service role / `DATABASE_URL` | Vercel (API), core and ops enclaves | Postgres connection used by server code | read and write every table and queue (bypasses RLS) | none in the database; enforced by server code |

User-held powers that never depend on Proviso: `SwapKeyPolicy.revoke()` (or uninstalling the module) from the account, `ThesisSeal.retire()` for a live idea, `CallerShare.claim()` for any funded epoch, removing a Hyperliquid agent on Hyperliquid, and direct transfers from the user's own wallet. None of these can be paused.

**Testnet history.** On Robinhood Chain testnet (46630) a separate relayer also held `ProvisoTestFeed.updater` (pushed TSLA/USDG and AMZN/USDG test prices) and aligned test pools; it also deployed the testnet contracts. None of this exists on mainnet: mainnet swaps price off Chainlink feeds and real Uniswap v4 pools.

## Incident runbook

First steps for any incident: note the time, stop the affected enclave worker if in doubt, rotate the exposed secret, then record it in the rotation log below.

**Stop a worker.** `bunx phala@1.1.22 cvms stop <cvm>`, check with `bunx phala@1.1.22 ps --cvm-id <cvm>`, and restart with `cvms start` or a redeploy (see [Deploy and verify](README.md#deploy-and-verify)). Stopping core halts evaluation, order placement and session-key swaps. Stopping ops halts stamping, reveals, roots, epochs and notifications. User exits (revoke, retire, claim, agent removal, direct transfers) keep working with both stopped.

| Compromised | Impact | Do now | Then |
| --- | --- | --- | --- |
| Relayer key | Attacker can post bogus stamp roots for unposted hours, post epoch roots (only with USDG it funds itself), choose reveal kinds within their windows, delay reveals and roots, and spend the relayer's ETH. It cannot forge a commitment, move user funds, or touch a funded epoch's USDG | Stop ops. Move the relayer's remaining ETH and tokens to a fresh key | Redeploy ThesisSeal, StampRoots and CallerShare with the new key as revealer/poster (`deploy-mainnet.ts`), update the relayer address in `packages/chain/src/chains.ts`, the ops env and redeploy ops; publish the new addresses |
| core enclave (or its dstack keys) | Sealed specs and salts readable; session keys and Hyperliquid agent keys usable within their signed policies | Stop core. Ask users to revoke swap keys (in the app, or `revoke()` on chain) and remove agents on Hyperliquid | Investigate the image digest and compose hash; deploy a new Phala app (new KMS keys), update `allowed-compose.ts`, and re-onboard keys |
| ops enclave | Same as the relayer key, plus the notification bot, Web Push and X tokens | Stop ops; rotate the relayer key and every bot and push credential | Redeploy ops with new env |
| Supabase service key / `DATABASE_URL` | Full read/write of the database: encrypted specs (not plaintext), queues, follows, user rows. Can enqueue jobs core and ops will act on, still inside every signer and contract bound | Rotate the database password and service role key; update the API, core and ops env; redeploy all three | Review queue tables and recent rows for injected jobs |
| Sign-in provider (Privy app) | Attacker-controlled sign-in or embedded wallets for new sessions | Rotate the app secret and check allowed origins; disable the app if needed (sign-in stops, on-chain user exits keep working) | Ask users to revoke swap keys created during the window |
| AI gateway key / web host project | Model spend; with the web host, the whole API path, including which attestation the browser sees | Revoke the key or project access; set the model budget to zero | Rotate every API secret; review recent deployments |
| Public-repo push token or account | Pushes to this repo trigger `images.yml` and publish images with genuine provenance | Revoke the token | Deploys pin digests, so check every pinned digest in `services/*/docker-compose.yml` against a known-good build before redeploying |

## Accepted risks

Each entry names the risk, the reason it is accepted, the mitigations, and when to revisit it.

| Risk | Accepted | Why | Mitigations | Revisit |
| --- | --- | --- | --- | --- |
| **One hot relayer key holds every immutable mainnet role** (`ThesisSeal.revealer`, `StampRoots.poster`, `CallerShare.poster`) | 2026-10-22 | The contracts are non-upgradeable and ownerless by design, so the roles are fixed at deploy. The relayer can delay reveals and roots but cannot forge a commitment (reveals must match the owner-bound hash), cannot move user funds, and can only fund epochs from its own USDG. Every user exit works without it | The key lives only in the ops enclave's encrypted env; balance alerts to the operator; a per-UTC-day budget and reserve on user-triggered relays; the deployer is a separate deploy-only key with no role | When a multisig or threshold poster is practical for the hourly roots and epochs; any redeploy |
| **A stale or paused oracle blocks session-key exits** (P-L1) | 2026-10-23 | The adapter fails closed: with a feed older than `maxOracleAge` (90000 s), a paused Stock Token oracle, or an unpriced multiplier change (`MultiplierChangeUnpriced`) it refuses every swap, exits included. The Stock Token feeds are 24/5, so this happens routinely over weekends and market holidays, not only in incidents. Pricing through a stale or paused feed (a halt or a corporate action) is the larger risk, and refusing never moves funds: the tokens stay in the user's own wallet the whole time | The user can always sell from their own wallet, outside Proviso; stop and take exits retry on later price ticks once the feed is fresh; ops alerts the operator on stale feeds during the NYSE session. An owner Stop pressed while the feed is stale is retried 5 times and then dropped with a `stop_failed` notice | At the next adapter redeploy (an exit path that does not need a fresh oracle) |
| **Adapter policy nonces are shared across an account's pools** (P-L7) | 2026-10-23 | `lastPolicyNonce` is one counter per account, not per pool, so an account's signed adapter policies must land in nonce order, and a newer policy for one pool makes an older unsubmitted one for another pool unusable. This is a liveness issue for setup, not a funds risk: every policy is signed by the account's own key and bounded by its slippage band, caps and expiry, and only the account itself can swap with it | The app builds all of a setup's policies with consecutive nonces and submits them in order; a failed setup is simply redone | At the next adapter redeploy (per-pool nonces) |
| **A 7702 re-delegation back to Kernel revives an old session key** (P-L8) | 2026-10-23 | If a wallet re-delegates away from Kernel without uninstalling SwapKeyPolicy and later delegates back, the old policy and session key are live again. Only the wallet's own main key can sign either delegation, the session key exists only sealed in the core enclave, and the policy still expires (the app signs at most 30 days plus 1 hour; the contract enforces whatever expiry was signed) and stays inside its caps | Revoke in the app uninstalls every SwapKeyPolicy module (its `onUninstall` clears the active policy), current and retired; policies expire | At the next SwapKeyPolicy redeploy (bind the policy to the delegation), or if wallets start re-delegating |
| **The per-day swap cap allows up to 2x around UTC midnight** (UTC-day 2x) | 2026-10-23 | `maxPerDay` counts per UTC calendar day (`block.timestamp / 1 days`), so a session key can spend one day's cap just before 00:00 UTC and another just after. The worst case is bounded at twice a cap the user signed, and the per-trade cap still applies to every swap. A rolling window costs extra storage and gas on every swap | Default caps are small ($100 per trade, $500 per day in USDG) and user-signed; per-trade caps; the session key only trades through core, for the account's own ideas and its copies of callers it follows | At the next SwapKeyPolicy redeploy (rolling 24 h window) |
| **The owner can label a late FIRED reveal as EXPIRED** (late-FIRED label) | 2026-10-23 | The revealer may reveal FIRED until `expiresAt + 1 minute`; after that the owner may reveal EXPIRED so an idea is never stuck unrevealed. Any FIRED reveal still not landed by then (for example, ops down for longer than an idea's remaining life plus a minute) can be recorded as EXPIRED by the owner instead | Ops sends a fire's reveal within about a minute; the fire is still evidenced by its FIRE and FILL stamp leaves in the hourly roots and by the trades on-chain | With ThesisSeal v2 (reveal kind and fire evidence stored on-chain, TU-30) |
| **Session-key swap exits trigger on the raw pool price** | 2026-10-23 | Stops and takes on Robinhood Chain swap positions are checked against the Uniswap v4 pool price, without the depth and oracle-agreement checks entries use. Someone who moves the pool can trigger an exit early. They cannot make it sell cheaply: every exit swap still goes through the adapter's oracle-banded `minOut` (at most a 3% band at default settings), and the per-trade cap still applies. Moving the pool costs the attacker the price impact. The worst case is an early exit near the oracle price | Oracle-banded `minOut` on every swap; per-trade caps ($100 USDG by default); the exit is reported and stamped like any other | When core adds pool/oracle agreement for exits, or if a manipulated exit is seen |
| **Sponsored relay pools can be spent by parked wallets** | 2026-10-23 | The relayer sponsors a limited amount of gas per UTC day for seals and swap setups, for wallets that have held the funding floor (1 USDG or 0.0002 ETH) for an hour. A determined spammer can park many such wallets and use up the day's pool. That costs the operator's relayer ETH, never user funds, and nobody is locked out: seals and swap setups can always be self-paid from the user's own wallet | Per-address and per-day caps; a gas reserve that keeps reveals, roots and epochs funded; balance alerts to the operator; self-pay for seals and setups | If sponsored pools run out in practice (then reserve part of each pool for accounts with history) |
| **FILL stamp leaves can link a follower's trades to a caller** | 2026-10-22 | The public record exists to prove Fair Copy ordering: followers filled before the caller, at what size and price. That proof needs per-fill size, price and time. Leaves carry no account address, and the underlying trades are already public on Hyperliquid and Robinhood Chain; the leaf adds the link to an idea. This is a privacy trade-off of a public record, not a funds risk | No account in the leaf; follows are opt-in; the record is the product's stated purpose | If users ask for follower privacy: aggregate follower fills per wave in the leaf |

## Known issues (open)

_Fixed 2026-10-22: enclave images are now scanned by Trivy in `images.yml` (fails on fixable CRITICAL). Adapter v2 (`0xe21590f12b0c57ebff50c6713918fd985b18ec0b`) pins one Chainlink oracle per Stock Token, requires `multiplier == 1e18` and USDG as the quote side, so a signed policy can no longer move the oracle floor; SwapKeyPolicy was redeployed against it (`0xf8d8cfb1bba1946ca955925ea41156a4fb5c0ea5`). The previous pair is listed under `previous` in `packages/chain/deployments/mainnet.json`._

Info-level items with planned fixes; none puts user funds at risk beyond the bounds above.

| Issue | Planned fix |
| --- | --- |
| Adapter pins are per token, not per pool: a policy the user signs for another fee tier or hooks contract on the same pair is accepted (loss bounded by the slippage band and caps) | Pin the PoolId, or require `hooks == 0` and allowed fee tiers, at the next adapter redeploy |
| The Trivy gate fails only on CRITICAL and runs after the image is pushed; Halmos `OracleBand` proofs time out and are not in CI (`AdapterPins` proves) | Gate on HIGH before push; bound the Halmos floor proofs |

## External review: re-audit v1.1 (2026-10-22)

An independent reviewer audited this repository at `86e99de` and reported four Medium and four Low findings in the off-chain services, each with a passing proof of concept. Our own published report ([docs/AUDIT.md](docs/AUDIT.md), 9.1 at the time) missed three of the Mediums and listed the fourth only as an unverified lead. All eight are fixed, with a regression test each:

| ID | Finding | Fix |
| --- | --- | --- |
| P-M1 | Fair Copy never auto-copied: the API stored the follow allow-list as an object, core read only arrays, so every follow fell back to tap-to-confirm | One normalizer (`packages/db/src/allowlist.ts`) used by the API to write and by core to read, including old rows |
| P-M2 | Pressing Stop on a fired idea crashed core (the exit report ran after the idea was dropped from memory, an unhandled rejection) | The idea is held until its exit is reported; async callbacks are caught; a process-level rejection handler keeps core running |
| P-M3 | One follower with a huge size (confirm-only, or auto with a funded account) shrank every other follower's copy, down to below the minimum | The depth budget is shared max-min fairly (smallest copies filled first, nobody above an equal split of the rest); auto followers first, confirm-only followers from what is left (fixed in two steps: the confirm-only path first, the auto path after our rescore found it still open) |
| P-M4 | Follows from accounts that never onboard could fill the 1,000 per-fire follower slots ahead of real followers | Only followers with a usable key (approved Hyperliquid agent, registered swap key) count toward the cap |
| L-1 | Stop pressed while a late copy was going in returned success but sold nothing; a backed-up follower key could delay the caller's entry and exit; copy confirms ran one at a time for everyone | Exits wait for the copy in progress and are serialized per idea; Stop fails (and retries, at most 5 times) while a position is still open; the caller's entry and exit wait at most 20 s for the follower wave; confirms for different fires run in parallel |
| L-2 | A retry after "already known" / "replacement underpriced" could buy twice | Swaps are signed before broadcast so the hash is known; "already known" waits for that transaction; only "nonce too low" is retried |
| L-3 | After a restart a repeat idea could fire before its open position was restored, orphaning it | Fires are held until the restore finishes |
| L-4 | Accounts set up on the retired SwapKeyPolicy kept it installed after a revoke | Revoke uninstalls every SwapKeyPolicy module on the wallet; wallets that still hold the retired one see a one-signature "remove the old swap permission" action. The one affected wallet has since uninstalled both modules (no active policy on either) |

## Secret rotation log

| Date | Secret | Reason |
| --- | --- | --- |
| 2026-10-21 | Public-repo push token | Exposed in a private file; the old token was deleted on GitHub and replaced by a new one kept outside the repository |
