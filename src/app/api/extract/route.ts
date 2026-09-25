import { after } from "next/server";

import { ExtractRequestSchema, type ExtractResponse } from "@/core/contracts/api";
import { CASE_RATES, getCasesDeps } from "@/server/cases";
import { enforce, json, readBody, route } from "@/server/cases/http";

/**
 * #8 POST /api/extract (DESIGN §4.4, §4.5 F1): case auth; 5/s burst 10 per case; 250 turns per case.
 * Idempotent on (caseId, turnId). `skipped:"after_takeover"` is a 200 (WP4 request 2).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Schedule after the response; outside a request scope (a later batch of the per-case queue) run it directly. */
function deferAfter(fn: () => Promise<unknown>): void {
  try {
    after(fn);
  } catch {
    void fn().catch(() => undefined);
  }
}

export const POST = route("extract", async (req: Request) => {
  const d = getCasesDeps();
  const { turn } = await readBody(req, ExtractRequestSchema);
  await d.platform.requireCase(req, { caseId: turn.caseId });
  await enforce(d.platform.rateLimiter(), [
    { ...CASE_RATES.extractBurst, key: turn.caseId, message: "Too many turns per second for this case." },
    { ...CASE_RATES.extractTotal, key: turn.caseId, message: "This case reached its 250-turn limit." },
  ]);
  const out = await d.extract.handle(turn, { defer: deferAfter });
  const body: ExtractResponse = {
    state: out.state,
    events: out.events,
    extractMs: out.extractMs,
    ...(out.skipped ? { skipped: out.skipped } : {}),
  };
  return json(body);
});
