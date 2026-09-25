# WP14b notes: server engine, relay registry, runtime switch

## WP14b·1: migration 0001, relay registry, `/api/relays`, gallery seed (D1 Fri Sep 25, ≈10:40–11:05 IST)

Branch `wp/wp14b` (worktree `.wt/wp14b`), based on `main` = `175a6b7` (C2). `git merge main` was a no-op.

| Commit | What |
|---|---|
| `747d0be` | `drizzle/0001_relays.sql` + meta, the additive tables in `src/server/db/schema.ts`, the one-line scaffold test update |
| `429f7e0` | `src/server/relays/**`, `src/app/api/relays/**`, `src/core/contracts/ext/wp14b-relays.ts`, pure tests |
| `e5b6582` | DB tests: migration, registry, routes, quotas, LRU |
| (next) | request files, these notes |

### Done

- **Migration `drizzle/0001_relays.sql`**, generated with `drizzle-kit generate --name relays`, so `drizzle-kit
  generate` reports no diff afterwards. It follows P§2.4 v2.1:
  - the tables `relays` (with `last_used_at` and the partial LRU index), `relay_versions` (with `moderation`, and
    UNIQUE on `(relay_id, version)` and `(relay_id, blueprint_hash)`), `relay_publications`, `connector_secrets`
    (`bytea`), `connector_calls` (with `args_hash`/`result` and the dedupe and analytics indexes), `sim_calls` (with
    `kind`), `tts_cache` and `drafts` (with the async statuses);
  - `cases.relay_version_id` and `cases.sim_call_id`, plus `cases_relay_version_idx`.

  It is additive only: no DROP, no ALTER COLUMN. `schema.ts` exports `RELAY_TABLES` and `EVERY_TABLE`;
  `ALL_TABLES` still lists the 0000 tables.
