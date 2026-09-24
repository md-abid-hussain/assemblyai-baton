import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes SQL migrations to drizzle/ (DESIGN §4.2: one initial migration, then additive only).
// Generation needs no database; `npm run db:migrate` applies them with scripts/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/baton" },
  strict: true,
  verbose: true,
});
