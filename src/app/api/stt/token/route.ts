import { SttTokenRequestSchema, type SttTokenResponse } from "@/core/contracts/api";
import { BatonError, isBatonError } from "@/core/contracts/errors";
import type { SlotResult } from "@/core/contracts/services";
import { mintSttToken } from "@/server/aai/tokens";
import { handler, json, readJson, requireCase } from "@/server/auth";
import { getDb } from "@/server/db";
import { getLimitsAuthority, getRateLimiter, limitsConfigFromEnv, RATE, sttReservationUsd } from "@/server/limits";
import { sttParamsFor } from "@/server/limits/stt-params";
import type { DbRateLimiter } from "@/server/limits/rate-limiter";
import { log } from "@/server/log";
import { getCallEntry, loadCaseRow } from "@/server/runs";
import { DEFAULT_CALL_DURATION_MS } from "@/server/runs/calls";

/**
 * #5 POST /api/stt/token (case token). DESIGN §2.3, §4.4, §5.1.6, §5.1.9.
 *
 * `{caseId, runId, n, channel?, ticket?, reconnect?}` → always HTTP 200 with a `SttTokenResponse`:
 *  - granted: one 10 s token for all n sessions, per-channel params, and our live-session ids by channel (G0);
 *  - queued (only while the broker ETA ≤ 15 s): poll again in `pollMs` with the ticket;
 *  - denied + `fallback:"cached_turn_replay"`: mode, budget, queue ETA, rate limit or balance, in plain words. An
 *    upstream mint failure is also a denial (never a bare 502): E_AAI_BALANCE for balance/credit texts, otherwise
 *    E_QUEUE_TIMEOUT ("no live slot right now").
 * Grants are rate limited per visitor (6/h) and per ipKey (15/h); queued polls do not count. Each granted session
 * gets its own ledger reservation (the remaining call time + the 30 s inactivity tail), settled by route #7.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 2000;
const denied = (code: Extract<SttTokenResponse, { status: "denied" }>["code"], message: string): SttTokenResponse => ({
  status: "denied",
  code,
  message,
  fallback: "cached_turn_replay",
});

export const POST = handler("stt-token", async (req) => {
  const body = await readJson(req, SttTokenRequestSchema);
  const auth = await requireCase(req, { caseId: body.caseId });
  const db = getDb();
  const c = await loadCaseRow(db, body.caseId);
  if (!c) throw new BatonError("E_NOT_FOUND", "Unknown case.");
  if (c.status !== "shadowing") throw new BatonError("E_CASE_STATE", "Live transcription ends when the baton is passed.");
  if (c.runPlan && c.runPlan.runId !== body.runId) throw new BatonError("E_FORBIDDEN", "This run is no longer current: reload the call.");

  const cfg = limitsConfigFromEnv();
  const authority = getLimitsAuthority();
  const limiter = getRateLimiter() as DbRateLimiter;

  // Rate limits count GRANTS: check first (read-only), record after a grant.
  for (const [spec, key, msg] of [
    [RATE.sttVisitor, auth.visitorId, "You've started several live runs this hour, so this one uses the labelled cached replay."],
    [RATE.sttIp, auth.ipKey, "Several people on your network ran live demos this hour, so this one uses the labelled cached replay."],
  ] as const) {
    const r = limiter.check ? await limiter.check(spec.bucket, key, spec.limit, spec.windowSec) : { ok: true, retryAfterSec: 0 };
    if (!r.ok) {
      if (body.ticket) await authority.sttCancel(body.ticket).catch(() => undefined);
      return json(denied("E_RATE_LIMITED", `${msg} Live again in ${Math.max(1, Math.ceil(r.retryAfterSec / 60))} min.`), {
        headers: { "retry-after": String(r.retryAfterSec) },
      });
    }
  }

  // `caseId` is an extra the DB authority stores on the rows (remote/file authorities ignore it).
  const acquireReq = {
    n: body.n,
    visitorId: auth.visitorId,
    ipKey: auth.ipKey,
    runId: body.runId,
    source: "judge" as const,
    deployId: cfg.deployId,
    caseId: body.caseId,
    ...(body.ticket ? { ticket: body.ticket } : {}),
    ...(body.reconnect ? { reconnect: true } : {}),
  };
  const slot: SlotResult = await authority.sttAcquire(acquireReq);
  if (slot.status === "queued") return json({ status: "queued", ticket: slot.ticket, position: slot.position, etaMs: slot.etaMs, pollMs: POLL_MS } satisfies SttTokenResponse);
  if (slot.status === "denied") return json(denied(slot.code, slot.message));

  const releaseAll = async (reason: string) => {
    for (const id of slot.sessionIds) await authority.release(id, reason).catch(() => undefined);
  };

  const call = await getCallEntry(c.callId);
  const perSessionUsd = sttReservationUsd(call?.durationMs ?? DEFAULT_CALL_DURATION_MS);
  for (const id of slot.sessionIds) {
    const r = await authority.ledger.reserve({ provider: "aai_stt", action: body.reconnect ? "stt_reconnect" : "stt_run", refId: id, estUsd: perSessionUsd, env: cfg.deployId });
    if (!r.ok) {
      await releaseAll("ledger_denied");
      return json(denied("E_BUDGET", "Today's live transcription budget is used up, so this run uses the labelled cached replay."));
    }
  }

  let minted: Awaited<ReturnType<typeof mintSttToken>>;
  try {
    minted = await mintSttToken();
  } catch (e) {
    await releaseAll("mint_failed");
    if (isBatonError(e) && e.code === "E_AAI_BALANCE") return json(denied("E_AAI_BALANCE", e.message));
    log.child({ component: "stt-token" }).warn("mint failed; denying with the cached replay", { caseId: body.caseId });
    return json(denied("E_QUEUE_TIMEOUT", "AssemblyAI didn't issue a live transcription token just now, so the labelled cached replay starts right away."));
  }

  await getRateLimiter().hit(RATE.sttVisitor.bucket, auth.visitorId, RATE.sttVisitor.limit, RATE.sttVisitor.windowSec);
  await getRateLimiter().hit(RATE.sttIp.bucket, auth.ipKey, RATE.sttIp.limit, RATE.sttIp.windowSec);

  const sessionIds: Extract<SttTokenResponse, { status: "granted" }>["sessionIds"] =
    body.n === 2 ? { rep: slot.sessionIds[0]!, customer: slot.sessionIds[1]! } : { [body.channel ?? "rep"]: slot.sessionIds[0]! };
  return json({
    status: "granted",
    token: minted.token,
    expiresAt: minted.expiresAt,
    params: { rep: sttParamsFor(call, c.policy, "rep"), customer: sttParamsFor(call, c.policy, "customer") },
    sessionIds,
  } satisfies SttTokenResponse);
});
