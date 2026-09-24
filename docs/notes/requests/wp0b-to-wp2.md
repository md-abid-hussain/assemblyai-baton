# WP0b → WP2 (seams left for you; answer at G1)

1. **In-process worker.** `src/instrumentation.ts` (WP0b) has a marked line `[WIRE-INPROC-WORKER]`. Please export
   `startInprocWorker(): void` from `src/server/jobs/runner.ts`. Make it idempotent with a `globalThis` flag:
   during local testing the instrumentation hook ran twice in one process (once at boot, once on the first request
   after an error), so a module-level guard is not enough. The integrator adds the one-line dynamic import at G1.
2. **Remote authority for scripts.** `scripts/lib/limits.ts` exposes `registerRemoteAuthorityFactory((url, key) => …)`.
   Once `RemoteLimitsAuthority` exists, either register it there (e.g. from a tiny `scripts/lib/remote.ts`, which the
   integrator can own) or ask the integrator to import it directly. Until then, a set `LIMITS_AUTHORITY_URL` makes
   script opens throw with a clear message, and an unset one uses the laptop file guard.
3. **Schema additions you can rely on** (all in the single initial migration):
   - `cases.version int default 0` (the `CaseRepository.load/applyEvents` version);
   - `stream_queue.ip_key` (for "≤2 open tickets per ipKey") and `stream_queue.last_poll_at` defaults to `now()`;
   - `live_sessions.source` (`OpenSource`) and `live_sessions.created_at`; `case_id`/`visitor_id` are nullable for
     script/synthetic opens;
   - `jobs.kind` includes `budget_guard`.
   - `app_flags` is seeded by `migrate.mjs` with `mode="live"`, `notice=null`, `payments_mode_override=null`,
     `aai_balance_usd=null` (JSON values, `ON CONFLICT DO NOTHING`).
4. **Pool.** `getDb()`/`getPool()` from `@/server/db` (max 15, connect timeout 3 s, `statement_timeout` 5 s). For
   `pg_advisory_xact_lock` transactions use `getDb().transaction(...)`.

---

## Integrator status (Wave 0, 2026-09-24)

**Accepted; forwarded to WP2 for G1.** Nothing here can be done in Wave 0, because `src/server/jobs/runner.ts` and
`RemoteLimitsAuthority` are WP2 deliverables. A static import of a module that doesn't exist yet would break
`next build`.

- **Item 1:** the seam is verified in place. `src/instrumentation.ts` has the `[WIRE-INPROC-WORKER]` line, and the
  bundle boots with `inprocWorker:false` and logs "runner not wired yet". zerops.yml sets `ENABLE_INPROC_WORKER=1`.
  **Integrator action at G1:** once `wp/wp2` exports an idempotent `startInprocWorker()` (with a `globalThis` guard),
  replace the marked log line with the dynamic import, rebuild, and confirm that a boot log plus one tick appear
  exactly once per process.
- **Item 2:** `registerRemoteAuthorityFactory` exists in `scripts/lib/limits.ts`. **Integrator action at G1:** add
  `scripts/lib/remote.ts` (integrator-owned). It registers WP2's `RemoteLimitsAuthority`, and `getLimitsAuthority()`
  imports it for its side effect. After that, `LIMITS_ROLE=remote` works from scripts.
- **Item 3:** verified against a fresh `postgres:17` (17.11) after `node bundle/migrate.mjs`:
  - `cases.version int not null default 0`;
  - `stream_queue.ip_key` (nullable) and `stream_queue.last_poll_at` (`not null default now()`);
  - `live_sessions.source` and `live_sessions.created_at` (`default now()`); `case_id`/`visitor_id` are nullable;
  - `jobs.kind` text, with the TS enum including `budget_guard`;
  - `app_flags` seeded with 4 rows.

  `drizzle-kit generate` reports "No schema changes", so `schema.ts` and the snapshot match.
- **Item 4:** verified in `src/server/db/client.ts`: max 15, 3 s connect timeout, `statement_timeout` 5000 as a
  startup parameter, and a `globalThis` holder.

---

## G0 update (fixer/integrator, 2026-09-24): what changed under you

The contracts are frozen with the amendments in `docs/notes/g0.md` ("Contract decisions"). These touch WP2 directly:

- **`SlotResult.granted` now carries `sessionIds: string[]`** (one `live_sessions` id per granted open; `[rep, customer]`
  for n = 2). Create one `live_sessions` row per id at grant time. Route #5 maps them to
  `SttTokenGranted.sessionIds: { rep?, customer? }`. `SttTokenRequest` has `channel` (required when n = 1).
  The laptop file guard and `scripts/lib/aai-open.ts` already use this; the `${grantId}:rep` suffix scheme is gone.
- **`vaAcquire.capMs` for VA is the absolute ceiling** `vaAbsoluteCeilingMs(VA_SESSION_CAP_MAX_MS)` (600 s by default,
  `contracts/takeover.ts`), not the dynamic cap. F5 marks stale at `cap_ms + 60 s`.
- **Columns are now `double precision`**: `live_sessions.billed_seconds`, `cases.t_arm_ms`, `takeovers.t_arm_ms`,
  `turns.{start,end,recv,extract}_ms`, `verifier_runs.{upto_turn_recv_ms,ms}`. `fact_events.turn_end_ms` (new, NOT NULL,
  no default) and `fact_events.confidence` NOT NULL. Still one initial migration (`drizzle/0000_init.sql`, regenerated;
  it was never deployed).
- **New error codes** `E_BAD_REQUEST` (400), `E_FORBIDDEN` (403) and `E_NOT_FOUND` (404) for zod failures, scope
  mismatches and unknown ids.
- **`CaseRepository.load().status` is `CaseStatus`** (`CASE_STATUSES` in `contracts/case.ts`, equal to the DB enum; a
  scaffold test pins it).
- **pagehide requests are keepalive `fetch` calls with the Authorization header, never `sendBeacon`** (route #5b
  release, #7 closed report, #13 end), so your auth middleware needs no body-token fallback.
