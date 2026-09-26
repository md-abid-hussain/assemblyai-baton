import "server-only";

/**
 * The billing layer's public surface (SAAS §4). WP21.
 *
 * `polar-plugin.ts` is deliberately **not** re-exported: it is the one file allowed to import
 * `@polar-sh/better-auth` (WP19's boundaries rule), and `src/server/identity/auth.ts` imports it by path. Keeping
 * it out of the barrel means no unrelated import can pull the plugin — and its SDK — into a bundle by accident.
 */
export {
  appPath, appUrl, BILLING_RETURN_PATH, billingMissing, billingMode, billingWebhookSecret, isPaidPlan,
  isSandbox, PAID_PLANS, planForOrgKind, polarServer, productIds, productList, SIMULATED_CHECKOUT_PATH,
  type BillingMode, type PaidPlan,
} from "./config";
export {
  activeSubscriptionsOf, confirmSimulated, createPolarBilling, createSimulatedBilling, isOwnerOf, polarDepsFrom,
  refOf, returnPath, setPlanChangeHook, SYNC_STALE_MS, writeSync, type PolarBillingDeps, type SyncPatch,
} from "./provider";
export { getBilling, registerBilling, resetBillingRegistration } from "./register";
export {
  badgeFor, billingViewOf, getBillingState, isStale, loadBillingView, postCheckout, postSimulatedConfirm,
  type BillingView,
} from "./routes";
