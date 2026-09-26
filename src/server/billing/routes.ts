import "server-only";

/**
 * The `/api/app/billing/**` handlers (SAAS §4.3, §4.6, §4.7). WP21.
 *
 * Kept out of `src/app/**` so they are testable with a plain `Request`, and so the `route.ts` files stay
 * one-line re-exports — the shape WP19 and WP14b already use.
 *
 * | route | need | what it does |
 * |---|---|---|
 * | `GET  /api/app/billing` | `billing:read` | the Billing page's whole state; syncs when stale or on return |
 * | `POST /api/app/billing/checkout` | `billing:manage`, `account` | `{plan}` → `{url}` (sandbox or simulated) |
 * | `POST /api/app/billing/simulated` | `billing:manage`, `account` | §4.7's confirm button |
 *
 * **Every one of them calls `requirePrincipal`, and none of them reads an org id from the request.** That is the
 * §10.1 rule 3 that makes a forged `referenceId` worthless: the checkout is created for the principal's org, and
 * the return is re-checked against the principal's org.
 */
import { PLANS } from "../../core/contracts/v3/plans";
import type { EntitlementView } from "../../core/contracts/v3/plans";
import type { Principal } from "../../core/contracts/v3/identity";
import { installIdentity } from "../identity";
import { readRow, viewOf } from "../entitlements/store";
import { log } from "../log";
import { isSaasError, SaasError, saasErrorResponse } from "../saas/errors";
import { requirePrincipal } from "../saas/principal";
import { billingMode, isPaidPlan, PAID_PLANS, type PaidPlan } from "./config";
import { getBilling } from "./register";
import { confirmSimulated, isOwnerOf, SYNC_STALE_MS } from "./provider";

const routeLog = log.child({ component: "billing" });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** One place turns a thrown `SaasError` into the §6.3 envelope; anything else is a 500 with no internals. */
async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (isSaasError(e)) return saasErrorResponse(e);
    routeLog.error("billing route failed", { err: e instanceof Error ? e.message : String(e) });
    return saasErrorResponse(new SaasError("E_BILLING_UNAVAILABLE", "Billing is temporarily unavailable."));
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function planFrom(body: Record<string, unknown>): PaidPlan {
  const plan = body.plan;
  if (!isPaidPlan(plan)) {
    throw new SaasError("E_VALIDATION", `"plan" must be one of ${PAID_PLANS.join(", ")}.`, {
      issues: [{ path: ["plan"], message: `expected one of ${PAID_PLANS.join(", ")}` }],
    });
  }
  return plan;
}

// ------------------------------------------------------------------------------------------------------ view

/** Exactly what the Billing page and `plan-notice.tsx` render. Plain data: no Polar object ever reaches a client. */
export interface BillingView {
  mode: "polar" | "simulated";
  orgId: string;
  plan: EntitlementView["plan"];
  planName: string;
  status: EntitlementView["status"];
  source: EntitlementView["source"];
  /** "Pro · Test mode (Polar sandbox) — no real money" / "Pro · simulated" (§4.6, §4.7). */
  badge: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  syncedAt: string | null;
  /** The org's current limits, overrides already applied — the page renders these, never `PLANS` directly. */
  limits: EntitlementView["limits"];
  /** Upgrade targets, most useful first. Empty on Business. */
  upgrades: { plan: PaidPlan; name: string; priceUsdMonthly: number | null }[];
  /** Only an owner sees the buttons; everyone with `billing:read` sees the plan. */
  canManage: boolean;
  /** `true` when the last sync failed: the page shows the fail-static notice (§4.4). */
  unavailable: boolean;
}

/** The plan badge (§4.6 step 5, §4.7). One function, so the page and the API can never word it differently. */
export function badgeFor(view: { plan: EntitlementView["plan"]; source: EntitlementView["source"] }): string {
  const name = PLANS[view.plan].name;
  if (view.source === "simulated") return `${name} · simulated`;
  if (view.source === "polar") return `${name} · Test mode (Polar sandbox) — no real money`;
  return name;
}

function upgradesFor(plan: EntitlementView["plan"]): BillingView["upgrades"] {
  const rank = { guest: 0, free: 1, pro: 2, business: 3 } as const;
  return PAID_PLANS.filter((p) => rank[p] > rank[plan]).map((p) => ({
    plan: p,
    name: PLANS[p].name,
    priceUsdMonthly: PLANS[p].priceUsdMonthly,
  }));
}

