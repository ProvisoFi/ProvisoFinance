import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "../../supabase/migrations",
  migrations: { prefix: "supabase" },
  schemaFilter: ["public"],
  entities: { roles: { provider: "supabase" } },
});
