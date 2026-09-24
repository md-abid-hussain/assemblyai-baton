/**
 * migrate.ts → bundle/migrate.mjs (DESIGN §10.1). Runs on every container start (Zerops `initCommands`) and
 * locally via `npm run db:migrate`.
 *
 * - Session advisory lock 778899, so concurrent containers never race.
 * - drizzle's migrator applies `drizzle/*.sql` not yet recorded in `drizzle.__drizzle_migrations`: a no-op
 *   the second time.
 * - Seeds flag defaults with an idempotent upsert (ON CONFLICT DO NOTHING). Never seeds destructive data.
 * - Its own single connection WITHOUT the app's 5 s statement_timeout (DDL can take longer).
 * - Prints JSON lines; never prints DATABASE_URL.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { loadEnv } from "./lib/load-env";

export const MIGRATION_LOCK_KEY = 778899;

/** Flag rows the app expects to exist (WP2's FlagStore reads them; values are JSON). */
export const FLAG_DEFAULTS: { key: string; value: unknown }[] = [
  { key: "mode", value: "live" },
  { key: "notice", value: null },
  { key: "payments_mode_override", value: null },
  { key: "aai_balance_usd", value: null },
];

function say(msg: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", component: "migrate", msg, ...data }));
}

/** bundle/migrate.mjs → bundle/drizzle; scripts/migrate.ts → ../drizzle; MIGRATIONS_DIR overrides both. */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "drizzle"), join(here, "..", "drizzle"), join(process.cwd(), "drizzle")]) {
    if (existsSync(join(c, "meta", "_journal.json"))) return c;
  }
  throw new Error(`[migrate] no drizzle/meta/_journal.json found near ${here} or ${process.cwd()}`);
}

export async function runMigrations(connectionString: string): Promise<{ applied: number; tables: number }> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, application_name: "baton:migrate" });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const folder = migrationsFolder();
      const count = async () => {
        const r = await client
          .query<{ n: string }>("select count(*)::text as n from drizzle.__drizzle_migrations")
          .catch(() => ({ rows: [{ n: "0" }] }));
        return Number(r.rows[0]?.n ?? 0);
      };
      const before = await count();
      await migrate(drizzle(client), { migrationsFolder: folder });
      const after = await count();
      for (const f of FLAG_DEFAULTS) {
        await client.query(
          "insert into app_flags (key, value, reason) values ($1, $2::jsonb, 'seed') on conflict (key) do nothing",
          [f.key, JSON.stringify(f.value)],
        );
      }
      const t = await client.query<{ n: string }>(
        "select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
      );
      return { applied: after - before, tables: Number(t.rows[0]?.n ?? 0) };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(JSON.stringify({ level: "error", component: "migrate", msg: "DATABASE_URL is not set" }));
    process.exit(1);
  }
  const t0 = Date.now();
  const r = await runMigrations(url);
  say(r.applied > 0 ? "migrations applied" : "schema up to date (no-op)", { applied: r.applied, publicTables: r.tables, ms: Date.now() - t0 });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e: unknown) => {
    const err = e instanceof Error ? { name: e.name, message: e.message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://***") } : { message: String(e) };
    console.error(JSON.stringify({ level: "error", component: "migrate", msg: "migration failed", err }));
    process.exit(1);
  });
}
