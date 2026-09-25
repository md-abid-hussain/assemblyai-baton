/**
 * Migration 0001_relays (TASKS-v2 WP14b acceptance 1): applies on a fresh Postgres and on top of a populated 0000
 * database (the Zerops path), a second run is a no-op, and `drizzle-kit generate` shows no diff. Real Postgres, $0.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { ALL_TABLES, EVERY_TABLE, RELAY_TABLES } from "@/server/db/schema";
import { runMigrations } from "../../../../scripts/migrate";
import { BASE_DB_URL, HAS_DB } from "../cases/helpers/test-db";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

describe("0001_relays.sql (static)", () => {
  const sql = readFileSync(join(ROOT, "drizzle", "0001_relays.sql"), "utf8");

  it("creates exactly the 0001 tables and only adds columns to cases", () => {
    for (const t of RELAY_TABLES) expect(sql).toContain(`CREATE TABLE "${t}"`);
    expect((sql.match(/CREATE TABLE/g) ?? []).length).toBe(RELAY_TABLES.length);
    expect(sql).not.toMatch(/DROP |ALTER COLUMN|RENAME /i);
    expect(sql.match(/ALTER TABLE "(\w+)" ADD COLUMN/g)).toEqual(['ALTER TABLE "cases" ADD COLUMN', 'ALTER TABLE "cases" ADD COLUMN']);
    expect(EVERY_TABLE.length).toBe(ALL_TABLES.length + RELAY_TABLES.length);
  });

  it("has the v2.1 columns and indexes (last_used_at, args_hash/result, moderation, sim_calls.kind, draft statuses)", () => {
    const table = (name: string) => sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
    expect(table("relays")).toMatch(/"last_used_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
    expect(table("relays")).toMatch(/CONSTRAINT "relays_slug_unique" UNIQUE\("slug"\)/);
    expect(table("relay_versions")).toMatch(/"moderation" jsonb,/);
    expect(table("connector_calls")).toMatch(/"args_hash" text,\s+"result" jsonb,/);
    expect(table("sim_calls")).toMatch(/"kind" text DEFAULT 'audio' NOT NULL/);
    expect(table("drafts")).toMatch(/"status" text NOT NULL/);
    expect(table("connector_secrets")).toMatch(/"ciphertext" "bytea" NOT NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "relay_versions_relay_version_uq" ON "relay_versions" USING btree \("relay_id","version"\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "relay_versions_relay_hash_uq" ON "relay_versions" USING btree \("relay_id","blueprint_hash"\)/);
    expect(sql).toMatch(/CREATE INDEX "relays_lru_idx" ON "relays" USING btree \("last_used_at"\) WHERE deleted_at IS NULL AND visibility <> 'gallery'/);
    expect(sql).toMatch(/CREATE INDEX "connector_calls_dedupe_idx" ON "connector_calls" USING btree \("takeover_id","tool_name","args_hash","created_at"\)/);
    expect(sql).toMatch(/CREATE INDEX "cases_relay_version_idx" ON "cases" USING btree \("relay_version_id","created_at"\)/);
  });

  it("drizzle-kit generate shows no diff against schema.ts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wp14b-drizzle-"));
    try {
      cpSync(join(ROOT, "drizzle"), tmp, { recursive: true });
      const before = readdirSync(tmp).sort();
      // drizzle-kit joins cwd + --out, so pass the temp dir relative to the repo root
      const out = execFileSync(
        process.execPath,
        [join(ROOT, "node_modules", "drizzle-kit", "bin.cjs"), "generate", "--dialect", "postgresql", "--schema", "./src/server/db/schema.ts", "--out", relative(ROOT, tmp)],
        { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "postgres://unused" } },
      );
      expect(out).toMatch(/No schema changes/);
      expect(readdirSync(tmp).sort()).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!HAS_DB)("0001_relays.sql (Postgres)", () => {
  const made: string[] = [];
  const saved = process.env.MIGRATIONS_DIR;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: BASE_DB_URL!, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function freshDb(tag: string): Promise<string> {
    const base = new URL(BASE_DB_URL!);
    const name = `${base.pathname.replace(/^\//, "") || "postgres"}_t_wp14b${tag}_${randomBytes(4).toString("hex")}`;
    await admin((c) => c.query(`create database "${name}"`));
    made.push(name);
    base.pathname = `/${name}`;
    return base.toString();
  }
  async function query<R extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<R[]> {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      return (await c.query<R>(text, values)).rows;
    } finally {
      await c.end();
    }
  }

  afterAll(async () => {
    if (saved === undefined) delete process.env.MIGRATIONS_DIR;
    else process.env.MIGRATIONS_DIR = saved;
    for (const n of made) await admin((c) => c.query(`drop database if exists "${n}" with (force)`)).catch(() => undefined);
  });

  it("applies on a fresh database; a second run is a no-op", async () => {
    const url = await freshDb("fresh");
    const first = await runMigrations(url);
    expect(first.applied).toBe(2);
    expect(first.tables).toBe(EVERY_TABLE.length);
    const again = await runMigrations(url);
    expect(again.applied).toBe(0);
    expect(again.tables).toBe(EVERY_TABLE.length);
    const cols = await query<{ table_name: string; column_name: string }>(
      url,
      "select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='cases' and column_name in ('relay_version_id','sim_call_id')) or (table_name='relays' and column_name='last_used_at') or (table_name='connector_calls' and column_name='args_hash') or (table_name='relay_versions' and column_name in ('moderation','preset')) or (table_name='sim_calls' and column_name='kind'))",
    );
    expect(cols.length).toBe(7);
  });

  it("applies on top of a populated 0000 database (the Zerops path): existing rows survive, new columns are null", async () => {
    const url = await freshDb("upgrade");
    const only0 = mkdtempSync(join(tmpdir(), "wp14b-mig0-"));
    try {
      cpSync(join(ROOT, "drizzle", "0000_init.sql"), join(only0, "0000_init.sql"));
      cpSync(join(ROOT, "drizzle", "meta"), join(only0, "meta"), { recursive: true });
      const journal = JSON.parse(readFileSync(join(only0, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag === "0000_init");
      writeFileSync(join(only0, "meta", "_journal.json"), JSON.stringify(journal));
      process.env.MIGRATIONS_DIR = only0;
      expect((await runMigrations(url)).applied).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = saved;
      rmSync(only0, { recursive: true, force: true });
    }
    await query(url, "insert into cases (id, mode, scenario_id, policy, state, visitor_id, ip_key) values ('c1','watch','s01','{}','{}','v','i')");
    const up = await runMigrations(url);
    expect(up.applied).toBe(1);
    expect(up.tables).toBe(EVERY_TABLE.length);
    const [row] = await query<{ id: string; relay_version_id: string | null; sim_call_id: string | null }>(url, "select id, relay_version_id, sim_call_id from cases");
    expect(row).toEqual({ id: "c1", relay_version_id: null, sim_call_id: null });
    expect((await runMigrations(url)).applied).toBe(0);
  });
});
