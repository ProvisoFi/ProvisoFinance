"use client";
// Funding route planner: Robinhood Chain USDG ⇄ Hyperliquid USDC through Relay. On testnet the
// server reports routes unavailable and the form stays disabled. Signed-out users get the
// local-only planner as before.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createWalletClient, custom, formatUnits, getAddress, type Hex, type TypedDataDefinition } from "viem";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Glyph } from "@/views/proviso/glyph";
import { Icon, useModal } from "@/views/proviso/shared";
import { Note, Panel, Tag } from "./ui";

// Same values as ROUTES_MAINNET in packages/api/src/relay.ts.
const RELAY_API = "https://api.relay.link";
const OUT_DECIMALS = { fund: 8, exit: 6 } as const; // HL USDC · RHC USDG

type Quote = {
  requestId: string;
  steps: { id: string; kind: "transaction" | "signature"; description?: string; items: { status: string; data: unknown }[] }[];
  amountOut?: string;
  minimumOut?: string;
  timeEstimateSec?: number;
  fees?: unknown;
};
type TxData = { to: Hex; data?: Hex; value?: string; chainId: number };
type SignData = {
  sign: { signatureKind: "eip712" | "eip191"; domain?: unknown; types?: unknown; primaryType?: string; value?: unknown; message?: string };
  post?: { endpoint: string; method?: string; body?: unknown };
};

const FINAL = ["done", "refunded", "failed"];
const units = (raw: string | undefined, d: number) => (raw ? formatUnits(BigInt(raw), d) : "—");
const feesText = (fees: unknown) =>
  fees && typeof fees === "object"
    ? Object.entries(fees as Record<string, { amountUsd?: string }>)
        .map(([k, f]) => `${k} $${f?.amountUsd ?? "?"}`)
        .join(" · ")
    : "—";

