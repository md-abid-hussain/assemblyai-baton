import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { EnvError, env } from "../env";
import { log } from "../log";
import * as schema from "./schema";

/**
 * `getDb()`: one lazily created pg Pool per process (DESIGN §3.3):
 * `max: 15`, `connectionTimeoutMillis: 3000`, `idleTimeoutMillis: 30000`, and every connection runs with
 * `statement_timeout = 5000` (a startup parameter, so it applies before the first query).
 *
 * Never hold a pool connection across an LLM or network call (DESIGN §4.5 F1).
 */

export type Db = NodePgDatabase<typeof schema>;
export { schema };

export const POOL_OPTIONS = {
  max: 15,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5000,
} as const;

type Holder = { pool: pg.Pool | null; db: Db | null };
// Survive `next dev` hot reloads without leaking pools.
const g = globalThis as typeof globalThis & { __batonDb?: Holder };
const holder: Holder = (g.__batonDb ??= { pool: null, db: null });

const dbLog = log.child({ component: "db" });

export function getPool(): pg.Pool {
  if (holder.pool) return holder.pool;
  const url = env().DATABASE_URL;
  if (!url) throw new EnvError(["DATABASE_URL"], []);
  const pool = new pg.Pool({ connectionString: url, ...POOL_OPTIONS, application_name: `baton:${env().BATON_DEPLOY_ID}` });
  // An idle client error (DB restart) must not crash the process.
  pool.on("error", (err) => dbLog.warn("idle client error", { err }));
  holder.pool = pool;
  return pool;
}

export function getDb(): Db {
  if (holder.db) return holder.db;
  holder.db = drizzle(getPool(), { schema });
  return holder.db;
}

/** `select 1` with a hard timeout. Never throws; used by `/api/health`. */
export async function pingDb(timeoutMs = 2500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pool = getPool();
    const q = pool.query("select 1 as ok").then((r) => r.rows[0]?.ok === 1);
    const t = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([q, t]);
  } catch (err) {
    dbLog.warn("ping failed", { err });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Close the pool (scripts and tests). */
export async function closeDb(): Promise<void> {
  const pool = holder.pool;
  holder.pool = null;
  holder.db = null;
  if (pool) await pool.end();
}
