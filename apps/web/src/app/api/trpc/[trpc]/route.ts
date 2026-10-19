import { appRouter, createContext } from "@proviso/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

// The site uses trailingSlash, so the client calls /api/trpc/<path>/; strip it for tRPC.
const handler = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/\/$/, "");
  return fetchRequestHandler({ endpoint: "/api/trpc", req: new Request(url, req), router: appRouter, createContext });
};

export { handler as GET, handler as POST };
