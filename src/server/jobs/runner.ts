import "server-only";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { JobKind, JobRunner } from "../../core/contracts/services";
import { newId } from "../../lib/ids";
import { getDb, type Db } from "../db/client";
import { jobs } from "../db/schema";
import { env } from "../env";
import { log, scrub } from "../log";

/**
 * Portable job runner (DESIGN §4.5). Jobs live in `jobs`; `advance(id)`:
 *  1. takes a 30 s lease (`status='running'`) only if the job is due and not leased;
 *  2. runs ONE step of the kind's registered step machine (no transaction is held across the step);
 *  3. persists `state`, then `run_after` for the next step, or `done`/`failed`.
 * A step that throws is retried with backoff; `MAX_ATTEMPTS` consecutive throws → `failed` (F3 "any step failing
 * 3 times"). `attempts` (passed to the step) = consecutive failures so far; a successful step resets it.
 *
 * Three callers: (a) the in-process ticker (`startInprocWorker`, every 2 s, ENABLE_INPROC_WORKER=1), (b) status-poll
 * routes (WP8's GET /api/verifications/…), (c) `POST /api/internal/cron?kind=tick` (the Vercel mirror).
 *
 * Step registrations live on `globalThis`, so every Next bundle in the process (instrumentation, route handlers)
 * shares them. A job whose kind has no step in this process is left pending (re-checked in 5 s).
 */

export type JobStep = Parameters<JobRunner["register"]>[1];
export type JobStatus = "pending" | "running" | "done" | "failed";

export const LEASE_MS = 30_000;
export const MAX_ATTEMPTS = 3;
const TICK_BATCH = 10;

type Registry = { steps: Map<JobKind, JobStep> };
const g = globalThis as typeof globalThis & { __batonJobSteps?: Registry; __batonJobRunner?: DbJobRunner; __batonInprocWorker?: InprocWorker };
const registry: Registry = (g.__batonJobSteps ??= { steps: new Map() });

const jobLog = log.child({ component: "jobs" });

export class DbJobRunner implements JobRunner {
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly steps: Map<JobKind, JobStep> = registry.steps,
  ) {}

  register(kind: JobKind, step: JobStep): void {
    this.steps.set(kind, step);
  }

  hasStep(kind: JobKind): boolean {
    return this.steps.has(kind);
  }

  async enqueue(kind: JobKind, refId: string, opts: { runAfterMs?: number; state?: unknown } = {}): Promise<string> {
    const id = newId();
    const nowMs = this.now();
    await this.db.insert(jobs).values({
      id,
      kind,
      refId,
      state: (opts.state ?? null) as never,
      status: "pending",
      runAfter: new Date(nowMs + (opts.runAfterMs ?? 0)),
      attempts: 0,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    return id;
  }

  /** Enqueue unless a pending/running/done job of this kind already exists for `refId`; returns that job's id. */
  async enqueueOnce(kind: JobKind, refId: string, opts: { runAfterMs?: number; state?: unknown } = {}): Promise<string> {
    const [existing] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, kind), eq(jobs.refId, refId), inArray(jobs.status, ["pending", "running", "done"])))
      .limit(1);
    return existing ? existing.id : this.enqueue(kind, refId, opts);
  }

  async status(jobId: string): Promise<JobStatus | null> {
    const [r] = await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
    return r?.status ?? null;
  }

  async advance(jobId: string): Promise<JobStatus> {
    const nowMs = this.now();
    const now = new Date(nowMs);
    const [job] = await this.db
      .update(jobs)
      .set({ status: "running", leaseUntil: new Date(nowMs + LEASE_MS), updatedAt: now })
      .where(
        and(
          eq(jobs.id, jobId),
          inArray(jobs.status, ["pending", "running"]),
          or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, now)),
          lte(jobs.runAfter, now),
        ),
      )
      .returning();
    if (!job) return (await this.status(jobId)) ?? "failed";

    const step = this.steps.get(job.kind);
    if (!step) {
      await this.db
        .update(jobs)
        .set({ status: "pending", leaseUntil: null, runAfter: new Date(nowMs + 5000), updatedAt: now })
        .where(eq(jobs.id, job.id));
      return "pending";
    }

    try {
      const r = await step({ id: job.id, refId: job.refId, state: job.state, attempts: job.attempts });
      const after = this.now();
      if (r.next === "done" || r.next === "failed") {
        await this.db
          .update(jobs)
          .set({ status: r.next, state: r.state as never, leaseUntil: null, attempts: 0, updatedAt: new Date(after) })
          .where(eq(jobs.id, job.id));
        return r.next;
      }
      await this.db
        .update(jobs)
        .set({
          status: "pending",
          state: r.state as never,
          leaseUntil: null,
          attempts: 0,
          runAfter: new Date(after + Math.max(0, r.next.afterMs)),
          updatedAt: new Date(after),
        })
        .where(eq(jobs.id, job.id));
      return "pending";
    } catch (err) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const msg = scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
      const after = this.now();
      await this.db
        .update(jobs)
        .set({
          status: failed ? "failed" : "pending",
          attempts,
          lastError: msg,
          leaseUntil: null,
          runAfter: new Date(after + 2000 * attempts),
          updatedAt: new Date(after),
        })
        .where(eq(jobs.id, job.id));
      jobLog.warn("job step failed", { jobId: job.id, kind: job.kind, attempts, failed, err: msg });
      return failed ? "failed" : "pending";
    }
  }

  /** Advance every due job once (up to 10). Returns how many steps ran. Never overlaps itself in-process. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      const due = await this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          or(
            and(eq(jobs.status, "pending"), lte(jobs.runAfter, now)),
            and(eq(jobs.status, "running"), lt(jobs.leaseUntil, now)),
          ),
        )
        .orderBy(asc(jobs.runAfter))
        .limit(TICK_BATCH);
      let ran = 0;
      for (const { id } of due) {
        const before = await this.status(id);
        const after = await this.advance(id);
        if (after !== before || after === "done" || after === "failed") ran++;
      }
      return ran;
    } finally {
      this.ticking = false;
    }
  }

  /** Jobs by kind and status (cron details, tests). */
  async counts(): Promise<Record<string, number>> {
    const rows = await this.db.execute(sql`select kind || ':' || status as k, count(*)::int as n from ${jobs} group by 1`);
    const out: Record<string, number> = {};
    for (const r of rows.rows as { k: string; n: number }[]) out[r.k] = Number(r.n);
    return out;
  }
}

