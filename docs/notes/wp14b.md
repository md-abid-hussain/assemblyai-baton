# WP14b notes: server engine, relay registry, runtime switch

## WP14b·1: migration 0001, relay registry, `/api/relays`, gallery seed (D1 Fri Sep 25, ≈10:40–11:05 IST)

Branch `wp/wp14b` (worktree `.wt/wp14b`), based on `main` = `175a6b7` (C2). `git merge main` was a no-op.

| Commit | What |
|---|---|
| `747d0be` | `drizzle/0001_relays.sql` + meta, the additive tables in `src/server/db/schema.ts`, the one-line scaffold test update |
| `429f7e0` | `src/server/relays/**`, `src/app/api/relays/**`, `src/core/contracts/ext/wp14b-relays.ts`, pure tests |
| `e5b6582` | DB tests: migration, registry, routes, quotas, LRU |
| `0353091`, `3b5b307` | request files (`docs/notes/requests/wp14b-to-{wp12,wp14a,wp15,wp16,wp17,wp18}.md`), these notes |

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

## WP14b·2: engine-for-version wiring, moderation, platform-stub ipKey swap (D1 Fri Sep 25, ≈14:30–15:00 IST)

The first attempt at this unit stopped at a usage limit. Its uncommitted work (the moderator, the run policy, run
resolution, the factory LRU, the ipKey swap) typechecked and was kept as `09f8221`. `git merge main` was a no-op:
`main` is still C2 (`175a6b7`). WP14a·2 (`compileRelay`, `policyToAccount`, `lintBlueprintJson`), WP12·0 (the
`client-ip.ts` hop fix) and WP17·1 (`SimCallStore`) are on their branches only, so each is consumed through a port that
is swapped in one place after their merge.

| Commit | What |
|---|---|
| `09f8221` | the kept work: `OpenAIModerator`, `moderateForRun`, `resolveRun`/`runVersion`/`galleryVersionFor`, `CachedRelayEngineFactory`, the ipKey swap |
| `9509d8e` | the kernel binding slot, `RelayCallCatalog`, the compiled view, relay runs on `/api/cases`, the default moderator, pure tests |
| `3c7e6d7` | DB tests: relay runs, the compiled route, run resolution, the moderation policy |
| `233ca12` | the platform-stub ipKey test |
| `ae0dd23`, `f40bb0a`, `49becc2` | request updates (`wp14b-to-{wp14a,wp15,wp17}.md`), these notes. A resumed run re-verified typecheck and 871/871 after a no-op `git merge main` |

### Done

