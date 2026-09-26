import "server-only";

/**
 * `GET /api/app/audit` — the audit read API (SAAS §9, §8.4). WP19·3.
 *
 * `?cursor&actor&action&from&to&limit`, admin+ (`audit:read`). The org is **not** a parameter: it is the
 * principal's, which is what makes "an admin of B cannot read A's log" a property of the route rather than of
 * every caller.
 *
 * The response carries `retentionDays` so the page can say "the Free plan keeps 7 days" next to an empty list
 * instead of implying nothing ever happened.
 */
import { readAuditPage, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } from "../audit/read";
import { retentionDaysFor } from "../audit/retention";
import { appPrincipal, appRoute, json, queryOf } from "./app-http";

export const listAudit = appRoute("app.audit.list", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "audit:read" });
  const rawLimit = Number(queryOf(req, "limit") ?? AUDIT_PAGE_DEFAULT);
  const page = await readAuditPage(p.orgId, {
    cursor: queryOf(req, "cursor"),
    actor: queryOf(req, "actor"),
    action: queryOf(req, "action"),
    from: queryOf(req, "from"),
    to: queryOf(req, "to"),
    limit: Number.isFinite(rawLimit) ? Math.min(rawLimit, AUDIT_PAGE_MAX) : AUDIT_PAGE_DEFAULT,
  });
  return json({ ...page, retentionDays: retentionDaysFor(p.plan) });
});
