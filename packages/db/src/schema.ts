// Proviso data model (Backend spec §9, completed where the spec's lines are cut off).
// Every table has RLS on. With no policy, only the service role (API + workers) can
// read or write. Only users and activity get owner policies, for Realtime.
// Plaintext specs and salts are never stored: enc_spec is sealed to the core enclave key.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts("created_at").notNull().defaultNow();
const myAddress = sql`(select address from public.users where auth_user_id = ${authUid})`;

export const users = pgTable(
  "users",
  {
    address: text().primaryKey(), // lowercase 0x main-key address
    authUserId: uuid("auth_user_id").unique().references(() => authUsers.id, { onDelete: "set null" }),
    limits: jsonb().notNull().default({}),
    hlBuildersApprovedAt: ts("hl_builders_approved_at"),
    createdAt: created(),
  },
  (t) => [
    pgPolicy("users_select_own", { for: "select", to: authenticatedRole, using: sql`${t.authUserId} = ${authUid}` }),
  ],
).enableRLS();

export const agentKeys = pgTable(
  "agent_keys",
  {
    address: text().notNull().references(() => users.address),
    version: integer().notNull(),
    agentAddr: text("agent_addr").notNull(),
    name: text().notNull(), // unique per user and version; reusing a name replaces the HL agent
    validUntil: ts("valid_until").notNull(),
    sealedPriv: bytea("sealed_priv").notNull(), // encrypted with the core enclave's dstack key
    approvedAt: ts("approved_at"),
    revokedAt: ts("revoked_at"),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.address, t.version] })],
).enableRLS();

// Robinhood Chain swap key (R4), one per user; re-setup replaces it. `sealed` is the session key
// encrypted with the core enclave's dstack key. `setup` holds the payloads the main key signs and,
// after swapKey.register, the signatures ops relays. Bigints are decimal strings in JSON.
export const swapKeys = pgTable("swap_keys", {
  address: text().primaryKey().references(() => users.address),
  keyAddr: text("key_addr").notNull(),
  sealed: jsonb().notNull(),
  setup: jsonb(),
  signedPolicy: jsonb("signed_policy"),
  policySig: text("policy_sig"),
  expiresAt: ts("expires_at").notNull(),
  registeredAt: ts("registered_at"),
  revokedAt: ts("revoked_at"),
  createdAt: created(),
}).enableRLS();

// A signed stamp waiting for the stamper to relay it. The thesis row exists once sealed on-chain.
export const stampRequests = pgTable(
  "stamp_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    owner: text().notNull().references(() => users.address),
    encSpec: bytea("enc_spec").notNull(),
    stamp: jsonb().notNull(), // EIP-712 Stamp message (hashes, expiry, nonce, deadline)
    ownerSig: text("owner_sig").notNull(),
    signedAt: ts("signed_at").notNull(),
    status: text().notNull().default("pending"),
    error: text(),
    thesisId: bigint("thesis_id", { mode: "bigint" }),
    createdAt: created(),
  },
  (t) => [check("stamp_requests_status", sql`${t.status} in ('pending','relaying','sealed','failed')`)],
).enableRLS();

export const theses = pgTable(
  "theses",
  {
    id: bigint({ mode: "bigint" }).primaryKey(), // ThesisSeal id
    owner: text().notNull().references(() => users.address),
    encSpec: bytea("enc_spec").notNull(),
    entryHash: text("entry_hash").notNull(),
    exitHash: text("exit_hash").notNull(),
    mode: text().notNull(),
    signedAt: ts("signed_at").notNull(),
    stampedAt: ts("stamped_at").notNull(),
    sealTx: text("seal_tx").notNull(),
    expiresAt: ts("expires_at").notNull(),
    retiredAt: ts("retired_at"),
    state: text().notNull(),
    flags: text().array().notNull().default(sql`'{}'`), // self_triggered, trivially_true, closed_outside, …
    createdAt: created(),
  },
  (t) => [
    check("theses_state", sql`${t.state} in ('draft','live','alert','fired','closed','stopped','retired','expired')`),
    check("theses_mode", sql`${t.mode} in ('live','alert')`),
    index("theses_owner_idx").on(t.owner),
    index("theses_active_idx").on(t.state).where(sql`${t.state} in ('live','alert')`),
  ],
).enableRLS();

