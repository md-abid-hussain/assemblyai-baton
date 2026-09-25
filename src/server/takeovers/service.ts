import "server-only";

import { createHash } from "node:crypto";

import type { ArmRequest, ArmResponse, EndTakeoverRequest, TakeoverEventsRequest } from "../../core/contracts/api";
import type { CaseState, PolicyRecord } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { TakeoverPhase } from "../../core/contracts/events";
import type { CaseRepository, EnqueueVerification, LimitsAuthority, TakeoverService, ValidateFirstUpdate } from "../../core/contracts/services";
import { TAKEOVER_TIMING, type CompiledTakeover, type DrainReport, type TakeoverOutcome } from "../../core/contracts/takeover";
import { newId } from "../../lib/ids";
import { ARMABLE_CASE_STATUSES, type TakeoverStore } from "./store";

/**
 * TakeoverService (TASKS §2; DESIGN §4.4 #9, #11–#13, §5.5.4 rules 2 and 5).
 *
 *  - arm: checks the case (visitor, run, status, aiHalf ≠ recorded → 409, ≤ 3 passes), inserts the takeover row and
 *    flips the case to `armed` atomically, re-issues the case token with `tko`, and returns the adaptive `leadMs`.
 *  - compile: `CaseRepository.freezeSnapshot` (WP3: t_arm_ms, late/cut marks, re-derive, freeze, ai_active) →
 *    WP1's `compileTakeover` → `validateFirstUpdate(buildFirstUpdate(compiled))` before returning; the greeting,
 *    prompt hash/version, stage and dynamic cap are stored on the takeover.
 *  - recordEvents: phase, timings (→ adaptive lead), VA session id, HUD, provisional QA, `failure` (sets
 *    `last_failure_at`, which route #10 needs before it mints attempt 1), heartbeat → `LimitsAuthority.heartbeat`.
 *  - end: idempotent; outcome + ended_at, case status = outcome, releases the VA slot as a safety net, enqueues the
 *    verification (WP8).
 *
 * Every collaborator is injected, so the service is testable without Postgres, WP1, WP2, WP3 or WP8.
 */

/** WP1 `compileTakeover(snapshot, policy, opts)` (src/core/compiler/compile.ts). */
export type CompileTakeoverFn = (
  snapshot: CaseState,
  policy: PolicyRecord,
  opts: {
    deployId: string;
    voice?: string;
    keytermsEnabled?: boolean;
    capEnv?: { baseMs: number; perFieldMs: number; maxMs: number };
    compiledBy?: "server" | "client";
    payToolMode?: "hold" | "push";
  },
) => CompiledTakeover;

/** WP1 `buildFirstUpdate(compiled)` (src/core/compiler/first-update.ts). */
export type BuildFirstUpdateFn = (compiled: CompiledTakeover) => { type: "session.update"; session: Record<string, unknown> };

export interface TakeoverCompileConfig {
  /** BATON_DEPLOY_ID (the prompt's deploy marker). */
  deployId: string;
  /** VA_VOICE. */
  voice: string;
  /** VA_KEYTERMS. */
  keytermsEnabled: boolean;
  /** PAY_TOOL_MODE. */
  payToolMode: "hold" | "push";
  /** VA_SESSION_CAP_{BASE,PER_FIELD,MAX}_MS. */
  capEnv: { baseMs: number; perFieldMs: number; maxMs: number };
}

export interface TakeoverServiceDeps {
  store: TakeoverStore;
  /** WP3. */
  cases: Pick<CaseRepository, "freezeSnapshot">;
  /** WP1. */
  compileTakeover: CompileTakeoverFn;
  buildFirstUpdate: BuildFirstUpdateFn;
  validateFirstUpdate: ValidateFirstUpdate;
  /** WP2 `issueCaseToken({caseId, visitorId, takeoverId})` (the takeover-scoped case token, DESIGN §4.3). */
  issueTakeoverToken: (i: { caseId: string; visitorId: string; takeoverId: string }) => Promise<string>;
  /** WP2 `getLimitsAuthority()`. */
  limits: Pick<LimitsAuthority, "heartbeat" | "release">;
  /** WP2 `vaSessionIdFor(takeoverId, attempt)` = our live_sessions id of the VA slot of that attempt. */
  liveSessionIdFor: (takeoverId: string, attempt: 0 | 1) => string;
  /** WP8 (a stub returning null until it ships). */
  enqueueVerification: EnqueueVerification;
  config: TakeoverCompileConfig;
  newId?: () => string;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** §5.5.4 rule 5: the lead is the median over this many recent successful takeovers. */
  leadWindow?: number;
}

