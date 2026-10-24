// Proviso for AI agents (expansion section 6 #4): an MCP server (Streamable HTTP, stateless, JSON
// responses) at /api/mcp. Any AI assistant can read markets and records, draft a rule, Dry Run it
// and check it. It can never seal, trade, sign or hold a key: the last step, prepare_seal, returns a
// link where the person reads the rule back and seals it with their own wallet. "The AI proposes,
// the seal constrains." Every tool runs the same public, rate-limited API procedures as the site.
// ponytail: hand-rolled JSON-RPC (no SDK dependency); add SSE / sessions only if a client needs them.
import { render, Spec } from "@proviso/dsl";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createContext } from "./context";
import { appRouter } from "./index";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://provisofi.com").replace(/\/$/, "");

const INSTRUCTIONS = `Proviso lets people seal a trading rule on Robinhood Chain before it can fire; Proviso's enclave then runs it on Hyperliquid, and every result is stamped and provable.
These tools never place trades, move money or sign anything. Typical flow: market_stats or list_markets -> draft_rule (plain English to a rule) -> dry_run (90 days of real history) and check_rule (math, replay and wording problems) -> prepare_seal, which returns a link the person opens to read the rule back and seal it with their own wallet.
Never present results as financial advice or a prediction. Past results don't predict future ones.`;

type Caller = ReturnType<typeof appRouter.createCaller>;
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (c: Caller, args: Record<string, unknown>) => Promise<unknown>;
};

