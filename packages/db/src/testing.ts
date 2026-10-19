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

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(STUBS);
  const init = readdirSync(migrations).find((f) => f.endsWith("_init.sql"));
  if (!init) throw new Error("init migration not found");
  await pg.exec(readFileSync(join(migrations, init), "utf8").replaceAll("--> statement-breakpoint", ""));
  // Same query surface as the postgres-js client for select/insert/update/transaction.
  return drizzle(pg, { schema }) as unknown as Db;
}