export const fires = pgTable(
  "fires",
  {
    id: uuid().primaryKey().defaultRandom(),
    thesisId: bigint("thesis_id", { mode: "bigint" }).notNull().references(() => theses.id),
    firedAt: ts("fired_at").notNull(),
    refMark: numeric("ref_mark").notNull(),
    flags: text().array().notNull().default(sql`'{}'`),
  },
  (t) => [index("fires_thesis_idx").on(t.thesisId)],
).enableRLS();

export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    fireId: uuid("fire_id").references(() => fires.id),
    thesisId: bigint("thesis_id", { mode: "bigint" }).notNull().references(() => theses.id),
    account: text().notNull(),
    role: text().notNull(),
    wave: smallint().notNull(),
    venue: text().notNull(),
    cloid: text().unique(),
    venueOrderId: text("venue_order_id"),
    coin: text().notNull(),
    side: text().notNull(),
    size: numeric().notNull(),
    px: numeric(),
    reduceOnly: boolean("reduce_only").notNull().default(false),
    status: text().notNull().default("pending"),
    filledSize: numeric("filled_size").notNull().default("0"),
    avgPx: numeric("avg_px"),
    error: text(),
    createdAt: created(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("orders_role", sql`${t.role} in ('caller','follower')`),
    check("orders_venue", sql`${t.venue} in ('hl','rhc')`),
    check("orders_side", sql`${t.side} in ('long','short','buy','sell')`),
    check("orders_status", sql`${t.status} in ('pending','acked','partial','filled','cancelled','rejected','failed')`),
    index("orders_fire_idx").on(t.fireId),
    index("orders_account_idx").on(t.account),
  ],
).enableRLS();

export const follows = pgTable(
  "follows",
  {
    id: uuid().primaryKey().defaultRandom(),
    follower: text().notNull().references(() => users.address),
    caller: text().notNull().references(() => users.address),
    thesisId: bigint("thesis_id", { mode: "bigint" }).references(() => theses.id), // null = all of the caller's ideas
    sizeRule: jsonb("size_rule").notNull(),
    limits: jsonb().notNull(),
    sealedAllowlist: jsonb("sealed_allowlist"),
    active: boolean().notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("follows_caller_idx").on(t.caller).where(sql`${t.active}`)],
).enableRLS();

// Evidence leaves; per-thesis sequence numbers make gaps visible.
export const stamps = pgTable(
  "stamps",
  {
    leaf: text().primaryKey(),
    thesisId: bigint("thesis_id", { mode: "bigint" }).notNull().references(() => theses.id),
    seq: integer().notNull(),
    kind: text().notNull(),
    data: jsonb().notNull(),
    hourStart: ts("hour_start").notNull(),
    createdAt: created(),
  },
  (t) => [
    unique("stamps_thesis_seq").on(t.thesisId, t.seq),
    check("stamps_kind", sql`${t.kind} in ('FIRE','FILL','EXIT','PNL','EXPIRE')`),
    index("stamps_hour_idx").on(t.hourStart),
  ],
).enableRLS();

export const stampRoots = pgTable("stamp_roots", {
  hourStart: ts("hour_start").primaryKey(),
  root: text().notNull(),
  leafCount: integer("leaf_count").notNull(),
  tx: text(),
  postedAt: ts("posted_at"),
}).enableRLS();

export const reveals = pgTable(
  "reveals",
  {
    thesisId: bigint("thesis_id", { mode: "bigint" }).notNull().references(() => theses.id),
    part: text().notNull(),
    kind: text(),
    dueAt: ts("due_at").notNull(),
    revealedAt: ts("revealed_at"),
    tx: text(),
  },
  (t) => [
    primaryKey({ columns: [t.thesisId, t.part] }),
    check("reveals_part", sql`${t.part} in ('entry','exit')`),
    check("reveals_kind", sql`${t.kind} in ('FIRED','EXPIRED','RETIRED','MANUAL_NO_TRADE')`),
    index("reveals_due_idx").on(t.dueAt).where(sql`${t.revealedAt} is null`),
  ],
).enableRLS();

export const epochs = pgTable("epochs", {
  epoch: bigint({ mode: "bigint" }).primaryKey(),
  root: text().notNull(),
  totalUsdg: numeric("total_usdg").notNull(),
  tx: text(),
  postedAt: ts("posted_at"),
}).enableRLS();

