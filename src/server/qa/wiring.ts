/**
 * server/qa/wiring.ts - connects WP8 to WP2 (runner, ledger, flags, rate limiter, auth, hooks) and WP1 (computeQa).
 *
 * Wired at G1 with the body from docs/notes/requests/wp8-to-integrator.md §1. Every WP8 entry point (the job modules,
 * the three routes) calls `ensureWp8Wired()` first, so the wiring holds with or without the in-process worker (the
 * Vercel mirror has none). Idempotent per process through a `globalThis` flag.
 */
import "server-only";

import { computeQa } from "../../core/qa";
import { requireCase } from "../auth/case-token";
import { getJobRunner, registerVaAuditHook } from "../jobs/runner";
import { registerPurgeStep } from "../jobs/purge";
import { getFlagStore, getLimitsAuthority, getRateLimiter } from "../limits/index";
import { log } from "../log";
import { registerStaleVaHandler } from "../registry/sweeper";
import { configureWp8 } from "./deps";

const g = globalThis as typeof globalThis & { __batonWp8Wired?: boolean; __batonWp8Hooks?: Promise<void> };

export function ensureWp8Wired(): void {
  if (g.__batonWp8Wired) return;
  g.__batonWp8Wired = true;
  configureWp8({
    runner: () => getJobRunner(),
    ledger: () => getLimitsAuthority().ledger,
    computeQa,
    authorizeTakeover: async (req, takeoverId) => {
      const a = await requireCase(req, { takeoverId, scope: "case" });
      return { caseId: a.caseId, visitorId: a.visitorId, takeoverId };
    },
    rateLimiter: () => getRateLimiter(),
    flags: () => getLimitsAuthority().flags(),
    tripReplayOnly: (reason) => getFlagStore().tripReplayOnly(reason),
  });
  // Hooks: lazy imports avoid a cycle (the WP8 job modules import this file). `wp8HooksReady()` awaits them.
  const hooks = Promise.all([
    import("../jobs/verify-takeover").then((m) => {
      m.installVerifyTakeover();
      registerStaleVaHandler((tko, sid) => m.enqueueVerificationFromSweeper(tko, sid));
    }),
    import("../jobs/va-audit").then((m) => registerVaAuditHook(m.vaAuditHook)),
    import("./purge").then((m) => registerPurgeStep("va_sessions", ({ db, now }) => m.purgeVaRecordings({ db, now }))),
  ]).then(() => undefined);
  g.__batonWp8Hooks = hooks;
  hooks.catch((err: unknown) => log.child({ component: "wp8" }).error("WP8 hook registration failed", { err }));
}

/**
 * Resolves once the hook registrations of `ensureWp8Wired()` have run (G1). WP2's `installBuiltinSteps()` awaits it,
 * so the in-process worker never ticks with the step registered but the stale-VA handler / audit hook missing.
 * Never await it from a WP8 module's top level (the hooks import those modules).
 */
export function wp8HooksReady(): Promise<void> {
  ensureWp8Wired();
  return g.__batonWp8Hooks ?? Promise.resolve();
}
