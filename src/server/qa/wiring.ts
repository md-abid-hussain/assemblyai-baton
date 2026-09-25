/**
 * server/qa/wiring.ts - connects WP8 to WP2 (runner, ledger, flags, rate limiter, auth, hooks) and WP1 (computeQa).
 *
 * ROUND 1 (this branch): WP2's and WP1's modules are not on `wp/wp8`, so this is a no-op and WP8 runs on the
 * defaults of `deps.ts`. G1: replace the body with the snippet in docs/notes/requests/wp8-to-integrator.md §1 (it
 * imports `getJobRunner`, `registerVaAuditHook`, `registerPurgeStep`, `registerStaleVaHandler`, `getLimitsAuthority`,
 * `getFlagStore`, `getRateLimiter`, `requireCase` and `computeQa`). Every WP8 entry point (the job modules, the three
 * routes) calls `ensureWp8Wired()` first, so the wiring holds with or without the in-process worker (the Vercel mirror
 * has none).
 */
import "server-only";

const g = globalThis as typeof globalThis & { __batonWp8Wired?: boolean };

export function ensureWp8Wired(): void {
  if (g.__batonWp8Wired) return;
  g.__batonWp8Wired = true;
  // [WIRE-WP8] G1: configureWp8({ runner, ledger, computeQa, authorizeTakeover, rateLimiter, flags, tripReplayOnly })
  // and the hook registrations. See docs/notes/requests/wp8-to-integrator.md.
}
