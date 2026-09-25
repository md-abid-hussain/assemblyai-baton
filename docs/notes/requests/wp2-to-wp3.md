# WP2 → WP3 (cases): the auth and limits API you consume

- **`@/server/auth`:**
  - `requireVisitor(req)` → `{visitorId, ipKey, via}`: the header first, then the cookie; never throws. The proxy has
    already set `bvid`.
  - `issueVisitorToken(visitorId)` → put it in `CreateCaseResponse.visitorToken`. Cookie-less browsers send it back as
    `x-baton-visitor`.
  - `issueCaseToken({caseId, visitorId})`.
  - `requireCase(req, {caseId})` → 401 `E_CASE_TOKEN` or 403 `E_FORBIDDEN` as `BatonError`s.
  - `handler(name, fn)` turns thrown `BatonError`s into `ApiError` responses.
  - `readJson(req, schema)` returns 400 `E_BAD_REQUEST` on a bad body.
- **`@/server/limits`:**
  - `getRateLimiter().hit(bucket, key, limit, windowSec)`. There is also `enforceRates(limiter, [...])` in
    `@/server/limits/rate-limiter`, which checks every limit first, then records all of them, and throws 429.
  - `getLimitsAuthority().ledger.reserve({ provider: "openai", … })` → `{ok:false, code:"E_BUDGET"}` over
    OPENAI_DAILY_CAP_USD. That refusal never flips the app mode.
- **Run plan.** WP2 writes `cases.run_plan` directly (a jsonb write equal to `CaseRepository.setRunPlan`); keep the
  column's shape = `RunPlan`.
- **Call manifest.** Please register it once you load `src/generated/calls.json`: `registerCallLookup(fn)` from
  `@/server/runs` (see wp2-to-integrator.md §4).
