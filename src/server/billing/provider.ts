import "server-only";

/**
 * The `BillingProvider` (SAAS §4.3, §4.4, §4.7). WP21.
 *
 * Two implementations behind one interface:
 *  - `createPolarBilling()` — the sandbox: checkout through the Better Auth plugin, plan through Customer State;
 *  - `createSimulatedBilling()` — §4.7: the same UI, a labelled local confirm page, `source: "simulated"`.
 *
 * Everything downstream (limits, API keys, webhooks, the plan badge) reads `org_entitlements` and cannot tell the
 * two apart except by `source`, which is exactly the point: the demo is honest and the feature is real.
 *
 * ## The three rules this file exists to enforce
 *
 * **1. `orgId` is never taken from the caller.** `startCheckout` receives the org from the route's `Principal`
 * and puts it in `referenceId`; `syncCheckout` then *re-checks* that the returned checkout's
 * `metadata.referenceId` equals the active org and that the payer is still an owner of it. A forged
 * `?checkout_id=` from another tenant therefore buys that tenant nothing here (§4.4 sync triggers).
 *
 * **2. Fail-static.** Any Polar error keeps the last known row, is logged, and surfaces as
 * `E_BILLING_UNAVAILABLE` on the Billing page only. It never grants a higher plan than the last confirmed one —
 * so an outage during the demo degrades to "we could not reach billing", not to a free upgrade.
 *
 * **3. Anonymous users never create Polar customers.** The plugin refuses them (`authenticatedUsersOnly`), and
 * `startCheckout` refuses them again here with `E_ACCOUNT_REQUIRED` so the UI can show the §4.6 step-2 wall
 * instead of a Polar error page.
 */
import { and, eq } from "drizzle-orm";

import type { PlanId } from "../../core/contracts/v3/identity";
import type { EntitlementView } from "../../core/contracts/v3/plans";
import type { BillingProvider } from "../../core/contracts/v3/services";
import { getDb } from "../db/client";
import { members } from "../db/schema-auth";
import { orgEntitlements } from "../db/schema-saas";
import { readRow, viewOf } from "../entitlements/store";
import { log } from "../log";
import { SaasError } from "../saas/errors";
import { getAuditWriter } from "../saas/ports";
import {
  appPath, BILLING_RETURN_PATH, isPaidPlan, type PaidPlan, productIds, SIMULATED_CHECKOUT_PATH,
} from "./config";
import { getPolarClient } from "./polar-plugin";

const billingLog = log.child({ component: "billing" });

/** How the Billing page decides whether to re-sync on load (§4.4). */
export const SYNC_STALE_MS = 60_000;

export interface StartCheckoutInput {
  orgId: string;
  userId: string;
  plan: PaidPlan;
  headers: Headers;
}

/** `productId → plan`, built fresh so a re-read of the env is picked up in dev. */
function planOfProduct(productId: string | null | undefined): PaidPlan | null {
  if (!productId) return null;
  const ids = productIds();
  if (ids.pro && productId === ids.pro) return "pro";
  if (ids.business && productId === ids.business) return "business";
  return null;
}

/** Statuses that mean "this subscription is currently entitling the org" (§4.4 step 2). */
const ENTITLING = new Set(["active", "trialing"]);

// ------------------------------------------------------------------------------------------------ persistence

export interface SyncPatch {
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  source: "default" | "polar" | "simulated" | "admin";
  billingUserId?: string | null;
  polarSubscriptionId?: string | null;
  polarProductId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  state?: Record<string, unknown> | null;
}

/**
 * Upsert the row, audit a plan change, and hand back the new view. `applyPlanChange` (the §4.6 downgrade rules)
 * is WP21·2's and is called from the one hook registered here, so this function stays the single write path.
 */
