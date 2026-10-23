// Proviso Arena (expansion.md section 6): weekly seasons where AI models and humans race sealed paper
// calls on real order books. Each AI entrant gets the same market snapshot and brief, writes its own
// rule with the rule writer, and seals it from its own wallet, server-side, exactly like a browser
// seal (stamp signed by the owner, spec sealed to the attested core enclave, relayed by ops).
import { chains, deployment, network, randomNonce, stampTypedData, type Stamp } from "@proviso/chain";
import { arenaEntries, stampRequests, users, type Db } from "@proviso/db";
import { durationMs, MAX_LEVERAGE, splitCommitments, Spec, validate, type SpecInput } from "@proviso/dsl";
import { InfoClient, listedDexes, perpUniverse } from "@proviso/hl";
import { sealSpec, verifyAttestation, type Attestation } from "@proviso/seal";
import { eq, sql } from "drizzle-orm";
import { getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { floorsFor, perps } from "./routers/market";
import { draftRule } from "./writer";

export type ArenaModel = { id: string; name: string };

/**
 * The AI lineup: ARENA_MODELS, a JSON array of {id: AI Gateway model id, name: public name ending
 * in "-AI"}, set on the deployment (kept out of the source). Empty or invalid: no AI entrants.
 */
export function arenaModels(env: Record<string, string | undefined> = process.env): ArenaModel[] {
  try {
    const list = JSON.parse(env.ARENA_MODELS ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((m) =>
      m && typeof m.id === "string" && typeof m.name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,22}[A-Za-z0-9]$/.test(m.name) ? [{ id: m.id, name: m.name }] : [],
    );
  } catch {
    return [];
  }
}

/** Markets every entrant may trade (perps, so paper fills walk Hyperliquid's real books). */
export const ARENA_COINS = ["BTC", "ETH", "SOL", "HYPE", "xyz:NVDA", "xyz:TSLA", "xyz:GOLD", "xyz:CL", "xyz:SP500"];

/** Every Arena call: paper, $1,000, up to 3x, closed within 48 h of firing so the season settles on stamped results. */
export const ARENA_RULES = { sizeUsd: 1000, maxLev: 3, maxHold: "48h", maxExpiryH: 72 } as const;

const DAY = 86_400_000;

/** The Arena's clock (tests set it). */
export const arenaClock = { now: () => new Date() };

export type Season = { id: string; start: Date; entryCloses: Date; expiryCap: Date; end: Date };

const season = (start: Date, id: string): Season => ({
  id,
  start,
  entryCloses: new Date(start.getTime() + 2 * DAY), // Mon + Tue
  expiryCap: new Date(start.getTime() + 5 * DAY), // calls expire by Saturday 00:00
  end: new Date(start.getTime() + 7 * DAY),
});

/** The ISO-week season (Monday 00:00 UTC to the next Monday) containing `at`, e.g. "2026-W44". */
export function seasonOf(at = arenaClock.now()): Season {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const start = new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY);
  const thursday = new Date(start.getTime() + 3 * DAY);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY / 7) + 1;
  return season(start, `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`);
}

/** The season with id "YYYY-Www", or null for a malformed id. */
export function seasonFromId(id: string): Season | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return null;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const s = season(new Date(week1 + (Number(m[2]) - 1) * 7 * DAY), id);
  return seasonOf(s.start).id === id ? s : null;
}

/** An AI entrant's wallet, derived from ARENA_SEED and its model id (stable across seasons). */
export const arenaAccount = (seed: string, model: string): PrivateKeyAccount =>
  privateKeyToAccount(keccak256(toHex(`proviso-arena:${seed}:${model}`)));

/** Mark, 24h move and funding for the Arena markets, one line each. */
export async function marketSnapshot(info = new InfoClient()): Promise<string> {
  const [meta, ctxs] = await perpUniverse(info, listedDexes());
  return ARENA_COINS.flatMap((coin) => {
    const i = meta.universe.findIndex((u) => u.name === coin);
    const c = ctxs[i];
    if (i < 0 || !c) return [];
    const mark = Number(c.markPx), prev = Number(c.prevDayPx);
    const change = prev > 0 ? ((mark - prev) / prev) * 100 : 0;
    return [`${coin}: mark ${mark}, 24h ${change >= 0 ? "+" : ""}${change.toFixed(2)}%, funding ${(Number(c.funding) * 100).toFixed(4)}%/h`];
  }).join("\n");
}

/** The brief every AI entrant gets (same words, same data). */
export function arenaBrief(name: string, snapshot: string, expiresH: number): string {
  return [
    `You are ${name}, competing in this week's Proviso Arena against other AI models and human traders.`,
    `Invent the single trading idea you believe will make the best return over the next few days, then write it as a rule.`,
    `Use only these Hyperliquid perp markets: ${ARENA_COINS.join(", ")}.`,
    `Current snapshot:\n${snapshot}`,
    `Constraints: one "hl" open action of $${ARENA_RULES.sizeUsd} at up to ${ARENA_RULES.maxLev}x leverage; mode "paper"; a stop and a target;`,
    `it should be able to fire within ${expiresH} hours (expires "${expiresH}h") and it closes at the latest ${ARENA_RULES.maxHold} after firing (exit.maxHold "${ARENA_RULES.maxHold}").`,
    `Be decisive: no ambiguities, pick your own numbers.`,
  ].join("\n");
}

