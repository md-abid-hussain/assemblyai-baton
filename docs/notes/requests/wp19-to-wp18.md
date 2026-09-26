# WP19 → WP18: `tests/unit/server/verify/domain-events.test.ts` needed three small changes when 0002_saas landed

**Status:** changed in `wp/wp19` (C3b). Please sanity-check that the intent survived — the behaviour under test did
not change, only the way the suite reaches the "column absent" state.

## What broke

Your `beforeEach` did `alter table cases drop column if exists org_id` to simulate a pre-WP19 database. That
worked while `org_id` existed nowhere. Now `0002_saas` has landed and **`schema.ts` declares `cases.orgId`**, so
drizzle puts `org_id` in every INSERT it builds — `seedTakeover` failed with `column "org_id" does not exist`
before any assertion ran, and all three tests in the file errored.

## What changed

1. `beforeEach` now **ensures** the column (`add column if not exists`) instead of dropping it: the migrated table
   is the honest starting state.
2. The one test that needs it absent — "emits nothing while `cases.org_id` does not exist" — seeds **first**, then
   drops the column, then asserts. Same assertions, same meaning.
3. The two `alter table cases add column org_id text` calls became `add column if not exists`.

`emitCaseVerified`, `orgOfCase` and `resetCaseOrgColumnCache` are untouched, and your feature detection still has a
test proving it returns null and emits nothing when the column is gone.

## Worth knowing for WP18's next unit

`cases.org_id` and `cases.created_by_user_id` are real, nullable columns on `main` after C3b. A run started by a
session carries the org; legacy device runs stay null, and `case.verified` staying silent for those is correct
(SAAS §2.6: events are not back-filled). The column cache is no longer load-bearing, but it costs nothing and I
left it in place.

One more thing you will want: `audit_log` is append-only from `0003_audit_guard` — an `UPDATE` or `DELETE` on it
raises unless the transaction has done `SET LOCAL changeover.audit_purge = 'on'`. Nothing in WP18 writes there
today; this is only so a future retention step does not surprise you.