export function billingViewOf(view: EntitlementView, canManage: boolean, unavailable: boolean): BillingView {
  return {
    mode: billingMode(),
    orgId: view.orgId,
    plan: view.plan,
    planName: PLANS[view.plan].name,
    status: view.status,
    source: view.source,
    badge: badgeFor(view),
    currentPeriodEnd: view.currentPeriodEnd,
    cancelAtPeriodEnd: view.cancelAtPeriodEnd,
    syncedAt: view.syncedAt,
    limits: view.limits,
    upgrades: upgradesFor(view.plan),
    canManage,
    unavailable,
  };
}

/** Whether a Billing page load should re-sync (§4.4): on the checkout return, or when the row is over 60 s old. */
export const isStale = (syncedAt: string | null, now = Date.now()): boolean =>
  syncedAt === null || now - Date.parse(syncedAt) > SYNC_STALE_MS;

/**
 * The page's state, for a principal that already passed `requirePrincipal`. Exported so the server component
 * renders from the same code path the API returns, with no second definition of "what Pro looks like".
 */
export async function loadBillingView(p: Principal, checkoutId: string | null): Promise<BillingView> {
  const orgId = p.orgId;
  if (!orgId) throw new SaasError("E_AUTH_REQUIRED", "Start a workspace to see billing.");
  const canManage = p.role === "owner";
  let view = viewOf(await readRow(orgId));
  let unavailable = false;

  const shouldSync = checkoutId !== null || isStale(view.syncedAt);
  if (shouldSync) {
    try {
      view =
        checkoutId !== null && p.userId
          ? await getBilling().syncCheckout(checkoutId, orgId, p.userId)
          : await getBilling().syncOrg(orgId);
    } catch (e) {
      // Fail-static (§4.4): the last known row still renders; only the notice is new.
      if (isSaasError(e) && e.code === "E_FORBIDDEN") throw e;
      unavailable = true;
      routeLog.warn("billing sync failed; showing the last known plan", {
        orgId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return billingViewOf(view, canManage, unavailable);
}

// --------------------------------------------------------------------------------------------------- handlers

/** `GET /api/app/billing[?checkout_id=…]` — the Billing page's state (§4.4 sync triggers). */
export async function getBillingState(req: Request): Promise<Response> {
  return handle(async () => {
    installIdentity();
    const p = await requirePrincipal(req, { perm: "billing:read" });
    const checkoutId = new URL(req.url).searchParams.get("checkout_id");
    return json(200, await loadBillingView(p, checkoutId));
  });
}

/**
 * `POST /api/app/billing/checkout {plan}` → `{url}` (§4.3).
 *
 * `account: true` is what turns a guest's Upgrade click into the §4.6 step-2 wall ("Create your free account to
 * upgrade — your workspace comes with you") instead of an anonymous Polar customer.
 */
export async function postCheckout(req: Request): Promise<Response> {
  return handle(async () => {
    installIdentity();
    const p = await requirePrincipal(req, { perm: "billing:manage", account: true });
    const plan = planFrom(await readJson(req));
    if (!p.orgId || !p.userId) throw new SaasError("E_AUTH_REQUIRED", "Sign in to upgrade.");
    const { url } = await getBilling().startCheckout({
      orgId: p.orgId,
      userId: p.userId,
      plan,
      headers: req.headers,
    });
    return json(200, { url, mode: billingMode() });
  });
}

/** `POST /api/app/billing/simulated {plan}` — §4.7's confirm button. Refused whenever Polar is really configured. */
export async function postSimulatedConfirm(req: Request): Promise<Response> {
  return handle(async () => {
    installIdentity();
    const p = await requirePrincipal(req, { perm: "billing:manage", account: true });
    const plan = planFrom(await readJson(req));
    if (!p.orgId || !p.userId) throw new SaasError("E_AUTH_REQUIRED", "Sign in to upgrade.");
    if (billingMode() !== "simulated") {
      throw new SaasError("E_CONFLICT", "Billing is configured on this deployment; use the real checkout.");
    }
    // `billing:manage` is owner-only in the §3.7 matrix, but the row write is the one place a wrong answer is
    // expensive, so ownership is re-read from the database rather than inferred from the principal's role.
    if (!(await isOwnerOf(p.userId, p.orgId))) {
      throw new SaasError("E_FORBIDDEN", "Only an owner can change this organization's plan.");
    }
    const view = await confirmSimulated(p.orgId, p.userId, plan);
    return json(200, billingViewOf(view, true, false));
  });
}