/** Holds a drafted rule to the Arena's terms: paper, Arena markets only, $1,000 total at ≤3x, 48 h max hold. */
export function arenaSpec(draft: SpecInput, expiresH: number): Spec {
  const s = Spec.parse(draft);
  const opens = s.entry.then.filter((a) => a.venue === "hl" && a.action === "open" && ARENA_COINS.includes(a.coin));
  if (!opens.length) throw new Error("no Arena perp action");
  const size = ARENA_RULES.sizeUsd / opens.length;
  return Spec.parse({
    ...s,
    mode: "paper",
    fire: "once",
    cooldown: "0m",
    expires: `${expiresH}h`,
    entry: {
      ...s.entry,
      then: opens.map((a) => (a.venue === "hl" && a.action === "open" ? { ...a, lev: Math.min(a.lev, ARENA_RULES.maxLev), size: { usd: size } } : a)),
    },
    exit: { ...s.exit, maxHold: ARENA_RULES.maxHold },
    limits: { maxUsd: ARENA_RULES.sizeUsd, maxLev: ARENA_RULES.maxLev },
  });
}

/**
 * Seals `spec` for `account` the way the browser does (owner-signed EIP-712 stamp, spec and salts
 * sealed to the attested enclave key) and queues it for the ops relayer. Returns the stamp request id.
 */
export async function sealAs(db: Db, account: PrivateKeyAccount, spec: Spec, enclaveKey: Uint8Array): Promise<string> {
  const thesisSeal = deployment().thesisSeal;
  if (!thesisSeal) throw new Error("ThesisSeal is not deployed on this network");
  const owner = getAddress(account.address);
  const c = splitCommitments(spec, { owner });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const stamp: Stamp = {
    owner,
    entryHash: c.entryHash,
    exitHash: c.exitHash,
    sealed: true,
    expiresAt: now + BigInt(durationMs(spec.expires) / 1000),
    nonce: randomNonce(),
    deadline: now + 15n * 60n,
  };
  const ownerSig = await account.signTypedData(stampTypedData(chains[network()].id, thesisSeal, stamp));
  const payload = { v: 1 as const, purpose: "thesis" as const, owner, spec, saltE: c.saltE, saltX: c.saltX };
  const [row] = await db
    .insert(stampRequests)
    .values({
      owner: owner.toLowerCase(),
      encSpec: sealSpec(enclaveKey, payload),
      stamp: { ...stamp, expiresAt: String(stamp.expiresAt), nonce: String(stamp.nonce), deadline: String(stamp.deadline), mode: "paper" },
      ownerSig,
      signedAt: new Date(),
    })
    .returning({ id: stampRequests.id });
  await db.execute(sql`select pgmq.send('stamp', ${JSON.stringify({ id: row!.id })}::jsonb)`);
  return row!.id;
}

/** The core enclave's sealing key from CORE_URL's attestation, checked like the browser does. */
export async function enclaveKeyFrom(coreUrl = process.env.CORE_URL): Promise<Uint8Array> {
  if (!coreUrl) throw new Error("CORE_URL is not set");
  const res = await fetch(`${coreUrl}/attestation`);
  if (!res.ok) throw new Error("The enclave did not answer");
  return verifyAttestation((await res.json()) as Attestation);
}

export type SeedResult = { season: string; entered: string[]; failed: { model: string; error: string }[]; skipped?: string };

/**
 * Enters every AI model that hasn't entered the current season yet (idempotent: run it again to
 * retry failures). Only during the entry window.
 */
export async function seedAiEntrants(
  db: Db,
  o: {
    seed: string;
    /** The core enclave's sealing key, from a verified attestation (see enclaveKeyFrom). */
    enclaveKey: () => Promise<Uint8Array>;
    now?: Date;
    info?: InfoClient;
    models?: readonly ArenaModel[];
    write?: typeof draftRule;
  },
): Promise<SeedResult> {
  const now = o.now ?? arenaClock.now();
  const s = seasonOf(now);
  if (now >= s.entryCloses) return { season: s.id, entered: [], failed: [], skipped: "entry window closed" };
  const expiresH = Math.min(ARENA_RULES.maxExpiryH, Math.floor((s.expiryCap.getTime() - now.getTime()) / 3_600_000));
  const have = new Set((await db.select({ entrant: arenaEntries.entrant }).from(arenaEntries).where(eq(arenaEntries.season, s.id))).map((r) => r.entrant));
  const todo = (o.models ?? arenaModels()).filter((m) => !have.has(m.id));
  if (!todo.length) return { season: s.id, entered: [], failed: [] };
  const info = o.info ?? new InfoClient();
  const [snapshot, market] = await Promise.all([marketSnapshot(info), perps(info)]);
  const hl = Object.fromEntries(market.map((p) => [p.coin, { maxLeverage: p.maxLeverage, volume24hUsd: p.volume24hUsd }]));
  const write = o.write ?? draftRule;
  const out: SeedResult = { season: s.id, entered: [], failed: [] };
  await Promise.all(
    todo.map(async (m) => {
      try {
        const account = arenaAccount(o.seed, m.id);
        const address = account.address.toLowerCase();
        // The entrant's public name; a human who already took it keeps it (the address stays the identity).
        await db.insert(users).values({ address, displayName: m.name }).onConflictDoNothing();
        await db.insert(users).values({ address }).onConflictDoNothing(); // the name was taken: no name
        const draft = await write(arenaBrief(m.name, snapshot, expiresH), m.id, { zeroDataRetention: false });
        const spec = arenaSpec(draft.spec, expiresH);
        const v = validate(spec, { hl, user: { maxUsd: ARENA_RULES.sizeUsd, maxLev: MAX_LEVERAGE }, floors: floorsFor(network()) });
        if (!v.ok) throw new Error(v.errors.map((e) => e.message).join("; "));
        const stampRequestId = await sealAs(db, account, v.spec, await o.enclaveKey());
        await db.insert(arenaEntries).values({ season: s.id, address, entrant: m.id, stampRequestId }).onConflictDoNothing();
        out.entered.push(m.id);
      } catch (e) {
        out.failed.push({ model: m.id, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      }
    }),
  );
  return out;
}