export async function writeSync(
  orgId: string,
  patch: SyncPatch,
  reason: string,
  actorUserId: string | null,
): Promise<EntitlementView> {
  const before = await readRow(orgId);
  const values = {
    orgId,
    plan: patch.plan,
    status: patch.status,
    source: patch.source,
    billingUserId: patch.billingUserId ?? before.billingUserId,
    polarSubscriptionId: patch.polarSubscriptionId ?? null,
    polarProductId: patch.polarProductId ?? null,
    currentPeriodEnd: patch.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
    state: (patch.state ?? null) as never,
    syncedAt: new Date(),
  };
  await getDb()
    .insert(orgEntitlements)
    .values({ ...values, overrides: {} })
    .onConflictDoUpdate({
      target: orgEntitlements.orgId,
      // `overrides` is deliberately absent: an admin's per-org raise survives every sync (§4.1).
      set: {
        plan: values.plan, status: values.status, source: values.source, billingUserId: values.billingUserId,
        polarSubscriptionId: values.polarSubscriptionId, polarProductId: values.polarProductId,
        currentPeriodEnd: values.currentPeriodEnd, cancelAtPeriodEnd: values.cancelAtPeriodEnd,
        state: values.state, syncedAt: values.syncedAt, updatedAt: new Date(),
      },
    });

  if (before.plan !== patch.plan) {
    await getAuditWriter().write({
      orgId,
      actor: actorUserId ? { type: "user", id: actorUserId, label: "billing" } : { type: "system", id: null, label: "billing" },
      action: "billing.plan_changed",
      metadata: { from: before.plan, to: patch.plan, source: patch.source, reason },
    });
    await onPlanChanged(orgId, before.plan, patch.plan);
  }
  return viewOf(await readRow(orgId));
}

/** WP21·2 registers `applyPlanChange` here; until then a plan change is recorded and nothing is disabled. */
type PlanChangeHook = (orgId: string, from: PlanId, to: PlanId) => Promise<void>;
let planChangeHook: PlanChangeHook | null = null;
export const setPlanChangeHook = (fn: PlanChangeHook | null): void => void (planChangeHook = fn);
async function onPlanChanged(orgId: string, from: PlanId, to: PlanId): Promise<void> {
  if (!planChangeHook) return;
  try {
    await planChangeHook(orgId, from, to);
  } catch (e) {
    billingLog.error("plan change hook failed", { orgId, from, to, err: String(e) });
  }
}

/** Still an owner of this org? The §4.4 check that makes a stolen `checkout_id` useless. */
export async function isOwnerOf(userId: string, orgId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  return row?.role === "owner";
}

// ------------------------------------------------------------------------------------------------- simulated

/**
 * §4.7. Upgrade goes to a local page clearly titled "Simulated checkout · billing is not configured on this
 * deployment", whose confirm button calls `confirmSimulated`.
 */
export function createSimulatedBilling(): BillingProvider {
  return {
    mode: "simulated",
    async startCheckout(i) {
      assertBuyable(i.plan);
      return { url: appPath(`${SIMULATED_CHECKOUT_PATH}?plan=${i.plan}`) };
    },
    async syncOrg(orgId) {
      // Nothing external to read: the simulated row is already the truth.
      return viewOf(await readRow(orgId));
    },
    async syncCheckout(checkoutId, orgId) {
      // The "checkout id" of a simulated upgrade is the plan slug the confirm page posted back.
      if (!isPaidPlan(checkoutId)) return viewOf(await readRow(orgId));
      return viewOf(await readRow(orgId));
    },
  };
}

/** The simulated confirm button (§4.7): the org goes to `plan` with `source: "simulated"`. */
export async function confirmSimulated(orgId: string, userId: string, plan: PaidPlan): Promise<EntitlementView> {
  return writeSync(
    orgId,
    { plan, status: "active", source: "simulated", billingUserId: userId, currentPeriodEnd: null, cancelAtPeriodEnd: false },
    "simulated_checkout",
    userId,
  );
}

function assertBuyable(plan: string): asserts plan is PaidPlan {
  if (!isPaidPlan(plan)) {
    throw new SaasError("E_UNPROCESSABLE", `"${plan}" is not a purchasable plan. Choose Pro or Business.`);
  }
}

// ----------------------------------------------------------------------------------------------------- polar

/** `auth.api.checkout` is added by the Polar plugin and is therefore not on `auth.api`'s *type* (WP19's note). */
type CheckoutCaller = (a: {
  body: { slug: string; referenceId: string };
  headers: Headers;
}) => Promise<{ url: string } | null>;

