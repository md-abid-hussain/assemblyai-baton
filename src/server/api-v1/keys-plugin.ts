import "server-only";

/**
 * `apiKeyPlugins()` — the Better Auth plugin list for org API keys (SAAS §6.1).
 *
 * **C3 stub, owned by WP19 for this one commit; WP22 owns `src/server/api-v1/**` from C3 on.** It returns `[]`, so
 * `src/server/identity/auth.ts` (WP19·2) can spread it into `plugins: [...]` from the day Better Auth is mounted and
 * WP22 fills it in without WP19 touching the auth file again.
 *
 * WP22 replaces the body with `apiKey({ references: "organization", defaultPrefix: "cko_", enableMetadata: true,
 * rateLimit: { enabled: true } })` [VERIFY option names, SAAS §16], keeping this signature. **Keys belong to the
 * org, never to their creator** (SAAS §6.1): nothing may authorize off `created_by_user_id`, on the fallback path
 * either — the acceptance test "a key keeps working after its creator is removed" is the condition for taking it.
 *
 * `better-auth` is imported only from `src/server/identity/**`, `src/client/identity/**` and the two
 * `*-plugin.ts` files, and the boundaries test in `tests/unit/server/saas/` enforces that.
 */

/** Better Auth's plugin type is not in the tree until WP19·2 installs it; `unknown[]` keeps this file dependency-free. */
export function apiKeyPlugins(): unknown[] {
  return [];
}

/** `true` once WP22 has wired the plugin, so the UI can hide the API-keys surface until then. */
export const API_KEYS_ENABLED = false;
