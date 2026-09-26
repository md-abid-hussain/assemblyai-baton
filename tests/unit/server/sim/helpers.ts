/**
 * WP17 sim test helpers: synthetic 24 kHz clips, a fake ledger, a fake TTS upstream, a script/blueprint fixture, and
 * a throwaway Postgres database (real drizzle/*.sql plus the 0001 `sim_calls`/`tts_cache` DDL as a no-op-safe
 * fixture until WP14b's migration lands). $0: no network beyond the local DB.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { SpendLedger } from "@/core/contracts/services";
import type { SimScript } from "@/core/contracts/v2/api";
import type { Blueprint } from "@/core/contracts/v2/blueprint";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import type { TtsDeps } from "@/server/openai/tts";
import { parseDotEnv, repoRoot } from "../../../../scripts/lib/load-env";
import { runMigrations } from "../../../../scripts/migrate";

// ============================================================================================ audio

/** PCM16 LE mono 24 kHz: `leadMs` of silence, then a `ms` tone, then `tailMs` of silence. */
export function tone24k(ms: number, o: { freq?: number; amp?: number; leadMs?: number; tailMs?: number } = {}): Uint8Array {
  const rate = 24_000;
  const lead = Math.round(((o.leadMs ?? 0) * rate) / 1000);
  const n = Math.round((ms * rate) / 1000);
  const tail = Math.round(((o.tailMs ?? 0) * rate) / 1000);
  const out = new Uint8Array((lead + n + tail) * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setInt16((lead + i) * 2, Math.round((o.amp ?? 8000) * Math.sin((2 * Math.PI * (o.freq ?? 440) * i) / rate)), true);
  return out;
}

// ============================================================================================ ledger

export interface LedgerCall { op: "reserve" | "settle" | "release"; id: string; provider?: string; action?: string; estUsd?: number; usd?: number; env?: string; refId?: string }

export function fakeLedger(o: { refuse?: boolean } = {}): SpendLedger & { calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  let n = 0;
  return {
    calls,
    async reserve(e) {
      if (o.refuse) {
        calls.push({ op: "reserve", id: "", provider: e.provider, action: e.action, estUsd: e.estUsd, env: e.env, refId: e.refId });
        return { ok: false, code: "E_BUDGET" };
      }
      const id = `led_${++n}`;
      calls.push({ op: "reserve", id, provider: e.provider, action: e.action, estUsd: e.estUsd, env: e.env, refId: e.refId });
      return { ok: true, id };
    },
    async settle(id, usd) {
      calls.push({ op: "settle", id, usd });
    },
    async release(id) {
      calls.push({ op: "release", id });
    },
    async summary() {
      return { sinceEpochUsd: 0, todayUsd: {}, dailyCapUsd: 0, judgingBudgetUsd: 0, pctToday: 0, byEnv: {} };
    },
  };
}

/** A fake upstream: a tone of 55 ms per character (≈ 18 chars/s), 440 Hz rep-ish or 660 Hz customer-ish by voice. */
export function fakeSpeak(o: { log?: { input: string; voice: string; instructions: string; model: string }[]; msPerChar?: number } = {}): NonNullable<TtsDeps["speak"]> {
  return async (_client, r) => {
    o.log?.push({ input: r.input, voice: r.voice, instructions: r.instructions, model: r.model });
    return tone24k(Math.max(200, r.input.length * (o.msPerChar ?? 55)), { freq: r.voice === "cedar" ? 440 : 660, leadMs: 120, tailMs: 150 });
  };
}

// ============================================================================================ fixtures

export const REP_LINE = "Is it OK if my assistant finishes the booking? I'll stay on the line.";

export const blueprintFixture = {
  handoff: { repLine: REP_LINE },
  playbook: { persona: { tone: "Warm, upbeat and efficient." } },
  context: {
    samples: [
      {
        customer: { firstName: "Maya", lastName: "Ortiz", phoneLast4: "4417" },
        org: { name: "BrightSmile Dental", repFirstName: "Dana" },
        callDate: "2026-09-25", facts: {}, tables: {},
      },
    ],
  },
} as unknown as Pick<Blueprint, "handoff" | "playbook" | "context">;

export function scriptFixture(over: Partial<SimScript> = {}): SimScript {
  return {
    turns: [
      { speaker: "rep", text: "Thanks for calling BrightSmile Dental, this is Dana. How can I help?", tag: "greet" },
      { speaker: "customer", text: "Hi, I'd like to book a cleaning for next week.", tag: "other" },
      { speaker: "rep", text: "Sure. Can I have your full name?", tag: "ask" },
      { speaker: "customer", text: "Maya Ortiz.", tag: "answer" },
      { speaker: "rep", text: "Thanks, Maya. Which day works best?", tag: "ask" },
      { speaker: "customer", text: "Tuesday morning, please.", tag: "answer" },
      { speaker: "rep", text: "Tuesday at nine. Is that right?", tag: "readback" },
      { speaker: "customer", text: "Yes, that's right.", tag: "confirm" },
      { speaker: "rep", text: "OK if my assistant finishes the booking? I'll stay on.", tag: "handoff" },
      { speaker: "customer", text: "Sure, go ahead.", tag: "accept" },
      { speaker: "rep", text: "Great.", tag: "other" },
    ],
    left_for_ai: ["insurance_carrier"],
    ai_half_answers: [{ field: "insurance_carrier", spoken: "It's BrightSmile Plus." }],
    consent_phrase: "Yes, please text me the link.",
    closing_phrase: "No, that's everything, thanks.",
    ...over,
  };
}

// ============================================================================================ DB

function baseUrl(): string | null {
  const fromShell = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (fromShell) return fromShell;
  const p = resolve(repoRoot(), ".env");
  if (!existsSync(p)) return null;
  return parseDotEnv(readFileSync(p, "utf8")).DATABASE_URL ?? null;
}

export const BASE_DB_URL = baseUrl();
export const HAS_DB = !!BASE_DB_URL && process.env.SKIP_DB_TESTS !== "1";

/** Migration 0001's `sim_calls` and `tts_cache` (WP14b, PLATFORM §2.4), idempotent: a no-op once 0001 is merged. */
export const SIM_DDL = `
CREATE TABLE IF NOT EXISTS "sim_calls" (
  "id" text PRIMARY KEY NOT NULL, "kind" text DEFAULT 'audio' NOT NULL, "relay_version_id" text NOT NULL,
  "sample_index" integer NOT NULL, "script" jsonb NOT NULL, "rep" bytea, "customer" bytea, "peaks" jsonb,
  "duration_ms" integer NOT NULL, "handoff" jsonb NOT NULL, "ai_clips" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "usd" double precision NOT NULL, "gallery" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "last_used_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "tts_cache" (
  "hash" text PRIMARY KEY NOT NULL, "model" text NOT NULL, "voice" text NOT NULL, "text" text NOT NULL,
  "pcm24k" bytea NOT NULL, "duration_ms" integer NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL);`;

export interface TestDb { pool: pg.Pool; db: Db; drop(): Promise<void> }

export async function createSimTestDb(tag: string): Promise<TestDb> {
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
  const pool = new pg.Pool({ connectionString: u.toString(), max: 5, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  await pool.query(SIM_DDL);
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
