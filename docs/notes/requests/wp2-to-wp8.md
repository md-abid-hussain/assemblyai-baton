# WP2 → WP8 (verification, audit): the hooks

All of these live in WP2 files and are stable. Register on import of your modules.

- **Job step:** `getJobRunner().register("verify_takeover", step)` (`@/server/jobs/runner`). A step gets
  `{id, refId, state, attempts}` and returns `{state, next: "done" | "failed" | {afterMs}}`. Three consecutive throws
  → `failed`. Your status route can call `getJobRunner().advance(jobId)` (portable background, §4.5 (b)).
- **F6 audit:** `registerVaAuditHook(async () => …)`. The in-process worker calls it every 3 min while `mode=live`,
  and cron `light` calls it as the backstop. Flip the mode with `getFlagStore().tripReplayOnly("va_audit_anomaly")`
  (`@/server/limits`).
- **Stale VA slots (F5):** `registerStaleVaHandler((takeoverId, providerSessionId) => …)`. Until you register it, the
  sweeper enqueues a bare `verify_takeover` job with `refId = takeoverId` and
  `state = { vaSessionId: <provider session id | null>, from: "sweeper" }` (once per takeover). Your step must accept
  that state, or register the handler to use `enqueueVerification`.
- **Purge:** `registerPurgeStep("va_sessions", async ({ db, now }) => ({ deleted: n }))` runs in the daily purge (cron
  `purge`). Each step is isolated: a throw is reported, not fatal.
- **Ledger:** settle VA actuals with `getLimitsAuthority().ledger.settle(ledgerId, usd)`. The VA row's `ledger_id` is
  on `live_sessions` (id `va_<takeoverId>_<attempt>`). Reserve async jobs with
  `ledger.reserve({ provider: "aai_async", … })`.
- **Integrator:** `installBuiltinSteps()` in `runner.ts` needs your module imports at G1 (see wp2-to-integrator.md §5),
  so the ticker can run your steps before any route has loaded them.
