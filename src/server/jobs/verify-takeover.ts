/**
 * server/jobs/verify-takeover.ts - F3 takeover verification (DESIGN §4.5): "✓ Verified from recording".
 *
 * `enqueueVerification(takeoverId, vaSessionId)` (TASKS §2, called by WP5's end route and WP2's F5 sweeper) creates
 * the `pending` verification and a `verify_takeover` job due in 7 s. The job's step machine, one step per `advance`:
 *  - S1 `await_artifacts`: `GET /v1/sessions/{id}` every 3 s (≤ 30 tries) until the `audio` artifact exists; stores
 *    `duration_seconds` and settles the VA ledger entry with the actual duration;
 *  - S2 `submit`: waits while ≥ 3 async jobs are in flight; reserves `aai_async` (2 ch × duration × $0.21/h);
 *    `POST /v2/transcript` {fresh pre-signed audio_url, universal-3-5-pro, multichannel, keyterms_prompt, webhook};
 *    on a 400 it resubmits once without `keyterms_prompt` (never tested together with multichannel);
 *  - S3 `await_transcript`: woken by the webhook (route #19) or polls `GET /v2/transcript/{id}` every 3 s for ≤ 60 s;
 *  - S4 `compute`: timeline + ch1/ch2 utterances → `computeQa` → `verifications` (completed) + `takeovers.metrics`,
 *    settles the async ledger entry with the billed seconds (duration × channels).
 * A step failing 3 times in a row (or a permanent error) → the verification is `failed` with a plain reason, and the
 * UI keeps its provisional numbers. The step never throws for AssemblyAI/QA errors (it counts them itself), so the
 * reason is always recorded; a throw reaching WP2's runner means the DB itself failed.
 */
import "server-only";

import { and, count, eq, inArray, ne, sql } from "drizzle-orm";

import type { CaseState, PolicyRecord } from "../../core/contracts/case";
import { QaResultSchema } from "../../core/contracts/events";
import { VerifyStateSchema, type VerifyState } from "../../core/contracts/ext/wp8-verify";
import type { EnqueueVerification, JobRunner } from "../../core/contracts/services";
import { AssemblyAIHttpError, billableSeconds, type Transcript, type TranscriptParams } from "../aai/async";
import { artifactUrl } from "../aai/va-rest";
import type { Db } from "../db/client";
import { cases, jobs, liveSessions, payments, takeovers } from "../db/schema";
import { log, scrub } from "../log";
import { buildQaInput, keytermsOf, type VaTimeline } from "../qa/build-input";
import { wp8, type Wp8Ports } from "../qa/deps";
import { emitCaseVerified } from "../qa/domain-events";
import {
  ensurePendingVerification,
  findVerifyJob,
  markVerificationCompleted,
  markVerificationFailed,
  setVerificationTranscript,
} from "../qa/verification";
import { ensureWp8Wired } from "../qa/wiring";

const vlog = log.child({ component: "verify" });

export const VERIFY_TIMING = {
  FIRST_RUN_AFTER_MS: 7_000,
  ARTIFACT_POLL_MS: 3_000,
  ARTIFACT_MAX_TRIES: 30,
  TRANSCRIPT_POLL_MS: 3_000,
  TRANSCRIPT_MAX_WAIT_MS: 60_000,
  MAX_IN_FLIGHT: 3,
  IN_FLIGHT_POLL_MS: 3_000,
  IN_FLIGHT_MAX_TRIES: 60,
  MAX_STEP_FAILURES: 3,
  RETRY_BACKOFF_MS: 2_000,
} as const;

/** List prices (DESIGN §7.1). The async job bills duration × channels. */
export const VERIFY_PRICES = { VA_USD_PER_SEC: 4.5 / 3600, ASYNC_USD_PER_CH_SEC: 0.21 / 3600, CHANNELS: 2, CEILING_SEC: 600 } as const;

export const SPEECH_MODEL = "universal-3-5-pro" as const;

/** Plain-words reasons shown by the QA card (VerificationView.reason). */
export const VERIFY_REASONS: Record<string, string> = {
  no_recording: "There is no recording of the AI half to verify.",
  artifacts_timeout: "The call recording was not ready in time.",
  budget: "Verification was skipped: the transcription budget is used up.",
  busy: "Too many recordings were waiting for transcription.",
  transcript_error: "Transcription of the recording failed.",
  transcript_timeout: "Transcription took longer than a minute.",
  qa_not_wired: "The QA engine is not available on this server.",
  takeover_gone: "The call record no longer exists.",
  await_artifacts_failed: "The call recording could not be fetched.",
  submit_failed: "The recording could not be sent for transcription.",
  await_transcript_failed: "The transcription status could not be read.",
  compute_failed: "The recording was transcribed, but the QA check could not run.",
};
export const reasonText = (key: string | null | undefined): string =>
  (key && VERIFY_REASONS[key]) || "Verification from the recording failed.";

