import "server-only";

/**
 * The database `Entitlements` (SAAS §4.2, §4.4). WP21.
 *
 * It replaces the C3 default in `src/server/saas/ports.ts`, which derived everything from `PLANS` and the org id.
 * The contract is unchanged, so every caller — `assertCount` before a $0 create, `checkRate` before a paid
 * action — keeps working exactly as it did; what changes is that the plan now comes from `org_entitlements`,
 * overrides are applied, and `refresh` can reach Polar.
 *
 * **`get` never blocks on Polar** (§4.4). It is one indexed read of one row, it is on the path of every limit
 * check, and a Polar outage must not slow down or fail an unrelated create. `refresh` is the only method that may
 * call out, and even that one is fail-static (see `billing/provider.ts`): an error keeps the last known row and
 * never grants a higher plan than the last confirmed one.
 *
 * A missing row is not an error. Orgs created outside `createOrg` (and every legacy `ws_<visitorId>` workspace)
 * read as their `org_meta.kind` default — guest for a guest workspace, free otherwise — which is exactly rule 1
 * of §4.4 and keeps the v2 path working while `TENANCY_MODE=legacy`.
 */
import { eq } from "drizzle-orm";

import type { PlanId } from "../../core/contracts/v3/identity";
import { PLANS, type CountLimitKey, type EntitlementView, type RateLimitKey } from "../../core/contracts/v3/plans";
import type { Entitlements } from "../../core/contracts/v3/services";
import type { UsageSummary } from "../../core/contracts/v3/usage";
import { getDb } from "../db/client";
import { orgEntitlements, orgMeta } from "../db/schema-saas";
import { SaasError } from "../saas/errors";
import { countOrg, getUsageMeter } from "../saas/ports";
import { applyOverrides, LIMIT_NOUNS, type Overrides } from "./limits";

/** Which usage number each rate limit is measured against (SAAS §4.1, §4.5) — the §4.5 split, not a blend. */
export const RATE_USED: Record<RateLimitKey, (s: UsageSummary) => number> = {
  liveRunsPerDay: (s) => s.today.liveRuns,
  dryRunsPerDay: (s) => s.today.dryRuns,
  voicedSimsPerDay: (s) => s.today.voicedSims,
  draftsPerDay: (s) => s.today.drafts,
  // Simulated minutes are free (§4.5): only recorded and published minutes draw on the allowance.
  aiMinutesPerMonth: (s) => s.aiMinutes.recorded + s.aiMinutes.published,
};

const PLAN_IDS = ["guest", "free", "pro", "business"] as const;
const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);

const STATUSES = ["active", "trialing", "past_due", "canceled", "none"] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (v: unknown): v is Status => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

const SOURCES = ["default", "polar", "simulated", "admin"] as const;
type Source = (typeof SOURCES)[number];
const isSource = (v: unknown): v is Source => typeof v === "string" && (SOURCES as readonly string[]).includes(v);

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : String(d);

/** The row as the rest of the layer needs it, before overrides are applied. */
export interface EntitlementRow {
  orgId: string;
  plan: PlanId;
  status: Status;
  source: Source;
  billingUserId: string | null;
  polarSubscriptionId: string | null;
  polarProductId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  overrides: Overrides;
  syncedAt: string | null;
}

/** `Entitlements.get` in row form, plus the fields only billing cares about. Always resolves. */
export async function readRow(orgId: string): Promise<EntitlementRow> {
  const [row] = await getDb()
    .select({
      plan: orgEntitlements.plan,
      status: orgEntitlements.status,
      source: orgEntitlements.source,
      billingUserId: orgEntitlements.billingUserId,
      polarSubscriptionId: orgEntitlements.polarSubscriptionId,
      polarProductId: orgEntitlements.polarProductId,
      currentPeriodEnd: orgEntitlements.currentPeriodEnd,
      cancelAtPeriodEnd: orgEntitlements.cancelAtPeriodEnd,
      overrides: orgEntitlements.overrides,
      syncedAt: orgEntitlements.syncedAt,
      kind: orgMeta.kind,
    })
    .from(orgEntitlements)
    .leftJoin(orgMeta, eq(orgMeta.orgId, orgEntitlements.orgId))
    .where(eq(orgEntitlements.orgId, orgId))
    .limit(1);

  if (!row) return missingRow(orgId, await kindOf(orgId));

  const plan = isPlanId(row.plan) ? row.plan : defaultPlanFor(row.kind);
  return {
    orgId,
    plan,
    status: isStatus(row.status) ? row.status : plan === "guest" ? "none" : "active",
    source: isSource(row.source) ? row.source : "default",
    billingUserId: row.billingUserId ?? null,
    polarSubscriptionId: row.polarSubscriptionId ?? null,
    polarProductId: row.polarProductId ?? null,
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
    overrides: (row.overrides ?? {}) as Overrides,
    syncedAt: iso(row.syncedAt),
  };
}

