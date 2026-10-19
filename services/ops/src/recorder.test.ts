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
  expect(snapshotRows(sample, ts)).toEqual([
    { coin: "BTC", ts, mark: "100000", oracle: "99990", funding: "0.0000125", oi: "12000", volume24h: "900000000" },
  ]);
});

test("fear & greed history converts unix seconds", () => {
  expect(fngRows({ data: [{ value: "42", timestamp: "1760875200" }] })).toEqual([
    { ts: new Date(1760875200 * 1000), value: 42 },
  ]);
});
