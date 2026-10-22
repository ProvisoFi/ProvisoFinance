// In-process Postgres (PGlite) with the real init migration, for tests of DB code.
// Supabase-only pieces are stubbed: the auth schema, auth.uid() and the API roles.
// pgmq and pg_cron aren't available here; test queue code against its SQL instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./index.ts";
import * as schema from "./schema.ts";

const migrations = join(import.meta.dirname, "../../../supabase/migrations");

const STUBS = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
`;

/** A fresh in-memory PGlite database with every table migration applied, typed as the production Db. */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(STUBS);
  // Every table migration in order; the Supabase platform ones (queues, cron, auth triggers) are skipped.
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrations, f), "utf8");
    if (/pgmq|cron\.|supabase_realtime|handle_web3_identity/.test(sql)) continue;
    await pg.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  // Same query surface as the postgres-js client for select/insert/update/transaction.
  return drizzle(pg, { schema }) as unknown as Db;
}
