import "server-only";

/**
 * Applying `org_entitlements.overrides` to a plan's limits (SAAS §4.1). WP21.
 *
 * `PLANS[plan].limits` is the one table. An override **raises a single limit for a single org** and is admin-only
 * and audited; it is never a fork of the table, and it is never allowed to *lower* a limit — a lowered limit
 * would be a silent, unauditable downgrade that no page explains, and §4.6 says downgrades are non-destructive
 * and go through `applyPlanChange`. So this module takes the maximum, per key, for numeric limits.
 *
 * `null` is "unlimited" for `overageUsdPerMin`, `secretTtlDays` and `publicationIdleHours`, which is why those are
 * handled by hand rather than by `Math.max`: `Math.max(null, 7)` is 7, i.e. the wrong direction for a TTL.
 */
import { PLANS, type PlanLimits } from "../../core/contracts/v3/plans";
import type { PlanId } from "../../core/contracts/v3/identity";

/** Keys where a bigger number is a bigger entitlement. */
const NUMERIC_KEYS = [
  "seats", "relays", "liveRunsPerDay", "aiMinutesPerMonth", "dryRunsPerDay", "voicedSimsPerDay", "draftsPerDay",
  "livePublications", "connectorHosts", "secrets", "apiKeys", "apiRatePerMin", "webhookEndpoints",
  "auditRetentionDays", "analyticsDays",
] as const satisfies readonly (keyof PlanLimits)[];

/** Keys where `null` means "no ceiling" and therefore beats every number. */
const NULL_IS_MORE = ["secretTtlDays", "publicationIdleHours"] as const satisfies readonly (keyof PlanLimits)[];

const SCOPE_RANK = { none: 0, build: 1, all: 2 } as const;

export type Overrides = Partial<Record<keyof PlanLimits, unknown>>;

/** Anything that is not a finite number is ignored: overrides are operator input, stored as loose JSON. */
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The plan's limits with the org's overrides applied, raising only. The result is a fresh frozen object, so no
 * caller can mutate the shared `PLANS` row by accident.
 */
export function applyOverrides(plan: PlanId, overrides: Overrides | null | undefined): PlanLimits {
  const base = PLANS[plan].limits;
  if (!overrides || typeof overrides !== "object" || Object.keys(overrides).length === 0) return base;
  const out: PlanLimits = { ...base };

  for (const key of NUMERIC_KEYS) {
    const n = asNumber(overrides[key]);
    if (n !== null && n > out[key]) out[key] = n;
  }
  for (const key of NULL_IS_MORE) {
    if (!(key in overrides)) continue;
    const v = overrides[key];
    if (v === null) out[key] = null;
    else {
      const n = asNumber(v);
      if (n !== null && out[key] !== null && n > (out[key] as number)) out[key] = n;
    }
  }
  // `overageUsdPerMin`: `null` means "blocked", so a *number* is the raise (billing beats blocking).
  if ("overageUsdPerMin" in overrides) {
    const n = asNumber(overrides.overageUsdPerMin);
    if (n !== null && n >= 0) out.overageUsdPerMin = n;
  }
  if (overrides.accountRequired === false) out.accountRequired = false;
  if (overrides.httpAction === true) out.httpAction = true;
  const scope = overrides.apiKeyScopes;
  if (scope === "build" || scope === "all" || scope === "none") {
    if (SCOPE_RANK[scope] > SCOPE_RANK[out.apiKeyScopes]) out.apiKeyScopes = scope;
  }
  return Object.freeze(out);
}

/** The count limits' human names, for the `E_PLAN_LIMIT` message ("Your Free plan includes 5 relays."). */
export const LIMIT_NOUNS: Record<string, string> = {
  seats: "seats",
  relays: "relays",
  livePublications: "live publications",
  secrets: "secrets",
  apiKeys: "API keys",
  webhookEndpoints: "webhook endpoints",
  connectorHosts: "connector hosts",
};
