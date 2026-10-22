// Shared test helpers: a real-migrations PGlite db with a pgmq stand-in, a caller factory, and a
// fetch stub that answers JSON-RPC / Hyperliquid / Relay / core by host and refuses everything else.
import type { Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { sql } from "drizzle-orm";
import { appRouter } from "./index";

export const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export const RPC_URL = "http://rpc.stub";

// pgmq isn't in PGlite: send() records into pgmq.sent (and q_agent, which swapKey.prepare reads).
const PGMQ = `
create schema if not exists pgmq;
create table pgmq.sent (queue text not null, message jsonb not null);
create table pgmq.q_agent (message jsonb not null);
create function pgmq.send(q text, m jsonb) returns bigint language plpgsql as $$
begin
  insert into pgmq.sent values (q, m);
  if q = 'agent' then insert into pgmq.q_agent values (m); end if;
  return 1;
end $$;
`;

/** PGlite db shaped like the API's postgres-js client (execute returns the rows array). */
export async function testDb(): Promise<Db> {
  const pg = await createTestDb();
  await (pg as unknown as { $client: { exec(q: string): Promise<unknown> } }).$client.exec(PGMQ);
  return new Proxy(pg, {
    get: (t, k) => (k === "execute" ? async (q: unknown) => ((await t.execute(q as never)) as unknown as { rows: unknown[] }).rows : Reflect.get(t, k)),
  }) as Db;
}

/** Messages sent to one pgmq queue, oldest first. */
export const sent = async (db: Db, queue: string) =>
  ((await db.execute(sql`select message from pgmq.sent where queue = ${queue}`)) as unknown as { message: Record<string, unknown> }[]).map((r) => r.message);

export const as = (db: Db, address: string | null) => appRouter.createCaller({ db, auth: address ? { uid: address, address } : null });

type Handler = (url: URL, body: any) => unknown;
/**
 * Replaces globalThis.fetch. `rpc` answers JSON-RPC posted to RPC_URL (return the `result`, or throw
 * for an RPC error); `hosts` answer other hosts (return a Response or a JSON value). Any other host
 * throws, so a test can never reach the network. Returns the restore function.
 */
export function stubFetch(o: { rpc?: (method: string, params: any[]) => unknown; hosts?: Record<string, Handler> }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const body = typeof raw === "string" && raw ? JSON.parse(raw) : undefined;
    if (url.origin === RPC_URL && o.rpc) {
      try {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: o.rpc(body.method, body.params ?? []) ?? null });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: String((e as Error).message) } });
      }
    }
    const h = o.hosts?.[url.host];
    if (!h) throw new Error(`test blocked a network call to ${url.host}`);
    const out = await h(url, body);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Sets env vars (undefined deletes) and returns the restore function. */
export function setEnv(vars: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) x === undefined ? delete process.env[k] : (process.env[k] = x);
  };
  apply(vars);
  return () => apply(before);
}
