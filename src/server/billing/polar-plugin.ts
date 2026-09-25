import "server-only";

/**
 * `polarPlugins()` — the Better Auth plugin list for Polar checkout and Customer State (SAAS §4.3).
 *
 * **C3 stub, owned by WP19 for this one commit; WP21 owns `src/server/billing/**` from C3 on.** It returns `[]`, so
 * `src/server/identity/auth.ts` (WP19·2) can spread it into `plugins: [...]` from the day Better Auth is mounted and
 * WP21 fills it in without WP19 touching the auth file again.
 *
 * WP21 replaces the body with the `@polar-sh/better-auth` plugin (sandbox server, the checkout and portal handlers,
 * the optional billing webhook). Everything runs in the Polar **sandbox**: no real money moves. When the token, the
 * product ids or the sandbox server are missing, the app selects `BILLING_MODE=simulated` (SAAS §4.7) and this list
 * legitimately stays empty.
 *
 * Secrets are never read, printed or committed here: the user sets them in the Zerops GUI (TASKS-v3 §2 rule 16).
 */

/** Better Auth's plugin type is not in the tree until WP19·2 installs it; `unknown[]` keeps this file dependency-free. */
export function polarPlugins(): unknown[] {
  return [];
}

/** `true` once WP21 has wired the plugin; until then `BillingProvider.mode` is `simulated` (SAAS §4.7). */
export const POLAR_BILLING_ENABLED = false;
