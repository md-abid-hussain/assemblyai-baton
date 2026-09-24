/**
 * server/qa/routes.ts - the logic of WP8's routes (DESIGN §4.4), kept out of `src/app/**` so unit tests can call it
 * with injected ports:
 *  - #19 `POST /api/webhooks/assemblyai?job=` (header secret) → 200, then advances the job;
 *  - #20 `GET /api/verifications/[takeoverId]` (takeover token, 1/s) → `VerificationView`; advances the job if due;
 *  - #21 `GET /api/va-sessions/[vaSessionId]/audio` (takeover token, must own it; 30/min) → 302 to a fresh
 *    pre-signed OGG URL. `?t=12.5` becomes the media fragment `#t=12.5`: a query parameter would break the S3
 *    signature, and a fragment survives the redirect.
 */
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { AaiWebhookBodySchema, VerificationViewSchema, type VerificationView } from "../../core/contracts/api";
import { apiError, BatonError, ERROR_HTTP_STATUS, type ErrorCode } from "../../core/contracts/errors";
import { verifyWebhookHeader } from "../aai/async";
import { artifactUrl, VaRestError } from "../aai/va-rest";
import { jobs, takeovers, webhookEvents } from "../db/schema";
import { EnvError } from "../env";
import { log, scrub } from "../log";
import { normalizeVerifyState, reasonText, stripUrlQueries, WEBHOOK_HEADER } from "../jobs/verify-takeover";
import { bearerToken } from "./auth";
import { wp8, type Wp8Ports } from "./deps";
import { failureReason, findVerifyJob, loadVerification, markVerificationFailed } from "./verification";
import { ensureWp8Wired } from "./wiring";

const rlog = log.child({ component: "wp8-routes" });

export const RATE = {
  VERIFICATION: { limit: 1, windowSec: 1 },
  VA_AUDIO: { limit: 30, windowSec: 60 },
} as const;

// ============================================================================================ plumbing

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(code: ErrorCode, message: string, opts: { status?: number; retryAfterSec?: number } = {}): Response {
  const headers: Record<string, string> = {};
  if (opts.retryAfterSec !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(opts.retryAfterSec)));
  return jsonResponse(
    apiError(code, message, opts.retryAfterSec !== undefined ? { retryAfterMs: Math.max(0, opts.retryAfterSec * 1000) } : {}),
    { status: opts.status ?? ERROR_HTTP_STATUS[code], headers },
  );
}

/** BatonError → ApiError; EnvError → 503 (names only); anything else → a logged 500 that leaks nothing. */
export async function guarded(name: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BatonError) {
      return errorResponse(e.code, e.message, e.retryAfterMs !== undefined ? { retryAfterSec: e.retryAfterMs / 1000 } : {});
    }
    if (e instanceof EnvError) {
      rlog.error("route misconfigured", { route: name, err: e });
      return errorResponse("E_INTERNAL", "The server is missing configuration.", { status: 503 });
    }
    rlog.error("route failed", { route: name, err: e });
    return errorResponse("E_INTERNAL", "Something went wrong on our side.");
  }
}

async function limit(p: Wp8Ports, bucket: string, key: string, r: { limit: number; windowSec: number }): Promise<void> {
  const res = await p.rateLimiter().hit(bucket, key, r.limit, r.windowSec);
  if (!res.ok) throw new BatonError("E_RATE_LIMITED", "Too many requests: slow down.", { retryAfterMs: res.retryAfterSec * 1000 });
}

// ============================================================================================ #20

/** Build the view, advancing the job one step when it is due (DESIGN §4.5 caller (b)). */
export async function verificationView(p: Wp8Ports, takeoverId: string): Promise<VerificationView | null> {
  const db = p.db();
  const [tko] = await db.select({ endedAt: takeovers.endedAt }).from(takeovers).where(eq(takeovers.id, takeoverId));
  if (!tko) return null;
  let v = await loadVerification(db, takeoverId);
  if (!v) return null;
  let job = await findVerifyJob(db, takeoverId);
  if (v.status === "pending" && job) {
    const now = p.now();
    const runner = p.runner();
    const due = (job.status === "pending" || job.status === "running") && job.runAfter.getTime() <= now && (!job.leaseUntil || job.leaseUntil.getTime() < now);
    if (due && runner) {
      try {
        await runner.advance(job.id);
      } catch (err) {
        rlog.warn("advance from the status route failed", { takeoverId, err });
      }
      v = (await loadVerification(db, takeoverId)) ?? v;
      job = (await findVerifyJob(db, takeoverId)) ?? job;
    }
    // The runner marked the job failed (e.g. three DB-level throws) but the row is still pending: reconcile.
    if (v.status === "pending" && job.status === "failed") {
      const st = normalizeVerifyState(job.state, takeoverId, now);
      await markVerificationFailed(db, takeoverId, reasonText(st.reason ?? `${st.step}_failed`), { transcriptId: st.transcriptId, now });
      v = (await loadVerification(db, takeoverId)) ?? v;
    }
  }
  const since = tko.endedAt?.getTime() ?? job?.createdAt.getTime() ?? p.now();
  const view: VerificationView = {
    status: v.status,
    qa: v.status === "completed" && v.qa ? (v.qa as unknown as VerificationView["qa"]) : null,
    elapsedMs: Math.max(0, p.now() - since),
    ...(v.status === "failed" ? { reason: (await failureReason(db, takeoverId)) ?? reasonText(null) } : {}),
  };
  return VerificationViewSchema.parse(view);
}

