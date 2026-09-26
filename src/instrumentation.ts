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
    // [WIRE-SCENARIOS] wired at QA-FIX (docs/notes/qa-fix.md). `src/generated/scenarios.json` is the scenario
    // policies WP9 generates, and `src/server/data/index.ts` says in its own header that these files are meant to
    // be **imported, never fs-read**, because `src/` is not in the deploy bundle — but nothing ever called
    // `registerGeneratedData`. The fs fallback then looked for `src/generated/scenarios.json` and
    // `data/scenarios/<id>.json` relative to the process cwd, neither of which the bundle contained, so on the
    // built server every `POST /api/cases` answered `404 "Unknown scenario s01."` and the whole guest demo — the
    // flagship judge path — was dead. Invisible in `next dev`, which reads both files off the live checkout.
    // A static import travels inside the JS chunk, so it cannot depend on cwd or on file tracing at all.
    try {
      const { registerGeneratedData } = await import("./server/data");
      const scenarios = (await import("./generated/scenarios.json")).default as unknown[];
      registerGeneratedData({ scenarios });
    } catch (err) {
      log.child({ component: "boot" }).error("generated scenarios failed to register", { err });
    }
    // [WIRE-PUBLISHING] wired at G2b. `installPublishing()` registers WP18's `livePublications` count source with the
    // v3 entitlements registry (`setOrgCounter`), which is what enforces the guest plan's 1 live publication before
    // WP21 exists (docs/notes/wp18.md "What the integrator must do" §2). It only stores a closure, so it stays cheap
    // at boot and opens no database connection.
    try {
      const { installPublishing } = await import("./server/publish");
      installPublishing();
    } catch (err) {
      log.child({ component: "boot" }).error("publishing failed to install", { err });
    }
    // [WIRE-RELAY-SAAS] wired at G3. `installRelaySaasPorts()` points WP19's v3 port registry at WP14b's real
    // `GuestSeeder`, `RelaySourceStore` and relay counter (docs/notes/wp14b.md, `src/server/relays/index.ts`).
    // It has to happen at boot rather than lazily because `/api/guest/start` never touches the relay graph: in a
    // cold container whose first request is a guest start — the judge path — the registry would still hold the
    // C3b no-op seeder and the guest would land with no "Dental deposit (your copy)". It builds the graph but
    // opens no connection (the `pg` Pool is lazy), so it stays cheap here.
    try {
      const { installRelaySaasPorts } = await import("./server/relays");
      installRelaySaasPorts();
    } catch (err) {
      log.child({ component: "boot" }).error("relay saas ports failed to install", { err });
    }
    // [WIRE-BILLING] wired at QA-FIX (docs/notes/qa-fix.md). `registerBilling()` is the only thing that points
    // `getBilling()` at the real Better Auth `/checkout` endpoint and the DB entitlements store, and nothing in
    // the app ever called it. `getBilling()` therefore always fell back to the simulated provider while
    // `billingMode()` (pure env) kept answering "polar", so a correctly configured deployment sent Upgrade to the
    // *simulated* checkout page and then refused the simulated confirm with "use the real checkout" — no path to
    // Pro at all. The resolver is lazy (a closure), so this opens no connection and builds no auth instance here.
    try {
      const { registerBilling } = await import("./server/billing");
      const { getAuth } = await import("./server/identity/auth");
      registerBilling(() => {
        try {
          return (getAuth()?.api ?? null) as { checkout?: unknown } | null;
        } catch {
          return null;
        }
      });
    } catch (err) {
      log.child({ component: "boot" }).error("billing failed to register", { err });
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
