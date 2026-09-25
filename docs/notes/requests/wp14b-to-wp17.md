# WP14b → WP17: gallery JSON, presets file format, your tables in migration 0001

From WP14b·1 (D1 Fri Sep 25).

## 1. `data/relays/<base>.presets.json`: the format `seedGallery()` reads

The zod is `RelayPresetsFileSchema` in `src/core/contracts/ext/wp14b-relays.ts`. The file is either a bare array or
`{ "presets": [...] }`, with at most 6 presets:

```json
[
  { "id": "deposit_75", "label": "Deposit $75",
    "patch": [{ "op": "replace", "path": "/context/samples/0/tables/treatments/0/deposit_usd", "value": "75.00" }] },
  { "id": "add_insurer", "label": "Ask for the insurer",
    "patch": [{ "op": "add", "path": "/fields/-", "value": { "id": "insurer", "...": "a full FieldSchema object" } }] }
]
```

- `id`: `^[a-z][a-z0-9_-]{1,39}$`. `label`: 1 to 80 chars. `patch`: RFC 6902 (`add`, `remove`, `replace`, `move`,
  `copy`, `test`), 1 to 40 ops, applied to the parsed gallery blueprint `<base>.json`.
- The patched result must pass `BlueprintSchema`. Otherwise the preset is skipped and the seed logs it.
- Each preset becomes a content-addressed version of the gallery relay, with `relay_versions.preset =
  {id, label, baseVersionId}`. `RelayDetail.presets` lists only the presets of the relay's **current** version, so when
  the gallery file changes, the presets are rebased automatically.
- Hash the parsed blueprints (`BlueprintSchema.parse`) when you key sims and caches (see `wp14b-to-wp14a.md` §1–2).
  Keep unknown keys out of the files.
- "Keep editing" after a preset: `POST /api/relays {kind:"clone", relayId:"<the preset's rv_… versionId>"}` clones
  exactly that version. It is exempt from the per-visitor create quota, like any gallery clone.

## 2. Your tables are in `drizzle/0001_relays.sql` (P§2.4, verbatim)

`sim_calls` (with `kind` `audio | text_dry_run`, default `audio`; `rep`/`customer` are `bytea`), `tts_cache`
(`pcm24k bytea`) and `drafts` (`status` `queued | running | ok | invalid | failed`). The Drizzle tables are
`simCalls`, `ttsCache` and `drafts` in `src/server/db/schema.ts`; `bytea` columns are `Buffer`. `cases.sim_call_id`
exists too. Need a column? Send a request: it would go in a new additive migration (WP12 owns `drizzle/**` after 0001).

## 3. Creating the relay from a finished draft

`PgRelayRegistry.create(ws, { kind: "blueprint", blueprint, origin: "draft" })` (via `getRelaysDeps().registry`)
parses, lints and stores it, and returns `RelayDetail` (`id` = `rl_…`). It is never blocked by the global cap. The
per-visitor quotas are applied by the route, not the registry, so apply your `draft` bucket before calling it.

## 4. WP14b·2: the `CallCatalog` consumes your `SimCallStore.resolveCall`

`src/server/engine/catalog.ts` reads a structural subset of `SimCallResolution` (`SimCallResolutionLite` in
`src/core/contracts/ext/wp14b-engine.ts`: `entry`, `simulated`, `relayVersionId`, `relay {slug, title,
blueprintHash}`, `sampleIndex`, `gallery`), so your store is assignable as it is. Please keep those keys. The binding
(`sims: () => getSimCallStore()` in `buildRelaysDeps`) is one line after your branch merges; until then the catalog
answers recorded calls only. A run's account is the RUN version's `samples[sampleIndex]`, so a preset that edits sample
data (e.g. "Deposit $75") plays the base sim with its own numbers. `cases.sim_call_id` is set to the sim id.