export class PermanentVerifyError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "PermanentVerifyError";
    this.reason = reason;
  }
}

// ============================================================================================ state

export function initialVerifyState(takeoverId: string, vaSessionId: string | null, from: VerifyState["from"], now: number): VerifyState {
  return {
    v: 1,
    step: "await_artifacts",
    takeoverId,
    vaSessionId,
    from,
    tries: 0,
    failures: 0,
    enteredAtMs: now,
    startedAtMs: now,
    durationSec: null,
    vaSettled: false,
    transcriptId: null,
    keyterms: false,
    keytermsDropped: false,
    webhook: false,
    asyncLedgerId: null,
    lastError: null,
    reason: null,
  };
}

/** Our state, or WP2's sweeper shape `{vaSessionId, from:"sweeper"}`, or null → a valid state. */
export function normalizeVerifyState(raw: unknown, takeoverId: string, now: number): VerifyState {
  const ok = VerifyStateSchema.safeParse(raw);
  if (ok.success) return ok.data;
  const r = (raw && typeof raw === "object" ? raw : {}) as { vaSessionId?: unknown; from?: unknown };
  return initialVerifyState(takeoverId, typeof r.vaSessionId === "string" && r.vaSessionId ? r.vaSessionId : null, r.from === "sweeper" ? "sweeper" : "end", now);
}

const goto = (s: VerifyState, step: VerifyState["step"], now: number): VerifyState => ({ ...s, step, tries: 0, failures: 0, enteredAtMs: now });

type StepResult = { state: VerifyState; next: "done" | "failed" | { afterMs: number } };

// ============================================================================================ helpers

async function takeoverVaSessionId(db: Db, takeoverId: string): Promise<string | null> {
  const [r] = await db.select({ sid: takeovers.vaSessionId }).from(takeovers).where(eq(takeovers.id, takeoverId));
  return r?.sid ?? null;
}

interface TakeoverContext {
  snapshot: Pick<CaseState, "fields">;
  policy: PolicyRecord;
  greeting: string | null;
  outcome: string | null;
  metrics: unknown;
  payment: { status: string; statusSource: string | null; simulated: boolean } | null;
}

async function loadContext(db: Db, takeoverId: string): Promise<TakeoverContext> {
  const [t] = await db
    .select({ snapshot: takeovers.snapshot, greeting: takeovers.greeting, outcome: takeovers.outcome, metrics: takeovers.metrics, policy: cases.policy, state: cases.state })
    .from(takeovers)
    .innerJoin(cases, eq(cases.id, takeovers.caseId))
    .where(eq(takeovers.id, takeoverId));
  if (!t) throw new PermanentVerifyError("takeover_gone");
  const [p] = await db
    .select({ status: payments.status, statusSource: payments.statusSource, simulated: payments.simulated, updatedAt: payments.updatedAt })
    .from(payments)
    .where(eq(payments.takeoverId, takeoverId))
    .orderBy(sql`${payments.updatedAt} desc`)
    .limit(1);
  const snap = (t.snapshot ?? t.state) as unknown as CaseState;
  return {
    snapshot: { fields: snap?.fields ?? ({} as CaseState["fields"]) },
    policy: t.policy as unknown as PolicyRecord,
    greeting: t.greeting,
    outcome: t.outcome,
    metrics: t.metrics,
    payment: p ? { status: p.status, statusSource: p.statusSource, simulated: p.simulated } : null,
  };
}

/** Settle the VA ledger entry of this takeover's session with the actual duration. Best effort. */
async function settleVa(p: Wp8Ports, takeoverId: string, vaSessionId: string, durationSec: number): Promise<boolean> {
  const ledger = p.ledger();
  if (!ledger) return false;
  try {
    const rows = await p
      .db()
      .select({ id: liveSessions.id, ledgerId: liveSessions.ledgerId, providerSessionId: liveSessions.providerSessionId })
      .from(liveSessions)
      .where(and(eq(liveSessions.kind, "va"), sql`(${liveSessions.providerSessionId} = ${vaSessionId} or ${liveSessions.id} in (${`va_${takeoverId}_0`}, ${`va_${takeoverId}_1`}))`))
      .orderBy(sql`${liveSessions.createdAt} desc`);
    const row = rows.find((r) => r.providerSessionId === vaSessionId) ?? rows[0];
    if (!row?.ledgerId) return false;
    await ledger.settle(row.ledgerId, durationSec * VERIFY_PRICES.VA_USD_PER_SEC);
    return true;
  } catch (err) {
    vlog.warn("VA ledger settle failed", { takeoverId, err });
    return false;
  }
}

