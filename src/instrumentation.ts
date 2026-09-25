/**
 * Next.js instrumentation hook (runs once per server process, before the first request).
 *
 * Wave 0: boot log + process-level error logging. The in-process job ticker (DESIGN §4.5 (a): every 2 s,
 * F5 sweeper 15 s, F6 audit 3 min, F8 budget guard 60 s) starts here when `ENABLE_INPROC_WORKER=1`.
 * WP2 provides `startInprocWorker()` in `src/server/jobs/runner.ts`; wired at G1 (docs/notes/g1.md).
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
    // [WIRE-CALLS] wired at G2. Routes #5/#5a (`src/server/runs/calls.ts`) read the WP9 call manifest through this
    // lookup; without it they silently fall back to DEFAULT_CALL_DURATION_MS and lose the Express start, the handoff
    // line and the call's audio format. `registerCallLookup` only stores the function, so this stays cheap at boot.
    try {
      const { registerCallLookup } = await import("./server/runs");
      const { getCaseDataSource } = await import("./server/data");
      registerCallLookup((id) => getCaseDataSource().getCall(id));
    } catch (err) {
      log.child({ component: "boot" }).error("call lookup failed to register", { err });
    }
    if (inprocWorker) {
      // [WIRE-INPROC-WORKER] wired at G1. startInprocWorker() is idempotent per process (globalThis guard), so a
      // second instrumentation run in the same process is harmless.
      try {
        const { startInprocWorker } = await import("./server/jobs/runner");
        startInprocWorker();
      } catch (err) {
        log.child({ component: "boot" }).error("in-process worker failed to start", { err });
      }
    }
  }
}
