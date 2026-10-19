// Hyperliquid onboarding (signed once by the main key, Backend §4). The trade-only agent key is
// generated inside the core enclave; this route only turns its public address into the typed
// data the user's wallet signs, and relays the signed approvals to Hyperliquid (testnet).
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
import { authedProcedure, router } from "../trpc";

const BUILDERS = [
  { env: "HL_PERPS_BUILDER", maxFeeRate: "0.05%" },
  { env: "HL_SPOT_BUILDER", maxFeeRate: "0.3%" },
] as const;

const sig = z.object({ r: z.string(), s: z.string(), v: z.number() });

export const hlRouter = router({
  status: authedProcedure.query(async ({ ctx }) => {
    const keys = await ctx.db
      .select({ version: agentKeys.version, agentAddr: agentKeys.agentAddr, validUntil: agentKeys.validUntil, approvedAt: agentKeys.approvedAt, revokedAt: agentKeys.revokedAt })
      .from(agentKeys)
      .where(eq(agentKeys.address, ctx.auth.address))
      .orderBy(desc(agentKeys.version));
    return { network: network().name, keys };
  }),

  // Asks the enclave for a fresh agent key, waits briefly for it, and returns what to sign.
  prepareAgent: authedProcedure.mutation(async ({ ctx }) => {
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
        const builders = BUILDERS.flatMap((b, i) => {
          const builder = process.env[b.env] as Hex | undefined;
          if (!builder) return [];
          const action = approveBuilderFeeAction({ builder, maxFeeRate: b.maxFeeRate, nonce: nonce + 1 + i }, net);
          return [{ action, typedData: approveBuilderFeeTypedData(action) }];
        });
        return { version: k.version, agent: { action: agent, typedData: approveAgentTypedData(agent) }, builders };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new TRPCError({ code: "TIMEOUT", message: "The enclave didn't answer; try again." });
  }),

  // Relays the user-signed approvals to Hyperliquid, then confirms the agent is listed.
  submitApprovals: authedProcedure
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
      if (!listed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Hyperliquid hasn't listed the agent yet. Is the account funded on testnet?" });
      await ctx.db
        .update(agentKeys)
        .set({ approvedAt: new Date() })
        .where(and(eq(agentKeys.address, ctx.auth.address), eq(agentKeys.version, input.version)));
      return { approved: true };
    }),
});