/** §4.4 rule 1: with nothing bought, the plan follows the org kind. A legacy `ws_…` workspace is a guest. */
export const defaultPlanFor = (kind: string | null | undefined): PlanId => (kind === "guest" ? "guest" : "free");

async function kindOf(orgId: string): Promise<string | null> {
  if (orgId.startsWith("ws_")) return "guest";
  const [row] = await getDb().select({ kind: orgMeta.kind }).from(orgMeta).where(eq(orgMeta.orgId, orgId)).limit(1);
  return row?.kind ?? null;
}

function missingRow(orgId: string, kind: string | null): EntitlementRow {
  const plan = defaultPlanFor(kind);
  return {
    orgId, plan,
    status: plan === "guest" ? "none" : "active",
    source: "default",
    billingUserId: null, polarSubscriptionId: null, polarProductId: null,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, overrides: {}, syncedAt: null,
  };
}

/** The row as `EntitlementView`, with overrides applied. */
export function viewOf(row: EntitlementRow): EntitlementView {
  return {
    orgId: row.orgId,
    plan: row.plan,
    status: row.status,
    source: row.source,
    limits: applyOverrides(row.plan, row.overrides),
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    syncedAt: row.syncedAt,
  };
}

/**
 * The `E_PLAN_LIMIT` a $0 create gets when it is over a count limit (§4.2). The message is the one §4.2 quotes,
 * and `extra.limit` carries `{limit, plan, upgradeUrl}` for the UI's Upgrade button.
 */
export function planLimitError(plan: PlanId, key: CountLimitKey, used: number, limit: number): SaasError {
  const noun = LIMIT_NOUNS[key] ?? key;
  return new SaasError(
    "E_PLAN_LIMIT",
    `Your ${PLANS[plan].name} plan includes ${limit} ${noun}. Upgrade, or remove one.`,
    { extra: { limit: { key, used, limit, plan, upgradeUrl: "/app/settings/billing" } } },
  );
}

/** The refresh hook billing registers; `null` (the default) makes `refresh` a plain re-read. */
type Refresher = ((orgId: string, reason: string) => Promise<void>) | null;
let refresher: Refresher = null;
export const setEntitlementRefresher = (fn: Refresher): void => void (refresher = fn);

/** The DB-backed `Entitlements`. Registered into the port registry by `src/server/billing/register.ts`. */
export function createDbEntitlements(): Entitlements {
  const get = async (orgId: string): Promise<EntitlementView> => viewOf(await readRow(orgId));
  return {
    get,
    async assertCount(orgId, key) {
      const view = await get(orgId);
      const limit = view.limits[key];
      const used = await countOrg(orgId, key);
      if (used >= limit) throw planLimitError(view.plan, key, used, limit);
    },
    async checkRate(orgId, key, add = 1) {
      const { limits } = await get(orgId);
      const limit = limits[key];
      const used = RATE_USED[key](await getUsageMeter().summary(orgId));
      return { ok: used + add <= limit, used, limit };
    },
    async refresh(orgId, reason) {
      // Fail-static: a refresher error is swallowed here and the last known row is returned (§4.4). The provider
      // has already logged it and it surfaces as `E_BILLING_UNAVAILABLE` on the Billing page only.
      if (refresher) {
        try {
          await refresher(orgId, reason);
        } catch {
          /* keep the last known row */
        }
      }
      return get(orgId);
    },
  };
}
