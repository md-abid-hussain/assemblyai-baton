/**
 * case-sync.ts - `CaseSync` (TASKS §2; DESIGN §5.1.7, §5.5.3 drain): finals → `POST /api/extract` IN ORDER.
 *
 * - One request in flight at a time, in enqueue order, so the server applies turns in call order and a slow luna
 *   call never lets a later turn overtake an earlier one (the route is idempotent on (caseId, turnId); a duplicate
 *   enqueue is ignored client-side too).
 * - Transient failures (network, 408/425/429/5xx) retry with backoff; 4xx other than those give up on that turn.
 * - `drain(timeoutMs)`: waits until everything enqueued BEFORE the call has completed, or the timeout; reports the
 *   completed and still-pending turn ids (the takeover's DrainReport, DESIGN §5.5).
 * - `state` is the newest `CaseState` by `version` (responses can arrive for a stale version after a newer one).
 * - Emits `case.state` and `case.facts` to the EventSink.
 */
import "client-only";

import { ExtractResponseSchema, type ExtractResponse } from "@/core/contracts/api";
import type { CaseState } from "@/core/contracts/case";
import type { CaseSync, EventSink } from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";

export interface CaseSyncOptions {
  caseToken: string;
  /** `x-baton-visitor` for cookie-less browsers (DESIGN §4.3). */
  visitorToken?: string;
  fetchImpl?: typeof fetch;
  sink?: EventSink;
  /** Event clock (ms since page session start). */
  now?: () => number;
  initialState?: CaseState | null;
  /** Backoff schedule for transient failures (ms). */
  retryDelaysMs?: number[];
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface TurnOutcome {
  turnId: string;
  status: "done" | "failed";
  ms: number;
  attempts: number;
  extractMs?: number;
  skipped?: ExtractResponse["skipped"];
  error?: string;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpCaseSync implements CaseSync {
  private readonly o: Required<Pick<CaseSyncOptions, "retryDelaysMs" | "requestTimeoutMs" | "endpoint">> & CaseSyncOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: TurnInput[] = [];
  private readonly seen = new Set<string>();
  private readonly completed: string[] = [];
  private readonly completedSet = new Set<string>();
  private readonly failed = new Set<string>();
  private inFlight: TurnInput | null = null;
  private pumping = false;
  private _state: CaseState | null;
  private readonly stateCbs = new Set<(s: CaseState) => void>();
  private readonly idleWaiters = new Set<() => void>();
  /** Per-turn outcomes (the dev page and the notes use them). */
  readonly outcomes: TurnOutcome[] = [];

  constructor(opts: CaseSyncOptions) {
    this.o = { retryDelaysMs: [250, 750, 1500, 3000], requestTimeoutMs: 15_000, endpoint: "/api/extract", ...opts };
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this._state = opts.initialState ?? null;
  }

  get state(): CaseState | null {
    return this._state;
  }

  onState(cb: (s: CaseState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  /** Ids enqueued but not completed (queued, in flight, or failed). */
  get pendingTurnIds(): string[] {
    return [...(this.inFlight ? [this.inFlight.turnId] : []), ...this.queue.map((t) => t.turnId)];
  }
  get completedTurnIds(): string[] {
    return [...this.completed];
  }

  enqueue(turn: TurnInput): void {
    if (this.seen.has(turn.turnId)) return;
    this.seen.add(turn.turnId);
    this.queue.push(turn);
    void this.pump();
  }

  /** Apply a state that arrived another way (route #3/#4, a takeover freeze): newest version wins. */
  applyState(s: CaseState): void {
    if (this._state && s.version < this._state.version) return;
    this._state = s;
    this.o.sink?.emit({ t: this.t(), type: "case.state", state: s });
    for (const cb of [...this.stateCbs]) cb(s);
  }

  async drain(timeoutMs: number): Promise<{ completedTurnIds: string[]; pendingTurnIds: string[]; waitedMs: number }> {
    const t0 = nowMs();
    const target = new Set(this.pendingTurnIds);
    if (target.size > 0) {
      await new Promise<void>((resolve) => {
        const check = () => {
          for (const id of target) if (!this.completedSet.has(id) && !this.failed.has(id)) return false;
          return true;
        };
        const done = () => {
          clearTimeout(timer);
          this.idleWaiters.delete(onProgress);
          resolve();
        };
        const onProgress = () => {
          if (check()) done();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        this.idleWaiters.add(onProgress);
        onProgress();
      });
    }
    return { completedTurnIds: this.completedTurnIds, pendingTurnIds: this.pendingTurnIds, waitedMs: nowMs() - t0 };
  }

  private t(): number {
    return this.o.now ? this.o.now() : nowMs();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const turn = this.queue.shift()!;
        this.inFlight = turn;
        const outcome = await this.post(turn);
        this.inFlight = null;
        this.outcomes.push(outcome);
        if (outcome.status === "done") {
          this.completed.push(turn.turnId);
          this.completedSet.add(turn.turnId);
        } else {
          this.failed.add(turn.turnId);
        }
        for (const w of [...this.idleWaiters]) w();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async post(turn: TurnInput): Promise<TurnOutcome> {
    const t0 = nowMs();
    const delays = this.o.retryDelaysMs;
    let attempts = 0;
    let lastErr = "";
    for (;;) {
      attempts++;
      try {
        const res = await this.fetchWithTimeout(turn);
        if (res.ok) {
          const body = ExtractResponseSchema.safeParse(await res.json());
          if (!body.success) {
            lastErr = "bad response shape";
          } else {
            this.onResponse(body.data);
            return { turnId: turn.turnId, status: "done", ms: nowMs() - t0, attempts, extractMs: body.data.extractMs, ...(body.data.skipped ? { skipped: body.data.skipped } : {}) };
          }
        } else {
          lastErr = `HTTP ${res.status}`;
          if (!RETRYABLE.has(res.status)) break;
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      const d = delays[attempts - 1];
      if (d === undefined) break;
      await (this.o.sleep ?? sleep)(d);
    }
    this.o.sink?.emit({ t: this.t(), type: "error", code: "E_CASE_STATE", message: `extract ${turn.turnId} failed: ${lastErr}` });
    return { turnId: turn.turnId, status: "failed", ms: nowMs() - t0, attempts, error: lastErr };
  }

  private async fetchWithTimeout(turn: TurnInput): Promise<Response> {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.o.requestTimeoutMs) : null;
    try {
      return await this.fetchImpl(this.o.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.o.caseToken}`,
          ...(this.o.visitorToken ? { "x-baton-visitor": this.o.visitorToken } : {}),
        },
        body: JSON.stringify({ turn }),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private onResponse(r: ExtractResponse): void {
    if (r.events.length) this.o.sink?.emit({ t: this.t(), type: "case.facts", events: r.events });
    this.applyState(r.state);
  }
}

const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
