// Server-side read of a call's public facts, for its page and share image (no auth needed).
import { appRouter, createContext } from "@proviso/api";
import type { ProfileIdea, PublicCall } from "@/lib/proviso/call";

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

/** A caller's public record for their profile, or null for a malformed address. */
export async function getProfile(address: string): Promise<{ caller: string; ideas: ProfileIdea[] } | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    const caller = appRouter.createCaller(await createContext({ req: new Request("https://provisofi.com/") }));
    const r = await caller.records.get({ caller: address });
    return {
      caller: r.caller,
      ideas: r.ideas.map((i) => ({
        id: i.id,
        owner: r.caller,
        mode: i.mode,
        state: i.state,
        stampedAt: new Date(i.stampedAt).toISOString(),
        expiresAt: new Date(i.expiresAt).toISOString(),
        sealTx: i.sealTx,
        fires: i.fires.map((f) => ({ at: new Date(f.at).toISOString(), refMark: f.refMark })),
        revealKind: i.entryReveal?.revealedAt ? i.entryReveal.kind : null,
        revealTx: i.entryReveal?.revealedAt ? i.entryReveal.tx : null,
        pnlUsd: i.pnlUsd,
        stampCount: i.stampCount,
      })),
    };
  } catch {
    return null;
  }
}
