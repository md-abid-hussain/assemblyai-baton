import { StartRunRequestSchema } from "@/core/contracts/api";
import { handler, json, readJson, requireCase } from "@/server/auth";
import { getRateLimiter, RATE } from "@/server/limits";
import { enforceRates } from "@/server/limits/rate-limiter";
import { getRunService } from "@/server/runs";

/**
 * #5a POST /api/runs (case token; 10/h/visitor). `StartRunRequest {caseId, callId, express}` → `RunPlan` (D14):
 * `aiHalf:"live"` with a held VA slot + reserved VA budget, or `aiHalf:"recorded"` with a plain reason; `sttHalf`
 * from mode, budget and the broker ETA.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler("runs", async (req) => {
  const body = await readJson(req, StartRunRequestSchema);
  const auth = await requireCase(req, { caseId: body.caseId });
  await enforceRates(getRateLimiter(), [
    { spec: RATE.runsVisitor, key: auth.visitorId, message: "You've started several runs this hour; try again in a few minutes." },
  ]);
  return json(await getRunService().start({ ...body, visitorId: auth.visitorId, ipKey: auth.ipKey }));
});
