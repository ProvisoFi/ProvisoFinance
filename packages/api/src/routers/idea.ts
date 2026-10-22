import { network, chains, deployment, stampTypedData, thesisSealAbi } from "@proviso/chain";
import { activity, recordSeal, reveals, stampRequests, testRuns, theses } from "@proviso/db";
import type { Attestation } from "@proviso/seal";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { createPublicClient, decodeFunctionData, getAddress, http, isAddressEqual, parseEventLogs, verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import { authedProcedure, limitedProcedure, publicProcedure, router } from "../trpc";
import { draftRule, MAX_IDEA_CHARS, WriterError } from "../writer";

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

const rhcClient = () => createPublicClient({ chain: chains[network()], transport: http(process.env.RHC_RPC_URL) });

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

  draft: limitedProcedure("draft").input(z.object({ text: z.string().min(3).max(MAX_IDEA_CHARS) })).mutation(async ({ input }) => {
    try {
      return await draftRule(input.text);
    } catch (e) {
      if (e instanceof WriterError) throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: e.message });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The rule writer is unavailable." });
    }
  }),

  // Accepts an owner-signed stamp and a spec sealed to the enclave; the stamper relays it.
  stamp: limitedProcedure("stamp").input(StampInput).mutation(async ({ ctx, input }) => {
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

  // The owner sent the seal from their own wallet (ThesisSeal.seal is permissionless), e.g. after a
  // sponsored relay was refused. Recorded only for a successful direct seal() call to ThesisSeal of
  // exactly this request's stamp, mined while the request was open; stamped-at is that block's time.
  confirmSelfSeal: limitedProcedure("selfSeal").input(z.object({ requestId: z.uuid(), txHash: hex32 })).mutation(async ({ ctx, input }) => {
    const [req] = await ctx.db
      .select()
      .from(stampRequests)
      .where(and(eq(stampRequests.id, input.requestId), eq(stampRequests.owner, ctx.auth.address)));
    if (!req) throw new TRPCError({ code: "NOT_FOUND" });
    if (req.status === "sealed") throw new TRPCError({ code: "CONFLICT", message: "This stamp is already sealed." });
    const { address } = sealContract();
    const pub = rhcClient();
    const receipt = await pub.getTransactionReceipt({ hash: input.txHash }).catch(() => null);
    if (!receipt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That transaction isn't mined yet; try again in a moment." });
    const s = req.stamp as { owner: string; entryHash: string; exitHash: string; sealed: boolean; expiresAt: string; nonce: string; deadline: string };
    // The Sealed event carries no nonce or deadline, so the tx itself must be a direct seal(stamp, sig)
    // of exactly this request's stamp; otherwise an older seal with the same hashes could be imported.
    const tx = await pub.getTransaction({ hash: input.txHash }).catch(() => null);
    let call: ReturnType<typeof decodeFunctionData<typeof thesisSealAbi>> | undefined;
    try {
      if (tx?.to && isAddressEqual(tx.to, address)) call = decodeFunctionData({ abi: thesisSealAbi, data: tx.input });
    } catch {}
    const st = call?.functionName === "seal" ? call.args[0] : undefined;
    const sameStamp =
      !!st &&
      isAddressEqual(st.owner, s.owner as Address) &&
      st.entryHash.toLowerCase() === s.entryHash.toLowerCase() &&
      st.exitHash.toLowerCase() === s.exitHash.toLowerCase() &&
      st.isSealed === Boolean(s.sealed) &&
      st.expiresAt === BigInt(s.expiresAt) &&
      st.nonce === BigInt(s.nonce) &&
      st.deadline === BigInt(s.deadline);
    const ev =
      sameStamp && receipt.status === "success" && receipt.to && isAddressEqual(receipt.to, address)
        ? parseEventLogs({ abi: thesisSealAbi, eventName: "Sealed", logs: receipt.logs }).find(
            (l) =>
              isAddressEqual(l.address, address) &&
              isAddressEqual(l.args.owner, req.owner as Address) &&
              isAddressEqual(l.args.owner, s.owner as Address) &&
              l.args.entryHash.toLowerCase() === s.entryHash.toLowerCase() &&
              l.args.exitHash.toLowerCase() === s.exitHash.toLowerCase() &&
              l.args.isSealed === Boolean(s.sealed) &&
              l.args.expiresAt === BigInt(s.expiresAt),
          )
        : undefined;
    if (!ev) throw new TRPCError({ code: "BAD_REQUEST", message: "That transaction didn't seal this stamp." });
    const [known] = await ctx.db.select({ id: theses.id }).from(theses).where(eq(theses.id, ev.args.id));
    if (known) throw new TRPCError({ code: "CONFLICT", message: "That seal is already recorded." });
    const block = await pub.getBlock({ blockHash: receipt.blockHash });
    // Mined while this request was open: not before it was made (120 s clock tolerance), not after its deadline.
    if (Number(block.timestamp) * 1000 < req.createdAt.getTime() - 120_000 || block.timestamp > BigInt(s.deadline))
      throw new TRPCError({ code: "BAD_REQUEST", message: "That seal wasn't mined while this stamp was open." });
    const ok = await recordSeal(ctx.db, req, { id: ev.args.id, tx: input.txHash, stampedAt: new Date(Number(block.timestamp) * 1000) });
    if (!ok) throw new TRPCError({ code: "CONFLICT", message: "This stamp is already sealed." });
    return { thesisId: String(ev.args.id) };
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

  // 90-day replay of a draft. The spec is sealed to the enclave (never a server-side draft),
  // so the tester runs inside core and writes test_runs; poll testResult with the request id.
  test: limitedProcedure("test")
    .input(z.object({ encSpec: z.string().max(Math.ceil((MAX_ENC_SPEC * 4) / 3) + 4), days: z.int().min(1).max(90).default(90), slippageBps: z.number().min(0).max(200).default(10) }))
    .mutation(async ({ ctx, input }) => {
      const requestId = crypto.randomUUID();
      await ctx.db.execute(
        sql`select pgmq.send('test', ${JSON.stringify({ requestId, owner: ctx.auth.address, encSpec: input.encSpec, days: input.days, slippageBps: input.slippageBps })}::jsonb)`,
      );
      return { requestId };
    }),

  testResult: authedProcedure.input(z.object({ requestId: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.requestId, input.requestId), eq(testRuns.owner, ctx.auth.address)));
    return row ? { status: row.status, testId: row.testId, snapshotIds: row.snapshotIds, testerVersion: row.testerVersion, result: row.result } : { status: "queued" as const };
  }),

  // The owner retires on-chain from their own wallet; this records it after checking the receipt.
  // The entry reveal is then due within 24 h (the core enclave reveals it with kind RETIRED).
  retired: authedProcedure
    .input(z.object({ id: z.string().regex(/^\d+$/), tx: hex32 }))
    .mutation(async ({ ctx, input }) => {
      const id = BigInt(input.id);
      const [t] = await ctx.db.select({ owner: theses.owner, state: theses.state }).from(theses).where(eq(theses.id, id));
      if (!t || t.owner !== ctx.auth.address) throw new TRPCError({ code: "NOT_FOUND" });
      const { address, chainId } = sealContract();
      if (chains[network()].id !== chainId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const pub = rhcClient();
      const receipt = await pub.getTransactionReceipt({ hash: input.tx }).catch(() => null);
      const ev = receipt?.status === "success"
        ? parseEventLogs({ abi: thesisSealAbi, eventName: "Retired", logs: receipt.logs }).find(
            (l) => isAddressEqual(l.address, address) && l.args.id === id,
          )
        : undefined;
      if (!ev) throw new TRPCError({ code: "BAD_REQUEST", message: "That transaction didn't retire this idea." });
      const retiredAt = new Date(Number(ev.args.retiredAt) * 1000);
      await ctx.db.transaction(async (tx) => {
        await tx.update(theses).set({ state: "retired", retiredAt }).where(eq(theses.id, id));
        await tx.update(reveals).set({ dueAt: new Date(Number(ev.args.revealDueBy) * 1000) }).where(and(eq(reveals.thesisId, id), eq(reveals.part, "entry")));
        await tx.insert(activity).values({ address: ctx.auth.address, kind: "retired", payload: { thesisId: input.id, tx: input.tx } });
      });
      return { retiredAt };
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
