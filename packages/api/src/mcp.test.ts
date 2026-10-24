import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "@proviso/db";
import { as, setEnv, stubFetch, testDb } from "./api.testkit";
import { handleMcp, MCP_PROTOCOL_VERSIONS, TOOLS } from "./mcp";

let db: Db;
let restore: () => void;
const HOUR = 3_600_000;
beforeAll(async () => {
  const e = setEnv({ HL_NETWORK: "mainnet", HL_DEXES: "", NEXT_PUBLIC_SITE_URL: "https://provisofi.com" });
  const now = Date.now();
  const candles = Array.from({ length: 30 * 24 }, (_, i) => ({ t: now - (30 * 24 - i) * HOUR, c: "100000", v: "500", h: "100000", l: "100000" }));
  const f = stubFetch({
    hosts: {
      "api.hyperliquid.xyz": (_u, b) =>
        b.type === "candleSnapshot" ? candles
        : b.type === "fundingHistory" ? []
        : b.type === "perpDexs" ? [null]
        : b.type === "metaAndAssetCtxs" ? [{ universe: [{ name: "BTC", maxLeverage: 40, szDecimals: 5 }] }, [{ markPx: "100000", prevDayPx: "100000", funding: "0", dayNtlVlm: "2000000000", oraclePx: "100000", openInterest: "1" }]]
        : null,
    },
  });
  restore = () => (f(), e());
  db = await testDb();
});
afterAll(() => restore());

const call = async (body: unknown, method = "POST") => {
  const res = await handleMcp(new Request("https://provisofi.com/api/mcp", { method, body: method === "POST" ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }), async () => as(db, null));
  return { status: res.status, json: res.status === 200 ? ((await res.json()) as any) : null };
};
const tool = (name: string, args: unknown = {}) => call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const rule = {
  v: 1,
  entry: { when: { price: { coin: "BTC", op: ">", value: 120000 } }, then: [{ venue: "hl", action: "open", coin: "BTC", side: "long", lev: 2, size: { usd: 100 } }], legs: { atomic: false, onPartial: "unwind" } },
  exit: { stop: { pct: -3 }, take: { pct: 6 }, ref: "trigger_mark" },
  limits: { maxUsd: 100, maxLev: 2 },
  mode: "paper",
  expires: "7d",
};

test("initialize negotiates the protocol version and says what the server can't do", async () => {
  const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  expect(r.json.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "proviso" } });
  expect(r.json.result.instructions).toContain("never place trades");
  expect((await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  expect((await call({ jsonrpc: "2.0", id: 3, method: "ping" })).json.result).toEqual({});
  expect((await call(null, "GET")).status).toBe(405);
  expect((await call({ jsonrpc: "2.0", id: 4, method: "resources/list" })).json.error.code).toBe(-32601);
});

test("every tool is listed read-only with an object schema; the rule tools carry the full rule schema", async () => {
  const { tools } = (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result;
  expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  for (const t of tools) {
    expect(t.inputSchema.type).toBe("object");
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  }
  const dry = tools.find((t: { name: string }) => t.name === "dry_run");
  expect(JSON.stringify(dry.inputSchema)).toContain("trigger_mark");
  // Nothing an agent can reach writes: no seal, stamp, follow, account or key procedure.
  expect(TOOLS.map((t) => t.run.toString()).join("\n")).not.toMatch(/\.(idea|follow|account|hl|swapKey|notify|route)\./);
});

test("tools run the public API: markets, a Dry Run, a rule check", async () => {
  const m = await tool("list_markets", { query: "bt" });
  expect(m.json.result.structuredContent.markets.map((x: { coin: string }) => x.coin)).toEqual(["BTC"]);
  const d = await tool("dry_run", { spec: rule });
  expect(d.json.result.isError).toBeUndefined();
  expect(d.json.result.structuredContent.result).toMatchObject({ fires: 0, fillModel: expect.stringContaining("paper-v1") });
  const c = await tool("check_rule", { spec: rule });
  expect(c.json.result.structuredContent.findings.map((f: { title: string }) => f.title)).toContain("Never fired in 90 days");
  expect(JSON.parse(c.json.result.content[0].text)).toEqual(c.json.result.structuredContent);
});

test("prepare_seal hands back a link carrying the exact rule in its fragment; bad rules and unknown tools fail cleanly", async () => {
  const r = (await tool("prepare_seal", { spec: rule, mode: "live" })).json.result.structuredContent;
  expect(r.mode).toBe("live");
  expect(r.url).toStartWith("https://provisofi.com/dashboard/compose/#rule=");
  const sent = JSON.parse(Buffer.from(r.url.split("#rule=")[1], "base64url").toString());
  expect(sent).toMatchObject({ ...rule, mode: "live", fire: "once" });
  expect(r.rule).toContain("BTC");
  const bad = (await tool("prepare_seal", { spec: { ...rule, exit: { stop: { pct: 3 } } } })).json.result;
  expect(bad).toMatchObject({ isError: true });
  expect(bad.content[0].text).toContain("Not a valid rule");
  expect((await tool("seal_it_for_me", {})).json.error.code).toBe(-32602);
  expect((await call("{not json")).json.error.code).toBe(-32600);
});
