import { expect, test } from "bun:test";
import { fngRows, snapshotRows, type MetaAndCtxs } from "./recorder";

const ts = new Date("2026-10-19T12:00:00Z");
const sample: MetaAndCtxs = [
  { universe: [{ name: "BTC" }, { name: "THIN" }, { name: "OLD", isDelisted: true }] },
  [
    { markPx: "100000", oraclePx: "99990", funding: "0.0000125", openInterest: "12000", dayNtlVlm: "900000000" },
    { markPx: "1", dayNtlVlm: "1000" },
    { markPx: "5", dayNtlVlm: "9000000" },
  ],
];

test("keeps liquid listed markets only, aligned by index", () => {
  expect(snapshotRows(sample, ts, 250_000)).toEqual([
    { coin: "BTC", ts, mark: "100000", oracle: "99990", funding: "0.0000125", oi: "12000", volume24h: "900000000" },
  ]);
});

test("fear & greed history converts unix seconds", () => {
  expect(fngRows({ data: [{ value: "42", timestamp: "1760875200" }] })).toEqual([
    { ts: new Date(1760875200 * 1000), value: 42 },
  ]);
});

test("fetchMetaAndCtxs posts metaAndAssetCtxs to the HL info URL and refuses a non-2xx answer", async () => {
  const { fetchMetaAndCtxs, HL_INFO } = await import("./recorder");
  const seen: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init: RequestInit) => (seen.push({ url, body: JSON.parse(String(init.body)) }), Response.json(sample))) as unknown as typeof fetch;
  expect(await fetchMetaAndCtxs(ok)).toEqual(sample);
  expect(seen).toEqual([{ url: HL_INFO, body: { type: "metaAndAssetCtxs" } }]);
  const down = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  await expect(fetchMetaAndCtxs(down)).rejects.toThrow("Hyperliquid info 429");
});

test("missing optional fields become null; a context missing for an asset drops it", () => {
  const rows = snapshotRows([{ universe: [{ name: "ETH" }, { name: "GHOST" }] }, [{ markPx: "3000", dayNtlVlm: "1000000" }]], ts, 250_000);
  expect(rows).toEqual([{ coin: "ETH", ts, mark: "3000", oracle: null, funding: null, oi: null, volume24h: "1000000" }]);
});
