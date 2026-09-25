import { SessionReportSchema } from "@/core/contracts/api";
import { BatonError } from "@/core/contracts/errors";
import { handler, json, readJson, requireCase } from "@/server/auth";
import { enforceRates } from "@/server/limits/rate-limiter";
import { getDbAuthority, getLimitsAuthority, getRateLimiter, RATE } from "@/server/limits";

/**
 * #7 POST /api/sessions/report (case token; 60/min/case). `SessionReport {sessionId (our live_sessions id), kind,
 * event: opened|closed, providerSessionId?, billedSeconds?, closeCode?}` → {ok:true}. Settles the ledger on
 * `closed` (billed seconds, else wall time + tail, else release). Sent on pagehide with a keepalive fetch (G0).
 * The session must belong to the token's case.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler("sessions-report", async (req) => {
  const auth = await requireCase(req);
  const body = await readJson(req, SessionReportSchema);
  await enforceRates(getRateLimiter(), [{ spec: RATE.reportCase, key: auth.caseId, message: "Too many session reports for this case." }]);
  const a = getDbAuthority();
  if (a) {
    const row = await a.session(body.sessionId);
    if (!row) throw new BatonError("E_NOT_FOUND", "Unknown session.");
    if (row.caseId !== auth.caseId) throw new BatonError("E_FORBIDDEN", "This session belongs to another case.");
    if (row.kind !== body.kind) throw new BatonError("E_BAD_REQUEST", "Session kind mismatch.");
  }
  await getLimitsAuthority().report(body);
  return json({ ok: true });
});
