import { BatonError } from "@/core/contracts/errors";
import { CASE_RATES, getCasesDeps } from "@/server/cases";
import { enforce, json, route } from "@/server/cases/http";
import { buildCaseView } from "@/server/cases/view";

/** #4 GET /api/cases/[caseId] (DESIGN §4.4): case auth; 120/min/case → CaseView. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route("cases.view", async (req: Request, ctx: { params: Promise<{ caseId: string }> }) => {
  const { caseId } = await ctx.params;
  if (!caseId) throw new BatonError("E_BAD_REQUEST", "Missing case id.");
  const d = getCasesDeps();
  await d.platform.requireCase(req, { caseId });
  await enforce(d.platform.rateLimiter(), [{ ...CASE_RATES.viewCase, key: caseId, message: "Too many case reads; slow down." }]);
  return json(await buildCaseView(d.repo, caseId));
});
