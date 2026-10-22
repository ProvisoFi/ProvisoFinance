import { createDb, users, type Db } from "@proviso/db";
import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type Auth = { uid: string; address: string };
export type Context = { db: Db; auth: Auth | null };

let db: Db | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * Verifies a Supabase access token (asymmetric signing keys, fetched from the project JWKS)
 * and resolves the wallet address the sign-in trigger mirrored into public.users.
 * Returns null for a bad, expired or unknown token; throws only if NEXT_PUBLIC_SUPABASE_URL is unset.
 */
export async function verifyToken(token: string, database: Db): Promise<Auth | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  jwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `${url}/auth/v1`, audience: "authenticated" });
    if (!payload.sub) return null;
    const [row] = await database.select({ address: users.address }).from(users).where(eq(users.authUserId, payload.sub));
    return row ? { uid: payload.sub, address: row.address } : null;
  } catch {
    return null;
  }
}

/** tRPC context per request: the shared db and, if a valid `Authorization: Bearer` token is sent, the caller's auth (else null). */
export async function createContext({ req }: { req: Request }): Promise<Context> {
  db ??= createDb();
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  return { db, auth: token ? await verifyToken(token, db) : null };
}
