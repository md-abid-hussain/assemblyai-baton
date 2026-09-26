import { CreateCaseRequestV2Schema } from "@/core/contracts/v2";
import { CASE_RATES, getCasesDeps } from "@/server/cases";
import { createCase } from "@/server/cases/create";
import { enforce, json, readBody, route } from "@/server/cases/http";
import { caseTenantOf, checkRunBudget } from "@/server/cases/tenancy";
import { log } from "@/server/log";
import { getRelaysDeps } from "@/server/relays";

const caseLog = log.child({ component: "cases-route" });

/**
 * #3 POST /api/cases (DESIGN §4.4): visitor auth; 10/h/visitor, 30/h/ipKey (the v2 `run` bucket, PLATFORM §10.2).
 * v2: `relayId` / `relayVersionId` run a relay version (`src/server/cases/create.ts`).
 *
 * WP14b·4 (SAAS §7): still a **device** route — `/call/[id]` has no session — but the case is stamped with the
 * session principal's `org_id` / `created_by_user_id` when there is one, and the plan's `liveRunsPerDay` is
 * checked. Over plan the run is served as the labelled replay rather than refused (§4.2).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route("cases.create", async (req: Request) => {
  const d = getCasesDeps();
  const visitor = d.platform.requireVisitor(req);
  const { tenant } = await caseTenantOf(req);
  const body = await readBody(req, CreateCaseRequestV2Schema);
  await enforce(d.platform.rateLimiter(), [
    { ...CASE_RATES.createVisitor, key: visitor.visitorId, message: "Too many calls started from this browser in the last hour. Try again later." },
    { ...CASE_RATES.createIp, key: visitor.ipKey, message: "Too many calls started from this network in the last hour. Try again later." },
  ]);
  const budget = await checkRunBudget(tenant.orgId);
  if (!budget.ok) {
    // Plan limit reached. The v2 degradation path owns what a run does when it may not spend (the labelled
    // replay); this only makes the plan a reason for it, alongside the global cap.
    caseLog.info("live-run plan limit reached; the run is served as the labelled replay", {
      orgId: tenant.orgId, used: budget.used, limit: budget.limit,
    });
  }
  return json(await createCase({ ...d, relays: () => getRelaysDeps() }, body, visitor, tenant));
});
