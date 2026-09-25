import { VaTokenRequestSchema, type VaTokenResponse } from "@/core/contracts/api";
import { BatonError, isBatonError } from "@/core/contracts/errors";
import { mintVaToken } from "@/server/aai/tokens";
import { handler, json, readJson, requireCase } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDbAuthority, getLimitsAuthority, getRateLimiter, limitsConfigFromEnv, RATE, vaReservationUsd, vaSessionIdFor } from "@/server/limits";
import { enforceRates } from "@/server/limits/rate-limiter";
import { log } from "@/server/log";
import { withTakeoverLocked } from "@/server/runs/case-port";

/**
 * #10 POST /api/va/token (takeover token: `tko` = takeoverId). DESIGN §4.4 #10, §8.2.
 *
 * Keyed on the takeover, not only on case status. Allowed when the case is `armed` or `ai_active`, the takeover has
 * not ended, and either
 *   - `attempt=0 ∧ retries=0` within 30 s of `armed_at` (consumes the run's `held` slot, which becomes `open`), or
 *   - `attempt=1 ∧ retries=0` within 30 s of `last_failure_at`; `retries=1` is set atomically in the same
 *     transaction, and the failed attempt's slot (`va_<tko>_0`) is released FIRST, so the retry is never refused by
 *     its own zombie slot.
 * One slot per (takeover, attempt): a second mint for the same attempt is refused (409).
 * Limits: 4/h and 8/day per visitor, 12/h per ipKey; global slots ≤ VA_MAX_CONCURRENT.
 * → `{token (10 s window), expiresInSeconds:10, liveSessionId}` | ApiError(E_BUDGET | E_RATE_LIMITED | E_VA_CAPACITY |
 *   E_AAI_BALANCE | E_VA_TRANSIENT | E_CASE_STATE, fallback:"recorded_ai_session").
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VA_MINT_WINDOW_MS = 30_000;
const FALLBACK = { fallback: "recorded_ai_session" as const };
const vaLog = log.child({ component: "va-token" });

export const POST = handler("va-token", async (req) => {
  const body = await readJson(req, VaTokenRequestSchema);
  const auth = await requireCase(req, { takeoverId: body.takeoverId });
  await enforceRates(
    getRateLimiter(),
    [
      { spec: RATE.vaHourVisitor, key: auth.visitorId, message: "You've run several live AI takeovers this hour; the recorded AI session plays instead." },
      { spec: RATE.vaDayVisitor, key: auth.visitorId, message: "You've run today's live AI takeovers; the recorded AI session plays instead." },
      { spec: RATE.vaHourIp, key: auth.ipKey, message: "Several people on your network ran live AI takeovers this hour; the recorded AI session plays instead." },
    ],
    FALLBACK,
  );

  const nowMs = Date.now();
  const decision = await withTakeoverLocked(getDb(), body.takeoverId, async (t, c, markRetry) => {
    if (!t || !c) throw new BatonError("E_NOT_FOUND", "Unknown takeover.");
    if (t.caseId !== auth.caseId) throw new BatonError("E_FORBIDDEN", "This takeover belongs to another case.");
    if (c.status !== "armed" && c.status !== "ai_active") throw new BatonError("E_CASE_STATE", "The AI half is not armed for this case.", FALLBACK);
    if (t.endedAt) throw new BatonError("E_CASE_STATE", "This takeover has ended.", FALLBACK);
    if (c.runPlan?.aiHalf === "recorded") throw new BatonError("E_CASE_STATE", "This run plays the recorded AI session.", FALLBACK);
    if (body.attempt === 0) {
      if (t.retries !== 0 || nowMs - t.armedAt.getTime() > VA_MINT_WINDOW_MS) {
        throw new BatonError("E_CASE_STATE", "The live AI window for this pass has closed.", FALLBACK);
      }
      return { holdId: c.runPlan?.vaHoldId ?? null, runId: c.runPlan?.runId ?? null };
    }
    if (t.retries !== 0 || !t.lastFailureAt || nowMs - t.lastFailureAt.getTime() > VA_MINT_WINDOW_MS) {
      throw new BatonError("E_CASE_STATE", "The one retry for this pass is used or expired.", FALLBACK);
    }
    if (!(await markRetry())) throw new BatonError("E_CASE_STATE", "The one retry for this pass is already used.", FALLBACK);
    return { holdId: null, runId: c.runPlan?.runId ?? null };
  });

  const cfg = limitsConfigFromEnv();
  const authority = getLimitsAuthority();
  if (body.attempt === 1) await authority.release(vaSessionIdFor(body.takeoverId, 0), "retry");

  const acquireReq = {
    ...(decision.holdId ? { holdId: decision.holdId } : {}),
    takeoverId: body.takeoverId,
    attempt: body.attempt,
    capMs: cfg.vaCeilingMs,
    source: "judge" as const,
    deployId: cfg.deployId,
    caseId: auth.caseId,
    visitorId: auth.visitorId,
    ...(decision.runId ? { runId: decision.runId } : {}),
  };
  const dbA = getDbAuthority();
  const slot = dbA ? await dbA.vaAcquireDetailed(acquireReq) : await authority.vaAcquire(acquireReq);
  if (!slot.ok) throw new BatonError(slot.code, slot.message, FALLBACK);

  const hasReservation = "ledgerId" in slot ? slot.ledgerId !== null : !!decision.holdId;
  if (!hasReservation) {
    const r = await authority.ledger.reserve({ provider: "aai_va", action: `va_takeover_a${body.attempt}`, refId: slot.liveSessionId, estUsd: vaReservationUsd(cfg), env: cfg.deployId });
    if (!r.ok) {
      await authority.release(slot.liveSessionId, "ledger_denied");
      throw new BatonError("E_BUDGET", "Today's live AI budget is used up, so the recorded AI session plays instead.", FALLBACK);
    }
  }

  try {
    const t = await mintVaToken({ maxSessionDurationSeconds: cfg.vaCeilingMs / 1000 });
    vaLog.info("va token minted", { takeoverId: body.takeoverId, attempt: body.attempt, liveSessionId: slot.liveSessionId });
    return json({ token: t.token, expiresInSeconds: t.expiresInSeconds, liveSessionId: slot.liveSessionId } satisfies VaTokenResponse);
  } catch (e) {
    await authority.release(slot.liveSessionId, "mint_failed");
    if (isBatonError(e)) throw new BatonError(e.code, e.message, FALLBACK);
    throw e;
  }
});