export function FundingRoutePanel() {
  const open = useModal();
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const signedIn = account.status === "signed-in";
  const availability = useQuery({ ...trpc.route.availability.queryOptions(), enabled: signedIn });
  const available = signedIn && availability.data?.available === true;
  const mine = useQuery({ ...trpc.route.mine.queryOptions(), enabled: available });
  const [direction, setDirection] = useState("to-hl"),
    [amount, setAmount] = useState(100),
    [error, setError] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = direction === "to-hl" ? "fund" : "exit";
  const blocked = signedIn && !available; // checking, errored, or unavailable on this network

  const requestQuote = async () => {
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a positive source amount.");
      return;
    }
    setError("");
    if (!signedIn) {
      open({
        title: "Live route quotes are coming.",
        body: `Your ${amount} ${direction === "to-hl" ? "USDG" : "USDC"} route needs a connected route.quote service. The final quote must disclose output, fees, timing, and source-refund terms before approval.`,
      });
      return;
    }
    setBusy(true);
    setQuote(null);
    setProgress(null);
    try {
      setQuote((await api.route.quote.mutate({ direction: kind, amountUsd: amount })) as Quote);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No quote was returned.");
    } finally {
      setBusy(false);
    }
  };

  // ponytail: mainnet-only path, not exercised end to end (Relay serves no testnet for these
  // chains). It follows Relay's step format as returned; verify against a live quote first.
  const execute = async (q: Quote) => {
    setBusy(true);
    setError("");
    try {
      const provider = await account.provider();
      if (!provider || !account.address) throw new Error("Wallet is not ready.");
      const wallet = createWalletClient({ account: getAddress(account.address), transport: custom(provider) });
      for (const step of q.steps) {
        for (const item of step.items) {
          if (item.status === "complete") continue;
          setProgress(step.description ?? `Confirm "${step.id}" in your wallet…`);
          if (step.kind === "transaction") {
            const tx = item.data as TxData;
            await wallet.switchChain({ id: tx.chainId });
            await wallet.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
          } else {
            const { sign, post } = item.data as SignData;
            const signature =
              sign.signatureKind === "eip712"
                ? await wallet.signTypedData({
                    domain: sign.domain,
                    types: sign.types,
                    primaryType: sign.primaryType,
                    message: sign.value,
                  } as TypedDataDefinition)
                : await wallet.signMessage({ message: { raw: sign.message as Hex } });
            if (post) {
              const res = await fetch(`${RELAY_API}${post.endpoint}?signature=${signature}`, {
                method: post.method ?? "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(post.body ?? {}),
              });
              if (!res.ok) throw new Error(`The relayer rejected the signature (${res.status}).`);
            }
          }
        }
      }
      for (let i = 0; i < 120; i++) {
        const s = await api.route.status.query({ requestId: q.requestId });
        setProgress(`Route status: ${s.status}.`);
        if (FINAL.includes(s.status)) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The route was not completed.");
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: trpc.route.mine.queryKey() });
    }
  };

  const outDecimals = OUT_DECIMALS[kind];
  return (
    <Panel className="w-route-panel" label="FUNDING ROUTE PLANNER" icon="route">
      <div className="route-map">
        <div>
          <span className="w-label">{direction === "to-hl" ? "ROBINHOOD CHAIN" : "HYPERLIQUID"}</span>
          <strong>{direction === "to-hl" ? "USDG" : "USDC"}</strong>
        </div>
        <div className="route-bridge">
          <i />
          <Glyph name="route" size={30} />
          <i />
          <small>PUBLIC RELAYER</small>
        </div>
        <div>
          <span className="w-label">{direction === "to-hl" ? "HYPERLIQUID" : "ROBINHOOD CHAIN"}</span>
          <strong>{direction === "to-hl" ? "USDC" : "USDG"}</strong>
        </div>
      </div>
      <div className="w-form-grid three">
        <label className="w-field">
          Direction
          <select value={direction} disabled={blocked || busy} onChange={(e) => (setDirection(e.target.value), setQuote(null))}>
            <option value="to-hl">Fund Hyperliquid</option>
            <option value="from-hl">Return to Robinhood Chain</option>
          </select>
        </label>
        <label className="w-field">
          Source amount
          <input
            type="number"
            min={signedIn ? 5 : 1}
            value={amount || ""}
            disabled={blocked || busy}
            onChange={(e) => (setAmount(Number(e.target.value)), setQuote(null))}
          />
        </label>
        <div className="route-quote">
          <span>Expected received</span>
          <strong>
            {quote
              ? `${units(quote.amountOut, outDecimals)} ${kind === "fund" ? "USDC" : "USDG"}`
              : blocked && availability.data
                ? "Unavailable"
                : "Quote required"}
          </strong>
        </div>
      </div>
      {error && (
        <p className="w-errors" role="alert">
          {error}
        </p>
      )}
      {signedIn && availability.isPending && <Note>Checking whether routes are available…</Note>}
      {signedIn && availability.error && <Note>Route availability could not be checked: {availability.error.message}</Note>}
      {availability.data?.available === false && signedIn && <Note>{availability.data.reason}</Note>}
      {quote && (
        <Note>
          Minimum received {units(quote.minimumOut, outDecimals)} · about {quote.timeEstimateSec ?? "?"} s · fees {feesText(quote.fees)} ·
          refunds go to the source account.
        </Note>
      )}
      {progress && <Note>{progress}</Note>}
      <div className="w-form-footer" aria-live="polite">
        <Note>Failed routes are designed to refund to the source account. No transfer is initiated here.</Note>
        {quote ? (
          <button className="w-button" disabled={busy} onClick={() => execute(quote)}>
            Approve in wallet <Icon name="check" size={16} />
          </button>
        ) : (
          <button className="w-button" disabled={blocked || busy} onClick={requestQuote}>
            Request route quote <Icon name="arrow" size={16} />
          </button>
        )}
      </div>
      {available && mine.data && mine.data.length > 0 && (
        <div className="w-live-list">
          {mine.data.map((r) => (
            <div key={r.id}>
              <strong>{r.kind === "fund" ? "Fund Hyperliquid" : "Return to Robinhood Chain"}</strong> <Tag>{r.status}</Tag>
              <Note>
                {r.amountIn} USD in · {new Date(r.createdAt).toLocaleString()}
                {r.srcTx && ` · source ${r.srcTx.slice(0, 10)}…`}
                {r.dstTx && ` · delivered ${r.dstTx.slice(0, 10)}…`}
                {r.refundTx && ` · refunded ${r.refundTx.slice(0, 10)}…`}
              </Note>
            </div>
          ))}
        </div>
      )}
      {available && mine.error && <Note>Your routes could not be loaded: {mine.error.message}</Note>}
    </Panel>
  );
}
