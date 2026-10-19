import { accountRouter } from "./routers/account";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),
  account: accountRouter,
});

export type AppRouter = typeof appRouter;
export { createContext } from "./context";