const specSchema = z.toJSONSchema(Spec, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const coin = { type: "string", description: 'Hyperliquid market, e.g. "BTC", "HYPE", "xyz:GOLD", "xyz:NVDA", "xyz:CL" (oil), "xyz:SP500"' };
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const specArg = { spec: { ...specSchema, description: "A Proviso rule (rule language v1), e.g. the spec draft_rule returned" } };

export const TOOLS: Tool[] = [
  {
    name: "list_markets",
    title: "List markets",
    description: "Hyperliquid perps Proviso can trade (crypto, and stocks, metals, oil and indices on the xyz dex): mark price, 24h volume and max leverage. Optional text filter.",
    inputSchema: obj({ query: { type: "string", description: 'Filter by name, e.g. "xyz:" or "GOLD"' } }),
    run: async (c, a) => {
      const { network, perps } = await c.market.perps();
      const q = typeof a.query === "string" ? a.query.toLowerCase() : "";
      return { network, markets: perps.filter((p) => p.coin.toLowerCase().includes(q)).slice(0, 60) };
    },
  },
  {
    name: "market_stats",
    title: "Market stats",
    description: "One market's last price, 24h change and 7-day high and low, from Hyperliquid's hourly history.",
    inputSchema: obj({ coin }, ["coin"]),
    run: (c, a) => c.dryRun.market({ coin: String(a.coin) }),
  },
  {
    name: "draft_rule",
    title: "Draft a rule",
    description: "Turns a trading idea in plain English into a Proviso rule, with a plain-English read-back and anything ambiguous or unsupported. Drafted as paper (simulated); prepare_seal can change the mode.",
    inputSchema: obj({ text: { type: "string", minLength: 3, maxLength: 2000 } }, ["text"]),
    run: (c, a) => c.dryRun.draft({ text: String(a.text) }),
  },
  {
    name: "dry_run",
    title: "Dry Run a rule",
    description: "Replays a rule over the last 90 days of Hyperliquid hourly history (paper, fees and funding included, re-armed a day after each fire): return, worst drawdown, fires, win rate. Up to 5x leverage (pre-IPO 2x).",
    inputSchema: obj(specArg, ["spec"]),
    run: (c, a) => c.dryRun.try({ spec: a.spec as never }),
  },
  {
    name: "check_rule",
    title: "Check a rule before sealing",
    description: "Finds problems with the rule itself: liquidation before the stop, targets eaten by fees, size against volume, never fires or already true, contradictory wording. Never says whether to trade.",
    inputSchema: obj(specArg, ["spec"]),
    run: (c, a) => c.dryRun.check({ spec: a.spec as never }),
  },
  {
    name: "would_fire_now",
    title: "Would it fire now?",
    description: "Whether the rule's conditions hold on live prices right now (would_fire, waiting or unknown).",
    inputSchema: obj(specArg, ["spec"]),
    run: (c, a) => c.dryRun.now({ spec: a.spec as never }),
  },
  {
    name: "prepare_seal",
    title: "Hand the rule over for sealing",
    description:
      "Validates the rule and returns a link the person opens to read it back, run the checks and seal it on Robinhood Chain with their own wallet. Nothing is sealed or traded until they do. The rule travels in the link's # fragment, so it never reaches a server.",
    inputSchema: obj({ ...specArg, mode: { type: "string", enum: ["paper", "alert", "live"], description: "paper simulates, alert only notifies, live trades real money" } }, ["spec"]),
    run: async (_c, a) => {
      const parsed = Spec.safeParse(a.mode ? { ...(a.spec as object), mode: a.mode } : a.spec);
      if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: `Not a valid rule: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      const fragment = Buffer.from(JSON.stringify(parsed.data)).toString("base64url");
      return {
        url: `${SITE()}/dashboard/compose/#rule=${fragment}`,
        rule: render(parsed.data),
        mode: parsed.data.mode,
        next: "Open the link, read the rule back and seal it with your wallet. Proviso can't seal or trade it for you.",
      };
    },
  },
  {
    name: "get_call",
    title: "A sealed call",
    description: "A sealed call's public facts: owner, state, seal and reveal transactions, fires, stamped P&L, what followers made, and its page (which verifies itself in the browser).",
    inputSchema: obj({ id: { type: "string", pattern: "^\\d{1,30}$" } }, ["id"]),
    run: async (c, a) => ({ ...(await c.records.byId({ id: String(a.id) })), page: `${SITE()}/call/${a.id}/` }),
  },
  {
    name: "get_caller",
    title: "A caller's record",
    description: "A caller's sealed record: standing (ladder, return, drawdown, score), what followers made, and their latest 20 calls.",
    inputSchema: obj({ address }, ["address"]),
    run: async (c, a) => {
      const r = await c.records.get({ caller: String(a.address) });
      return { ...r, ideas: r.ideas.slice(0, 20).map((i) => ({ id: i.id, mode: i.mode, state: i.state, stampedAt: i.stampedAt, fires: i.fires.length, pnlUsd: i.pnlUsd })), page: `${SITE()}/c/${r.caller}/` };
    },
  },
  {
    name: "leaderboard",
    title: "Leaderboard",
    description: "Top 20 callers by risk-adjusted score (return over drawdown) and top 20 by what their followers made.",
    inputSchema: obj({}),
    run: async (c) => {
      const b = await c.records.leaderboard();
      return { ladder: b.ladder, byScore: b.callers.slice(0, 20), byFollowers: b.byFollowers.slice(0, 20) };
    },
  },
  {
    name: "arena_season",
    title: "Proviso Arena",
    description: "This week's Proviso Arena: AI models and people racing sealed paper calls on real order books.",
    inputSchema: obj({ season: { type: "string", description: 'e.g. "2026-W44"; default this week' } }),
    run: (c, a) => c.arena.season(a.season ? { season: String(a.season) } : undefined),
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const rpc = (id: Rpc["id"], body: { result: unknown } | { error: { code: number; message: string } }) => Response.json({ jsonrpc: "2.0", id: id ?? null, ...body });

/** A caller with no sign-in and only the client's IP (for the public rate limits): MCP clients never act as a user. */
async function anonCaller(req: Request): Promise<Caller> {
  const headers = new Headers();
  for (const h of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) if (req.headers.get(h)) headers.set(h, req.headers.get(h)!);
  return appRouter.createCaller(await createContext({ req: new Request("https://provisofi.com/", { headers }) }));
}

/** Handles one MCP HTTP request. POST carries one JSON-RPC message; GET (server-sent stream) isn't offered. */
export async function handleMcp(req: Request, callerFor: (req: Request) => Promise<Caller> = anonCaller): Promise<Response> {
  if (req.method !== "POST") return new Response("Proviso MCP: POST JSON-RPC here.", { status: 405, headers: { allow: "POST" } });
  let m: Rpc;
  try {
    m = (await req.json()) as Rpc;
  } catch {
    return rpc(null, { error: { code: -32700, message: "Parse error" } });
  }
  if (Array.isArray(m) || typeof m !== "object" || m === null || typeof m.method !== "string")
    return rpc(null, { error: { code: -32600, message: "Send one JSON-RPC request per POST" } });
  if (m.id === undefined) return new Response(null, { status: 202 }); // a notification (e.g. notifications/initialized)
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return rpc(m.id, {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "proviso", title: "Proviso", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      });
    }
    case "ping":
      return rpc(m.id, { result: {} });
    case "tools/list":
      return rpc(m.id, {
        result: {
          tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
            name,
            title,
            description,
            inputSchema,
            // Nothing here writes: no seal, trade or account change (prepare_seal only builds a link).
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
          })),
        },
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return rpc(m.id, { error: { code: -32602, message: `Unknown tool: ${String(m.params?.name)}` } });
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await tool.run(await callerFor(req), args);
        const structured = out !== null && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out };
        return rpc(m.id, { result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: structured } });
      } catch (e) {
        const msg = e instanceof TRPCError || e instanceof Error ? e.message : "The tool failed.";
        return rpc(m.id, { result: { content: [{ type: "text", text: msg }], isError: true } });
      }
    }
    default:
      return rpc(m.id, { error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}
