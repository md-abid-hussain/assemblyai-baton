/**
 * A throwaway, migrated Postgres database per test file (DESIGN §9.1: $0, no network beyond the local DB).
 * DATABASE_URL comes from the shell or the worktree `.env` (parsed without touching process.env, never printed).
 * No URL, or SKIP_DB_TESTS=1 → HAS_DB=false and the DB suites skip. Not a test file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Db } from "../../../../src/server/db/client";
import * as schema from "../../../../src/server/db/schema";
import { parseDotEnv, repoRoot } from "../../../../scripts/lib/load-env";
import { runMigrations } from "../../../../scripts/migrate";

function baseUrl(): string | null {
  const fromShell = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (fromShell) return fromShell;
  const p = resolve(repoRoot(), ".env");
  if (!existsSync(p)) return null;
  return parseDotEnv(readFileSync(p, "utf8")).DATABASE_URL ?? null;
}

const BASE = baseUrl();
export const HAS_DB = !!BASE && process.env.SKIP_DB_TESTS !== "1";

export interface TestDb {
  db: Db;
  drop(): Promise<void>;
}

export async function createTestDb(tag: string): Promise<TestDb> {
  if (!BASE) throw new Error("no DATABASE_URL for DB tests");
  const base = new URL(BASE);
  const name = `${base.pathname.replace(/^\//, "") || "postgres"}_t_${tag}_${randomBytes(4).toString("hex")}`.toLowerCase();
  const admin = new pg.Client({ connectionString: BASE, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(BASE);
  u.pathname = `/${name}`;
  await runMigrations(u.toString());
  const pool = new pg.Pool({ connectionString: u.toString(), max: 5, statement_timeout: 5000 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    async drop() {
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: BASE, connectionTimeoutMillis: 5000 });
      await a.connect();
      try {
        await a.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