export function handleVerificationGet(req: Request, takeoverId: string, ports?: Wp8Ports): Promise<Response> {
  return guarded("verifications", async () => {
    ensureWp8Wired();
    const p = ports ?? wp8();
    await p.authorizeTakeover(req, takeoverId);
    await limit(p, "verification", takeoverId, RATE.VERIFICATION);
    const view = await verificationView(p, takeoverId);
    if (!view) return errorResponse("E_NOT_FOUND", "There is no verification for this takeover.");
    return jsonResponse(view);
  });
}

// ============================================================================================ #19

export type Defer = (fn: () => Promise<void>) => void;

/**
 * AssemblyAI completion webhook. Answers 2xx fast (AssemblyAI wants it within 10 s; a 4xx is permanent), dedupes on
 * `aai:<transcript_id>:<status>`, makes the job due now, and advances it after the response (`defer`).
 */
export function handleAaiWebhook(req: Request, defer: Defer, ports?: Wp8Ports): Promise<Response> {
  return guarded("webhook-assemblyai", async () => {
    ensureWp8Wired();
    const p = ports ?? wp8();
    const { webhookSecret } = p.config();
    if (!webhookSecret || !verifyWebhookHeader(req.headers, WEBHOOK_HEADER, webhookSecret)) {
      return errorResponse("E_FORBIDDEN", "Webhook authentication failed.", { status: 401 });
    }
    const jobId = new URL(req.url).searchParams.get("job");
    if (!jobId) return errorResponse("E_BAD_REQUEST", "Missing job.");
    let body: { transcript_id: string; status: "completed" | "error" };
    try {
      const parsed = AaiWebhookBodySchema.safeParse(JSON.parse(await req.text()));
      if (!parsed.success) return errorResponse("E_BAD_REQUEST", "Unrecognised webhook body.");
      body = parsed.data;
    } catch {
      return errorResponse("E_BAD_REQUEST", "The webhook body is not JSON.");
    }
    const db = p.db();
    const eventId = `aai:${body.transcript_id}:${body.status}`;
    const inserted = await db
      .insert(webhookEvents)
      .values({ id: eventId, provider: "assemblyai", type: `transcript.${body.status}`, payload: { transcript_id: body.transcript_id, status: body.status, job: jobId } })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!inserted.length) return jsonResponse({ ok: true, duplicate: true });

    const fail = async (error: string) => {
      await db.update(webhookEvents).set({ processedAt: new Date(p.now()), error }).where(eq(webhookEvents.id, eventId));
      return jsonResponse({ ok: true, ignored: error });
    };
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job || job.kind !== "verify_takeover") return fail("unknown job");
    const st = normalizeVerifyState(job.state, job.refId, p.now());
    if (st.transcriptId !== body.transcript_id) return fail("transcript does not match the job");

    // Wake the job: due now (it may be sleeping on its 3 s poll).
    await db
      .update(jobs)
      .set({ runAfter: sql`now()` })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")));
    defer(async () => {
      let error: string | null = null;
      try {
        const runner = p.runner();
        if (runner) await runner.advance(jobId);
        else error = "no job runner wired";
      } catch (e) {
        error = stripUrlQueries(scrub(e instanceof Error ? e.message : String(e))).slice(0, 300);
      }
      await db.update(webhookEvents).set({ processedAt: new Date(p.now()), error }).where(eq(webhookEvents.id, eventId));
    });
    return jsonResponse({ ok: true });
  });
}

// ============================================================================================ #21

export function handleVaAudio(req: Request, vaSessionId: string, ports?: Wp8Ports): Promise<Response> {
  return guarded("va-audio", async () => {
    ensureWp8Wired();
    const p = ports ?? wp8();
    if (!bearerToken(req)) throw new BatonError("E_CASE_TOKEN", "Missing case token.");
    const [tko] = await p
      .db()
      .select({ id: takeovers.id })
      .from(takeovers)
      .where(eq(takeovers.vaSessionId, vaSessionId))
      .orderBy(sql`${takeovers.armedAt} desc`)
      .limit(1);
    if (!tko) return errorResponse("E_FORBIDDEN", "This recording does not belong to your takeover.");
    const who = await p.authorizeTakeover(req, tko.id);
    await limit(p, "va_audio", who.visitorId, RATE.VA_AUDIO);
    let url: string | null;
    try {
      url = artifactUrl(await p.vaRest().getSession(vaSessionId), "audio");
    } catch (e) {
      if (e instanceof VaRestError && e.notFound) return errorResponse("E_NOT_FOUND", "The recording no longer exists.");
      rlog.warn("session lookup failed", { err: e });
      return errorResponse("E_VA_TRANSIENT", "The recording service did not answer.", { status: 502 });
    }
    if (!url) return errorResponse("E_NOT_FOUND", "The recording is not ready yet.", { retryAfterSec: 3 });
    const t = Number(new URL(req.url).searchParams.get("t"));
    const location = Number.isFinite(t) && t > 0 ? `${url}#t=${Math.round(t * 1000) / 1000}` : url;
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  });
}
