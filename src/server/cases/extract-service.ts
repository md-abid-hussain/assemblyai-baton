import "server-only";

import type { ExtractResponse } from "../../core/contracts/api";
import type { CaseState, FactEvent, NewFactEvent } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { Extractor } from "../../core/contracts/services";
import { TAKEOVER_TIMING } from "../../core/contracts/takeover";
import type { TurnInput } from "../../core/contracts/turns";
import type { CaseDataSource } from "../data";
import { log } from "../log";
import type { ExtractTurnResult } from "../openai/extractor";
import type { CaseEngine } from "./engine";
import { cacheEntryFor, servedEvents } from "./prefill";
import { isFrozenStatus, type ExtractStatus, type PgCaseRepository, type TurnUpdate } from "./repository";

/**
 * F1 extraction (DESIGN §4.5), behind POST /api/extract (#8):
 *
 * 1. Insert the turn (idempotent on (caseId, turnId); a duplicate returns the current state, `skipped:"duplicate"`;
 *    a duplicate of a turn still being extracted in this process waits for that extraction instead).
 * 2. Read the case (plain read, no lock).
 * 3. Extract OUTSIDE any transaction: cached events for `source:"stt_cache"` turns when the WP9 cache matches our
 *    extractorVersion ($0), else luna (§5.3 budgets, newest-turn retry).
 * 4. One short transaction under the case advisory lock: insert events with the next seq, re-derive, version+1.
 * 5. Return. 6. `defer(maybeRunVerifier)`.
 *
 * Per case, one extraction runs at a time in this process (a per-case queue), and when more than one turn is waiting
 * they go to luna together, at most `maxNewTurns` (3) per call, ordered by `endMs`; each request still returns
 * the events of its own turn. Across processes the step-4 lock keeps the result correct.
 *
 * After the takeover snapshot is frozen (case status ai_active or later) a turn returns `skipped:"after_takeover"`
 * (stored for the transcript, never extracted), unless it is in the drain's `pendingTurnIds` and arrives within
 * LATE_PENDING_WINDOW_MS (3 s) of the freeze: those are extracted and shown, and the frozen snapshot never changes.
 * An upstream failure is not an HTTP error: the turn is marked `extract_status='failed'` and the current state is
 * returned (the case card shows "1 turn not analysed"; the verifier may fill the gap).
 */

export interface ExtractServiceDeps {
  repo: PgCaseRepository;
  engine: CaseEngine;
  extractor: Extractor;
  data: CaseDataSource;
  /** Schedules background work after the response (Next `after`); tests run it inline or collect it. */
  defer?: (fn: () => Promise<unknown>) => void;
  /** F2 hook, scheduled with `defer` after every extraction. */
  maybeRunVerifier?: (caseId: string) => Promise<unknown>;
  /** Records OpenAI spend (settle actual, §7.1). Called after the response via `defer`. */
  recordSpend?: (e: { caseId: string; usd: number; action: string }) => Promise<void>;
  /** Wall clock (ms) for the late-pending window. */
  now?: () => number;
}

interface JobResult {
  state: CaseState;
  events: FactEvent[];
  extractMs: number;
  status: ExtractStatus;
}

interface Job {
  turn: TurnInput;
  resolve: (r: JobResult | null) => void;
  reject: (e: unknown) => void;
}

interface CaseQueue {
  pending: Job[];
  running: boolean;
  /** turnId → the extraction in flight (null result = that request found a duplicate row). */
  inflight: Map<string, Promise<JobResult | null>>;
}

const exLog = log.child({ component: "extract" });

export interface ExtractOutcome extends ExtractResponse {
  status: ExtractStatus | "duplicate" | "after_takeover";
}

export class ExtractService {
  private readonly queues = new Map<string, CaseQueue>();
  private readonly d: ExtractServiceDeps;
  /** Number of luna calls made (tests and the notes' measurements). */
  llmCalls = 0;

