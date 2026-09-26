# WP18 → WP19: `relay_publications.org_id`, `cases.org_id`, and the boundaries scanner

From WP18·1 (D1 Fri Sep 25, ≈21:00 IST). Three small things for `0002_saas` / C3b; none of them blocks you.

## 1. `relay_publications.org_id` — WP18 writes it the moment your column exists

TASKS-v3 §2 rule 14 means WP18 adds no migration, so `src/server/publish/org.ts` feature-detects the column
(`information_schema`, cached per process) and:

- **writes** `org_id = <the relay's workspace_id>` on every publish and republish once the column is there;
- **counts** live publications through the `relays` join, which is correct before *and* after `0002`, so
  `Entitlements.assertCount(org, "livePublications")` already works today.

So your `0002` back-fill (SAAS §2.4 step 5, "`relay_publications.org_id` for the moved relays") only has to cover rows
published **before** the migration. After it, new rows carry the org by themselves. `workspace_id ≡ organization.id`
is the assumption throughout — if a moved relay ever gets a `workspace_id` that is not its org id, say so and WP18
will read the column instead of the join.

If you would like the column populated in the same statement that inserts the row (one less write), add `org_id text`
to the drizzle table in `src/server/db/schema.ts` in `0002` and WP18 will switch to it in WP18·2.

## 2. `cases.org_id` unlocks `case.verified` with no further wiring

`src/server/qa/domain-events.ts` emits `case.verified` from the async verification job (SAAS §7.1, §12 WP18 row). It
feature-detects `cases.org_id` the same way and emits **only** when the run carries an org, exactly as §7.1 requires
("events are not back-filled"). Before `0002` every call is a cheap no-op; after it, runs whose `org_id` is set start
producing events with no change on either side.

- `dedupeKey` is `case.verified:<takeoverId>`, so a retried verification never doubles a delivery.
- The payload is validated against your `CaseVerifiedData` before it is handed to `DomainEvents.emit`.
- `links.run` is `<APP_URL>/app/runs/<takeoverId>` and `links.api` is `<APP_URL>/api/v1/runs/<takeoverId>`. If WP20's
  or WP22's final paths differ, tell me and I will change the one helper (`runLinks`).

## 3. The §10.1 rule 1 boundaries scanner must follow a re-export

WP18's five routes are thin `src/app/api/**/route.ts` files that re-export handlers from
`src/server/publish/routes.ts`, where `requirePrincipal` is actually called (the same shape WP14b uses for
`src/server/relays/routes.ts`). A scanner that greps each `route.ts` for `requirePrincipal` will flag them all.
Please resolve a single-identifier re-export to its source module, or allowlist these two patterns:

| Route file | Principal |
|---|---|
| `src/app/api/publications/[id]/route.ts` | `GET` is **public** (the share page, SAAS §2.5); `DELETE` needs `relay:publish` |
| `src/app/api/publications/[id]/runs/[takeoverId]/state/route.ts` | `requirePrincipal(req, { allowVisitor: true })`, then the run's own `visitorId` must match |
| `src/app/api/connectors/pub/[pubId]/[tool]/route.ts` | **no principal by design**: AssemblyAI's servers carry no cookie. The credential is `X-Changeover-Key`, compared constant-time against `relay_publications.key_hash`. This belongs on the public allowlist next to `webhook-inbox` |
| `src/app/api/relays/[id]/publish/route.ts` (WP14b mounts it) | `requirePrincipal(req, { perm: "relay:publish" })` |
