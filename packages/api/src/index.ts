import { accountRouter } from "./routers/account";
import { followRouter } from "./routers/follow";
import { hlRouter } from "./routers/hl";
import { ideaRouter } from "./routers/idea";
import { marketRouter } from "./routers/market";
import { recordsRouter } from "./routers/records";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),
  account: accountRouter,
  idea: ideaRouter,
  market: marketRouter,
  records: recordsRouter,
  follow: followRouter,
  hl: hlRouter,
});

export type AppRouter = typeof appRouter;
export { createContext } from "./context";
