# WP14b → WP18: publications in `RelayDetail`, relay status, your tables in 0001

From WP14b·1 (D1 Fri Sep 25).

1. **`RelayDetail.publication`** comes from a port that is `null` until you plug it in:
   `PublicationLookup { forRelay(relayId): Promise<PublicationView | null> }` (`src/server/relays/registry.ts`).
   Wire it with `setRelaysDeps({ publications })`, or ask WP14b to bind your default in `src/server/relays/index.ts`
   once `src/server/publish/**` is on `main`.
2. **Set `relays.status`** to `'published'` when a publication goes live, and back to `'draft'` on unpublish. The LRU
   archive at the global cap (P§10.2) skips relays that are `published` or have a `relay_publications` row in
   `creating`/`live`. Both checks are in place; the status is the cheap one.
3. **`DELETE /api/relays/:id`** soft-deletes the relay (`deleted_at`). It does not unpublish. If you want delete to
   unpublish first, send a request and WP14b will call your `Publisher.unpublish` before the soft delete.
4. **Your tables** are in `drizzle/0001_relays.sql`: `relay_publications` (P§2.4 verbatim; `share_slug` is unique)
   and `connector_calls` (with `args_hash` and `result`, the dedupe index `(takeover_id, tool_name, args_hash,
   created_at)`, and the analytics index `(relay_version_id, created_at)`). The Drizzle tables are
   `relayPublications` and `connectorCalls` in `src/server/db/schema.ts`. `cases.relay_version_id` has the index
   `(relay_version_id, created_at)` for per-version analytics.
5. **Moderation before publish:** `getRelaysDeps().registry.moderate(versionId)` returns `{flagged, categories}`,
   cached once per version in `relay_versions.moderation`. The OpenAI implementation lands in WP14b·2. Until then it
   throws `E_INTERNAL` for non-seed versions; seeded gallery versions are pre-marked clean.

---

## From WP14b·2 (D1 Fri Sep 25)

6. **Moderation is live.** `getRelaysDeps().registry.moderate(versionId)` is the Publish policy of P§7.4: the stored
   result, else the gallery-text pre-clear, else OpenAI `omni-moderation-latest` (free, a $0 ledger reserve → settle),
   cached in `relay_versions.moderation`. **Publish fails closed**: when the endpoint is unavailable it throws
   `ModerationUnavailableError` (`src/server/relays/moderation.ts`) and you should answer 503, not publish. Test runs
   have their own policy (`moderateForRun(versionId, "test")`) and are not yours.
7. **One of your test files was edited**, for the same reason as WP12's scaffold test in WP14b·1: migration 0001 is
   this WP's deliverable. `tests/unit/server/verify/va-audit.test.ts`, the case
   "readPublishedAgents is [] without relay_publications and reads the live rows once 0001 exists", created
   `relay_publications` by hand; the migrated test database now already has it, so the create failed with
   `42P07 relation "relay_publications" already exists`. One statement was added in front -
   `drop table if exists relay_publications` - so the test still covers both branches (no table → `[]`, then the
   table → the live rows). Nothing else in the file changed, and its hand-written DDL matches 0001 column for column.
   If you would rather read the migrated table directly and drop the DDL, that is your call.
8. **`PublicationLookup` is still `null`** in `buildRelaysDeps` (`publications: o.publications ?? null`).
   `src/server/publish/**` is not on `main` after the G2 merge of `wp/wp18`, so there was nothing to bind. Item 1
   above still stands: send a request, or bind your default yourself once the module lands.
