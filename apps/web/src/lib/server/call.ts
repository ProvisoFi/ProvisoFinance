// Server-side read of a call's public facts, for its page and share image (no auth needed).
import { appRouter, createContext } from "@proviso/api";
import type { PublicCall } from "@/lib/proviso/call";

/** The call's public facts, or null for a malformed or unknown id. */
export async function getCall(id: string): Promise<PublicCall | null> {
  if (!/^\d{1,30}$/.test(id)) return null;
  try {
    const caller = appRouter.createCaller(await createContext({ req: new Request("https://provisofi.com/") }));
    const c = await caller.records.byId({ id });
    return {
      ...c,
      stampedAt: new Date(c.stampedAt).toISOString(),
      expiresAt: new Date(c.expiresAt).toISOString(),
      fires: c.fires.map((f) => ({ at: new Date(f.at).toISOString(), refMark: f.refMark })),
    };
  } catch {
    return null;
  }
}
