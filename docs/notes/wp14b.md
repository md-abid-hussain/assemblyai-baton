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

## WP14b·2: engine-for-version wiring, moderation, the WP5 compile port, platform-stub ipKey swap (D1 Fri Sep 25, ≈14:30–16:05 IST)

Read the **"Resumed after the G2 merge"** subsection below for the final state: this unit ran in three sittings (two
usage limits), and the first two predate `main` reaching G2.

The first attempt at this unit stopped at a usage limit. Its uncommitted work (the moderator, the run policy, run
resolution, the factory LRU, the ipKey swap) typechecked and was kept as `09f8221`. `git merge main` was a no-op:
`main` was still C2 (`175a6b7`). WP14a·2 (`compileRelay`, `policyToAccount`, `lintBlueprintJson`), WP12·0 (the
`client-ip.ts` hop fix) and WP17·1 (`SimCallStore`) were on their branches only, so each is consumed through a port
that is swapped in one place after their merge. **By the third sitting `main` was at G2 and WP12·0 had landed.**

| Commit | What |
|---|---|
| `09f8221` | the kept work: `OpenAIModerator`, `moderateForRun`, `resolveRun`/`runVersion`/`galleryVersionFor`, `CachedRelayEngineFactory`, the ipKey swap |
| `9509d8e` | the kernel binding slot, `RelayCallCatalog`, the compiled view, relay runs on `/api/cases`, the default moderator, pure tests |
| `3c7e6d7` | DB tests: relay runs, the compiled route, run resolution, the moderation policy |
| `233ca12` | the platform-stub ipKey test |
| `ae0dd23`, `f40bb0a`, `49becc2` | request updates (`wp14b-to-{wp14a,wp15,wp17}.md`), these notes. A resumed run re-verified typecheck and 871/871 after a no-op `git merge main` |
| `f8c818f` | `git merge main` at G2 (wp5, wp12, wp6, wp7, wp9, wp18, wp13). No conflicts |
| `aa805b1` | **the WP5 compile port** (`engine/takeover-compile.ts`, the `relayCompile` seam in `takeovers/{service,wiring,store,default-deps}.ts`), its tests, and the `va-audit` test fix |
| `964680f` | `{ poolMax: 4 }` in the four WP14b DB suites; request updates (`wp14b-to-{wp12,wp18}.md`) |

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

### Resumed after the G2 merge (a second usage limit; `f8c818f`…`964680f`)

The unit was interrupted twice. The second resume found the working tree clean with `f8c818f` (`git merge main` at
G2) already committed but **never verified**, so the first thing it did was re-run typecheck and the suite. That found
one real collision and one repo-wide flake, and it unblocked one T2 item.

- **`main` moved from C2 to G2** (merges of wp5, wp12, wp6, wp7, wp9, wp18, wp13). What that changed for this unit:
  - **WP5's `src/server/takeovers/**` is now on `main` and is WP14b's** → the compile port, below, is no longer
    blocked and is done;
  - **WP12·0's `auth/client-ip.ts` is on `main`** → nothing to do, as predicted: `platform-stub.ts` calls `ipKeyOf`,
    which now groups the balancer-set hop by /24 or /48 on its own. Its test still passes unchanged;
  - **WP18's `src/server/publish/**` is *not* on `main`** (the wp18 merge brought its WP8 paths, not the publisher),
    so `publications` in `buildRelaysDeps` stays `null`. Flagged again in `requests/wp14b-to-wp18.md` §8;
  - WP14a and WP17 are still on their branches, so the kernel binding and the sim resolver stay null.
- **The WP5 compile port** (TASKS-v2 §6 WP5, "WP14b·2 wires it after the ownership transfer"), `aa805b1`:
  - `src/server/engine/takeover-compile.ts` → `RelayEngineFactory.forVersion(case.relay_version_id).takeover(...)`;
  - the seam is `TakeoverServiceDeps.relayCompile`, bound in `takeovers/default-deps.ts` to
    `relayTakeoverCompile(() => getRelaysDeps())`. `TakeoverCase` (and `loadCase`) now carry `relayVersionId` and
    `simCallId`;
  - it answers **null — "compile through WP1" — in exactly two cases**: the case has no `relay_version_id` (every
    case that exists today), or no kernel is bound (every server today). So binding it is a **zero-behaviour-change
    merge**, exactly like the kernel binding slot;
  - **anything else throws.** An unknown version or a failed compile is not degraded into a Baton compile, because a
    Baton prompt for someone else's relay is wrong, not merely stale;
  - **the account is recovered exactly as `createRelayCase` chose it**: a simulated call → the RUN version's sample at
    the sim's index through the catalog (so a preset that edits sample data keeps its own numbers), a recorded call →
    `binding.policyToAccount(case.policy)`. It reads the case row only, so an org-scoped case later needs no change;
  - `takeovers.protocol.compile.relayVersionId` records which compiler ran, for the WP14b·3 parity check.
