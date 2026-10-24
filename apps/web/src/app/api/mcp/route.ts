// Proviso's MCP server for AI assistants (expansion section 6 #4). Public and stateless; no cookies or
// sign-in are read, so any origin may call it.
import { handleMcp } from "@proviso/api/mcp";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};
const withCors = async (res: Promise<Response>) => {
  const r = await res;
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
};

export const POST = (req: Request) => withCors(handleMcp(req));
export const GET = (req: Request) => withCors(handleMcp(req));
export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });

// draft_rule runs the rule writer (20–60 s).
export const maxDuration = 120;