/** The process-wide runner on `getDb()` (steps shared through globalThis). */
export function getJobRunner(): DbJobRunner {
  g.__batonJobRunner ??= new DbJobRunner(getDb());
  return g.__batonJobRunner;
}

// ============================================================================================ in-process worker

/** F6 VA audit hook (WP8 registers it; runs every 3 min while mode=live). */
type AuditHook = () => Promise<unknown>;
const hooks = g as typeof g & { __batonAuditHook?: AuditHook | null };
export function registerVaAuditHook(fn: AuditHook | null): void {
  hooks.__batonAuditHook = fn;
}
export function getVaAuditHook(): AuditHook | null {
  return hooks.__batonAuditHook ?? null;
}

export interface InprocWorker {
  stop(): void;
  startedAt: number;
}

export const WORKER_PERIODS = { tickMs: 2000, sweepMs: 15_000, budgetMs: 60_000, auditMs: 180_000 } as const;

/**
 * Start the in-process ticker (DESIGN §4.5 (a)): job tick every 2 s, F5 sweeper every 15 s, F8 budget guard every
 * 60 s, F6 audit every 3 min while `mode=live`. Idempotent per PROCESS through a `globalThis` flag (the
 * instrumentation hook can run twice in one process; WP0b request item 1). Only when ENABLE_INPROC_WORKER=1.
 */
export function startInprocWorker(): void {
  if (g.__batonInprocWorker) return;
  if (!env().ENABLE_INPROC_WORKER) {
    jobLog.info("in-process worker disabled (ENABLE_INPROC_WORKER!=1)");
    return;
  }
  const running = new Set<string>();
  const every = (name: string, ms: number, fn: () => Promise<unknown>): ReturnType<typeof setInterval> => {
    const t = setInterval(() => {
      if (running.has(name)) return;
      running.add(name);
      fn()
        .catch((err: unknown) => jobLog.warn("worker task failed", { task: name, err }))
        .finally(() => running.delete(name));
    }, ms);
    t.unref?.();
    return t;
  };
  const timers = [
    every("tick", WORKER_PERIODS.tickMs, () => getJobRunner().tick()),
    every("sweep", WORKER_PERIODS.sweepMs, async () => {
      const { getDbAuthority } = await import("../limits/index");
      const a = getDbAuthority();
      if (!a) return;
      const { sweepRegistry } = await import("../registry/sweeper");
      await sweepRegistry(a);
    }),
    every("budget", WORKER_PERIODS.budgetMs, async () => {
      const { getDbAuthority } = await import("../limits/index");
      const a = getDbAuthority();
      if (!a) return;
      const { runBudgetGuard } = await import("./budget-guard");
      await runBudgetGuard(a);
    }),
    every("audit", WORKER_PERIODS.auditMs, async () => {
      const hook = getVaAuditHook();
      if (!hook) return;
      const { getLimitsAuthority } = await import("../limits/index");
      if ((await getLimitsAuthority().flags()).mode !== "live") return;
      await hook();
    }),
  ];
  g.__batonInprocWorker = {
    startedAt: Date.now(),
    stop() {
      for (const t of timers) clearInterval(t);
      g.__batonInprocWorker = undefined;
    },
  };
  void installBuiltinSteps().catch((err: unknown) => jobLog.warn("builtin job steps failed to load", { err }));
  jobLog.info("in-process worker started", { ...WORKER_PERIODS });
}

export function stopInprocWorker(): void {
  g.__batonInprocWorker?.stop();
}

/**
 * Register the job steps this process can run. Purge is WP2's. [WIRE-WP8-STEPS] G1 (integrator): once WP8's modules
 * exist, add `await import("./verify-takeover")` and `await import("./va-audit")` here (each registers its step /
 * audit hook on import), so the ticker can run them before any route has loaded them.
 */
export async function installBuiltinSteps(runner: DbJobRunner = getJobRunner()): Promise<void> {
  const { registerPurgeJob } = await import("./purge");
  registerPurgeJob(runner);
  const { setFallbackVerificationEnqueue } = await import("../registry/sweeper");
  setFallbackVerificationEnqueue((takeoverId, vaSessionId) =>
    runner.enqueueOnce("verify_takeover", takeoverId, { state: { vaSessionId, from: "sweeper" } }),
  );
}