- **`PgRelayRegistry`** (`src/server/relays/registry.ts`) implements the full `RelayRegistry`, including
  `setVisibility`:
  - workspaces are `ws_<visitorId>` from WP12's `requireVisitor`;
  - access: owner, read-only (gallery, or someone's unlisted relay) or 404; `:id` is an id or a slug;
  - drafts: optimistic `draft_rev`; a schema failure → 422 `E_LINT` and nothing is stored;
  - versions are content-addressed (an unchanged draft → the same version; a revert → the old version becomes
    current again);
  - `stripSecrets` on cross-workspace clones;
  - soft delete;
  - `last_used_at` is bumped on owner reads (at most once a minute), saves, snapshots and creates;
  - `moderate()` is cached once per version through a `Moderator` port;
  - the `publication` in `RelayDetail` comes through a `PublicationLookup` port (WP18).
- **The global cap never refuses a create** (P§10.2). Inside the create transaction, under an advisory lock:
  - at the soft cap (400 live non-gallery relays), the least-recently-used unpublished relay that has been idle for more
    than 1 h is archived;
  - above the hard cap (2000), the LRU unpublished relay is archived whatever its idle time;
  - published relays (`status` or a live `relay_publications` row) and gallery relays are never archived.
- **`seedGallery()`** (`seed.ts`):
  - reads `data/relays/*.json` plus `<base>.presets.json` (RFC 6902 patches, `json-patch.ts`) into `ws_gallery`,
    flagship = `baton-add-driver.json`;
  - it is idempotent by content hash: the second boot creates 0 versions and writes 0 rows, and an advisory lock
    serializes concurrent containers;
  - presets are versions with `preset = {id, label, baseVersionId}` and are rebased when the file changes;
  - seeded versions are pre-marked moderated (`source: "seed"`);
  - it runs lazily, once per process, before the first relay request (`ensureSeeded`), and retries after a failure.
  - **Stub until WP14a·2 / WP17:** `data/relays/` does not exist yet, so the seed is a no-op on the real server. The
    tests use `MemoryGallerySource` with the WP14a mini blueprint as "Dental deposit" (2 presets) and a flagship
    stand-in.
- **Routes**, `src/app/api/relays/**` (the handlers are in `src/server/relays/routes.ts`):
  - `GET/POST /api/relays`;
  - `GET/PUT/DELETE /api/relays/:id`;
  - `PUT /:id/draft`;
  - `POST /:id/versions`;
  - `GET /:id/compiled`, which answers 503 `E_MAINTENANCE` until the compiler is injected (WP14b·2).

  Errors use the `ApiErrorV2` envelope (`RelayError` carries the v2 codes and `lint`). A 409 draft conflict body is
  `{conflict, rev, error}`. `next typegen` plus `tsc` validate the route signatures.
- **Quotas** (`quotas.ts`, numbers in `ext/wp14b-relays.ts`):
  - `relay:create`: 5 live relays per workspace, 10 per visitor per day, and 20 per ipKey per day in
    `relay:create:ip`. Clones of gallery relays, presets and unlisted relays are exempt;
  - `relay:save`: 120 per visitor per hour (draft, visibility, versions);
  - reads, compile and delete are never rate-limited, and the paid buckets never gate a Studio action.

### Decisions

1. **`relay_versions.preset jsonb`** is an addition to P§2.4. The "Try an edit" presets need a label and a base
   version, and P§2.4 has no place for them. The column is nullable and additive.
2. **The blueprint hash** is `sha256hex(canonicalJson(parsed blueprint))` with recursively sorted keys. It is pinned by
   a test vector, and WP14a's isomorphic version must match it (`requests/wp14b-to-wp14a.md`). The seed never
   rewrites a gallery file, so a stored hash equals the hash of the file as parsed.
3. **The kernel is a port** (`kernel.ts`), because WP14a's `lint.ts`/`migrate.ts` are not on `main`. The default
   parses with `BlueprintSchema` and returns `SCHEMA` issues only. The swap to `lintBlueprintJson` and
   `blueprintHash` is one file, done in WP14b·2.
4. **Clone** sets `meta.origin = "clone"`, keeps `meta.title`, and gets a relay slug of `<meta.slug>-<8 lower alnum>`.
   `relayId` may be a version id (`rv_…`), so "Keep editing" after a preset clones exactly that version. Gallery
   relays are cloned from their current draft, which is always their current version.
5. **Archived relays** (`status = 'archived'`) disappear from lists and reads, but the rows and versions stay, because
   runs point at them. Delete is a soft delete (`deleted_at`).
6. **Gallery relays** have `workspace_id = ws_gallery`, `visibility = gallery` and `status = draft`. They are always
   read-only (403 `E_READ_ONLY` on every write route, including `POST /versions`). A run uses their
   `currentVersionId` or a preset `versionId` directly (WP14b·2).
7. **`POST /api/relays` answers 201.** `POST /versions` answers 201 when it creates a version and 200 when it reuses
   one.
8. **`tests/unit/platform/scaffold.test.ts`** (WP12's) asserted a single migration. I changed only that assertion,
   because the migration is this unit's deliverable. It is flagged in `requests/wp14b-to-wp12.md`.

### Tests

`npm run typecheck` is clean. `npm test` passes **842/842** (67 files; +37 new, all in `tests/unit/server/relays/`):

- **`pure.test.ts`** (10): canonical JSON and the pinned hash vector; the JSON patch operations and errors; the
  presets file format; the blank blueprint passes the schema for all 7 industries; `stripSecrets`;
  `moderationText`; the default kernel.
- **`migration.test.ts`** (5):
  - the static checks on the SQL;
  - **`drizzle-kit generate` shows no diff** (run against a temporary copy of `drizzle/`);
  - on a fresh Postgres, 2 migrations apply and **the second run applies 0**;
  - **on a populated 0000 database** (the Zerops path), 0001 applies, the existing case keeps null new columns, and a
    rerun is a no-op.
- **`registry.test.ts`** (12):
  - **the seed: 4 versions, then 0 on the second boot, with the rows byte-identical**;
  - a changed file → a new current version with rebased presets, and back again with 0 new rows;
  - create (blank, clone, clone of a preset `rv_`, blueprint, errors);
  - the draft rev conflict;
  - content-addressed snapshots;
  - workspace isolation and unlisted;
  - moderation caching and flagging;
  - soft delete;
  - **LRU archive:** the soft cap archives the idle LRU (published exempt), the soft cap with nothing idle still
    creates, and the hard cap archives regardless of idle time.
- **`routes.test.ts`** (10), all TASKS-v2 acceptance item 2 sub-points:
  - **gallery 403** on PUT draft, PUT, DELETE and POST versions, while its **preset versions are listed** (and
    clonable);
  - **clone at the global cap** archives instead of refusing;
  - **draft rev conflict → 409**;
  - **`POST /versions` 201 then 200 with the same version**;
  - **workspace isolation → 404** (by id and by slug, and for a visitor with no identity);
  - **quota 429s never block a $0 action**: the 6th blank → 429 with the P§10.2 copy, while a gallery clone, a save,
    a snapshot and reads still work with every paid bucket exhausted; only `relay:save` itself refuses a save, with
    `Retry-After`;
  - the daily bucket;
  - the compiled route's 404/503/injected paths;
  - 400/422 bodies.

The DB suites use real Postgres (the local docker DB from `.env`, one throwaway database per file) and skip without
`DATABASE_URL`.

### Live spend

**$0.** No AssemblyAI, OpenAI or Zerops access.

### What the integrator must do

1. Merge `wp/wp14b`. It touches only WP14b paths, plus the one assertion in `tests/unit/platform/scaffold.test.ts`.
   The next container start applies `0001_relays.sql` through `bundle/migrate.mjs`; there is no manual step.
2. Apply `requests/wp14b-to-wp12.md` §2: `outputFileTracingIncludes` for `./data/relays/*.json`. Otherwise the Zerops
   gallery stays empty once the JSON files exist. §3 (the boot seed in `instrumentation.ts`) is optional.
3. Nothing to set in the GUI. No new env vars.

### Acceptance status (TASKS-v2 WP14b)

| # | Item | Status |
|---|---|---|
| 1 | Migration on fresh Postgres and on a populated 0000 database; second run a no-op; `drizzle-kit` no diff | Done locally. **Zerops is pending the integrator's deploy** |
| 2 | Route tests (gallery 403, clone at cap, 409, idempotent snapshot, isolation 404, $0 never 429) | Done. The "preset versions **run**" part is WP14b·2 (`/api/cases` with `relayVersionId`) |
| 3 | Seed: two boots create 0 versions | Done, on the stub gallery. The real files come from WP14a·2 and WP17 |
| 4–6 | Dental case / moderation block / kernel parity / `buildQaInput` | WP14b·2 and WP14b·3 |

### Where WP14b·2 starts

1. `git merge main`. If WP14a·2 has landed, swap `src/server/relays/kernel.ts` to `lintBlueprintJson` and
   `blueprintHash` from `src/core/relay/**`, and check that the pinned hash vector and `blankBlueprint` pass the full
   lint.
2. `src/server/relays/moderation.ts`: the OpenAI `omni-moderation-latest` `Moderator` (free, through
   `src/server/openai/client.ts` with a $0 ledger reserve/settle). Bind it in `buildRelaysDeps`. Fail closed for
   Publish, fail open for Test runs of gallery-derived relays (P§7.4).
3. `src/server/engine/**`: `RelayEngineFactory` (LRU 50; `forVersion(null)` = legacy Baton) using
   `registry.getVersion`. Then wire `compileView` for `GET /:id/compiled`.
4. `/api/cases`: `relayId` → `registry.snapshotVersion` (owner) or the gallery's `currentVersionId`; `relayVersionId`
   (presets) → `getVersion` and check the relay is visible to the workspace. Moderate before a version's first run;
   flagged → 422 `E_MODERATION_FLAGGED`. Also the `UiSpec`/`listening`/`provenance` fields and
   `cases.relay_version_id`.
5. The extractor and verifier through `compiled.extractor`, the WP5 compile port, `buildQaInput`, and the
   `platform-stub.ts:50` ipKey swap.
6. Open for WP14b·3: Try an edit on **clones** (`RelayDetail.presets` is `[]` for clones today).
