/**
 * Real-Postgres throwaway databases for WP6's DB tests ($0; the local docker Postgres only). Each file gets its own
 * `<base>_t_<tag>_<rand>` database on the server of DATABASE_URL, migrated with the real drizzle/*.sql, and dropped
 * afterwards. DATABASE_URL comes from the shell or the repo `.env` (parsed WITHOUT touching process.env). No URL →
 * HAS_DB=false and the DB suites skip.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { parseDotEnv, repoRoot } from "../../../../scripts/lib/load-env";
import { runMigrations } from "../../../../scripts/migrate";

function baseUrl(): string | null {
  const fromShell = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (fromShell) return fromShell;
  const p = resolve(repoRoot(), ".env");
  if (!existsSync(p)) return null;
  return parseDotEnv(readFileSync(p, "utf8")).DATABASE_URL ?? null;
}

export const BASE_DB_URL = baseUrl();
export const HAS_DB = !!BASE_DB_URL && process.env.SKIP_DB_TESTS !== "1";

export interface TestDb {
  pool: pg.Pool;
  db: Db;
  drop(): Promise<void>;
}

export async function createTestDb(tag: string): Promise<TestDb> {
  if (!BASE_DB_URL) throw new Error("no DATABASE_URL for DB tests");
  const base = new URL(BASE_DB_URL);
  const name = `${base.pathname.replace(/^\//, "") || "postgres"}_t_${tag.replace(/[^a-z0-9]/gi, "").toLowerCase()}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: BASE_DB_URL, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(BASE_DB_URL);
  u.pathname = `/${name}`;
  await runMigrations(u.toString());
  const pool = new pg.Pool({ connectionString: u.toString(), max: 10, statement_timeout: 5000 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    pool,
    db,
    async drop() {
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: BASE_DB_URL!, connectionTimeoutMillis: 5000 });
      await a.connect();
      try {
        await a.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}

/** Insert a case row and a takeover row (the FKs payments/tool_calls need). */
export async function seedCaseAndTakeover(db: Db, ids: { caseId: string; takeoverId: string }, policy: unknown, state: unknown): Promise<void> {
  await db.insert(schema.cases).values({
    id: ids.caseId, mode: "watch", callId: "s01_take1", scenarioId: "s01", policy: policy as Record<string, unknown>,
    state: state as Record<string, unknown>, status: "ai_active", visitorId: "v1", ipKey: "ip1", tArmMs: 60_000,
  });
  await db.insert(schema.takeovers).values({
    id: ids.takeoverId, caseId: ids.caseId, armedAt: new Date(Date.UTC(2026, 8, 25, 12, 0, 0)), tArmMs: 60_000, stage: "disclose",
    metrics: { hud: { click_to_first_audible: 900 } },
  });
}
