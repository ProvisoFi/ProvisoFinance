// Proviso Arena: enters the AI models into the current season (Vercel Cron, Monday and Tuesday).
// Idempotent: a model already entered is skipped, so a later run retries only the ones that failed.
import { createContext, enclaveKeyFrom, seedAiEntrants } from "@proviso/api";

export const maxDuration = 300; // six models write and seal in parallel

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const seed = process.env.ARENA_SEED;
  if (!seed) return Response.json({ error: "ARENA_SEED is not set" }, { status: 503 });
  const { db } = await createContext({ req: new Request("https://provisofi.com/") });
  const key = enclaveKeyFrom(); // one verified attestation for every model
  const result = await seedAiEntrants(db, { seed, enclaveKey: () => key });
  return Response.json(result, { status: result.failed.length && !result.entered.length ? 502 : 200 });
}