export const callerShares = pgTable(
  "caller_shares",
  {
    epoch: bigint({ mode: "bigint" }).notNull().references(() => epochs.epoch),
    caller: text().notNull(),
    amountUsdg: numeric("amount_usdg").notNull(),
    proof: jsonb().notNull(),
    claimed: boolean().notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.epoch, t.caller] })],
).enableRLS();

export const linkFlags = pgTable(
  "link_flags",
  {
    a: text().notNull(),
    b: text().notNull(),
    reason: text().notNull(),
    score: numeric().notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
).enableRLS();

export const routes = pgTable(
  "routes",
  {
    id: text().primaryKey(),
    address: text().notNull().references(() => users.address),
    kind: text().notNull(),
    amountIn: numeric("amount_in").notNull(),
    amountOut: numeric("amount_out"),
    status: text().notNull().default("quoted"),
    srcTx: text("src_tx"),
    dstTx: text("dst_tx"),
    refundTx: text("refund_tx"),
    createdAt: created(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("routes_kind", sql`${t.kind} in ('fund','exit')`),
    check("routes_status", sql`${t.status} in ('quoted','submitted','bridging','done','refunded','failed')`),
  ],
).enableRLS();

// Lifecycle stream for the workspace; delivered over Supabase Realtime.
export const activity = pgTable(
  "activity",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    address: text().notNull(),
    kind: text().notNull(),
    payload: jsonb().notNull().default({}),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("activity_address_idx").on(t.address, t.at),
    pgPolicy("activity_select_own", { for: "select", to: authenticatedRole, using: sql`${t.address} = ${myAddress}` }),
  ],
).enableRLS();

// Self-recorded market history; Hyperliquid has no historical open-interest API.
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    coin: text().notNull(),
    ts: ts("ts").notNull(),
    mark: numeric().notNull(),
    oracle: numeric(),
    funding: numeric(),
    oi: numeric(),
    volume24h: numeric("volume_24h"),
  },
  (t) => [primaryKey({ columns: [t.coin, t.ts] })],
).enableRLS();

export const candles = pgTable(
  "candles",
  {
    coin: text().notNull(),
    interval: text().notNull(),
    ts: ts("ts").notNull(),
    o: numeric().notNull(),
    h: numeric().notNull(),
    l: numeric().notNull(),
    c: numeric().notNull(),
    v: numeric().notNull(),
  },
  (t) => [primaryKey({ columns: [t.coin, t.interval, t.ts] })],
).enableRLS();

export const fearGreed = pgTable("fear_greed", {
  ts: ts("ts").primaryKey(),
  value: smallint().notNull(),
}).enableRLS();

export const testRuns = pgTable("test_runs", {
  testId: text("test_id").primaryKey(), // sha256(spec, snapshot ids, tester version)
  requestId: uuid("request_id").unique(), // latest request that produced this run
  owner: text().references(() => users.address),
  snapshotIds: text("snapshot_ids").array().notNull(),
  testerVersion: text("tester_version").notNull(),
  status: text().notNull().default("queued"),
  result: jsonb(),
  createdAt: created(),
}).enableRLS();

export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text().primaryKey(),
  address: text().notNull().references(() => users.address),
  keys: jsonb().notNull(),
  createdAt: created(),
}).enableRLS();

export const telegramLinks = pgTable("telegram_links", {
  address: text().primaryKey().references(() => users.address),
  chatId: bigint("chat_id", { mode: "bigint" }).notNull().unique(),
  linkedAt: ts("linked_at").notNull().defaultNow(),
}).enableRLS();

// X accounts the core enclave asks ops to poll (only handles, never rule contents).
export const xHandles = pgTable("x_handles", {
  handle: text().primaryKey(), // lowercase, without @
  addedAt: ts("added_at").notNull().defaultNow(),
  lastSeenId: text("last_seen_id"),
}).enableRLS();

// One-time codes for linking a Telegram chat (/start <code>).
export const telegramCodes = pgTable("telegram_codes", {
  code: text().primaryKey(),
  address: text().notNull().references(() => users.address),
  expiresAt: ts("expires_at").notNull(),
}).enableRLS();

// Testnet price feeds pushed on demand: the RHC executor touches a feed before a swap.
export const feedWanted = pgTable("feed_wanted", {
  feed: text().primaryKey(),
  wantedAt: ts("wanted_at").notNull().defaultNow(),
}).enableRLS();