- **A real merge collision, fixed** (`tests/unit/server/verify/va-audit.test.ts`, WP18's). Its case
  "readPublishedAgents is [] without relay_publications…" creates `relay_publications` by hand; migration 0001 now
  creates it, so the test died on `42P07 … already exists`. One statement was added in front
  (`drop table if exists relay_publications`), keeping both branches of the test. Same precedent, and same reason, as
  WP12's scaffold test in WP14b·1: the migration is this WP's deliverable. Sent in `requests/wp14b-to-wp18.md` §7.
- **A repo-wide test flake, diagnosed and reported, not fixed here.** After G2 the repo has ~25 unit files calling
  `createTestDb`, vitest runs files in parallel (32 CPUs here), each pool is `max: 15`, and `baton-pg` is the stock
  `max_connections = 100`. Two consecutive `npm test` runs failed 9 and then 17 files, always
  `Hook timed out in 20000ms` in `beforeAll`/`afterAll`, never an assertion; `--maxWorkers=4` and an idle machine both
  give 0 such failures. The fix belongs to a shared file nobody owns in §4.1, so it went to the integrator with the
  measurements and three options (`requests/wp14b-to-wp12.md` §6). What this unit could do on its own paths it did:
  its four DB suites now pass `{ poolMax: 4 }`.

### Not in this unit (with reasons) → WP14b·3

- **The extractor and verifier through `compiled.extractor`**, and **`buildQaInput`**. Re-checked after G2, and still
  deferred - the blocker was never the file moves (`src/server/qa/build-input.ts` is on `main` and is WP14b's now), it
  is the **P§4.7 widening**, which is WP14a·3's one commit and is not on `main`:
  - an extractor port could carry `compiled.extractor`'s prompt, format and `buildInput`, but the patch it returns is
    turned into fact events by `CaseEngine.applyExtraction`, which is bound to Baton's field set. Wiring half of it
    would let a Dental patch be applied by Baton's applier - a wrong result, where the compile port's fallback is a
    correct one. That is why this one waits and the compile port did not;
  - `buildQaInput` is blocked at the contract: `Wp8QaInput.policy` is a `PolicyRecord`, `Wp8QaDisclosure.kind` is
    Baton's `DisclosureKind`, and `TakeoverMetricsReadSchema.disclosures` is a fixed two-value enum
    (`core/contracts/ext/wp8-verify.ts`, not a WP14b path). A relay's own disclosure ids cannot be stored, let alone
    read back, until those widen.
- Express re-extraction, `RELAY_ENGINE=kernel`, the parity check over Postgres, and the Dental path (T3 as planned).

### Tests

`npm run typecheck` is clean. `npm test` passes **1369 passed | 1 skipped (1370)** over **111 files** after the G2
merge (`+10` from the compile port; the rest is what G2 brought). Before the merge this unit's own count was 871/871.
The local `baton-pg` container was restarted: Docker Desktop was not running.

- **`tests/unit/server/engine/takeover-compile.test.ts`** (10, new): a Baton case and a kernel-less server are null
  and never touch the engine; an unknown version throws instead of falling back; a recorded call's account is
  `policyToAccount`, a sim's is the run version's sample at the sim's index, a sim the catalog lost falls back to
  sample 0 (never to the policy), and a blueprint-less compile is `E_INTERNAL`; the version compiles once through the
  LRU; and through the real `TakeoverServiceImpl`: a relay case never calls WP1, is still `validateFirstUpdate`d, and
  records `protocol.compile.relayVersionId`, while a Baton case records null.

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

**$0**, across all three sittings. No AssemblyAI, OpenAI or Zerops access. Nothing called `omni-moderation-latest`:
the endpoint is free, but it was not called.

### What the integrator must do

1. Merge `wp/wp14b` (WP14b paths, plus `src/server/cases/**`, which WP14b has owned since G1). There are no new env vars
   or GUI secrets. `OPENAI_API_KEY` is already set, and moderation reuses it.
2. After **WP14a·2/·3** merge: set `DEFAULT_BINDING` in `src/server/engine/kernel-binding.ts` (the snippet is in the
   file header) and swap `src/server/relays/kernel.ts` to `lintBlueprintJson` + `blueprintHash`. WP14b·3 does this
   if it runs after them. It needs WP14a's canned-snapshot export (`requests/wp14b-to-wp14a.md` §5).
3. After **WP17** merges: `sims: () => getSimCallStore()` in `buildRelaysDeps` (`requests/wp14b-to-wp17.md` §4).
4. After **WP12·0** merges: nothing. Done - WP12 is on `main` and `platform-stub.ts` already calls `ipKeyOf`.
5. **Please read `requests/wp14b-to-wp12.md` §6 before you run the whole suite on a busy machine.** The DB unit files
   exhaust the dev Postgres's 100 connections in parallel and fail in a different place every run. Any one of the
   three fixes there clears it; until then, `npx vitest run --maxWorkers=4` is green.
6. The merge touches **`src/server/takeovers/**`** (WP14b's since G2) for the compile port. WP5's behaviour is
   unchanged while no kernel is bound, which is every server today.

### Acceptance status (TASKS-v2 WP14b)

| # | Item | Status |
|---|---|---|
| 2 | "…but their preset versions run" | Wired and tested up to the non-Baton gate (resolve, moderation, compile). The end-to-end preset run is WP14b·3 |
| 4 | Dental `UiSpec`/listening/provenance + `<intent>_patch` format; flagged moderation blocks the run | **Blocking: done** (422, nothing compiled). The response fields are done for Baton and a fake kernel; the Dental values need WP14a's compiler (WP14b·3) |
| 5–6 | Kernel parity over Postgres; `buildQaInput` | WP14b·3. The compile port that acceptance 5 measures is in place, and `protocol.compile.relayVersionId` says which compiler ran |

**T2 is complete.** Its seven bullets: `RelayEngineFactory`, `CallCatalog`, `/api/cases` relay versions + response
fields + moderation, and `platform-stub.ts:50` landed in the first pass; **the WP5 compile port** landed in this one;
the extractor/verifier through `compiled.extractor` and `buildQaInput` are the two that wait on the P§4.7 widening,
with the reasons above.

### Where WP14b·3 starts

1. `git merge main`. Bind the kernel and swap `kernel.ts` (above). Check the blank blueprint and the pinned hash vector
   against the full lint.
2. Remove the non-Baton gate in `createRelayCase`: store the `AccountRecord` (`$kind: "account"`) in `cases.policy`,
   add `accountOf(caseRow)`, and pass `compiled.spec` into the case engine (WP14a·3).
3. The extractor through `compiled.extractor` (by `cases.relay_version_id`) and `buildQaInput` - both need the
   widening first (see "Not in this unit"); then Express re-extraction, the Dental path end to end and the "add a
   field" preset.
4. The compile port needs no further wiring: binding the kernel switches every relay case to
   `compiled.takeover(...)` on its own. Acceptance 5's parity check is then "an s01/s02/s05 pass compiles
   deep-equal through the port and through WP1", which `protocol.compile.relayVersionId` makes easy to assert.

---

## WP14b·3: the widening lands, the Dental server path, presets, Express re-extraction, kernel parity (D2 Sat Sep 26, ≈11:55–13:10 IST)

Seven commits, `2dcc272`…`65abfd0`. `main` was already merged (0 behind at start and at finish); `npm run migrate`
was a no-op (`baton_wp14b`, 25 public tables). The unit was resumed after an interruption: four modified files and
one untracked `src/server/engine/mode.ts` were on disk, typechecked clean, and were committed as `e420d27` after
review rather than rewritten.

### Done

**1. The relay case engine (`2dcc272`) — the P§4.7 widening is what unblocked it.**
`src/server/cases/relay-engine.ts` wraps WP1's `CaseEngine` with ONE version's `IntentSpec` and the compiled relay's
dynamic extractor. Because WP14a·3 put the optional trailing `spec?: IntentSpec` on every core function, the wrapper
adds no new core path — it only chooses the spec. With it:

- **the non-Baton gate in `createRelayCase` is gone.** A relay case stores an `AccountRecord` with `$kind:"account"`
  in `cases.policy` (P§4.2 `storedAccount`) and `intent:"relay"`; `schema.ts:50`'s enum gained `"relay"`, the
  one-word change WP14a·4 asked for. The column is text with no DB check, and **`drizzle-kit generate` still says
  "No schema changes"** — re-verified this unit, so acceptance 1 is unaffected;
- `accountFor()` reads either shape, so the stored row flows straight through the unchanged `PolicyRecord`
  parameter. A Baton row still maps with `policyToAccount`, which is why the flagship is byte-identical with a spec
  or without one;
- `extractor.version` is the compiled relay's `versionId`, not `EXTRACTOR_VERSION_V3`.

**2. Express re-extraction (`c990cef`, P§7.5).** That version pin is the point: a relay whose fields differ has a
different prompt and a different strict schema, so WP9's `pc_ctx` cache of a recorded call must not be served to it.
`prefill.ts` compares the two ids and, for a relay run, re-extracts the cached turns in ONE batched call instead. For
the flagship compiled through the kernel the generated prompt and schema are byte-identical to V3, so the ids are
equal and the caches keep being served — no regression and no extra spend on the Baton path.

**3. The Dental server path end to end (`0022484`), `tests/unit/server/engine/dental.test.ts` (238 lines).** Real
Postgres, the REAL WP14a kernel and the REAL WP1 case engine; the only fakes are the upstreams (a local `Extractor`
returning a patch; no audio, STT or VA). It pins the relay row, the Dental `UiSpec`/listening/provenance with
`policy: null`, extraction through `compiled.extractor` (Dental field ids in the derived state, Baton's 21 absent), a
Baton case on the same server still on the flagship engine, and **the "add a field" preset** (P§7.5.3) really adding
`insurance_carrier`, with an extractor pin that differs from the base relay's — which is what makes Express
re-extract instead of serving a cache. That is acceptances 2 ("their preset versions run") and 4.

**4. `RELAY_ENGINE` (`e420d27`, `src/server/engine/mode.ts`, P§4.6).** `legacy` is the default **and the submission
setting** (P§0 P3). Under `kernel`, `kernelPinnedBaton` pins a plain Baton run to the seeded flagship version, so the
case records `relay_version_id` and every engine call passes `compiled.spec` — while the row stays a *Baton* row
(`intent:"add_driver"`, a `PolicyRecord` in `cases.policy`), because the parity claim is that the blueprint
reproduces the flagship, not that it replaces its data. Read from `process.env` (not `EnvSchema`: `env.ts` is WP12's;
`requests/wp14b-to-wp12.md`), and an unknown value logs once and falls back to `legacy`.

**5. The stored account through the two remaining readers (`e420d27`).** `takeover-compile.ts` reads the stored
account straight back instead of guessing, and `run-service.ts` takes `repFirstName` through `accountFor`.

**6. `buildQaInput`'s relay half (`e420d27`, `4710dd6`) — acceptance 6.** `src/server/engine/qa-context.ts` reads the
three sets `build-input.ts` used to hard-code off `CompiledRelay`: `toolNames` (the union over `STAGES` of
`compiled.tools(stage)`), `disclosureIds` (`compiled.ui.disclosures`, blueprint order) and `spec` (for
`entityFields`). `buildQaInput(sources, relay?)`, `toolCallsOf(t, known?)`, `disclosuresOf(…, relay?)` and
`keytermsOf(…, spec?)` all take it as an optional trailing argument, so **omitted, every output is Baton's byte for
byte** — WP18's `tests/unit/server/verify/build-input.test.ts` passes untouched.

**7. Kernel parity over Postgres (`3e52c45`) — acceptance 5.** `tests/unit/server/engine/parity.pg.test.ts`.

### Decisions

- **`relayTakeoverCompile` with no kernel bound now THROWS `E_MAINTENANCE` instead of returning null.** Until this
  unit the only relay that could create a case was the flagship, whose WP1 compile is the parity target, so falling
  back was correct. Now a Dental case exists, and a Baton compile of one would hand the Voice Agent Baton's prompt
  and Baton's tools for a dental booking — a wrong result where a 503 is the right one. The test that asserted the
  old behaviour was rewritten into two, so the Baton half of the claim is still pinned.
- **The QA context fails SOFT, the run path fails HARD.** `relayQaContextFor` answers null for a Baton case, an
  unwired relay graph *and* a compile failure. QA runs after the call, on a pass that already happened, so the worst
  a missing context can do is score a relay run with Baton's sets; losing the whole verification would be strictly
  worse. `relayTakeoverCompile` is the opposite, for the reason above. Both are tested.
- **A defect found and fixed: every Dental run was losing its HUD latency.**
  `TakeoverMetricsReadSchema.disclosures` is a `partialRecord` over Baton's two `DisclosureKind`s, so a relay's own
  ids fail the key — and because the failure is at the top-level `safeParse`, `readMetrics` returned `{}` and `hud`
  went with it. `readMetrics` now retries once without the `disclosures` key; a Baton run never reaches the retry.
  The relay's texts are read from the raw value by `disclosuresOf`. Both halves are pinned by tests, and the widening
  that would delete both workarounds is `requests/wp14b-to-wp18.md` §10.
- **`QaSources.policy` and `keytermsOf`'s `policy` widened to `PolicyRecord | AccountRecord`.** A relay case's row
  really does hold an account; typing it as a `PolicyRecord` would have been a lie the compiler could not catch.
  `Wp8QaInput.policy` is unchanged: `buildQaInput` converts with WP14a's `policyFor`, which returns a `PolicyRecord`
  untouched.
- **The parity test asserts the listed difference rather than ignoring it.** `promptVersion` must match
  `/^relay:[0-9a-f]{8}$/` and must NOT equal WP1's; everything else is deep-equal.
- **A hard-coded `deployId` was removed from two test files.** The shared pre-commit hook blocks any staged literal
  equal to a `.env` value, and that string happened to be this worktree's `BATON_DEPLOY_ID`. The tests now use
  `"test-wp14b-env"`, and `moderation.ts`'s doc comment no longer quotes the local value. The hook was never
  bypassed, here or anywhere in this unit.

### [VERIFY] results

**None are WP14b's.** SAAS §16's table has fifteen rows, owned by WP19·2 (4), WP19·3, WP22·1 (2), WP21·1 (3),
WP23·1 (2), WP15·1, WP23·2 and WP12. Checked at the start of the unit; nothing to record, and nothing in this unit
depends on a library option taken from a docs summary.

### Tests

`npm run typecheck` clean. **`npm test` green: 2347 passed, 0 failed, 0 skipped, 169 files** (the full
`npx vitest run --maxWorkers=4`, which also picks up the four `tests/e2e` files, is 2352 passed | 9 skipped). The
connection-pool flake of `requests/wp14b-to-wp12.md` §6 did not reproduce in either run.

- **`tests/unit/server/engine/parity.pg.test.ts` (13, new, Postgres, $0)** — the REAL `data/relays/*.json` through
  `FsGallerySource`, the REAL kernel binding, the real registry, the real LRU factory, the real port:
  - the switch: unset, blank and a TYPO (`kernal`) all read `legacy`; `kernel` reads `kernel`;
  - `legacy`: a plain Baton case keeps `relay_version_id` null and a v1 response;
  - `kernel`: the same request pins the seeded flagship version id, and `intent` and the `PolicyRecord` are untouched;
  - **acceptance 5: s01 × s02 × s05 at `early`/`middle`/`handoff` — nine points, each deep-equal to WP1's
    `compileTakeover` apart from `promptVersion`**;
  - the second `forVersion` is the same object, so nine points cost one compile.
  - *Note for anyone copying the env helper:* it `await`s inside the `try`. The synchronous version restored
    `RELAY_ENGINE` before the in-flight route read it, and the pin silently fell back to legacy.
- **`tests/unit/server/engine/qa-context.test.ts` (13, new, no DB, $0)** — the real kernel over the mini Dental
  blueprint. Every case is a pair, with and without the context: the disclosure ids (`deposit_terms` vs
  `premium_change`), the tool names (`send_deposit_link` kept / `confirm_effective_date` dropped, and the reverse),
  `made_up_tool` dropped either way (P§4.7 widened `ToolNameSchema`, so the old `ToolNameSchema.safeParse` would have
  let it through), the entity fields (`patient_name` vs `driver_full_name`), the stored account arriving at QA as a
  `PolicyRecord`, the HUD-latency rescue, and `relayQaContextFor`'s three null paths plus the compile-failure path.
  It also pins that `log_crm_note` is **absent**: the blueprint declares that connector but no stage offers it.
- **`tests/unit/server/engine/dental.test.ts` (238 lines, Postgres)** and the `runs.test.ts` additions for the lifted
  gate, from the earlier commits of this unit.
- `takeover-compile.test.ts`: the "no kernel is null" case became two (throw for a relay case, null for a Baton one).

### Live spend

**$0.** No AssemblyAI, no OpenAI, no Zerops, no deploy, no production HTTP. The parity test seeds the gallery with a
pre-clearing moderator, so no relay text reached `omni-moderation-latest` (which is free anyway, but was not called).
`RUN_LIVE` was never set. Running total for WP14b across four sittings: **$0.00** of the $0.05 budget.

### What the integrator must do

1. Merge `wp/wp14b` (WP14b paths, plus `src/server/cases/**` and `src/server/runs/**`, WP14b's since G1, and
   `src/server/takeovers/**` since G2). No new env vars and no new GUI secrets.
2. **`RELAY_ENGINE` is not in `EnvSchema`** — it is read from `process.env`, because `src/server/env.ts` is WP12's.
   `requests/wp14b-to-wp12.md` asks for the line. **Leave it unset for the submission** (P§0 P3: `legacy`).
3. **`requests/wp14b-to-wp18.md` §9 is the last of acceptance 6.** Three edits in `verify-takeover.ts` (WP18's file)
   pass the relay QA context into the verify job. Without them a Dental run is still scored with Baton's tool names,
   entity fields and disclosure kinds. §10 is the contract widening that would delete two workarounds in
   `build-input.ts`.
4. Items 3 and 5 of the WP14b·2 list still stand (WP17's `sims` port is bound since G2b; the
   `requests/wp14b-to-wp12.md` §6 pool note).
5. Nothing under `drizzle/**` changed. `0001_relays.sql` is unchanged, and `drizzle-kit generate` reports no diff
   after the `cases.intent` widening.

### Acceptance status (TASKS-v2 WP14b)

| # | Item | Status |
|---|---|---|
| 1 | Migration applies, second run a no-op, no `drizzle-kit` diff | **PASS**, re-verified after the `intent` widening |
| 2 | Gallery relays read-only, but their preset versions run | **PASS** (the "add a field" preset runs end to end) |
| 3 | Seed: two boots create 0 new versions | **PASS** (unchanged since ·1) |
| 4 | Dental `UiSpec`/listening/provenance + `<intent>_patch`; flagged moderation blocks the run | **PASS** |
| 5 | Kernel parity over Postgres | **PASS** — 9 points, deep-equal apart from the listed `promptVersion` |
| 6 | WP8's QA fixture equal through `buildQaInput` | **PASS** for the contract (WP18's suite is green untouched, and the relay half is built and tested). The three-line call-site wiring is `requests/wp14b-to-wp18.md` §9, because `verify-takeover.ts` is WP18's file |

**T3 is complete**, and with it TASKS-v2 WP14b (T1, T2, T3).

### Where WP14b·4 starts

WP14b·4 is the SaaS adoption (TASKS-v3 §7, +0.5 T, D2 ≈14:00–16:30), which is new work rather than a continuation:

1. **`RelaySourceStore`** in `src/server/relays/**` and `GET/PUT /api/relays/:id/source` (TASKS-v3 §6, §3 priority 8).
   WP15·1 saves through `PUT /api/relays/:id/draft` until it lands.
2. **`GuestSeeder`** (§3 priority 3): the guest org seeded with Baton pinned and a Dental copy carrying a YAML source.
   WP19·2 ships the default no-op seeder, so this can land after C3b without blocking it.
3. **Tenancy** (§3 priority 5): `requirePrincipal` on every org route, `cases.org_id`, and WP14b's rows in the
   cross-tenant suite. Every route this unit touched is still visitor-scoped; none gained or changed an org route.
4. Before any of it: `git merge main` for WP19·2's `0002`/`0003` and its one re-export line in `schema.ts`
   (TASKS-v3 §6 carve-out 2) — WP14b must not have the file open when that line goes in.

---

## WP14b·4: SaaS adoption — tenancy, the source store, the guest seeder, usage (D2 Sat Sep 26, ≈14:00–16:30 IST)

TASKS-v3 §7 WP14b·4, §3 priorities 3, 5 and 8, §5 cell "D2 13:00–17:00". Seven commits on `wp/wp14b`
(`d0e6d2d` → `f87bdff`), `main` merged in at `2d7258c` (C3b: WP19's `0002_saas` / `0003_audit_guard` and the one
`schema.ts` re-export line — the §6 carve-out 2 landed cleanly and WP14b did not have the file open).

### Done

1. **Tenancy on every relay route.** `workspaceFor` → `relayPrincipal(req, perm)` → `requirePrincipal`
   (`src/server/relays/index.ts`). All ten handlers in `src/server/relays/routes.ts` go through it —
   list, create, get, update, delete, draft, versions, compiled, and the two new source handlers — so there is
   **one** place that decides a workspace for `/api/relays/**`, which is what makes the SAAS §11 manifest rows
   assertable rather than ten separate accidents. `SaasError` maps through the existing `relayRoute` wrapper.
   A principal with no org is `E_AUTH_REQUIRED` ("Start a free workspace to continue"), not a 500.

2. **`RelaySourceStore`** (`src/server/relays/source-store.ts`, `PgRelaySourceStore`) over WP19's `0002` columns
   (`relays.draft_source` / `draft_source_format`, `relay_versions.source` / `source_format`), plus
   **`GET/PUT /api/relays/:id/source`**. `get` falls back to serializing the canonical draft with `stored:false`,
   so the Code tab opens on **any** relay, not only on ones authored as code. `save` is conflict-checked on
   `expectedRev`, never merging. `create` is the CLI's first `push` / the Studio's Import.
   `captureVersionSource` keeps a version's text as it stood at snapshot time (wired into the snapshot route),
   and a dedup'd snapshot leaves the existing version's source alone.

3. **`GuestSeeder`** (`src/server/relays/guest-seeder.ts`, `PgGuestSeeder`): one read, one insert, no compile, no
   moderation, no version row — the Dental gallery relay cloned as "Dental deposit (your copy)" with secrets
   stripped and a real YAML source under a two-line header. Baton is **pinned, not cloned** (WP19 does that in
   the org-creating transaction). A missing template is a warn and an empty result, never a throw.

4. **`/api/cases`**: `org_id` and `created_by_user_id` from the principal (`src/server/cases/tenancy.ts`), the
   token's `org` claim, and the daily live-run check that **reports rather than throws** — over budget is the
   labelled replay, 200, not a 402.

5. **The terminal transaction** (`src/server/takeovers/terminal-usage.ts`): `run.completed` +
   `live_run` + `ai_minutes`, inside `store.end`'s transaction, guarded by its `first` flag *and* by a
   deterministic idempotency key per write.

6. **The relay count limit** on create / clone / import, plan-aware under `orgs` and the v2 cap under `legacy`,
   with the **gallery clone exempt** as in v2.

7. **The SAAS §9 audit rows**: `relay.created` / `.cloned` / `.deleted` / `.source_saved`, the actor always taken
   from the principal and never from a body field.

8. **`installRelaySaasPorts()`** — see decision 5; this was the one real defect found in the second pass.

### Decisions

1. **Everything is additive and inert under `TENANCY_MODE=legacy`.** A device visitor's `orgId` is
   `ws_<visitorId>`, which is the workspace the v2 code already used, so stamping it changes nothing. That is why
   the v2 route tests pass **unchanged** rather than having been adjusted — the acceptance line asks for exactly
   that, and an adjusted test would have hidden a regression.

2. **An audit or usage write that fails is logged, not thrown.** A demo must never lose a save because an audit
   row could not be written, and a takeover must never lose its end because a metering row could not be. The
   takeover row is the source of truth; usage is derived and rebuildable.

3. **A comment-only edit changes the text and not the hash.** The canonical blueprint stays `relays.draft` and
   the version hash stays `sha256(canonicalJson(bp))`; `draft_source` is the author's text *beside* it. This is
   what keeps formatting churn from creating versions, and it is only true on the `/source` path — `/draft`
   takes a blueprint and loses the file. WP15 has been told (`requests/wp14b-to-wp15.md`).

4. **Lint errors save; syntax, zod and credential errors do not.** Lint blocks Test and Publish, not Save
   (P§3.4), so a 200 can still carry diagnostics.

5. **The port registry is populated at boot, not on first relay touch.** `installRelaySaas` runs as a side effect
   of building the relay graph, which is lazy. `/api/guest/start` (WP19's) reads `getGuestSeeder()` and **never
   touches the relay graph** — so on a cold container whose first request is a guest start, the registry still
   held WP19's no-op default and the guest got an empty workspace: no Dental copy, no YAML source. That is the
   judge path and the landing CTA's background start. It is invisible in tests and in any warm process, which is
   why it survived the first pass. `installRelaySaasPorts()` (exported from `src/server/relays/index.ts`,
   idempotent, a re-register rather than a build) closes it, and `src/instrumentation.ts` needs one block beside
   `[WIRE-PUBLISHING]` — integrator action 1 below.

6. **`created_by_user_id` is provenance only.** SAAS §6.1 forbids authorizing off it; nothing in WP14b's code
   does, and the request file says so explicitly so WP19·3's manifest can assert it.

7. **`POST /api/cases` is deliberately not a 401 row** in the tenancy manifest: `/call/[id]` has no account
   behind it, so `caseTenantOf` uses `allowVisitor: true`. Written up as an explicit exception row rather than
   an omission, so a later change that starts 401ing visitors fails a test instead of the demo.

### [VERIFY] results

**None are WP14b's** — re-checked against SAAS §16 at the start of this unit, as in ·3. The fifteen rows belong
to WP19·2 (4), WP19·3, WP22·1 (2), WP21·1 (3), WP23·1 (2), WP15·1, WP23·2 and WP12. The nearest neighbour is
WP23·1's `yaml` row, and it stays WP23's: the source store does not parse YAML itself, it calls the codec
(`validateSource` / `serialize` / `convert` from `src/core/relay-code`), so the server is authoritative without
a second parser and without a second `[VERIFY]`.

### Tests

`npm run typecheck` clean. **`npm test` green: 174 files, 2420 tests, 0 failed.**

- **`tests/unit/server/relays/saas.test.ts` (16, Postgres, $0)** — relay-as-code (generated vs stored, the
  comment-only edit, `?format=` conversion, the 409, the 422, lint-still-saves), the cross-org rows for relays
  and source, the gallery read-only row, the seeder, the plan check in both modes, the audit coalescing window,
  the lifecycle rows, and the port installation of decision 5.
- **`tests/unit/server/takeovers/terminal-usage.pg.test.ts` (4, Postgres, $0)** — the acceptance line: a replayed
  terminal transition emits **one** `run.completed` and **one** of each usage row; simulated and replay sources
  are recorded at quantity 0.
- `tests/unit/server/relays/migration.test.ts` — teardown parallelised (`cd2030f`); the 20 s `afterAll` budget
  was the suite's contention peak and the cause of the `roundtrip.test.ts` timeout WP14b·4 first reported to
  WP23 as a blocker. Corrected in that request file to hardening: three consecutive full runs are green, and so
  were both runs of this pass.

### Live spend

**$0.** No `RUN_LIVE`, no AssemblyAI, no OpenAI, no Polar. Every new test is Postgres-only against
`baton_wp14b`; the moderation call is stubbed as before. Cumulative WP14b live spend is unchanged from ·3.

### What the integrator must do

1. **`src/instrumentation.ts`: add the `[WIRE-RELAY-SAAS]` block** (verbatim in
   `docs/notes/requests/wp14b-to-wp19.md` §1). Without it a cold container's first `/api/guest/start` seeds with
   the no-op default and the guest workspace is empty. Cheap at boot — `getDb()` wraps a `pg` `Pool` that does
   not connect until its first query, and the rest of the graph is object construction. This is the single
   highest-value line in the unit and the easiest to forget, because nothing goes red without it.
2. **WP19·3** takes the manifest rows and the `/api/cases` exception from `requests/wp14b-to-wp19.md` §2–§3.
3. **WP15·1** can move Save from `PUT /draft` to `PUT /source` (`requests/wp14b-to-wp15.md`, last section). Both
   routes keep working; only `/source` keeps the author's text. If the Studio would rather not round-trip an
   Import through a parse, WP14b can add `POST /api/relays {kind:"source"}` — the store method already exists.
4. **WP23** still has the optional `120_000` timeout on `roundtrip.test.ts` (hardening, nothing is red).

### Acceptance status (TASKS-v3 §7 WP14b·4)

| # | Acceptance line | Status |
|---|---|---|
| 1 | The v2 route tests pass unchanged in legacy mode | **PASS** — unchanged, not adjusted; the whole suite is green |
| 2 | The tenancy manifest rows for relays, source and cases pass in orgs mode | **PASS for the behaviour**, pinned in `saas.test.ts`. The manifest file itself is WP19·3's and does not exist yet; its rows are handed over in `requests/wp14b-to-wp19.md` §2–§3 |
| 3 | The events and usage rows are idempotent on a replayed terminal transition | **PASS** — `terminal-usage.pg.test.ts`, guarded twice (the `first` flag and a deterministic idempotency key) |

### Where WP14b·5 starts

WP14b has no ·5 in TASKS-v3 §5. If a slot opens, in value order:

1. `POST /api/relays { kind: "source" }` (integrator action 3) — small, and it removes a round-trip from Import.
2. The `/source` rows of the P2 read endpoints in SAAS §6.2 (`/relays/{id}/source` for the public API, WP22's
   surface) — the store is already the right shape for it.
3. Nothing else is owed. TASKS-v2 WP14b (T1–T3) completed at ·3, and WP14b·4's three acceptance lines are met.