async function countInFlight(db: Db, exceptJobId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "verify_takeover"),
        inArray(jobs.status, ["pending", "running"]),
        ne(jobs.id, exceptJobId),
        sql`${jobs.state}->>'step' = 'await_transcript'`,
      ),
    );
  return Number(r?.n ?? 0);
}

const estAsyncUsd = (durationSec: number | null): number =>
  VERIFY_PRICES.CHANNELS * (durationSec ?? VERIFY_PRICES.CEILING_SEC) * VERIFY_PRICES.ASYNC_USD_PER_CH_SEC;

/** The webhook target, or null for poll-only (no secret, no public https origin: AssemblyAI cannot reach localhost). */
export function webhookTarget(cfg: { appUrl: string | null; webhookSecret: string | null }, jobId: string): { url: string; secret: string } | null {
  if (!cfg.appUrl || !cfg.webhookSecret) return null;
  let u: URL;
  try {
    u = new URL(cfg.appUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname) || u.hostname.endsWith(".local")) return null;
  return { url: `${u.origin}/api/webhooks/assemblyai?job=${encodeURIComponent(jobId)}`, secret: cfg.webhookSecret };
}

export const WEBHOOK_HEADER = "X-Baton-Webhook";

// ============================================================================================ steps

async function awaitArtifacts(p: Wp8Ports, s: VerifyState): Promise<StepResult> {
  const now = p.now();
  const sid = s.vaSessionId ?? (await takeoverVaSessionId(p.db(), s.takeoverId));
  if (!sid) throw new PermanentVerifyError("no_recording");
  const rec = await p.vaRest().getSession(sid);
  if (!artifactUrl(rec, "audio")) {
    const tries = s.tries + 1;
    if (tries >= VERIFY_TIMING.ARTIFACT_MAX_TRIES) throw new PermanentVerifyError("artifacts_timeout");
    return { state: { ...s, vaSessionId: sid, tries, failures: 0 }, next: { afterMs: VERIFY_TIMING.ARTIFACT_POLL_MS } };
  }
  const durationSec = typeof rec.duration_seconds === "number" && Number.isFinite(rec.duration_seconds) ? rec.duration_seconds : null;
  const vaSettled = s.vaSettled || (durationSec !== null && (await settleVa(p, s.takeoverId, sid, durationSec)));
  return { state: goto({ ...s, vaSessionId: sid, durationSec, vaSettled }, "submit", now), next: { afterMs: 0 } };
}

async function submit(p: Wp8Ports, jobId: string, s: VerifyState): Promise<StepResult> {
  const db = p.db();
  if ((await countInFlight(db, jobId)) >= VERIFY_TIMING.MAX_IN_FLIGHT) {
    const tries = s.tries + 1;
    if (tries >= VERIFY_TIMING.IN_FLIGHT_MAX_TRIES) throw new PermanentVerifyError("busy");
    return { state: { ...s, tries, failures: 0 }, next: { afterMs: VERIFY_TIMING.IN_FLIGHT_POLL_MS } };
  }
  const sid = s.vaSessionId;
  if (!sid) throw new PermanentVerifyError("no_recording");
  const ctx = await loadContext(db, s.takeoverId);
  const rec = await p.vaRest().getSession(sid); // fresh pre-signed URL (1 h TTL)
  const audioUrl = artifactUrl(rec, "audio");
  if (!audioUrl) throw new Error("the audio artifact is missing");
  const durationSec = s.durationSec ?? (typeof rec.duration_seconds === "number" ? rec.duration_seconds : null);

  const ledger = p.ledger();
  const cfg = p.config();
  let asyncLedgerId = s.asyncLedgerId;
  let reservedNow: string | null = null;
  if (!asyncLedgerId && ledger) {
    const r = await ledger.reserve({ provider: "aai_async", action: "verify_takeover", refId: s.takeoverId, estUsd: estAsyncUsd(durationSec), env: cfg.deployId });
    if (!r.ok) throw new PermanentVerifyError("budget");
    asyncLedgerId = reservedNow = r.id;
  }
  try {
    const hook = webhookTarget(cfg, jobId);
    const terms = s.keytermsDropped ? [] : keytermsOf(ctx.snapshot, ctx.policy);
    const base: TranscriptParams = {
      audio_url: audioUrl,
      speech_models: [SPEECH_MODEL],
      multichannel: true,
      ...(hook ? { webhook_url: hook.url, webhook_auth_header_name: WEBHOOK_HEADER, webhook_auth_header_value: hook.secret } : {}),
    };
    let keytermsDropped = s.keytermsDropped;
    let t: Transcript;
    try {
      t = await p.asyncClient().submit(terms.length ? { ...base, keyterms_prompt: terms } : base);
    } catch (err) {
      if (!(err instanceof AssemblyAIHttpError) || err.status !== 400 || !terms.length) throw err;
      vlog.warn("async submit rejected with keyterms; retrying without", { takeoverId: s.takeoverId, status: err.status });
      keytermsDropped = true;
      t = await p.asyncClient().submit(base);
    }
    await setVerificationTranscript(db, s.takeoverId, t.id);
    const next = goto(
      { ...s, durationSec, transcriptId: t.id, keyterms: terms.length > 0 && !keytermsDropped, keytermsDropped, webhook: !!hook, asyncLedgerId },
      "await_transcript",
      p.now(),
    );
    return { state: next, next: { afterMs: VERIFY_TIMING.TRANSCRIPT_POLL_MS } };
  } catch (err) {
    if (reservedNow && ledger) await ledger.release(reservedNow).catch(() => undefined);
    throw err;
  }
}

