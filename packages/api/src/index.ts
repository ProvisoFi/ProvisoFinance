import { accountRouter } from "./routers/account";
import { ideaRouter } from "./routers/idea";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),
  account: accountRouter,
  idea: ideaRouter,
});

export type AppRouter = typeof appRouter;
export { createContext } from "./context";
