/**
 * Next.js instrumentation hook (runs once per server process, before the first request).
 *
 * Wave 0: boot log + process-level error logging. The in-process job ticker (DESIGN §4.5 (a): every 2 s,
 * F5 sweeper 15 s, F6 audit 3 min, F8 budget guard 60 s) starts here when `ENABLE_INPROC_WORKER=1`.
 * WP2 provides `startInprocWorker()` in `src/server/jobs/runner.ts`; the integrator wires it in at the
 * marked line once that module exists (see docs/notes/wp0b.md).
 *
 * Everything sits inside the `NEXT_RUNTIME === "nodejs"` block so the edge compile of this file drops it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installProcessErrorLogging, log, logBoot } = await import("./server/log");
    const { versionString } = await import("./lib/version");
    installProcessErrorLogging();
    const inprocWorker = process.env.ENABLE_INPROC_WORKER === "1";
    logBoot({ version: versionString(process.env), inprocWorker });
    if (inprocWorker) {
      // [WIRE-INPROC-WORKER] G1: `const { startInprocWorker } = await import("./server/jobs/runner"); startInprocWorker();`
      log.child({ component: "boot" }).info("in-process worker requested; runner not wired yet (WP2)");
    }
  }
}