/** Median of `firstAudiblePlayed − sessionUpdateSent`, clamped to 500–1500; the default 900 when there is no sample. */
export function computeLeadMs(timings: Record<string, number>[]): number {
  const xs = timings
    .map((t) => (typeof t.firstAudiblePlayed === "number" && typeof t.sessionUpdateSent === "number" ? t.firstAudiblePlayed - t.sessionUpdateSent : Number.NaN))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!xs.length) return TAKEOVER_TIMING.DEFAULT_LEAD_MS;
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return Math.round(Math.min(TAKEOVER_TIMING.LEAD_MS_MAX, Math.max(TAKEOVER_TIMING.LEAD_MS_MIN, median)));
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const phaseAfterEnd = (o: TakeoverOutcome): TakeoverPhase => (o === "failed" ? "failed" : "done");

export class TakeoverServiceImpl implements TakeoverService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly d: TakeoverServiceDeps) {
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? newId;
  }

  private log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
    this.d.log?.(level, msg, data);
  }

  async arm(i: ArmRequest & { visitorId: string }): Promise<ArmResponse> {
    const c = await this.d.store.loadCase(i.caseId);
    if (!c) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    if (c.visitorId !== i.visitorId) throw new BatonError("E_FORBIDDEN", "This case belongs to another visitor.");
    if (c.runPlan?.aiHalf === "recorded") {
      throw new BatonError("E_CASE_STATE", "This run plays the recorded AI session, so the manual pass is disabled.", { fallback: "recorded_ai_session" });
    }
    if (!c.runPlan) throw new BatonError("E_CASE_STATE", "Start the call before passing the baton.");
    if (c.runPlan.runId !== i.runId) throw new BatonError("E_CASE_STATE", "This pass belongs to an older run of the call; reload to continue.");
    if (!ARMABLE_CASE_STATUSES.includes(c.status)) {
      throw new BatonError("E_CASE_STATE", c.status === "armed" || c.status === "ai_active" ? "The AI half is already running for this call." : "This call has ended.");
    }
    const takeoverId = this.newId();
    const nowMs = this.now();
    const r = await this.d.store.createArmed({
      id: takeoverId,
      caseId: i.caseId,
      tArmMs: i.tArmMs,
      midUtterance: i.midUtterance,
      protocol: { source: i.source, runId: i.runId, timings: {} },
      fromStatuses: ARMABLE_CASE_STATUSES,
      maxPerCase: TAKEOVER_TIMING.MAX_TAKEOVERS_PER_CASE,
      now: new Date(nowMs),
    });
    if (r === "limit") {
      throw new BatonError("E_RATE_LIMITED", `A call allows ${TAKEOVER_TIMING.MAX_TAKEOVERS_PER_CASE} passes of the baton.`);
    }
    if (r === "conflict") throw new BatonError("E_CASE_STATE", "The AI half is already running for this call.");
    const takeoverToken = await this.d.issueTakeoverToken({ caseId: i.caseId, visitorId: i.visitorId, takeoverId });
    const leadMs = await this.leadMs();
    this.log("info", "takeover armed", { takeoverId, caseId: i.caseId, source: i.source, tArmMs: i.tArmMs, midUtterance: i.midUtterance, leadMs });
    return { takeoverId, takeoverToken, leadMs };
  }

  /** §5.5.4 rule 5. A failure to read the history never blocks an arm: the default lead is used. */
  async leadMs(): Promise<number> {
    try {
      return computeLeadMs(await this.d.store.recentLeadTimings(this.d.leadWindow ?? 20));
    } catch (err) {
      this.log("warn", "lead history unavailable", { err: String(err) });
      return TAKEOVER_TIMING.DEFAULT_LEAD_MS;
    }
  }

  async compile(takeoverId: string, drain: DrainReport): Promise<CompiledTakeover> {
    const t = await this.d.store.load(takeoverId);
    if (!t) throw new BatonError("E_NOT_FOUND", "Unknown takeover.");
    if (t.endedAt) throw new BatonError("E_CASE_STATE", "This takeover has ended.");
    if (drain.tArmMs !== t.tArmMs) throw new BatonError("E_BAD_REQUEST", "The drain report is for a different pass point.");
    const c = await this.d.store.loadCase(t.caseId);
    if (!c) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    const started = this.now();
    const snapshot = await this.d.cases.freezeSnapshot(t.caseId, takeoverId, drain);
    const cfg = this.d.config;
    const compiled = this.d.compileTakeover(snapshot, c.policy, {
      deployId: cfg.deployId,
      voice: cfg.voice,
      keytermsEnabled: cfg.keytermsEnabled,
      capEnv: cfg.capEnv,
      compiledBy: "server",
      payToolMode: cfg.payToolMode,
    });
    // The contract (services.ts): validateFirstUpdate runs before the config leaves the server. Throws E_VA_CONFIG.
    this.d.validateFirstUpdate(this.d.buildFirstUpdate(compiled), { keytermsEnabled: cfg.keytermsEnabled });
    await this.d.store.saveCompiled(takeoverId, {
      greeting: compiled.greeting,
      systemPromptHash: sha256Hex(compiled.systemPrompt),
      promptVersion: compiled.promptVersion,
      stage: compiled.stage,
      vaSessionCapMs: compiled.vaSessionCapMs,
      phase: "compiling",
      protocol: {
        drain: {
          tCutMs: drain.tCutMs, capHit: drain.capHit, midUtterance: drain.midUtterance, waitedMs: drain.waitedMs,
          completed: drain.completedTurnIds.length, pending: drain.pendingTurnIds, cut: drain.cutTurnIds, timings: drain.timings,
        },
        compile: { at: new Date(this.now()).toISOString(), ms: this.now() - started, by: "server", keyterms: compiled.keyterms.length, transcriptionMode: compiled.transcriptionMode },
      },
    });
    this.log("info", "takeover compiled", { takeoverId, stage: compiled.stage, promptVersion: compiled.promptVersion, vaSessionCapMs: compiled.vaSessionCapMs });
    return compiled;
  }

  async recordEvents(takeoverId: string, e: TakeoverEventsRequest): Promise<void> {
    const t = await this.d.store.load(takeoverId);
    if (!t) throw new BatonError("E_NOT_FOUND", "Unknown takeover.");
    if (e.heartbeat) {
      // The VA slot of the current attempt: route #10 sets retries = 1 when it mints attempt 1.
      const attempt: 0 | 1 = t.retries > 0 ? 1 : 0;
      if (!t.endedAt) await this.d.limits.heartbeat(this.d.liveSessionIdFor(takeoverId, attempt));
    }
    if (t.endedAt) {
      // After /end only measurements are still merged (a HUD value or the provisional QA can race the end; WP8 reads
      // metrics.hud when it verifies). Phase, failure and heartbeat are ignored.
      const late = {
        ...(e.timings ? { timings: e.timings } : {}),
        ...(e.vaSessionId && !t.vaSessionId ? { vaSessionId: e.vaSessionId } : {}),
        ...(e.hud ? { hud: e.hud as Record<string, number> } : {}),
        ...(e.provisionalQa ? { provisionalQa: e.provisionalQa } : {}),
      };
      if (Object.keys(late).length) await this.d.store.recordEvents(takeoverId, late);
      return;
    }
    const failureAt = e.failure ? new Date(this.now()) : undefined;
    await this.d.store.recordEvents(takeoverId, {
      ...(e.phase ? { phase: e.phase } : {}),
      ...(e.timings ? { timings: e.timings } : {}),
      ...(e.vaSessionId ? { vaSessionId: e.vaSessionId } : {}),
      ...(e.hud ? { hud: e.hud as Record<string, number> } : {}),
      ...(e.provisionalQa ? { provisionalQa: e.provisionalQa } : {}),
      ...(failureAt && e.failure ? { failureAt, failureCode: e.failure.code } : {}),
    });
    if (e.failure) this.log("warn", "takeover failure reported", { takeoverId, code: e.failure.code });
  }

  async end(takeoverId: string, e: EndTakeoverRequest): Promise<{ verificationJobId: string | null }> {
    const t = await this.d.store.load(takeoverId);
    if (!t) throw new BatonError("E_NOT_FOUND", "Unknown takeover.");
    const vaSessionId = e.vaSessionId ?? t.vaSessionId;
    const r = await this.d.store.end(takeoverId, {
      outcome: e.outcome,
      vaSessionId,
      reason: e.reason ?? null,
      endedAt: new Date(this.now()),
      phase: phaseAfterEnd(e.outcome),
    });
    if (!r.first) {
      const prev = r.record?.metrics.verificationJobId;
      return { verificationJobId: typeof prev === "string" ? prev : null };
    }
    // Safety net: the client reports `closed` with the billed seconds first; this settles a slot it never closed
    // (pagehide, a crashed tab). A no-op on a closed or released row.
    const attempt: 0 | 1 = (r.record?.retries ?? t.retries) > 0 ? 1 : 0;
    await this.d.limits.release(this.d.liveSessionIdFor(takeoverId, attempt), `takeover_${e.outcome}`).catch((err: unknown) => {
      this.log("warn", "va slot release failed", { takeoverId, err: String(err) });
    });
    let verificationJobId: string | null = null;
    try {
      verificationJobId = await this.d.enqueueVerification(takeoverId, vaSessionId);
      if (verificationJobId) await this.d.store.setVerificationJob(takeoverId, verificationJobId);
    } catch (err) {
      this.log("error", "verification enqueue failed", { takeoverId, err: String(err) });
    }
    this.log("info", "takeover ended", { takeoverId, outcome: e.outcome, reason: e.reason ?? null, verificationJobId });
    return { verificationJobId };
  }
}
