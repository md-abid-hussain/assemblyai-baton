/**
 * Real-Postgres test databases for WP3's unit tests (DESIGN §9.1: $0, no network beyond the local DB).
 *
 * Each test file gets its own throwaway database `<base>_t_<tag>_<rand>` on the server of DATABASE_URL (shell, else
 * the worktree `.env`, parsed WITHOUT touching process.env), migrated with the real drizzle/*.sql, and dropped after.
 * No URL (or SKIP_DB_TESTS=1) → `HAS_DB=false` and the DB suites skip, so a CI without Postgres stays green.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { parseDotEnv, repoRoot } from "../../../../../scripts/lib/load-env";
import { runMigrations } from "../../../../../scripts/migrate";

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
  url: string;
  pool: pg.Pool;
  db: Db;
  drop(): Promise<void>;
}

/** `poolMax` = 15 reproduces the production pool (DESIGN §3.3) for the pool-exhaustion acceptance. */
export async function createTestDb(tag: string, o: { poolMax?: number } = {}): Promise<TestDb> {
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
  const url = u.toString();
  await runMigrations(url);
  const pool = new pg.Pool({ connectionString: url, max: o.poolMax ?? 15, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    url,
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
