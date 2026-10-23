// Proviso Arena: the public season scoreboard and a human's entry. See ../arena.ts.
import { arenaEntries, fires, orders, reveals, stampRequests, stamps, theses, users } from "@proviso/db";
import { renderAction, renderCondition } from "@proviso/dsl";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ARENA_COINS, ARENA_RULES, arenaClock, arenaModels, seasonFromId, seasonOf } from "../arena";
import { limitedProcedure, publicProcedure, router } from "../trpc";
import { perps } from "./market";

/** "When … : open …" from a revealed entry's canonical JSON; null if it can't be read. */
export function revealedRule(canonical: string | null): string | null {
  if (!canonical) return null;
  try {
    const e = JSON.parse(canonical) as { entry?: { when?: unknown; then?: unknown[] } };
    if (!e.entry?.when || !Array.isArray(e.entry.then)) return null;
    return `When ${renderCondition(e.entry.when as never)}: ${e.entry.then.map((a) => renderAction(a as never)).join(", then ")}.`;
  } catch {
    return null;
  }
}

const modelName = (entrant: string) => arenaModels().find((m) => m.id === entrant)?.name ?? null;

export const arenaRouter = router({
  /**
   * Public: one season's board (the current one by default). Score = return on the entry's paper
   * notional: stamped P&L, plus (while the season runs) the open position at the current mark.
   * Once the season ends only stamped results count, so the final board is provable.
   */
  season: publicProcedure.input(z.object({ season: z.string().max(10).optional() }).optional()).query(async ({ ctx, input }) => {
    const s = input?.season ? seasonFromId(input.season) : seasonOf();
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "No such season." });
    const now = arenaClock.now().getTime();
    const live = now < s.end.getTime();
    const rows = await ctx.db
      .select({ e: arenaEntries, requestThesis: stampRequests.thesisId, requestStatus: stampRequests.status, name: users.displayName })
      .from(arenaEntries)
      .leftJoin(stampRequests, eq(arenaEntries.stampRequestId, stampRequests.id))
      .leftJoin(users, eq(users.address, arenaEntries.address))
      .where(eq(arenaEntries.season, s.id));
    const ids = rows.flatMap((r) => (r.e.thesisId ?? r.requestThesis) ?? []);
    const [ts, fs, rs, pnl, os, market] = ids.length
      ? await Promise.all([
          ctx.db.select().from(theses).where(inArray(theses.id, ids)),
          ctx.db.select().from(fires).where(inArray(fires.thesisId, ids)).orderBy(desc(fires.firedAt)),
          ctx.db.select().from(reveals).where(and(inArray(reveals.thesisId, ids), eq(reveals.part, "entry"))),
          ctx.db.select({ thesisId: stamps.thesisId, data: stamps.data, createdAt: stamps.createdAt }).from(stamps).where(and(inArray(stamps.thesisId, ids), eq(stamps.kind, "PNL"))),
          ctx.db.select().from(orders).where(and(inArray(orders.thesisId, ids), eq(orders.venue, "paper"))),
          live ? perps().catch(() => []) : Promise.resolve([]),
        ])
      : [[], [], [], [], [], []];
    const markOf = (coin: string) => market.find((p) => p.coin === coin)?.mark;
    const entries = rows.map((r) => {
      const id = r.e.thesisId ?? r.requestThesis ?? null;
      const t = id ? ts.find((x) => x.id === id) : undefined;
      const fire = id ? fs.find((x) => x.thesisId === id) : undefined;
      const rev = id ? rs.find((x) => x.thesisId === id) : undefined;
      // Only stamps written before the season ended count.
      const realized = pnl
        .filter((p) => p.thesisId === id && p.createdAt.getTime() <= s.end.getTime())
        .reduce((sum, p) => sum + (Number((p.data as { pnlUsd?: unknown }).pnlUsd) || 0), 0);
      const mine = os.filter((o) => o.thesisId === id && Number(o.filledSize) > 0);
      const opened = mine.filter((o) => !o.reduceOnly);
      const notional = opened.reduce((sum, o) => sum + Number(o.filledSize) * Number(o.avgPx), 0);
      let unrealized = 0;
      if (live && t?.state === "fired")
        for (const o of opened) {
          const closed = mine.filter((c) => c.reduceOnly && c.coin === o.coin).reduce((sum, c) => sum + Number(c.filledSize), 0);
          const left = Number(o.filledSize) - closed, mark = markOf(o.coin);
          if (left > 0 && mark) unrealized += (mark - Number(o.avgPx)) * left * (o.side === "short" ? -1 : 1);
        }
      const status = !t ? (r.requestStatus === "failed" ? "failed" : "sealing") : t.state === "alert" ? "sealed" : t.state === "fired" ? "open" : t.state;
      return {
        address: r.e.address,
        entrant: r.e.entrant,
        ai: r.e.entrant !== "human",
        name: modelName(r.e.entrant) ?? r.name ?? null,
        thesisId: id ? String(id) : null,
        status,
        sealedAt: t?.stampedAt ?? null,
        firedAt: fire?.firedAt ?? null,
        rule: revealedRule(rev?.canonical ?? null),
        returnPct: notional > 0 ? ((realized + unrealized) / notional) * 100 : null,
        pnlUsd: notional > 0 ? realized + unrealized : null,
      };
    });
    entries.sort((a, b) => (b.returnPct ?? 0) - (a.returnPct ?? 0) || Number(b.ai) - Number(a.ai));
    return {
      season: s.id,
      start: s.start,
      entryCloses: s.entryCloses,
      end: s.end,
      live,
      rules: { ...ARENA_RULES, coins: ARENA_COINS },
      models: arenaModels().map((m) => m.name.replace(/-AI$/, "")),
      entries,
    };
  }),

  /**
   * Enters the caller's paper call into the current season: sealed during the entry window, paper
   * mode, expiring by the season's cap; one entry per address. The 48 h hold is up to the caller:
   * a position still open when the season ends doesn't count.
   */
  enter: limitedProcedure("arenaEnter").input(z.object({ thesisId: z.string().regex(/^\d{1,30}$/) })).mutation(async ({ ctx, input }) => {
    const s = seasonOf();
    if (arenaClock.now().getTime() >= s.entryCloses.getTime())
      throw new TRPCError({ code: "BAD_REQUEST", message: "This season's entries closed Tuesday 24:00 UTC. The next season opens Monday." });
    const [t] = await ctx.db.select().from(theses).where(and(eq(theses.id, BigInt(input.thesisId)), eq(theses.owner, ctx.auth.address)));
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That isn't one of your sealed calls." });
    if (t.mode !== "paper") throw new TRPCError({ code: "BAD_REQUEST", message: "Arena entries are paper calls." });
    if (t.stampedAt < s.start) throw new TRPCError({ code: "BAD_REQUEST", message: "Seal a new paper call this week to enter." });
    if (t.expiresAt > s.expiryCap) throw new TRPCError({ code: "BAD_REQUEST", message: "Arena calls must expire by Saturday 00:00 UTC (at most 3 days)." });
    const [row] = await ctx.db
      .insert(arenaEntries)
      .values({ season: s.id, address: ctx.auth.address, entrant: "human", thesisId: t.id })
      .onConflictDoNothing()
      .returning({ id: arenaEntries.id });
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "You already have an entry this season." });
    return { season: s.id };
  }),
});
