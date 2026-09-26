import "server-only";

/**
 * The plan half of the secret store (SAAS §4.1, §12 WP16 row; WP16·3).
 *
 * v2 gave every workspace 10 secrets that expire after 7 days (PLATFORM §6.4). v3 makes both numbers a plan
 * property — Guest 3 / 7 days, Free 5 / 30 days, Pro 50 / never, Business 200 / never — and SAAS outranks PLATFORM,
 * so this is the live rule. The store keeps the v2 constants as its no-plan default, which is what every unit test
 * and every pre-SaaS caller still sees.
 *
 * Reading the plan must never take the Connectors tab down: an entitlement lookup that fails falls back to the
 * Guest numbers (the smallest allowance and the shortest life), because failing closed on a secret is the safe
 * direction.
 */
import { PLANS } from "../../core/contracts/v3/plans";
import { log } from "../log";
import { getEntitlements } from "../saas/ports";
import type { SecretPlanLimits } from "./store";

const planLog = log.child({ component: "secrets" });

const DAY_MS = 24 * 60 * 60 * 1000;

const GUEST_FALLBACK: SecretPlanLimits = {
  maxSecrets: PLANS.guest.limits.secrets,
  ttlMs: (PLANS.guest.limits.secretTtlDays ?? 7) * DAY_MS,
};

/** `{maxSecrets, ttlMs}` for a workspace. `ttlMs: null` on Pro and Business: those secrets do not expire. */
export async function secretPlanLimits(ws: string): Promise<SecretPlanLimits> {
  try {
    const view = await getEntitlements().get(ws);
    const days = view.limits.secretTtlDays;
    return { maxSecrets: view.limits.secrets, ttlMs: days === null ? null : days * DAY_MS };
  } catch (err) {
    planLog.warn("could not read the plan for secrets (guest limits applied)", { err });
    return GUEST_FALLBACK;
  }
}