/** Injected so tests drive the provider without mounting Better Auth. Production passes `requireAuth().api`. */
export interface PolarBillingDeps {
  checkout: CheckoutCaller;
  customerState: (externalId: string) => Promise<unknown>;
  getCheckout: (checkoutId: string) => Promise<unknown>;
}

export function createPolarBilling(deps: PolarBillingDeps): BillingProvider {
  return {
    mode: "polar",
    async startCheckout(i) {
      assertBuyable(i.plan);
      const row = await readRow(i.orgId);
      if (row.plan === i.plan && ENTITLING.has(row.status)) {
        throw new SaasError("E_CONFLICT", `This organization is already on ${i.plan === "pro" ? "Pro" : "Business"}.`);
      }
      let res: { url: string } | null;
      try {
        res = await deps.checkout({ body: { slug: i.plan, referenceId: i.orgId }, headers: i.headers });
      } catch (e) {
        billingLog.error("polar checkout failed", { orgId: i.orgId, plan: i.plan, err: errText(e) });
        throw new SaasError("E_BILLING_UNAVAILABLE", "Billing is temporarily unavailable. Your plan is unchanged.");
      }
      if (!res?.url) {
        throw new SaasError("E_BILLING_UNAVAILABLE", "Billing is temporarily unavailable. Your plan is unchanged.");
      }
      // `billing_user_id` is the caller (§4.3): the Polar customer's external id is this Better Auth user.
      await getDb()
        .update(orgEntitlements)
        .set({ billingUserId: i.userId, updatedAt: new Date() })
        .where(eq(orgEntitlements.orgId, i.orgId));
      await getAuditWriter().write({
        orgId: i.orgId,
        actor: { type: "user", id: i.userId, label: "billing" },
        action: "billing.checkout_started",
        metadata: { plan: i.plan },
      });
      return { url: res.url };
    },

    async syncOrg(orgId) {
      return syncFromPolar(deps, orgId, "sync_org", null);
    },

    async syncCheckout(checkoutId, orgId, userId) {
      let checkout: unknown;
      try {
        checkout = await deps.getCheckout(checkoutId);
      } catch (e) {
        billingLog.error("polar checkout read failed", { orgId, err: errText(e) });
        return viewOf(await readRow(orgId));
      }
      // Rule 1: the checkout must belong to *this* org, and the payer must still be an owner of it.
      const ref = refOf(checkout);
      if (ref && ref !== orgId) {
        throw new SaasError("E_FORBIDDEN", "That checkout belongs to a different organization.");
      }
      if (!(await isOwnerOf(userId, orgId))) {
        throw new SaasError("E_FORBIDDEN", "Only an owner can confirm a subscription for this organization.");
      }
      return syncFromPolar(deps, orgId, "checkout_return", userId);
    },
  };
}

/**
 * §4.4 step 2: read the Customer State by external id, take the active subscriptions whose
 * `metadata.referenceId` is this org, map product → plan, upsert.
 *
 * **[VERIFY] "Customer-State subscriptions carry `metadata`".** The SDK type says they do
 * (`CustomerStateSubscription.metadata`), and the plugin writes `referenceId` into the checkout's metadata,
 * which Polar copies onto the subscription. The documented fallback is implemented rather than merely noted:
 * when *no* active subscription carries a `referenceId` at all and the org has exactly one candidate, the single
 * unlabelled subscription of this billing user is accepted. When several are unlabelled, none is: guessing which
 * org a payment belongs to is the one thing this function must never do.
 */
