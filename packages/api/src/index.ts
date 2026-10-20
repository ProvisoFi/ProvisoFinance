import { accountRouter } from "./routers/account";
import { followRouter } from "./routers/follow";
import { hlRouter } from "./routers/hl";
import { ideaRouter } from "./routers/idea";
import { marketRouter } from "./routers/market";
import { notifyRouter } from "./routers/notify";
import { recordsRouter } from "./routers/records";
import { routeRouter } from "./routers/route";
import { swapKeyRouter } from "./routers/swapkey";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),
  account: accountRouter,
  idea: ideaRouter,
  market: marketRouter,
  records: recordsRouter,
  follow: followRouter,
  hl: hlRouter,
  notify: notifyRouter,
  route: routeRouter,
  swapKey: swapKeyRouter,
});

export type AppRouter = typeof appRouter;
export { createContext } from "./context";
