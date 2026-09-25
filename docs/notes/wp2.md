# WP2 notes: platform and the limits authority (round 1, gate G1)

**Status: done for G1.**

- `npm run typecheck` is clean.
- `npm test`: 22 files, **353/353** tests pass in about 3.2 s. WP2's share is 81 tests in 9 files, 8 of them on real
  Postgres.
- Acceptance 1–6 pass against local Postgres 17.11: the `baton-pg` container on :55432, with a throwaway database per
  test file.
- Acceptance 7 passed once live (`RUN_LIVE=1`). Live spend was **≈ $0.0023**.
- `next build --webpack` compiles all 11 WP2 routes and the proxy. The built app was smoke-tested on port 3102.
- Everything is committed on `wp/wp2`. Nothing was pushed or deployed.

## What exists (all paths are in WP2's ownership)

| Area | Files |
|---|---|
| Auth primitives (DESIGN §4.3) | `src/server/auth/{visitor,case-token,keys,http,crypto,index}.ts`, `src/proxy.ts` |
| Flags | `src/server/flags.ts` (`DbFlagStore`, `modeDenial`, reason ranks) |
| Limits authority | `src/server/limits/{db-authority,ledger,rate-limiter,remote-authority,config,stt-params,probes,index}.ts` |
| Registry | `src/server/registry/sweeper.ts` (F5) |
| Runs (D14) | `src/server/runs/{run-service,case-port,calls,index}.ts` |
| Health | `src/server/health/{synthetic,status,cron}.ts` (F7, #2, #26) |
| Jobs | `src/server/jobs/{runner,purge,budget-guard}.ts` (runner + `startInprocWorker`, purge, F8) |
| Tokens | `src/server/aai/tokens.ts`: the only product-code token mint |
| Routes | #2 `status`, #5 `stt/token`, #5a `runs`, #5b `runs/[runId]/release`, #6 `stt/queue/[ticket]`, #7 `sessions/report`, #10 `va/token`, #26 `internal/cron`, #27 `admin/{flags,ledger}`, #28 `internal/limits/[op]` |
| Tests | `tests/unit/server/{auth,limits,registry,runs,jobs}/**`, `tests/integration/tokens.test.ts` |

## Acceptance results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Broker on real PG: 10 parallel `n:2` never > 4 opens/60 s; FIFO; ETA > 15 s → `E_QUEUE_TIMEOUT`; ticket expiry after 3 missed polls; 3rd ticket per ipKey refused | **PASS** | `limits/broker.test.ts` (10). 10 parallel requests → exactly 2 grants (4 opens) and 8 × `E_QUEUE_TIMEOUT`. A real-clock stress run (3 × 10 parallel) never exceeds 4 |
| 2 | The same through `RemoteLimitsAuthority` → route handlers | **PASS** | `limits/remote.test.ts` (6). The client's fetch dispatches to the real #28 module. Also covers a bad key (403), a non-authority process (404) and the split-budget fallback |
| 3 | Ledger epoch, dynamic cap with a fake clock, over-cap → `E_BUDGET` + `replay_only (budget_daily)` restored after 00:00 UTC, low balance → `aai_balance` | **PASS** | `limits/ledger.test.ts` (10), incl. `budget_total`, the dev guard and the OpenAI cap |
| 4 | `POST /api/runs` live with a hold, or recorded with a plain reason; hold expiry released by the sweeper | **PASS** | `runs/runs-va.test.ts` (7 of 15), incl. #5b release and superseded holds |
| 5 | `/api/va/token` attempt/retry rules; a missing heartbeat frees a slot | **PASS** | `runs/runs-va.test.ts` (8 of 15). Parallel retries: exactly one wins. The retry succeeds even when every other slot is taken (its own zombie slot is released first) |
| 6 | Wrong `vid` → 403; expired → 401; cookie-less works through the header | **PASS** | `auth/auth.test.ts` (10) and end to end through `POST /api/runs` in `limits/platform-routes.test.ts` |
| 7 | Synthetic light passes against real APIs; full passes once; credit/balance mint errors → `E_AAI_BALANCE` | **PASS** (live, 2026-09-25) | `tests/integration/tokens.test.ts` 3/3 with `RUN_LIVE=1` through the laptop guard. Balance mapping in `stt-routes.test.ts` and `runs-va.test.ts` (fake 402s) |

## Measured numbers (live, 2026-09-25, from the laptop guard's ledger, env `dev-wp2`)

| Probe | Billed | Cost |
|---|---|---|
| Full STT: `question_16k.wav` (7.3 s, "481529") + 1.5 s tail | 9 s (`session_duration_seconds`) | $0.001125 |
| Full VA: greeting-only session, first `reply.audio`, then `session.end` | 0.94 s | $0.00118 |
| Light OpenAI `gpt-6-luna`, 16 tokens | – | $0.0000037 |
| Mints: STT and VA tokens (twice) | – | $0 |
| **Total live spend** | | **≈ $0.0023** of the $0.30 round budget |

Other numbers:

- The whole unit suite takes about 3.2 s, including throwaway-DB create, migrate and drop per file.
- The built app answers `/api/status` in milliseconds against the local DB.
- Vitest hides the console of passing tests. Set `WP2_LIVE_OUT=<file>` to keep the probe JSON (ms, first-audio ms,
  transcript) next time.

## Day-1 tests

WP2 owns no App. B test.

**T-D1-8 (WP0b), "a remote `stt-acquire` round trip":** the route and the client are proven in-process (acceptance 2).
The real round trip **needs the deployed URL**. The first check after the Zerops deploy should be:

```
curl -X POST $APP_URL/api/internal/limits/flags -H "x-limits-key: …"
```

Then run one script with `LIMITS_ROLE=remote`.

## Decisions (where DESIGN left room)

1. **Visitor.** A valid `x-baton-visitor` header wins over the cookie. The proxy mints a fresh cookie on every request
   of a cookie-less browser and injects it into that same request, so the cookie cannot be trusted over the header.
   Visitor ids are `[A-Za-z0-9_-]{1,64}` with HMAC-SHA256.
   `ipKey = hmac(VISITOR_SECRET, "ip:" + dayUTC + ":" + firstHop)`, truncated to 22 chars.
2. **Token statuses.** A missing, invalid, expired or `alg:none` case token → 401 `E_CASE_TOKEN`. A valid token for
   another visitor, case, scope or takeover → 403 `E_FORBIDDEN`. The admin, cron and limits keys are constant-time
   compares; a missing secret never authorizes.
3. **STT broker.**
   - Grants create `live_sessions` rows (`status:"open"`) at grant time, one per session id (G0).
   - Rows `released` because the mint or ledger failed do not count toward the 60 s window: nothing reached
     AssemblyAI.
   - Reconnects (`reconnect:true`) and synthetic checks may use the free tier's spare 5th slot, and reconnect tickets
     sort ahead of new-call tickets ("the ETA counts pending reconnect opens").
   - Tickets sort FIFO even within one millisecond: time plus an in-process counter in the id.
   - An expired or unknown ticket is treated as a new request and queues at the back.
   - The 3rd queued ticket per ipKey → `denied(E_RATE_LIMITED)`.
4. **Route #5 always answers HTTP 200 with a `SttTokenResponse`.** A non-balance upstream mint failure is
   `denied(E_QUEUE_TIMEOUT)` with a plain message and the cached-replay fallback. The contract's denial set has no
   upstream code, and DESIGN says "never a bare 502".
5. **VA registry.**
   - With a `takeoverId`, the slot row id is `va_<takeoverId>_<attempt>`. One attempt can never hold two slots, the
     retry can release attempt 0 by id, and the sweeper can find the takeover without a new column.
   - `vaAcquire` with a live hold marks the hold `released` and opens the new row with the hold's reservation
     (`ledger_id` moves). "The held slot becomes open", without double-counting.
6. **Route #10.**
   - One transaction: `SELECT … FOR UPDATE` on the takeover, the attempt/window checks, and `retries = retries + 1
     WHERE retries = 0`.
   - The attempt-0 slot is released before the retry acquires.
   - A second mint for the same attempt is refused.
   - Every refusal carries `fallback:"recorded_ai_session"`.
7. **Ledger.**
   - `remaining` is measured at the **start** of the UTC day, so the cap does not shrink while today's runs spend.
   - Before the epoch the dev guard is $3/day per env *family* (all `dev-*` together; other envs alone) and never flips
     the mode.
   - OpenAI has its own daily cap and never flips the mode. Polar is $0.
   - Amounts are rounded to numeric(10,5).
   - `reserve(refId = liveSessionId)` links `live_sessions.ledger_id`, so `report(closed)` settles automatically.
8. **Settlement.**
   - `closed` with `billedSeconds` → billed × list price.
   - Without it, but opened → wall time + 30 s (STT inactivity / VA bare-close tail).
   - Never opened → release.
   - Stale (F5) → the reserved amount.
   - Orphan reservations older than 20 min → the reserved amount.
9. **Mode reasons have ranks**, so an auto-cleared reason never overwrites an operator-cleared one:
   `budget_daily` < `synthetic_failed` < `va_audit_anomaly` < `budget_total` < `aai_balance` < `operator`.
   Synthetic checks may still open in `replay_only`, except for `aai_balance`: they are how `synthetic_failed` clears.
10. **F8 "3 consecutive 1008 closes on fresh tokens".** A report with `closeCode 1008` and nothing billed is counted in
    `rate_events` (bucket `aai-1008`); a normal close resets the count. There is no `close_code` column.
11. **`getLimitsAuthority()` (server).**
    - `LIMITS_ROLE=authority` → the DB authority.
    - Otherwise, with `LIMITS_AUTHORITY_URL` set → the remote client, with the split-budget laptop guard as fallback.
    - Neither → the laptop file guard, so local `next dev` shares the account-wide limits before the deploy.
12. **Job runner.**
    - `attempts` = consecutive throws (reset on success); 3 → `failed`. The lease is 30 s.
    - Steps are registered on `globalThis`, shared by every Next bundle in the process.
    - The process-wide runner resolves `getDb()` lazily.
13. **Health fixture.** WP4's `public/fixtures/health_16k.pcm`; until it exists, `spikes/fixtures/question_16k.wav`
    (the same "481529"). The Zerops bundle has neither yet, so full checks report `E_FIXTURE_MISSING` there until WP4
    ships the fixture.
14. **Admin flags.** A balance below the reserve wins over anything else posted. `mode:"live"` is the operator clear.
15. **Purge** deletes `watch`, `live` and `synthetic` cases older than 14 days (cascade), keeps `spot`. It also drops
    rate events older than 2 days, health checks older than 30 days, queue rows older than 2 days, and finished jobs
    older than 14 days. The ledger and live-session rows are kept.

## Known gaps (with the reason)

- **`next build` (Turbopack) in this worktree.** It panics on the junctioned `node_modules` (a worktree artifact).
  `next build --webpack` passes. **The integrator must confirm Turbopack on the main checkout.**
- **Local dev without a role or URL uses the laptop file guard.** Its VA ids are `lg_va_*`, so the route #10 retry
  cannot release the attempt-0 slot by id. With the guard's limit of 1 VA session, a local retry can be refused until
  that slot goes stale (30 s without a heartbeat). This does not happen on the DB authority. For local retry testing
  use `LIMITS_ROLE=remote` against the deployed authority. **Needs the deployed URL.**
- **Remote role (the Vercel mirror).**
  - Route #7 cannot check that a session belongs to the case (no DB authority).
  - `/api/status` reports `sttQueueDepth:0` and derives `aiHalfAvailable` from the mode only.
  - `/api/runs` cannot peek the broker ETA or the STT budget, so `sttHalf` is decided at connect time instead.
- **Wiring owned by others.** Streaming params (WP4 `buildSttParams`), the call manifest lookup (WP9/WP3), WP8's
  steps and hooks, and the two G1 seams from WP0b. See `docs/notes/requests/wp2-to-integrator.md`.
- **`x-forwarded-for` first hop.** Whether Zerops' L7 balancer appends or overwrites XFF is unverified. **Needs the
  deployed URL.**
- **The proxy cookie is `Secure` only in production.** Local http works because browsers treat localhost as secure.
- **The broker ETA ignores competitors arriving later** (the same approximation as the file guard). The queue stays
  correct because grants happen only in FIFO order under the advisory lock.

## Exactly what the integrator wires

**At G1** (details in `docs/notes/requests/wp2-to-integrator.md`):

1. `src/instrumentation.ts` `[WIRE-INPROC-WORKER]` → `startInprocWorker()`.
2. `scripts/lib/remote.ts` registering `RemoteLimitsAuthority`, with the split-budget fallback.
3. Zerops env: `LIMITS_ROLE=authority`, `LIMITS_AUTHORITY_KEY`, `ENABLE_INPROC_WORKER=1`, `BATON_DEPLOY_ID=zp-prod`.
   Remotes: `LIMITS_ROLE=remote` + `LIMITS_AUTHORITY_URL` + the key.
4. Confirm the Turbopack `next build` on main.

**At G2** (as the other WPs land):

5. `[WIRE-STT-PARAMS]` → WP4 `buildSttParams`.
6. `[WIRE-CALLS]` → `registerCallLookup` from the manifest loader.
7. `[WIRE-WP8-STEPS]` → import WP8's job modules in `installBuiltinSteps()`.

## How to run

```bash
npm run typecheck && npm test        # DB suites need DATABASE_URL (CREATEDB) or TEST_DATABASE_URL; else they skip
node scripts/lib/run-with-env.mjs RUN_LIVE=1 -- npx vitest run tests/integration/tokens.test.ts   # ≈ $0.0025
```
