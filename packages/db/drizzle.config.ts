import { defineConfig } from "drizzle-kit";

// Generation only: drizzle-kit diffs src/schema.ts into a new SQL file under migrations/.
// Generated SQL is read and hand-extended (roles, grants, RLS) before commit — ADR-0010.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