- **Kernel binding** (`src/server/engine/kernel-binding.ts`, type `KernelBinding` in `ext/wp14b-engine.ts`): `compile`
  (= `compileRelay`), `policyToAccount` and `cannedSnapshot` (lint G2's four states). It is **null on `main` today**.
  While it is null:
  - `forVersion` answers 503 `E_MAINTENANCE`, and the failure is not cached;
  - `GET /api/relays/:id/compiled` answers 503;
  - `/api/cases` relay runs answer 503 after their access and moderation checks;
  - Baton runs keep their exact v1 response.

  Tests bind a fake with `setKernelBinding` or the `binding` override.
- **`RelayEngineFactory`** (`engine/factory.ts`):
  - an LRU of 50 compiled versions (versions are immutable, so an entry never goes stale);
  - concurrent misses share one compile;
  - a failed compile is not cached;
  - the compiler is read from the binding at each miss, so binding it later needs no rebuild;
  - `forVersion(null)` is `data/relays/baton-add-driver.json`, compiled with `flagship: true, versionId: null`.

  It lives on `RelaysDeps.engine` (`getRelaysDeps().engine`).
- **`CallCatalog`** (`engine/catalog.ts`, `RelaysDeps.catalog`). Recorded calls come first (WP3's
  `CaseDataSource.getCall`; `simulated: false`, no version, no account). Then sims come through WP17's `resolveCall`
  port:
  - DB sims keep their `relayVersionId`;
  - gallery sims are mapped from slug + blueprint hash to the seeded version (else the current version);
  - the account is `samples[sampleIndex]`.

  The resolver is `null` until WP17 merges; then it is one line: `sims: () => getSimCallStore()` in `buildRelaysDeps`.
- **`POST /api/cases` relay runs** (`server/cases/create.ts`, `engine/run.ts`). The route parses
  `CreateCaseRequestV2Schema`. For `relayId` / `relayVersionId`, `prepareRelayRun`:
  1. seeds the gallery;
  2. resolves the version in the visitor's workspace. `relayVersionId` may be any version `ws` can see (presets);
     `relayId` snapshots the owner's draft, or a reader runs the current version. Across workspaces it is a 404, and
     lint errors are a 422 `E_LINT`;
  3. resolves the call through the catalog (a DB sim of a relay `ws` cannot see is "Unknown call.");
  4. **moderates before the version's first run**: flagged → 422 `E_MODERATION_FLAGGED` with top-level `categories`;
  5. compiles through the factory.

  The case row records `relay_version_id` and `sim_call_id`. The response adds `account`, `relay` (`UiSpec` with
  `relay.simulated` set per run), `listening`, `simulated` and `provenance`, and parses as `CreateCaseResponseV2`. The
  account is the run version's sample at the sim's index, so a preset that edits sample data plays the base sim with
  its own numbers.

  **Only the flagship (Baton) relay creates a case today.** Any other relay answers 503 after the checks, because the
  case engine is Baton's until the P§4.7 widening and WP14a·3 spec injection (WP14b·3). A plain Baton run gains the v2
  fields through `forVersion(null)` only when the kernel is bound. That path is best effort: a failure is logged and
  never fails the run.
- **Moderation** (P§7.4). The default `Moderator` in `buildRelaysDeps` is `OpenAIModerator`:
  - `omni-moderation-latest`, free, one request of ≤ 16 inputs × 4000 chars, `maxRetries: 0`, 8 s timeout;
  - **a $0 ledger reserve → settle** (provider `openai`, action `moderation`, env `BATON_DEPLOY_ID`), released on
    failure;
  - every failure (no key, no or refusing ledger, HTTP, a malformed answer) is `ModerationUnavailableError`.

  The policy lives in `PgRelayRegistry.moderateForRun(versionId, "test" | "publish")`:
  1. the stored result;
  2. **the gallery-text pre-clear**: when every author line already appears in a seeded gallery version (clones, presets,
     edits that touch no spoken text), it is stored as `source: "seed"` with no call;
  3. otherwise OpenAI, stored.

  When the endpoint is unavailable, **Publish fails closed** (503). A **Test run fails open only for gallery-derived
  relays** (gallery or clone), and that result is not stored; a user-authored relay fails closed. Any other error
  propagates. `RelayRegistry.moderate()` is the Publish policy (WP18).
- **`GET /api/relays/:id/compiled`**: the default `compileView` (`engine/compile-view.ts`) returns a
  `CompiledRelayView` with:
  - greetings for every sample × the 4 canned states (word count, seconds at 0.34 s/word);
  - prompts and tools per runtime stage for sample 0 in `one_pending`;
  - `extractor.strictOk` from the OpenAI strict-mode rules;
  - `firstUpdate` from `compiled.takeover()` (a throw is `{ok: false, reason}`, never a 500).

  Lint errors → 422 `E_LINT`. A version compiles through the LRU; a draft compiles directly with
  `flagship: detail.flagship`.
- **`platform-stub.ts:50`**: the stand-in's ipKey is now WP12's `ipKeyOf(req)`, with the same material and hmac. It
  follows the WP12·0 hop fix (`client-ip.ts`: X-Real-IP or the rightmost XFF, /24 and /48, `IPKEY_MODE`) automatically
  once `wp/wp12` merges, so there is no second edit. The stub is only used by WP3's unit tests; production binds
  WP12's auth.
- `cases/http.ts` `route()` maps `RelayError` to `ApiErrorV2` bodies. `repository.create` takes `relayVersionId` and
  `simCallId`. `registry.canSeeVersion(ws, versionId)` is new.

### Decisions

1. **One kernel binding, null until WP14a merges** (TASKS-v2 §2: no unmerged imports). The Baton path is untouched
   while it is null, so this branch can merge at G2 with zero behaviour change for the Baton slice.
2. **The gallery-text pre-clear** adds a step to P§7.4. Seeded text is ours and was pre-marked moderated in WP14b·1.
   Sending a clone's unchanged text to OpenAI would only add latency and a failure mode. The check is line-exact.
3. **Fail open is not stored**, so the next run asks again once the endpoint is back.
4. **The provenance defaults** at case creation:
   - recorded takes: recorded / live / live / recorded;
   - sims: simulated / live / live / synthetic, plus the §7.5 detail line.

   The console changes the segments only it knows about: a cached replay, a recorded AI session, the mic.
5. **The factory compiles with `simulated: false`.** It caches per version, so the run sets `ui.relay.simulated`.
6. **The non-Baton gate is a 503 with a friendly message**, not a half-working Dental case on Baton's `CaseState`.
   It is lifted in WP14b·3 together with the widening.
7. Everything new takes the workspace (`ws`) as a parameter, with no globals, so it can be org-scoped later (SaaS).

### Not in this unit (with reasons) → WP14b·3

- **The extractor and verifier through `compiled.extractor`**, and **`buildQaInput`** (WP8's `build-input.ts` moves to
  WP14b at G2). They only matter for non-Baton cases, which cannot exist before the widening. Baton keeps the WP1
  extractor (parity).
- **The WP5 compile port** (`TakeoverService` → `forVersion(case.relay_version_id).takeover(...)`). WP5's
  `src/server/takeovers/**` moves to WP14b at G2 and is not on `main`.
- Express re-extraction, `RELAY_ENGINE=kernel`, the parity check over Postgres, and the Dental path (T3 as planned).

### Tests

`npm run typecheck` is clean. `npm test` passes **871/871** (71 files; +29). The local `baton-pg` container was
restarted: Docker Desktop was not running.

- **`tests/unit/server/engine/engine-pure.test.ts`** (11):
  - the factory LRU: shared misses, eviction order, a 404 is not cached, no kernel → 503 not cached then a late
    binding works, a throwing compile is retried, `forVersion(null)` = the flagship file;
  - the catalog: order, the gallery-sim hash mapping and its fallback, no resolver;
  - the compiled view: schema-valid, `firstUpdate` failure, `strictSchemaErrors`;
  - `runAccount`, the provenance defaults, the binding slot.
- **`tests/unit/server/relays/moderation.test.ts`** (6): the pinned model and one request; $0 reserve → settle;
  flagged categories; all six unavailable paths release (never settle) and never reach OpenAI when the ledger refuses;
  chunking never drops text.
- **`tests/unit/server/engine/runs.test.ts`** (9, Postgres), through the real route handlers:
  - a flagship run records `relay_version_id` and returns valid v2 fields, and a second run is an LRU hit;
  - a plain Baton run is v1 without a kernel and v2 with one;
  - no kernel → 503, but 404 comes first;
  - **a preset version runs** (resolve → seed-moderated with 0 calls → compiled → the non-Baton 503);
  - **flagged → 422 `E_MODERATION_FLAGGED` with categories, nothing compiled, checked once**;
  - moderation down: a clone fails open, a blank fails closed;
  - isolation 404, and unlisted is visible;
  - a gallery sim runs with its sample, the simulated provenance and `sim_call_id`, while a private DB sim of another
    workspace is a 404;
  - the compiled route (draft, version, flagship) and lint errors → 422 on both the compiled view and a run.
- **`registry.test.ts`**: the moderation test was rewritten for the policy (gallery-text pre-clear, openai, flagged,
  stored), plus fail open and fail closed, and run resolution (`resolveRun`, `canSeeVersion`, `galleryVersionFor`).
- **`tests/unit/server/cases/platform-stub.test.ts`** (1): the stub's ipKey = `ipKeyOf` for 5 header shapes.

### Live spend

**$0.** No AssemblyAI, OpenAI or Zerops access. Nothing called `omni-moderation-latest`: the endpoint is free, but it
was not called.

### What the integrator must do

1. Merge `wp/wp14b` (WP14b paths, plus `src/server/cases/**`, which WP14b has owned since G1). There are no new env vars
   or GUI secrets. `OPENAI_API_KEY` is already set, and moderation reuses it.
2. After **WP14a·2/·3** merge: set `DEFAULT_BINDING` in `src/server/engine/kernel-binding.ts` (the snippet is in the
   file header) and swap `src/server/relays/kernel.ts` to `lintBlueprintJson` + `blueprintHash`. WP14b·3 does this
   if it runs after them. It needs WP14a's canned-snapshot export (`requests/wp14b-to-wp14a.md` §5).
3. After **WP17** merges: `sims: () => getSimCallStore()` in `buildRelaysDeps` (`requests/wp14b-to-wp17.md` §4).
4. After **WP12·0** merges: nothing. `platform-stub.ts` already calls `ipKeyOf`.

### Acceptance status (TASKS-v2 WP14b)

| # | Item | Status |
|---|---|---|
| 2 | "…but their preset versions run" | Wired and tested up to the non-Baton gate (resolve, moderation, compile). The end-to-end preset run is WP14b·3 |
| 4 | Dental `UiSpec`/listening/provenance + `<intent>_patch` format; flagged moderation blocks the run | **Blocking: done** (422, nothing compiled). The response fields are done for Baton and a fake kernel; the Dental values need WP14a's compiler (WP14b·3) |
| 5–6 | Kernel parity over Postgres; `buildQaInput` | WP14b·3 |

### Where WP14b·3 starts

1. `git merge main`. Bind the kernel and swap `kernel.ts` (above). Check the blank blueprint and the pinned hash vector
   against the full lint.
2. Remove the non-Baton gate in `createRelayCase`: store the `AccountRecord` (`$kind: "account"`) in `cases.policy`,
   add `accountOf(caseRow)`, and pass `compiled.spec` into the case engine (WP14a·3).
3. The extractor through `compiled.extractor` (by `cases.relay_version_id`), `buildQaInput`, the WP5 compile port and
   Express re-extraction; then the Dental path end to end and the "add a field" preset.
