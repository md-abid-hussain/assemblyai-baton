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
