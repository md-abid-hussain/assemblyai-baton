/**
 * WP8 test helpers: a throwaway Postgres database per test file (migrated with the real drizzle/*.sql, dropped after),
 * row seeds, and fakes for the AssemblyAI ports, the ledger and the job runner. $0: no network beyond the local DB.
 *
 * DATABASE_URL comes from the shell or the worktree `.env` (parsed without touching process.env). No URL →
 * `HAS_DB=false` and the DB suites skip.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { SignJWT } from "jose";

import type { CaseState, FieldId, FieldState, PolicyRecord } from "@/core/contracts/case";
import { FIELD_IDS } from "@/core/intents/add-driver.fields";
import type { QaResult } from "@/core/contracts/events";
import type { ComputeQa, Wp8QaInput } from "@/core/contracts/ext/wp8-verify";
import type { JobKind, JobRunner, SpendLedger } from "@/core/contracts/services";
import type { Transcript, TranscriptParams } from "@/server/aai/async";
import type { SessionRecord, SessionsPage, VaRestPort } from "@/server/aai/va-rest";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { cases, jobs, takeovers } from "@/server/db/schema";
import { MemoryRateLimiter, type AsyncPort, type Wp8Ports } from "@/server/qa/deps";
import { tokenAuthorizer } from "@/server/qa/auth";
import { parseDotEnv, repoRoot } from "../../../../scripts/lib/load-env";
import { runMigrations } from "../../../../scripts/migrate";

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

export interface TestDb { db: Db; pool: pg.Pool; drop(): Promise<void> }

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
  const url = u.toString();
  const origLog = console.log;
  console.log = () => undefined; // migrate prints JSON lines
  try {
    await runMigrations(url);
  } finally {
    console.log = origLog;
  }
  const pool = new pg.Pool({ connectionString: url, max: 10, statement_timeout: 5000 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    pool,
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

// ============================================================================================ seeds

export const POLICY: PolicyRecord = {
  policyNumber: "HV-100-200",
  carrier: "Harborview Mutual",
  agencyName: "Harborview Insurance Agency",
  repFirstName: "Daniel",
  policyholder: { firstName: "Mark", lastName: "Delgado" },
  phoneOnFileLast4: "4419",
  address: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
  existingDrivers: [{ name: "Mark Delgado", relation: "self" }],
  vehicles: [{ id: "veh1", year: 2014, make: "Toyota", model: "Corolla", label: "2014 Toyota Corolla" }],
  currentMonthlyPremiumUsd: 142,
  callDate: "2026-09-25",
} as PolicyRecord;

export function field(f: FieldId, status: FieldState["status"], value: string | null, display: string | null = value): FieldState {
  const reason: FieldState["reason"] = status === "VERIFIED" ? "acknowledged" : status === "PENDING" ? "stated_once" : "absent";
  return { field: f, status, reason, value, display, source: value ? "customer" : null, evidence: [], conflict: null, flags: [], updatedAtMs: 0 };
}

export function snapshot(over: Partial<Record<FieldId, FieldState>> = {}): CaseState {
  const fields = Object.fromEntries(FIELD_IDS.map((f) => [f, over[f] ?? field(f, "MISSING", null)])) as CaseState["fields"];
  return {
    caseId: "c1",
    intent: "add_driver",
    version: 1,
    callClockMs: 0,
    fields,
    readiness: { verified: 0, pending: 0, missing: FIELD_IDS.length, requiredTotal: FIELD_IDS.length, ready: false },
    conflicts: [],
    stage: "confirm",
    disclosuresGiven: [],
    payment: null,
    confirmationNumber: null,
  };
}

export async function seedTakeover(
  db: Db,
  o: { caseId?: string; takeoverId?: string; vaSessionId?: string | null; mode?: "watch" | "live" | "spot" | "synthetic"; armedAt?: Date; endedAt?: Date | null; metrics?: Record<string, unknown>; outcome?: "completed" | "handed_back" | null; snap?: CaseState; greeting?: string } = {},
): Promise<{ caseId: string; takeoverId: string }> {
  const caseId = o.caseId ?? `case_${randomBytes(4).toString("hex")}`;
  const takeoverId = o.takeoverId ?? `tko_${randomBytes(4).toString("hex")}`;
  const snap = o.snap ?? snapshot();
  await db.insert(cases).values({ id: caseId, mode: o.mode ?? "watch", scenarioId: "s02", policy: POLICY as never, state: snap as never, visitorId: "v1", ipKey: "ip1", status: "completed" }).onConflictDoNothing();
  await db.insert(takeovers).values({
    id: takeoverId,
    caseId,
    tArmMs: 61000.5,
    snapshot: snap as never,
    greeting: o.greeting ?? "Hi Mark, this is the AI assistant.",
    vaSessionId: o.vaSessionId === undefined ? "sess_test_1" : o.vaSessionId,
    outcome: o.outcome === undefined ? "completed" : o.outcome,
    metrics: (o.metrics ?? {}) as never,
    ...(o.armedAt ? { armedAt: o.armedAt } : {}),
    ...(o.endedAt !== undefined ? { endedAt: o.endedAt } : { endedAt: new Date() }),
  });
  return { caseId, takeoverId };
}

// ============================================================================================ fakes

export class FakeVaRest implements VaRestPort {
  sessions = new Map<string, SessionRecord>();
  pages: SessionsPage[] | null = null;
  calls: string[] = [];
  deleted: string[] = [];
  getError: Error | null = null;
  async getSession(id: string): Promise<SessionRecord> {
    this.calls.push(`get:${id}`);
    if (this.getError) throw this.getError;
    const s = this.sessions.get(id);
    if (!s) {
      const { VaRestError } = await import("@/server/aai/va-rest");
      throw new VaRestError("get-session", 404, { error: "not found" });
    }
    return s;
  }
  async listSessions(q: { limit?: number; cursor?: string | null } = {}): Promise<SessionsPage> {
    this.calls.push(`list:${q.cursor ?? ""}`);
    if (this.pages) {
      const i = q.cursor ? Number(q.cursor.replace("c", "")) : 0;
      return this.pages[i] ?? { sessions: [], hasMore: false, nextCursor: null };
    }
    return { sessions: [...this.sessions.values()].map(({ config: _c, artifacts: _a, ...rest }) => rest as SessionRecord), hasMore: false, nextCursor: null };
  }
  async deleteSession(id: string): Promise<number> {
    this.deleted.push(id);
    return this.sessions.delete(id) ? 204 : 404;
  }
  async createAgent(): Promise<never> {
    throw new Error("not used");
  }
  async deleteAgent(): Promise<number> {
    return 204;
  }
}

export function endedSession(id: string, o: { audio?: boolean; duration?: number; prompt?: string; status?: string; createdAt?: string; endedAt?: string | null } = {}): SessionRecord {
  return {
    id,
    status: o.status ?? "completed",
    duration_seconds: o.duration ?? 62.5,
    created_at: o.createdAt ?? new Date(Date.now() - 5 * 60_000).toISOString(),
    ended_at: o.endedAt === undefined ? new Date().toISOString() : o.endedAt,
    config: { system_prompt: o.prompt ?? "You are a test.\n(internal ref: baton-deploy=zp-prod; never mention this)" },
    artifacts: o.audio === false ? [] : [
      { type: "audio", url: `https://s3.example.test/${id}/audio.ogg?Signature=x&Expires=1`, content_type: "audio/ogg" },
      { type: "timeline", url: `https://s3.example.test/${id}/timeline.json?Signature=x`, content_type: "application/json" },
    ],
  };
}

export class FakeAsync implements AsyncPort {
  submitted: TranscriptParams[] = [];
  transcripts = new Map<string, Transcript>();
  deleted: string[] = [];
  submitError: ((p: TranscriptParams) => Error | null) | null = null;
  getError: Error | null = null;
  /** Polls before a submitted transcript completes. */
  pollsUntilDone = 1;
  private polls = new Map<string, number>();
  completeWith: (id: string) => Transcript = (id) => transcriptFixture(id);
  async submit(p: TranscriptParams): Promise<Transcript> {
    this.submitted.push(p);
    const e = this.submitError?.(p);
    if (e) throw e;
    const id = `tr_${this.submitted.length}`;
    this.transcripts.set(id, { id, status: "queued", audio_url: p.audio_url });
    return this.transcripts.get(id)!;
  }
  async get(id: string): Promise<Transcript> {
    if (this.getError) throw this.getError;
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    if (n > this.pollsUntilDone) return this.completeWith(id);
    return this.transcripts.get(id) ?? { id, status: "processing", audio_url: "" };
  }
  async delete(id: string): Promise<Transcript> {
    this.deleted.push(id);
    return { id, status: "completed", audio_url: "" };
  }
}

