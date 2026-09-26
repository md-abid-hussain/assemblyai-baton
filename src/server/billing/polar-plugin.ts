import "server-only";

/**
 * `polarPlugins()` — the Better Auth plugin list for Polar checkout, the customer portal and Customer State
 * (SAAS §4.3). WP21 owns this file from C3 on; `src/server/identity/auth.ts` spreads it and never changes again.
 *
 * Everything runs in the Polar **sandbox**: no real money moves. When the token, a product id or the sandbox
 * server is missing, `billingMode()` is `simulated` (§4.7) and this list stays legitimately empty — the app boots,
 * the Billing page renders and Upgrade goes to the labelled simulated checkout instead.
 *
 * Two safety properties are configuration, not code, and both are asserted by tests:
 *  - `createCustomerOnSignUp: false` — anonymous users must never create Polar customers (§4.3). Every guest is an
 *    anonymous Better Auth account, so the opposite setting would mint a Polar customer per visitor.
 *  - `authenticatedUsersOnly: true` on checkout — the plugin refuses `isAnonymous` sessions outright, which is the
 *    second half of the same guarantee and the reason §4.6 step 2 shows the "create your free account" wall first.
 *
 * Secrets are never read into a return value, printed or committed: the user sets them in the Zerops GUI.
 *
 * **[VERIFY] recorded in `docs/notes/wp21.md`** (read out of `@polar-sh/better-auth` 1.8.4's own build):
 * the checkout endpoint calls `polar.checkouts.create({ externalCustomerId: session.user.id, metadata: {
 * referenceId, ...} })`, so the Polar customer's external id *is* the paying Better Auth user and `referenceId`
 * *is* carried as checkout metadata. `polar-direct.ts` is the same-interface fallback if that ever changes.
 */
import { Polar } from "@polar-sh/sdk";
import { checkout, polar, portal, usage, webhooks } from "@polar-sh/better-auth";

import {
  appPath, billingMode, billingWebhookSecret, BILLING_RETURN_PATH, polarAccessToken, productList,
} from "./config";

/** One sandbox client per process, rebuilt when `resetPolarClient()` is called (tests, dev env changes). */
let client: Polar | null = null;

/** The sandbox client, or `null` when there is no token. Callers degrade to simulated rather than throw. */
export function getPolarClient(): Polar | null {
  if (client) return client;
  const accessToken = polarAccessToken();
  if (!accessToken) return null;
  // `server: "sandbox"` is hard-coded, not read from env: `billingMode()` has already refused any other value,
  // and a literal here means no configuration mistake can point a checkout at production.
  client = new Polar({ accessToken, server: "sandbox" });
  return client;
}

export function resetPolarClient(): void {
  client = null;
}

/**
 * Better Auth's plugin type is not nameable here without importing `better-auth` itself, which the WP19
 * boundaries test forbids outside `src/server/identity/**` (this file and `keys-plugin.ts` are its two named
 * exceptions, but staying dependency-free keeps the exception honest). `unknown[]` is what `auth.ts` spreads.
 *
 * **Cost recorded by WP19 and inherited here:** endpoints these plugins add are not on `auth.api`'s *type*, so
 * `provider.ts` calls `auth.api.checkout` through one narrow cast at the call site.
 */
export function polarPlugins(): unknown[] {
  if (billingMode() !== "polar") return [];
  const polarClient = getPolarClient();
  if (!polarClient) return [];

  const webhookSecret = billingWebhookSecret();

  return [
    polar({
      client: polarClient,
      // §4.3: anonymous users must never create Polar customers. The checkout creates the customer instead.
      createCustomerOnSignUp: false,
      use: [
        checkout({
          products: productList(),
          successUrl: appPath(`${BILLING_RETURN_PATH}?checkout_id={CHECKOUT_ID}`),
          returnUrl: appPath(BILLING_RETURN_PATH),
          authenticatedUsersOnly: true,
        }),
        portal({ returnUrl: appPath(BILLING_RETURN_PATH) }),
        usage(),
        // P4 (WP21·3). Mounted only with its own secret, so an unsigned POST to /api/auth/polar/webhooks
        // cannot reach a handler. The handlers themselves arrive with WP21·3.
        ...(webhookSecret ? [webhooks({ secret: webhookSecret })] : []),
      ],
    }),
  ];
}

/** `true` once the plugin is really mounted; the Billing page shows "simulated" otherwise (SAAS §4.7). */
export const polarBillingEnabled = (): boolean => polarPlugins().length > 0;

/**
 * A C3 leftover, kept only so WP19's `tests/unit/server/saas/boundaries.test.ts` — which is WP19's file, not
 * ours — keeps passing unmodified. It was always a compile-time literal and cannot answer a question about the
 * environment, so it is wrong the moment Polar is configured.
 *
 * @deprecated use `polarBillingEnabled()` (or `billingMode()`), which re-read the environment.
 *   A request to delete this export is filed in `docs/notes/requests/wp21-to-wp19.md`.
 */
export const POLAR_BILLING_ENABLED = false;
