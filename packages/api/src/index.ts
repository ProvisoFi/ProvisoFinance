import { accountRouter } from "./routers/account";
import { arenaRouter } from "./routers/arena";
import { followRouter } from "./routers/follow";
import { hlRouter } from "./routers/hl";
import { ideaRouter } from "./routers/idea";
import { marketRouter } from "./routers/market";
import { notifyRouter } from "./routers/notify";
import { recordsRouter } from "./routers/records";
import { routeRouter } from "./routers/route";
import { swapKeyRouter } from "./routers/swapkey";
import { publicProcedure, router } from "./trpc";

/** The full tRPC API served by the web app; each key is a sub-router. */
export const appRouter = router({
  /** Liveness check; public, always `{ ok: true }`. */
  health: publicProcedure.query(() => ({ ok: true })),
  /** Account row and per-account trading limits. */
  account: accountRouter,
  /** Draft, test, stamp, seal and stop ideas. */
  idea: ideaRouter,
  /** Hyperliquid market lists and rule-validation context. */
  market: marketRouter,
  /** Public track records and stamp proofs. */
  records: recordsRouter,
  /** Copy-follows of other callers' ideas. */
  follow: followRouter,
  /** Hyperliquid agent-key setup and approvals. */
  hl: hlRouter,
  /** Push and Telegram notification settings. */
  notify: notifyRouter,
  /** Funding routes between Robinhood Chain and Hyperliquid via Relay. */
  route: routeRouter,
  /** Robinhood Chain swap session-key setup and revoke. */
  swapKey: swapKeyRouter,
  /** Proviso Arena: weekly seasons of sealed paper calls, AI models and humans. */
  arena: arenaRouter,
});

export type AppRouter = typeof appRouter;
export { createContext } from "./context";
export { LADDER, type Standing } from "./standing";
export { enclaveKeyFrom, seedAiEntrants } from "./arena";