/** A completed multichannel transcript: ch2 = agent, ch1 = user. */
export function transcriptFixture(id: string): Transcript {
  const words = (text: string, start: number) =>
    text.split(/\s+/).map((w, i) => ({ text: w, start: start + i * 300, end: start + i * 300 + 250, confidence: 0.99, speaker: null, channel: null }));
  const u = (channel: "1" | "2", text: string, start: number) => {
    const ws = words(text, start);
    return { speaker: channel, channel, text, start, end: ws[ws.length - 1]!.end, confidence: 0.98, words: ws };
  };
  return {
    id,
    status: "completed",
    audio_url: "https://s3.example.test/x",
    audio_duration: 62.5,
    audio_channels: 2,
    utterances: [
      u("2", "Hi Mark, this is the AI assistant. Is the car still kept at ZIP 78701?", 560),
      u("1", "Yes, that's right.", 8800),
      u("2", "What is the ZIP code where the car is parked?", 12000),
      u("1", "It's 78701.", 16000),
    ],
  };
}

export const TIMELINE_FIXTURE = {
  session_id: "sess_test_1",
  started_at_unix_ms: 1790273390171,
  turns: [
    { turn_id: "resp_1", trigger: "greeting", agent_text: "Hi Mark", agent_reply_started_at_ms: 1790273390545 },
    {
      turn_id: "resp_2",
      trigger: "tool_result",
      tool_calls: [
        { call_id: "c1", name: "get_disclosure", arguments: { kind: "premium_change" }, result: "{}", dispatched_at_ms: 1790273420040, result_received_at_ms: 1790273420248 },
        { call_id: "c2", name: "made_up_tool", arguments: {}, dispatched_at_ms: 1790273421000, result_received_at_ms: 1790273421100 },
      ],
    },
  ],
};

