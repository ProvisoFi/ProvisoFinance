// Hyperliquid onboarding (signed once by the main key, Backend §4). The trade-only agent key is
// generated inside the core enclave; this route only turns its public address into the typed
// data the user's wallet signs, and relays the signed approvals to Hyperliquid (HL_NETWORK).
import { agentKeys } from "@proviso/db";
import {
  approveAgentAction,
  approveAgentTypedData,
  approveBuilderFeeAction,
  approveBuilderFeeTypedData,
  ExchangeClient,
  InfoClient,
  network,
} from "@proviso/hl";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { z } from "zod";
import { authedProcedure, limitedProcedure, router } from "../trpc";

const BUILDERS = [
  { kind: "perps", env: "HL_PERPS_BUILDER", maxFeeRate: "0.05%" },
  { kind: "spot", env: "HL_SPOT_BUILDER", maxFeeRate: "0.3%" },
] as const;
/** Builders set in this deployment, with the fee in tenths of a basis point (maxBuilderFee's unit). */
const configuredBuilders = () =>
  BUILDERS.flatMap((b) => {
    const builder = process.env[b.env];
    return builder && /^0x[0-9a-fA-F]{40}$/.test(builder)
      ? [{ kind: b.kind, builder: builder as Hex, maxFeeRate: b.maxFeeRate, tenthsBp: Math.round(parseFloat(b.maxFeeRate) * 1000) }]
      : [];
  });
const builderApprovals = (nonce: number) =>
  configuredBuilders().map((b, i) => {
    const action = approveBuilderFeeAction({ builder: b.builder, maxFeeRate: b.maxFeeRate, nonce: nonce + i }, network());
    return { kind: b.kind, action, typedData: approveBuilderFeeTypedData(action) };
  });
/** Hyperliquid caps approved builders per account; its refusal is turned into a next step. */
const builderRefusal = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /builder/i.test(m) && /(max|limit|too many|10)/i.test(m)
    ? `Your Hyperliquid account already has the most builder approvals it allows. Revoke one you no longer use on app.hyperliquid.xyz, then approve again. (${m})`
    : m;
};

const sig = z.object({ r: z.string(), s: z.string(), v: z.number() });

