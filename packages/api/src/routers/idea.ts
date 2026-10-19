import { network, chains, deployment, stampTypedData } from "@proviso/chain";
import { stampRequests, theses } from "@proviso/db";
import type { Attestation } from "@proviso/seal";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { getAddress, isAddressEqual, verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import { authedProcedure, publicProcedure, router } from "../trpc";
import { draftRule, WriterError } from "../writer";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<Hex>;
const MAX_EXPIRY_S = 30n * 86_400n;
const MAX_ENC_SPEC = 64 * 1024;

export const StampInput = z.object({
  encSpec: z.string().max(Math.ceil((MAX_ENC_SPEC * 4) / 3) + 4), // base64 of the sealed box
  mode: z.enum(["live", "alert"]),
  stamp: z.object({
    owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    entryHash: hex32,
    exitHash: hex32,
    sealed: z.boolean(),
    expiresAt: z.bigint(),
    nonce: z.bigint().min(0n).max(2n ** 64n - 1n),
    deadline: z.bigint(),
  }),
  ownerSig: z.string().regex(/^0x[0-9a-fA-F]+$/) as z.ZodType<Hex>,
  signedAt: z.date(),
});

const sealContract = () => {
  const addr = deployment().thesisSeal;
  if (!addr) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ThesisSeal is not deployed on this network yet." });
  return { address: addr, chainId: chains[network()].id };
};

let attestationCache: { at: number; value: unknown } | undefined;

export const ideaRouter = router({
  // Where browsers seal to: the chain, contract and enclave attestation.
  sealTarget: publicProcedure.query(() => {
    const { address, chainId } = sealContract();
    return { address, chainId };
  }),
  attestation: publicProcedure.query(async () => {
    if (attestationCache && Date.now() - attestationCache.at < 5 * 60_000) return attestationCache.value as Attestation;
    const url = process.env.CORE_URL;
    if (!url) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The evaluator enclave is not deployed yet." });
    const res = await fetch(`${url}/attestation`);
    if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "The evaluator enclave did not answer." });
    const value = (await res.json()) as Attestation;
    attestationCache = { at: Date.now(), value };
    return value;
  }),

  draft: authedProcedure.input(z.object({ text: z.string().min(3).max(2000) })).mutation(async ({ input }) => {
    try {
      return await draftRule(input.text);
    } catch (e) {
      if (e instanceof WriterError) throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: e.message });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The rule writer is unavailable." });
    }
  }),

  // Accepts an owner-signed stamp and a spec sealed to the enclave; the stamper relays it.
  stamp: authedProcedure.input(StampInput).mutation(async ({ ctx, input }) => {
    const { stamp } = input;
    if (!isAddressEqual(stamp.owner as Address, ctx.auth.address as Address))
      throw new TRPCError({ code: "FORBIDDEN", message: "The stamp must be signed by your signed-in wallet." });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (stamp.deadline < now + 30n) throw new TRPCError({ code: "BAD_REQUEST", message: "The stamp deadline is too close; sign again." });
    if (stamp.deadline > now + 3600n) throw new TRPCError({ code: "BAD_REQUEST", message: "The stamp deadline is too far out." });
    // signed-at is shown on the public record next to stamped-at, so it can't be backdated:
    // the client's clock is accepted only within 5 minutes of the server's.
    if (Math.abs(input.signedAt.getTime() - Date.now()) > 5 * 60_000)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Your device clock is off; signed-at must be within 5 minutes of now." });
    if (stamp.expiresAt <= now || stamp.expiresAt > now + MAX_EXPIRY_S)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Expiry must be within 30 days." });
    const encSpec = Buffer.from(input.encSpec, "base64");
    if (encSpec.length < 57 + 16 || encSpec.length > MAX_ENC_SPEC) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid sealed spec." });

    const { address, chainId } = sealContract();
    const message = { ...stamp, owner: getAddress(stamp.owner) };
    const valid = await verifyTypedData({ ...stampTypedData(chainId, address, message), address: message.owner, signature: input.ownerSig });
    if (!valid) throw new TRPCError({ code: "BAD_REQUEST", message: "The stamp signature does not match." });

    const [row] = await ctx.db
      .insert(stampRequests)
      .values({
        owner: ctx.auth.address,
        encSpec,
        stamp: { ...stamp, expiresAt: String(stamp.expiresAt), nonce: String(stamp.nonce), deadline: String(stamp.deadline), mode: input.mode },
        ownerSig: input.ownerSig,
        signedAt: input.signedAt,
      })
      .returning({ id: stampRequests.id });
    await ctx.db.execute(sql`select pgmq.send('stamp', ${JSON.stringify({ id: row.id })}::jsonb)`);
    return { requestId: row.id };
  }),

  stampStatus: authedProcedure.input(z.object({ requestId: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select({ status: stampRequests.status, error: stampRequests.error, thesisId: stampRequests.thesisId })
      .from(stampRequests)
      .where(and(eq(stampRequests.id, input.requestId), eq(stampRequests.owner, ctx.auth.address)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  // Reduce-only close of the idea's positions; core reports progress through activity.
  stop: authedProcedure.input(z.object({ id: z.string().regex(/^\d+$/) })).mutation(async ({ ctx, input }) => {
    const id = BigInt(input.id);
    const [t] = await ctx.db.select({ owner: theses.owner, state: theses.state }).from(theses).where(eq(theses.id, id));
    if (!t || t.owner !== ctx.auth.address) throw new TRPCError({ code: "NOT_FOUND" });
    if (!["live", "alert", "fired"].includes(t.state)) throw new TRPCError({ code: "BAD_REQUEST", message: `This idea is already ${t.state}.` });
    await ctx.db.execute(sql`select pgmq.send('stop', ${JSON.stringify({ thesisId: input.id, owner: ctx.auth.address })}::jsonb)`);
    return { requested: true };
  }),

  mine: authedProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: theses.id,
        entryHash: theses.entryHash,
        exitHash: theses.exitHash,
        mode: theses.mode,
        state: theses.state,
        flags: theses.flags,
        signedAt: theses.signedAt,
        stampedAt: theses.stampedAt,
        expiresAt: theses.expiresAt,
        sealTx: theses.sealTx,
      })
      .from(theses)
      .where(eq(theses.owner, ctx.auth.address))
      .orderBy(desc(theses.stampedAt))
      .limit(200),
  ),
});
