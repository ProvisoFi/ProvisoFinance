import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { isPushEndpoint } from "./push";
export { recordSeal } from "./seal";
export { allowEntries, type AllowEntry } from "./allowlist";
export { schema };

/**
 * Service-role connection for the API and workers. Never use from the browser.
 * prepare:false is required by Supabase's transaction pooler (port 6543). Throws if no URL is set.
 */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(postgres(url, { prepare: false }), { schema });
}

export type Db = ReturnType<typeof createDb>;
