# WP8 → integrator (G1 wiring)

Everything below is on `wp/wp8`. WP8 codes against the TASKS §2 contracts and reads its collaborators through one
seam, `configureWp8()` in `src/server/qa/deps.ts`. Round 1 runs on defaults (no runner, no ledger, no QA engine,
a case-token-only authorizer). At G1 one file changes: `src/server/qa/wiring.ts` (WP8-owned). Paste the body below
(after merging `wp/wp1` and `wp/wp2`). WP8 can do it itself in round 2 after `main` is merged into `wp/wp8`.

## 1. `src/server/qa/wiring.ts` body `[WIRE-WP8]`

```ts
import "server-only";

import { computeQa } from "../../core/qa";
import { requireCase } from "../auth/case-token";
import { getJobRunner, registerVaAuditHook } from "../jobs/runner";
import { registerPurgeStep } from "../jobs/purge";
import { getFlagStore, getLimitsAuthority, getRateLimiter } from "../limits/index";
import { registerStaleVaHandler } from "../registry/sweeper";
import { configureWp8 } from "./deps";

const g = globalThis as typeof globalThis & { __batonWp8Wired?: boolean };

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
  // Hooks: lazy imports avoid a cycle (the WP8 job modules import this file).
  void import("../jobs/verify-takeover").then((m) => {
    m.installVerifyTakeover();
    registerStaleVaHandler((tko, sid) => m.enqueueVerificationFromSweeper(tko, sid));
  });
  void import("../jobs/va-audit").then((m) => registerVaAuditHook(m.vaAuditHook));
  void import("./purge").then((m) => registerPurgeStep("va_sessions", ({ db, now }) => m.purgeVaRecordings({ db, now })));
}
```

Why here and not only in WP2's `installBuiltinSteps()`: that runs only when `ENABLE_INPROC_WORKER=1`. The Vercel
mirror has no worker, so route #20 must be able to wire and advance jobs by itself. Every WP8 entry point (both job
modules and the three routes) calls `ensureWp8Wired()` first.

## 2. WP2's `installBuiltinSteps()` `[WIRE-WP8-STEPS]`

Add `await import("./verify-takeover");` and `await import("./va-audit");`. On import they run `ensureWp8Wired()`,
so the ticker has the `verify_takeover` step and the audit hook before any route loads. The step accepts WP2's
sweeper fallback state `{vaSessionId, from:"sweeper"}` (tested), so the fallback enqueue can stay as it is.

## 3. WP5 end route

`POST /api/takeovers/[id]/end` → `await enqueueVerification(takeoverId, body.vaSessionId)` from
`@/server/jobs/verify-takeover` (TASKS §2 `EnqueueVerification`). It returns `null` when the takeover has no VA
session (nothing to verify) or no runner is wired. It is idempotent per takeover. See `wp8-to-wp5.md`.

## 4. Environment

- `AAI_WEBHOOK_SECRET` (already in `.env.example`) and `APP_URL` = the public **https** origin (`https://…zerops.app`).
  With `APP_URL` unset, http, or localhost, F3 is poll-only (3 s polls, ≤ 60 s). That is the local-dev behaviour;
  AssemblyAI cannot reach localhost.
- Nothing new otherwise. The audit reads `BATON_DEPLOY_ID` and `VA_MAX_CONCURRENT`. It does nothing on `dev-*`,
  `vercel-*` and `local` deploys (`skipped:"not_production"`).

## 5. Build check (g0.md known gap: `ws` in the bundle)

Routes #20 and #21 reach `src/server/aai/va-node.ts` (through `va-rest.ts`), which imports `ws` statically. After
`npm run build`, confirm that `bundle/node_modules/ws` exists. In the WP8 worktree, `next build` compiled the three
routes (see `docs/notes/wp8.md`).

## 6. Tests at the merge

- `tests/unit/server/verify/**` creates throwaway databases on `DATABASE_URL`, like WP2's helper. With no URL it skips.
- WP8's `TestRunner` is a test double of WP2's `DbJobRunner`. After the merge, the three route/step suites can also
  run against the real runner. Swap it in the helper `harness()` if you want that coverage.
- `tests/integration/async-verify.test.ts` (RUN_LIVE=1, ≈ $0.09) finds WP1's `computeQa` at `@/core/qa` once it is merged.