async function awaitTranscript(p: Wp8Ports, s: VerifyState): Promise<StepResult> {
  if (!s.transcriptId) throw new Error("no transcript id in state");
  const t = await p.asyncClient().get(s.transcriptId);
  if (t.status === "completed") return compute(p, goto(s, "compute", p.now()), t);
  if (t.status === "error") throw new PermanentVerifyError("transcript_error", t.error ?? undefined);
  if (p.now() - s.enteredAtMs >= VERIFY_TIMING.TRANSCRIPT_MAX_WAIT_MS) throw new PermanentVerifyError("transcript_timeout");
  return { state: { ...s, tries: s.tries + 1, failures: 0 }, next: { afterMs: VERIFY_TIMING.TRANSCRIPT_POLL_MS } };
}

async function compute(p: Wp8Ports, s: VerifyState, transcript: Transcript | null): Promise<StepResult> {
  if (!s.transcriptId || !s.vaSessionId) throw new Error("compute without a transcript or session id");
  const t = transcript ?? (await p.asyncClient().get(s.transcriptId));
  if (t.status !== "completed") throw new Error(`transcript is ${t.status}`);
  const computeQa = p.computeQa;
  if (!computeQa) throw new PermanentVerifyError("qa_not_wired");
  const db = p.db();
  const ctx = await loadContext(db, s.takeoverId);
  const rec = await p.vaRest().getSession(s.vaSessionId);
  const tlUrl = artifactUrl(rec, "timeline");
  const timeline = tlUrl ? ((await p.fetchJson(tlUrl)) as VaTimeline) : null;
  const durationSec = s.durationSec ?? (typeof rec.duration_seconds === "number" ? rec.duration_seconds : null);
  const input = buildQaInput({ ...ctx, transcript: t, timeline, durationSec });
  const qa = QaResultSchema.parse({ ...computeQa(input), provisional: false });
  const now = p.now();
  await markVerificationCompleted(db, s.takeoverId, qa, { transcriptId: t.id, audioDurationSec: t.audio_duration ?? null, now });
  // SAAS §7.1: the run's QA is now non-provisional, so `case.verified` goes to the outbox (a no-op until the run
  // carries an org). It never throws into the job: a failed emit must not fail a finished verification.
  await emitCaseVerified(db, { takeoverId: s.takeoverId, qa, appUrl: p.config().appUrl });
  const ledger = p.ledger();
  if (ledger && s.asyncLedgerId) {
    await ledger.settle(s.asyncLedgerId, billableSeconds(t, true) * VERIFY_PRICES.ASYNC_USD_PER_CH_SEC).catch((err: unknown) => vlog.warn("async ledger settle failed", { err }));
  }
  vlog.info("verified", { takeoverId: s.takeoverId, ms: now - s.startedAtMs, reAsked: qa.reAsked, keyterms: s.keyterms });
  return { state: { ...s, durationSec, reason: null }, next: "done" };
}

