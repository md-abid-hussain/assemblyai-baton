/**
 * WP19·2 acceptance 1 and C3b-VERIFY item (d): `0002_saas` / `0003_audit_guard` against a real Postgres.
 *
 * - they apply on a **fresh** database and on a **populated `0001`** database (the Zerops path: a running container
 *   upgrades in place at start, so existing rows must survive and the new columns arrive null);
 * - a second run is a no-op;
 * - `drizzle-kit generate` is **diff-free** — the committed SQL really is what the schema files describe, which is
 *   the property that stops the journal forking (TASKS-v3 §2 rule 14);
 * - the `0003` trigger makes `audit_log` append-only, and the purge escape hatch works.
 *
 * $0: local Postgres only.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { EVERY_TABLE_V3, SAAS_TABLE_NAMES } from "@/server/db/schema";
import { runMigrations } from "../../../../scripts/migrate";
import { BASE_DB_URL, HAS_DB } from "../cases/helpers/test-db";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const made: string[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: BASE_DB_URL!, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

async function freshDb(tag: string): Promise<string> {
  const base = new URL(BASE_DB_URL!);
  const name = `${base.pathname.replace(/^\//, "")}_m_${tag}_${randomBytes(3).toString("hex")}`;
  await admin((c) => c.query(`create database "${name}"`));
  made.push(name);
  const u = new URL(BASE_DB_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!HAS_DB)("0002_saas / 0003_audit_guard", () => {
  const savedDir = process.env.MIGRATIONS_DIR;

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.MIGRATIONS_DIR;
    else process.env.MIGRATIONS_DIR = savedDir;
    for (const n of made) {
      await admin((c) => c.query(`drop database if exists "${n}" with (force)`)).catch(() => undefined);
    }
  });

  it("applies on a fresh database, brings every §2.7 table, and a second run is a no-op", async () => {
    const url = await freshDb("fresh");
    const first = await runMigrations(url);
    expect(first.applied).toBe(4);
    expect(first.tables).toBe(EVERY_TABLE_V3.length);

    const present = (await query<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema='public'",
    )).map((r) => r.table_name);
    for (const t of SAAS_TABLE_NAMES) expect(present).toContain(t);

    // The §2.7 name move: Better Auth's own verification table must not have taken v2's `verifications`.
    expect(present).toContain("auth_verifications");
    expect(present).toContain("verifications");

    const again = await runMigrations(url);
    expect(again.applied).toBe(0);
    expect(again.tables).toBe(EVERY_TABLE_V3.length);
  });

  it("applies on top of a populated 0001 database: rows survive and the org columns arrive null", async () => {
    const url = await freshDb("upgrade");
    const only01 = mkdtempSync(join(tmpdir(), "wp19-mig01-"));
    try {
      cpSync(join(ROOT, "drizzle", "0000_init.sql"), join(only01, "0000_init.sql"));
      cpSync(join(ROOT, "drizzle", "0001_relays.sql"), join(only01, "0001_relays.sql"));
      cpSync(join(ROOT, "drizzle", "meta"), join(only01, "meta"), { recursive: true });
      const journalPath = join(only01, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag === "0000_init" || e.tag === "0001_relays");
      writeFileSync(journalPath, JSON.stringify(journal));
      process.env.MIGRATIONS_DIR = only01;
      expect((await runMigrations(url)).applied).toBe(2);
    } finally {
      if (savedDir === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = savedDir;
      rmSync(only01, { recursive: true, force: true });
    }

    // A run recorded before the SaaS layer existed.
    await query(
      url,
      "insert into cases (id, mode, scenario_id, policy, state, visitor_id, ip_key) " +
        "values ('c_pre','watch','s01','{}','{}','v_pre','ip_pre')",
    );

    const up = await runMigrations(url);
    expect(up.applied).toBe(2); // 0002 + 0003
    expect(up.tables).toBe(EVERY_TABLE_V3.length);

    const [row] = await query<{ id: string; org_id: string | null; created_by_user_id: string | null }>(
      url,
      "select id, org_id, created_by_user_id from cases where id = 'c_pre'",
    );
    expect(row).toEqual({ id: "c_pre", org_id: null, created_by_user_id: null });
    expect((await runMigrations(url)).applied).toBe(0);
  });

  it("0003 makes audit_log append-only, and only the purge may delete", async () => {
    const url = await freshDb("guard");
    await runMigrations(url);
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      await c.query(
        "insert into audit_log (id, org_id, actor_type, actor_label, action) values ('aud_1', null, 'system', 'test', 'org.created')",
      );
      await expect(c.query("update audit_log set action = 'org.deleted' where id = 'aud_1'")).rejects.toThrow(
        /append-only/,
      );
      await expect(c.query("delete from audit_log where id = 'aud_1'")).rejects.toThrow(/append-only/);

      // The retention purge sets the flag for its own transaction only.
      await c.query("begin");
      await c.query("set local changeover.audit_purge = 'on'");
      await c.query("delete from audit_log where id = 'aud_1'");
      await c.query("commit");
      expect(await query(url, "select id from audit_log where id = 'aud_1'")).toHaveLength(0);

      // …and the flag really was local: deleting again outside a purge transaction is refused.
      await c.query(
        "insert into audit_log (id, org_id, actor_type, actor_label, action) values ('aud_2', null, 'system', 'test', 'org.created')",
      );
      await expect(c.query("delete from audit_log where id = 'aud_2'")).rejects.toThrow(/append-only/);
    } finally {
      await c.end();
    }
  });

  /**
   * C3b review finding 2. A row-level trigger never fires for TRUNCATE, so the guard above — on its own — let
   * one statement erase the whole log, and 0003 deliberately does no `REVOKE`, so the app's own role could
   * issue it. The statement-level trigger has no purge escape hatch: the §3.5 purge deletes by age, so nothing
   * legitimate truncates this table.
   */
  it("0003 refuses TRUNCATE too, purge transaction or not", async () => {
    const url = await freshDb("trunc");
    await runMigrations(url);
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      await c.query(
        "insert into audit_log (id, org_id, actor_type, actor_label, action) values ('aud_t', null, 'system', 'test', 'org.created')",
      );
      await expect(c.query("truncate audit_log")).rejects.toThrow(/append-only/);

      // Not even inside the transaction the retention purge runs in.
      await c.query("begin");
      await c.query("set local changeover.audit_purge = 'on'");
      await expect(c.query("truncate audit_log")).rejects.toThrow(/append-only/);
      await c.query("rollback");

      // The row is still there after both attempts.
      expect(await query(url, "select id from audit_log where id = 'aud_t'")).toHaveLength(1);
    } finally {
      await c.end();
    }
  });

  it("drizzle-kit generate is diff-free: the committed SQL matches the schema files (VERIFY d)", () => {
    // Generate into a throwaway folder seeded with the real journal. A clean run writes no new .sql file.
    const out = mkdtempSync(join(tmpdir(), "wp19-gen-"));
    try {
      cpSync(join(ROOT, "drizzle"), out, { recursive: true });
      const before = readdirSync(out).filter((f) => f.endsWith(".sql"));
      // `process.execPath` + the package's own bin, like `tests/unit/server/relays/migration.test.ts`:
      // spawning `npx.cmd` directly is EINVAL on Windows.
      const stdout = execFileSync(
        process.execPath,
        [
          join(ROOT, "node_modules", "drizzle-kit", "bin.cjs"),
          "generate",
          "--dialect",
          "postgresql",
          "--schema",
          "./src/server/db/schema.ts",
          "--out",
          relative(ROOT, out),
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 100_000, env: { ...process.env, DATABASE_URL: "postgres://unused" } },
      );
      const after = readdirSync(out).filter((f) => f.endsWith(".sql"));
      expect(
        after,
        `drizzle-kit generated a new migration — the schema files and the committed SQL have drifted:\n${stdout}`,
      ).toEqual(before);
      expect(stdout).toMatch(/No schema changes|no changes/i);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
