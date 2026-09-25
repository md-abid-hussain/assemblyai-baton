# WP14a → WP12: the full `npm test` run can exhaust Postgres connections on a cold DB

**Raised:** D1 Fri Sep 25, during WP14a·2's post-G2-merge verification on `wp/wp14a`.
**Severity:** flaky, not broken. It cost one red run out of three here, and it will hit the integrator at G3/G4.
**Not my paths** — filing rather than fixing. WP12 owns `src/server/db/**` and integration/ops; the helpers below are
spread across WP12, WP14b and WP16, so WP12 seemed the right single addressee. Reassign freely.

## What happened

On the **first** full `npm test` after merging `main` (`c913c63`) into `wp/wp14a`, 4 files failed:

| File | Owner |
|---|---|
| `tests/unit/server/cases/prefill.test.ts` | WP14b |
| `tests/unit/server/cases/repository.test.ts` | WP14b |
| `tests/unit/server/limits/ledger.test.ts` | WP12 |
| `tests/unit/server/tools/g1-stack.test.ts` | WP16 (from G2) |

plus one failing test each in `runs-va.test.ts`, `payments/routes.test.ts` and `limits/platform-routes.test.ts`.

The failures are **not assertion failures**. Each file sat at the 20 s `testTimeout` (20672 ms, 21102 ms, 21143 ms,
20698 ms against a 19.84 s whole-run duration), and the visible errors are downstream of a connection that never
arrived: `pg-protocol` parse errors, and zod complaining that a row came back `undefined`.

**The same run is green when anything reduces concurrency:**

- `npx vitest run tests/unit/server/tools/g1-stack.test.ts` alone → pass;
- `npx vitest run tests/unit/server` (34 files, 320 tests) → all pass;
- the 2nd and 3rd full `npm test` (warm DB, 9.27 s) → **114 files, 1570 passed, 1 skipped, 0 failed**.

## Why

`vitest.config.ts` has `fileParallelism: true` when `RUN_LIVE !== "1"`, and vitest isolates each file in its own
worker process. **17 test files build their own `pg.Pool`**, and the pool ceilings add up well past the server:

| Helper | `max` |
|---|---|
| `tests/unit/server/cases/helpers/test-db.ts` | `o.poolMax ?? 15` |
| `tests/unit/server/limits/helpers/test-db.ts` | 20 |
| `tests/unit/server/payments/test-db.ts` | 10 |
| `tests/unit/server/verify/helpers.ts` | 10 |
| `tests/unit/server/takeovers/_db.ts` | 5 |

`baton-pg` runs the stock `max_connections = 100`. Pools open lazily, so a warm run never fills them — but on a cold
DB every file does more concurrent work at once, the ceilings are reached, and `connectionTimeoutMillis: 3000` (or the
20 s test timeout) fires. Nothing here is specific to the `main` merge; the merge only added enough files to make it
likely.

## Suggested fixes (WP12's call)

1. **Cheapest:** raise `max_connections` on `baton-pg` (200 is plenty) and document it wherever the container is
   started. No code changes, no ownership crossings.
2. Drop the helper ceilings to `max: 3–5`. No suite needs 15–20 connections in one worker; they are ceilings, not
   reservations. Touches four owners.
3. Give the DB files a `poolOptions`/`maxConcurrency` cap, or move them into a second vitest project that runs with
   `fileParallelism: false`, so the pure-core files keep running wide.

(1) alone should be enough for G3. My read is that (1) + (2) is the durable pair.

## What WP14a needs

Nothing blocking. WP14a's own suites are pure and DB-free: `tests/unit/core/relay` is 14 files / 340 tests and passes
standalone every time. Flagging it only so a red integrator run is diagnosed as this and not as a real regression —
**re-run before bisecting.**