  constructor(d: ExtractServiceDeps) {
    this.d = d;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private queue(caseId: string): CaseQueue {
    let q = this.queues.get(caseId);
    if (!q) {
      q = { pending: [], running: false, inflight: new Map() };
      this.queues.set(caseId, q);
    }
    return q;
  }

  /** `opts.defer` = the request's scheduler (Next `after`); the F2 run is scheduled on it. */
  async handle(turn: TurnInput, opts: { defer?: (fn: () => Promise<unknown>) => void } = {}): Promise<ExtractOutcome> {
    const { repo } = this.d;
    const caseId = turn.caseId;
    const row = await repo.loadRow(caseId);
    if (!row) throw new BatonError("E_NOT_FOUND", "Unknown case.");

    if (isFrozenStatus(row.status)) {
      const f = await repo.freezeInfo(caseId);
      const lateOk = !!f && f.pendingTurnIds.includes(turn.turnId) && this.now() - Date.parse(f.frozenAt) <= TAKEOVER_TIMING.LATE_PENDING_WINDOW_MS;
      if (!lateOk) {
        await repo.insertTurnWithStatus(turn, "skipped");
        return { state: row.state, events: [], extractMs: 0, skipped: "after_takeover", status: "after_takeover" };
      }
    }

    const q = this.queue(caseId);
    const existing = q.inflight.get(turn.turnId);
    if (existing) return this.duplicate(turn, await existing);

    let resolve!: (r: JobResult | null) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<JobResult | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    p.catch(() => undefined);
    q.inflight.set(turn.turnId, p);
    let inserted: "inserted" | "duplicate";
    try {
      inserted = await repo.insertTurn(turn);
    } catch (e) {
      q.inflight.delete(turn.turnId);
      reject(e);
      throw e;
    }
    if (inserted === "duplicate") {
      q.inflight.delete(turn.turnId);
      if (!q.running && !q.pending.length && !q.inflight.size) this.queues.delete(caseId);
      resolve(null);
      return this.duplicate(turn, null);
    }
    q.pending.push({ turn, resolve, reject });
    void this.pump(caseId);
    const r = await p;
    if (!r) return this.duplicate(turn, null);
    if (this.d.maybeRunVerifier) this.defer(() => this.d.maybeRunVerifier!(caseId), opts.defer);
    return { state: r.state, events: r.events, extractMs: r.extractMs, status: r.status };
  }

  /** Current state + this turn's stored events (idempotent replay). */
  private async duplicate(turn: TurnInput, r: JobResult | null): Promise<ExtractOutcome> {
    if (r) return { state: r.state, events: r.events, extractMs: r.extractMs, skipped: "duplicate", status: "duplicate" };
    const { repo } = this.d;
    const [row, events, t] = await Promise.all([repo.loadRow(turn.caseId), repo.factsOfTurn(turn.caseId, turn.turnId), repo.getTurn(turn.caseId, turn.turnId)]);
    if (!row) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    return { state: row.state, events, extractMs: t?.extractMs ?? 0, skipped: "duplicate", status: "duplicate" };
  }

  private defer(fn: () => Promise<unknown>, via?: (fn: () => Promise<unknown>) => void): void {
    const run = () => fn().catch((err) => exLog.warn("deferred task failed", { err }));
    const sched = via ?? this.d.defer;
    if (sched) sched(run);
    else void run();
  }

  /** Drain the case's queue: one batch at a time. */
  private async pump(caseId: string): Promise<void> {
    const q = this.queue(caseId);
    if (q.running) return;
    q.running = true;
    try {
      while (q.pending.length) {
        q.pending.sort((a, b) => a.turn.endMs - b.turn.endMs || a.turn.recvMs - b.turn.recvMs);
        const batch = q.pending.splice(0, Math.max(1, this.d.engine.extractor.maxNewTurns));
        try {
          await this.runBatch(caseId, batch);
        } catch (err) {
          exLog.error("extraction batch failed", { caseId, err });
          for (const j of batch) j.reject(err);
          await this.d.repo.setTurnStatus(caseId, batch.map((j) => ({ turnId: j.turn.turnId, status: "failed", extractMs: null }))).catch(() => undefined);
        } finally {
          for (const j of batch) q.inflight.delete(j.turn.turnId);
        }
      }
    } finally {
      q.running = false;
      if (!q.pending.length && !q.inflight.size) this.queues.delete(caseId);
    }
  }

  private async runBatch(caseId: string, batch: Job[]): Promise<void> {
    const { repo, engine, data } = this.d;
    const row = await repo.loadRow(caseId);
    if (!row) throw new BatonError("E_NOT_FOUND", "Unknown case.");

    // 3a. cached events for stt_cache turns (no LLM).
    const cachedJobs: { job: Job; events: NewFactEvent[] }[] = [];
    const live: Job[] = [];
    for (const job of batch) {
      const entry = job.turn.source === "stt_cache" ? await cacheEntryFor(data, row.callId, job.turn.turnId, engine.extractor.version) : null;
      if (entry) cachedJobs.push({ job, events: servedEvents(caseId, job.turn, entry.events) });
      else live.push(job);
    }
    if (cachedJobs.length) {
      const c = await repo.commit(caseId, row.version, cachedJobs.flatMap((x) => x.events),
        cachedJobs.map((x) => ({ turnId: x.job.turn.turnId, status: "done" as const, extractMs: 0 })));
      for (const { job } of cachedJobs) {
        job.resolve({ state: c.state, events: c.inserted.filter((e) => e.turnId === job.turn.turnId), extractMs: 0, status: "done" });
      }
    }
    if (!live.length) return;

    // 3b. luna, outside any transaction.
    const cur = cachedJobs.length ? await repo.loadRow(caseId) : row;
    if (!cur) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    const newTurns = live.map((j) => j.turn);
    const minEnd = Math.min(...newTurns.map((t) => t.endMs));
    const recent = await repo.recentTurns(caseId, minEnd, engine.extractor.recentTurns, newTurns.map((t) => t.turnId));
    this.llmCalls++;
    const res = (await this.d.extractor.extractTurn({
      caseId, policy: cur.policy, callDate: cur.policy.callDate, state: cur.state, recent, newTurns,
    })) as Partial<ExtractTurnResult> & Awaited<ReturnType<Extractor["extractTurn"]>>;
    const covered = new Set(res.coveredTurnIds ?? newTurns.map((t) => t.turnId));
    const updates: TurnUpdate[] = newTurns.map((t) => ({ turnId: t.turnId, status: covered.has(t.turnId) ? "done" : "failed", extractMs: res.ms }));

    // 4. short transaction: events + derive + version+1.
    const c = await repo.commit(caseId, cur.version, res.events, updates);
    for (const job of live) {
      job.resolve({
        state: c.state, events: c.inserted.filter((e) => e.turnId === job.turn.turnId), extractMs: res.ms,
        status: covered.has(job.turn.turnId) ? "done" : "failed",
      });
    }
    const usd = res.usd ?? 0;
    if (this.d.recordSpend && usd > 0) this.defer(() => this.d.recordSpend!({ caseId, usd, action: "extract" }));
    if (res.error) exLog.info("extraction degraded", { caseId, code: res.error.code, covered: [...covered], failed: res.failedTurnIds ?? [] });
  }
}
