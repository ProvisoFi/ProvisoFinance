import { afterAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Db } from "@proviso/db";
import { createContext, verifyToken } from "./context";

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
const base = `http://localhost:${server.port}`;
process.env.NEXT_PUBLIC_SUPABASE_URL = base;
afterAll(() => server.stop());

// Minimal stand-in for the drizzle select chain used by verifyToken.
const db = { select: () => ({ from: () => ({ where: async () => [{ address: "0xabc" }] }) }) } as unknown as Db;

const sign = (claims: { iss?: string; aud?: string; sub?: string }, key = privateKey) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(claims.iss ?? `${base}/auth/v1`)
    .setAudience(claims.aud ?? "authenticated")
    .setSubject(claims.sub ?? "user-1")
    .setExpirationTime("5m")
    .sign(key);

test("valid Supabase token resolves the wallet address", async () => {
  expect(await verifyToken(await sign({}), db)).toEqual({ uid: "user-1", address: "0xabc" });
});

test("wrong issuer, wrong audience or foreign key is rejected", async () => {
  const other = (await generateKeyPair("ES256")).privateKey;
  expect(await verifyToken(await sign({ iss: "https://evil/auth/v1" }), db)).toBeNull();
  expect(await verifyToken(await sign({ aud: "anon" }), db)).toBeNull();
  expect(await verifyToken(await sign({}, other), db)).toBeNull();
  expect(await verifyToken("not-a-jwt", db)).toBeNull();
});

test("a valid token for a wallet with no Proviso row has no session", async () => {
  const none = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db;
  expect(await verifyToken(await sign({}), none)).toBeNull();
});

test("createContext: no Authorization header, a non-Bearer one, or a bad token gives no session", async () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test@127.0.0.1:1/none"; // postgres-js connects lazily; no query runs here
  try {
    const ctx = (headers: Record<string, string>) => createContext({ req: new Request("http://localhost/trpc", { headers }) });
    expect((await ctx({})).auth).toBeNull();
    expect((await ctx({ authorization: "Basic abc" })).auth).toBeNull();
    expect((await ctx({ authorization: "Bearer not-a-jwt" })).auth).toBeNull();
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});