/** Hyperliquid onboarding for the signed-in caller: agent-key status, approval typed data, relaying approvals. */
export const hlRouter = router({
  /** The Hyperliquid network name and the caller's agent keys, newest version first. */
  status: authedProcedure.query(async ({ ctx }) => {
    const keys = await ctx.db
      .select({ version: agentKeys.version, agentAddr: agentKeys.agentAddr, validUntil: agentKeys.validUntil, approvedAt: agentKeys.approvedAt, revokedAt: agentKeys.revokedAt })
      .from(agentKeys)
      .where(eq(agentKeys.address, ctx.auth.address))
      .orderBy(desc(agentKeys.version));
    return { network: network().name, keys };
  }),

  /** Proviso's builder fees in this deployment and whether the caller approved each (live trades only pay a fee that was approved). */
  builderStatus: authedProcedure.query(async ({ ctx }) => {
    const info = new InfoClient();
    return Promise.all(
      configuredBuilders().map(async (b) => {
        const max = await info.maxBuilderFee(ctx.auth.address as Hex, b.builder).catch(() => null);
        return { kind: b.kind, builder: b.builder, maxFeeRate: b.maxFeeRate, approved: typeof max === "number" && max >= b.tenthsBp };
      }),
    );
  }),

  /** Typed data for the caller's main wallet to approve Proviso's builder fees (for accounts connected before a fee was set, or after a revoke). */
  prepareBuilders: limitedProcedure("hlApprovals").mutation(() => builderApprovals(Date.now())),

  /** Relays signed builder-fee approvals. Only this deployment's builders at their published rates are relayed. */
  submitBuilders: limitedProcedure("hlApprovals")
    .input(z.object({ builders: z.array(z.object({ action: z.record(z.string(), z.unknown()), signature: sig })).min(1).max(2) }))
    .mutation(async ({ input }) => {
      const ours = configuredBuilders();
      for (const b of input.builders) {
        const a = b.action as { type?: unknown; builder?: unknown; maxFeeRate?: unknown };
        const match = ours.find((o) => typeof a.builder === "string" && a.builder.toLowerCase() === o.builder.toLowerCase());
        if (a.type !== "approveBuilderFee" || !match || a.maxFeeRate !== match.maxFeeRate)
          throw new TRPCError({ code: "BAD_REQUEST", message: "That approval isn't for Proviso's builder fee." });
      }
      const ex = new ExchangeClient();
      try {
        for (const b of input.builders) await ex.approveBuilderFee(b.action as never, b.signature as never);
      } catch (e) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: builderRefusal(e) });
      }
      return { approved: true };
    }),

  /**
   * Asks the enclave for a fresh agent key, waits briefly for it, and returns what to sign
   * (approveAgent plus a builder-fee approval per configured builder). TIMEOUT after ~10 s.
   */
  prepareAgent: limitedProcedure("agentKey").mutation(async ({ ctx }) => {
    const since = new Date();
    await ctx.db.execute(sql`select pgmq.send('agent', ${JSON.stringify({ owner: ctx.auth.address })}::jsonb)`);
    for (let i = 0; i < 20; i++) {
      const [k] = await ctx.db
        .select()
        .from(agentKeys)
        .where(and(eq(agentKeys.address, ctx.auth.address), isNull(agentKeys.approvedAt), isNull(agentKeys.revokedAt)))
        .orderBy(desc(agentKeys.version))
        .limit(1);
      if (k && k.createdAt >= since) {
        const net = network();
        const nonce = Date.now();
        const agent = approveAgentAction(
          { agentAddress: k.agentAddr as Hex, agentName: `${k.name} valid_until ${k.validUntil.getTime()}`, nonce },
          net,
        );
        const builders = builderApprovals(nonce + 1).map(({ action, typedData }) => ({ action, typedData }));
        return { version: k.version, agent: { action: agent, typedData: approveAgentTypedData(agent) }, builders };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new TRPCError({ code: "TIMEOUT", message: "The enclave didn't answer; try again." });
  }),

  /**
   * Relays the user-signed approvals to Hyperliquid, then confirms the agent is listed and marks the key approved.
   * Refuses an approval for any address other than the caller's key `version`; PRECONDITION_FAILED if not listed.
   */
  submitApprovals: limitedProcedure("hlApprovals")
    .input(
      z.object({
        version: z.int().min(1),
        agent: z.object({ action: z.record(z.string(), z.unknown()), signature: sig }),
        builders: z.array(z.object({ action: z.record(z.string(), z.unknown()), signature: sig })).max(2),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [k] = await ctx.db
        .select()
        .from(agentKeys)
        .where(and(eq(agentKeys.address, ctx.auth.address), eq(agentKeys.version, input.version)));
      if (!k || input.agent.action.agentAddress !== k.agentAddr)
        throw new TRPCError({ code: "BAD_REQUEST", message: "That approval isn't for your current agent key." });
      const ex = new ExchangeClient();
      await ex.approveAgent(input.agent.action as never, input.agent.signature as never);
      for (const b of input.builders) await ex.approveBuilderFee(b.action as never, b.signature as never);
      const agents = await new InfoClient().extraAgents(ctx.auth.address as Hex);
      const listed = agents.some((a) => a.address.toLowerCase() === k.agentAddr.toLowerCase());
      if (!listed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Hyperliquid hasn't listed the agent yet. Is the account funded on ${network().name === "mainnet" ? "Hyperliquid" : "testnet"}?` });
      await ctx.db
        .update(agentKeys)
        .set({ approvedAt: new Date() })
        .where(and(eq(agentKeys.address, ctx.auth.address), eq(agentKeys.version, input.version)));
      return { approved: true };
    }),
});
