import "server-only";

/**
 * Who a case belongs to, and whether their plan still has room for it (SAAS §7 route table, §4.2). WP14b·4.
 *
 * `POST /api/cases` is the one org-aware route that **must keep working with no session at all**: `/call/[id]` is
 * the judge path and the public demo, and it has no account behind it. So this resolves with
 * `allowVisitor: true` — an org when the caller has one, nothing when they do not — and never 401s a visitor.
 *
 * The plan check is deliberately a **report, not a throw** (`Entitlements.checkRate`). Over `liveRunsPerDay` the
 * run degrades to the same labelled replay the global cap produces (§4.2), rather than failing: a judge who opens
 * the link after the day's allowance is gone should see a correct, labelled run, not an error page.
 */
import type { Principal } from "../../core/contracts/v3/identity";
import { log } from "../log";
import { getEntitlements } from "../saas/ports";
import { requirePrincipal } from "../saas/principal";
import type { CaseTenant } from "./create";

const tenancyLog = log.child({ component: "cases-tenancy" });

/** The tenant of a case-creating request. Empty on the device-only path, which is the v2 behaviour unchanged. */
export async function caseTenantOf(req: Request): Promise<{ tenant: CaseTenant; principal: Principal }> {
  const principal = await requirePrincipal(req, { allowVisitor: true });
  return {
    principal,
    // A device visitor under `TENANCY_MODE=legacy` has `orgId = ws_<visitorId>`, which is the workspace the v2
    // code already used, so stamping it changes nothing; under `orgs` a visitor has no org and the case has none.
    tenant: { orgId: principal.orgId, userId: principal.userId },
  };
}

export interface RunBudget {
  /** False → the run is served as the labelled replay (§4.2), never refused. */
  ok: boolean;
  used: number;
  limit: number;
}

/**
 * The plan's daily live-run allowance. Never throws: an entitlement lookup that fails must not cost a demo its
 * run, so an error reads as "in budget" and is logged. The hard stop is the v2 ledger, which is unchanged and
 * still authoritative (S8: no plan can raise a global cap).
 */
export async function checkRunBudget(orgId: string | null | undefined): Promise<RunBudget> {
  if (!orgId) return { ok: true, used: 0, limit: Number.POSITIVE_INFINITY };
  try {
    return await getEntitlements().checkRate(orgId, "liveRunsPerDay");
  } catch (err) {
    tenancyLog.warn("live-run entitlement check failed; treating the run as in budget", { orgId, err });
    return { ok: true, used: 0, limit: Number.POSITIVE_INFINITY };
  }
}
