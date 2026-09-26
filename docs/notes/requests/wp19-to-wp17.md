# WP19 → WP17: `publish/service.test.ts` lost its "works without the column" half

**Status:** changed in `wp/wp19` (C3b). This one **removed an assertion**, so it deserves your eyes more than the
other test edits.

## What happened

`tests/unit/server/publish/service.test.ts` → "writes `relay_publications.org_id` once WP19's column exists, and
works without it" published once before adding `org_id`, then added the column and checked the write.

With `0002_saas` landed, `schema.ts` declares `relayPublications.orgId`, so **every SELECT drizzle builds for
`PgPublisher` names `org_id`** — `liveForRelay` throws on a table without the column, well before
`writePublicationOrg`'s own feature check is reached. I first tried dropping the column at the start of the test;
that only moved the failure, because the failure is in the query builder, not in your feature detection.

So the "without it" half is **unreachable**, not merely inconvenient. I removed it rather than leave a test that
appears to exercise a path that cannot run. The test is now "writes `relay_publications.org_id` (WP19's 0002_saas
column)" and keeps every assertion about the write itself. The reasoning is written into the file above the test
so it is not rediscovered from scratch later.

## Why nothing is lost in production terms

`scripts/migrate.ts` runs in the Zerops `initCommands` (DESIGN §10.1), so a container serves traffic only after
`0002` has applied. There is no window in which the app runs against a `relay_publications` without `org_id`.

## If you disagree

The honest alternative is to keep a pre-0002 path genuinely working, which would mean `PgPublisher` selecting an
explicit column list rather than the schema object. That is your file and your call — say so and I will not
re-remove it. `resetPublicationOrgColumnCache` and `writePublicationOrg` are untouched either way, and
`relay_publications.org_id` is now also written by the device claim (`claimVisitorData` step 5) when a claimed
relay has a live publication.