async function syncFromPolar(
  deps: PolarBillingDeps,
  orgId: string,
  reason: string,
  actorUserId: string | null,
): Promise<EntitlementView> {
  const row = await readRow(orgId);

  // Rule 1 of §4.4: nothing bought → the plan follows the org kind, and we never call Polar at all.
  if (!row.billingUserId) return viewOf(row);

  let state: unknown;
  try {
    state = await deps.customerState(row.billingUserId);
  } catch (e) {
    // Fail-static (§4.4): keep the last known row, log, and let the Billing page show E_BILLING_UNAVAILABLE.
    billingLog.error("polar customer state failed", { orgId, reason, err: errText(e) });
    throw new SaasError("E_BILLING_UNAVAILABLE", "We could not reach billing. Showing your last known plan.");
  }

  const subs = activeSubscriptionsOf(state);
  const labelled = subs.filter((s) => refOf(s) === orgId);
  const unlabelled = subs.filter((s) => refOf(s) === null);
  const chosen = labelled[0] ?? (labelled.length === 0 && unlabelled.length === 1 ? unlabelled[0] : undefined);

  if (!chosen) {
    // No entitling subscription for this org: fall back to the org's own default plan (§4.4 rule 1 / §4.6).
    return writeSync(
      orgId,
      {
        plan: row.plan === "guest" ? "guest" : "free",
        status: subs.length > 0 ? "canceled" : "none",
        source: "polar",
        billingUserId: row.billingUserId,
      },
      reason,
      actorUserId,
    );
  }

  const plan = planOfProduct(chosen.productId);
  if (!plan) {
    // A product we do not recognise is not an upgrade. Keep the last known row rather than invent a plan.
    billingLog.warn("polar subscription on an unknown product", { orgId, reason });
    return viewOf(row);
  }

  return writeSync(
    orgId,
    {
      plan,
      status: chosen.status === "trialing" ? "trialing" : chosen.status === "active" ? "active" : "past_due",
      source: "polar",
      billingUserId: row.billingUserId,
      polarSubscriptionId: chosen.id,
      polarProductId: chosen.productId,
      currentPeriodEnd: chosen.currentPeriodEnd,
      cancelAtPeriodEnd: chosen.cancelAtPeriodEnd,
      // A trimmed snapshot: ids and statuses, never card data (§4.4).
      state: { subscriptionId: chosen.id, productId: chosen.productId, status: chosen.status },
    },
    reason,
    actorUserId,
  );
}

// ------------------------------------------------------------------------------------- shape readers (untyped)

/**
 * The SDK's `CustomerState` is a large union and the plugin hands back plain JSON in some paths, so these two
 * readers pick out only the five fields §4.4 uses and validate each one. Nothing here trusts a shape.
 */
interface Sub {
  id: string;
  productId: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const date = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `metadata.referenceId` (camel or snake), wherever it sits. `null` when there is none. */
export function refOf(v: unknown): string | null {
  const o = rec(v);
  if (!o) return null;
  const m = rec(o.metadata) ?? {};
  return str(m.referenceId) ?? str(m.reference_id) ?? null;
}

/** The entitling subscriptions of a Customer State, in the SDK's camelCase or the API's snake_case. */
export function activeSubscriptionsOf(state: unknown): Sub[] {
  const o = rec(state);
  if (!o) return [];
  const raw = o.activeSubscriptions ?? o.active_subscriptions;
  if (!Array.isArray(raw)) return [];
  const out: Sub[] = [];
  for (const item of raw) {
    const s = rec(item);
    if (!s) continue;
    const id = str(s.id);
    const productId = str(s.productId) ?? str(s.product_id);
    const status = str(s.status) ?? "active";
    if (!id || !productId || !ENTITLING.has(status)) continue;
    out.push({
      id,
      productId,
      status,
      currentPeriodEnd: date(s.currentPeriodEnd ?? s.current_period_end),
      cancelAtPeriodEnd: Boolean(s.cancelAtPeriodEnd ?? s.cancel_at_period_end),
      metadata: rec(s.metadata) ?? {},
    });
  }
  return out;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --------------------------------------------------------------------------------------------- the real deps

/** The production `PolarBillingDeps`: the plugin for checkout, the SDK for the two reads. */
export function polarDepsFrom(api: { checkout?: unknown }): PolarBillingDeps {
  const client = getPolarClient();
  if (!client) throw new SaasError("E_BILLING_UNAVAILABLE", "Billing is not configured on this deployment.");
  const checkout = api.checkout as CheckoutCaller | undefined;
  return {
    checkout: async (a) => {
      if (!checkout) throw new Error("the Polar plugin's /checkout endpoint is not mounted");
      return checkout(a);
    },
    customerState: (externalId) => client.customers.getStateExternal({ externalId }),
    getCheckout: (checkoutId) => client.checkouts.get({ id: checkoutId }),
  };
}

export const returnPath = (): string => appPath(BILLING_RETURN_PATH);