export class FakeLedger implements SpendLedger {
  rows = new Map<string, { estUsd: number; status: "reserved" | "settled" | "released"; actual?: number; provider: string; refId: string }>();
  refuse = false;
  private n = 0;
  async reserve(e: Parameters<SpendLedger["reserve"]>[0]) {
    if (this.refuse) return { ok: false as const, code: "E_BUDGET" as const };
    const id = `led_${++this.n}`;
    this.rows.set(id, { estUsd: e.estUsd, status: "reserved", provider: e.provider, refId: e.refId });
    return { ok: true as const, id };
  }
  async settle(id: string, actualUsd: number) {
    const r = this.rows.get(id) ?? { estUsd: 0, status: "reserved" as const, provider: "?", refId: "?" };
    this.rows.set(id, { ...r, status: "settled", actual: actualUsd });
  }
  async release(id: string) {
    const r = this.rows.get(id);
    if (r && r.status === "reserved") this.rows.set(id, { ...r, status: "released" });
  }
  async summary() {
    return { sinceEpochUsd: 0, todayUsd: {}, dailyCapUsd: 3, judgingBudgetUsd: 28, pctToday: 0, byEnv: {} };
  }
}

/**
 * A test double of WP2's DbJobRunner (same observable rules: one step per advance, due + lease check, state and
 * run_after persisted, 3 consecutive throws → failed). The real runner is WP2's; this only exercises WP8's step.
 */
export class TestRunner implements JobRunner {
  steps = new Map<JobKind, Parameters<JobRunner["register"]>[1]>();
  constructor(private readonly db: Db, private readonly now: () => number) {}
  register(kind: JobKind, step: Parameters<JobRunner["register"]>[1]): void {
    this.steps.set(kind, step);
  }
  async enqueue(kind: JobKind, refId: string, opts: { runAfterMs?: number; state?: unknown } = {}): Promise<string> {
    const id = `job_${randomBytes(5).toString("hex")}`;
    const t = this.now();
    await this.db.insert(jobs).values({ id, kind, refId, state: (opts.state ?? null) as never, runAfter: new Date(t + (opts.runAfterMs ?? 0)), createdAt: new Date(t), updatedAt: new Date(t) });
    return id;
  }
  async advance(jobId: string): Promise<"pending" | "running" | "done" | "failed"> {
    const t = this.now();
    const [job] = await this.db
      .update(jobs)
      .set({ status: "running", leaseUntil: new Date(t + 30_000) })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["pending", "running"]), or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, new Date(t))), lte(jobs.runAfter, new Date(t))))
      .returning();
    if (!job) {
      const [r] = await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
      return r?.status ?? "failed";
    }
    const step = this.steps.get(job.kind)!;
    try {
      const r = await step({ id: job.id, refId: job.refId, state: job.state, attempts: job.attempts });
      const after = this.now();
      if (r.next === "done" || r.next === "failed") {
        await this.db.update(jobs).set({ status: r.next, state: r.state as never, leaseUntil: null, attempts: 0 }).where(eq(jobs.id, job.id));
        return r.next;
      }
      await this.db.update(jobs).set({ status: "pending", state: r.state as never, leaseUntil: null, attempts: 0, runAfter: new Date(after + r.next.afterMs) }).where(eq(jobs.id, job.id));
      return "pending";
    } catch (err) {
      const attempts = job.attempts + 1;
      await this.db.update(jobs).set({ status: attempts >= 3 ? "failed" : "pending", attempts, lastError: String(err), leaseUntil: null, runAfter: new Date(this.now() + 2000 * attempts) }).where(eq(jobs.id, job.id));
      return attempts >= 3 ? "failed" : "pending";
    }
  }
  async tick(): Promise<number> {
    const due = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, new Date(this.now())))).orderBy(asc(jobs.runAfter));
    for (const d of due) await this.advance(d.id);
    return due.length;
  }
}