async function finalizeFailure(p: Wp8Ports, s: VerifyState, reason: string): Promise<void> {
  await markVerificationFailed(p.db(), s.takeoverId, reasonText(reason), { transcriptId: s.transcriptId, now: p.now() });
  const ledger = p.ledger();
  if (ledger && s.asyncLedgerId) {
    // No transcript (or AssemblyAI reported an error) → nothing billed. Otherwise assume it billed: settle at the estimate.
    const release = !s.transcriptId || reason === "transcript_error";
    await (release ? ledger.release(s.asyncLedgerId) : ledger.settle(s.asyncLedgerId, estAsyncUsd(s.durationSec))).catch(() => undefined);
  }
  vlog.warn("verification failed", { takeoverId: s.takeoverId, step: s.step, reason, err: s.lastError });
}

/** Strip query strings from URLs: an AssemblyAI download error can echo the pre-signed S3 URL (a 1 h credential). */
export const stripUrlQueries = (s: string): string => s.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1?…");
const errText = (err: unknown): string => stripUrlQueries(scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err))).slice(0, 300);

/** The `verify_takeover` step (register with WP2's runner). `ports` defaults to the live `wp8()` registry. */
export function createVerifyStep(ports: () => Wp8Ports = wp8): Parameters<JobRunner["register"]>[1] {
  return async (job) => {
    const p = ports();
    const s = normalizeVerifyState(job.state, job.refId, p.now());
    try {
      switch (s.step) {
        case "await_artifacts":
          return await awaitArtifacts(p, s);
        case "submit":
          return await submit(p, job.id, s);
        case "await_transcript":
          return await awaitTranscript(p, s);
        case "compute":
          return await compute(p, s, null);
      }
    } catch (err) {
      const failures = s.failures + 1;
      const lastError = errText(err);
      const permanent = err instanceof PermanentVerifyError;
      if (permanent || failures >= VERIFY_TIMING.MAX_STEP_FAILURES) {
        const reason = permanent ? err.reason : `${s.step}_failed`;
        const state: VerifyState = { ...s, failures, lastError, reason };
        await finalizeFailure(p, state, reason);
        return { state, next: "failed" };
      }
      return { state: { ...s, failures, lastError }, next: { afterMs: VERIFY_TIMING.RETRY_BACKOFF_MS * failures } };
    }
  };
}

// ============================================================================================ enqueue

/**
 * Enqueue F3 for a takeover (idempotent: an existing job for it is returned). Null when there is nothing to verify
 * (no VA session was ever opened) or no job runner is wired yet.
 */
export async function enqueueVerificationWith(
  p: Wp8Ports,
  takeoverId: string,
  vaSessionId: string | null,
  from: VerifyState["from"] = "end",
): Promise<string | null> {
  const db = p.db();
  const [tko] = await db.select({ id: takeovers.id, sid: takeovers.vaSessionId }).from(takeovers).where(eq(takeovers.id, takeoverId));
  if (!tko) return null;
  const sid = vaSessionId ?? tko.sid ?? null;
  if (!sid) return null;
  const existing = await findVerifyJob(db, takeoverId);
  if (existing) return existing.id;
  const runner = p.runner();
  if (!runner) {
    vlog.warn("verify_takeover not enqueued: no job runner wired", { takeoverId });
    return null;
  }
  await ensurePendingVerification(db, takeoverId);
  return runner.enqueue("verify_takeover", takeoverId, {
    runAfterMs: VERIFY_TIMING.FIRST_RUN_AFTER_MS,
    state: initialVerifyState(takeoverId, sid, from, p.now()),
  });
}

/** TASKS §2 `EnqueueVerification` (WP5's `/api/takeovers/[id]/end`; WP2's stale-VA handler). */
export const enqueueVerification: EnqueueVerification = (takeoverId, vaSessionId) => {
  ensureWp8Wired();
  return enqueueVerificationWith(wp8(), takeoverId, vaSessionId, "end");
};

/** For `registerStaleVaHandler` (F5): same as above, tagged `from: "sweeper"`. */
export const enqueueVerificationFromSweeper = (takeoverId: string, vaSessionId: string | null): Promise<void> => {
  ensureWp8Wired();
  return enqueueVerificationWith(wp8(), takeoverId, vaSessionId, "sweeper").then(() => undefined);
};

/** Register the step with the wired runner (idempotent). Runs on import, so WP2's `installBuiltinSteps` can import us. */
export function installVerifyTakeover(): void {
  ensureWp8Wired();
  wp8().runner()?.register("verify_takeover", createVerifyStep());
}
installVerifyTakeover();