export class Clock {
  t: number;
  constructor(iso = "2026-09-25T10:00:00Z") {
    this.t = Date.parse(iso);
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export const fakeQa: ComputeQa = (input: Wp8QaInput): QaResult => ({
  provisional: input.provisional,
  reAsked: input.ch2.filter((u) => /what is the zip/i.test(u.text)).length,
  newlyAsked: 0,
  pendingConfirmed: 0,
  verifiedReconfirmed: input.ch2.filter((u) => /78701\?/.test(u.text)).length,
  disclosures: input.disclosures.map((d) => ({ kind: d.kind, similarity: 1, ok: true, missingCritical: [] })),
  clickToFirstAudibleMs: input.latency?.clickToFirstAudibleMs ?? null,
  deadAirAfterRepMs: input.latency?.deadAirAfterRepMs ?? null,
  turnLatencyP50Ms: input.latency?.turnLatencyP50Ms ?? null,
  payment: input.payment,
  handedBack: input.handedBack,
  aiSeconds: input.aiSeconds,
  adviceFlags: 0,
  details: [],
});

export const TEST_SECRET = "test-case-token-secret-0123456789abcdef";

export async function tokenFor(o: { caseId: string; takeoverId?: string; visitorId?: string; scp?: string[]; expSec?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { vid: o.visitorId ?? "v1", scp: o.scp ?? ["case", "tools"] };
  if (o.takeoverId) payload.tko = o.takeoverId;
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuer("baton").setSubject(o.caseId).setIssuedAt(now).setExpirationTime(now + (o.expSec ?? 600)).sign(new TextEncoder().encode(TEST_SECRET));
}

export interface Harness {
  ports: Wp8Ports;
  rest: FakeVaRest;
  async: FakeAsync;
  ledger: FakeLedger;
  runner: TestRunner;
  clock: Clock;
  timelineFetches: string[];
  tripped: string[];
}

export function harness(db: Db, over: Partial<Wp8Ports> = {}): Harness {
  const clock = new Clock();
  const rest = new FakeVaRest();
  const asyncC = new FakeAsync();
  const ledger = new FakeLedger();
  const runner = new TestRunner(db, clock.now);
  const timelineFetches: string[] = [];
  const tripped: string[] = [];
  const limiter = new MemoryRateLimiter(clock.now);
  const ports: Wp8Ports = {
    db: () => db,
    now: clock.now,
    runner: () => runner,
    ledger: () => ledger,
    computeQa: fakeQa,
    vaRest: () => rest,
    asyncClient: () => asyncC,
    fetchJson: async (url) => {
      timelineFetches.push(url);
      return TIMELINE_FIXTURE;
    },
    authorizeTakeover: tokenAuthorizer({ secret: () => TEST_SECRET }),
    rateLimiter: () => limiter,
    flags: async () => ({ mode: "live", reason: null }),
    tripReplayOnly: async (reason) => {
      tripped.push(reason);
      return true;
    },
    config: () => ({ appUrl: null, webhookSecret: "whsec-test", deployId: "zp-prod", vaMaxConcurrent: 3 }),
    ...over,
  };
  return { ports, rest, async: asyncC, ledger, runner, clock, timelineFetches, tripped };
}
