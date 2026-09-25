# WP14b → WP14a: blueprint hash, gallery JSON, kernel port

From WP14b·1 (D1 Fri Sep 25). Nothing here blocks you. Items 1 and 2 are contracts WP14b already relies on.

## 1. `blueprintHash` must equal WP14b's server hash (please pin the vector)

`relay_versions.blueprint_hash` is computed today by `src/server/relays/canonical.ts` (server only, `node:crypto`).
When your isomorphic `src/core/relay/migrate.ts` (`canonicalJson`, `blueprintHash`) lands, both must give the same
string:

- `canonicalJson(v)` = `JSON.stringify` of `v` with every object's keys sorted by the default `Array.prototype.sort()`
  (UTF-16 code units). No whitespace. Array order is kept. `undefined`-valued keys are dropped and `undefined` array
  items become `null`, as `JSON.stringify` does. Numbers print as `JSON.stringify` prints them.
- `blueprintHash(bp)` = lowercase hex SHA-256 of the UTF-8 bytes of `canonicalJson(bp)`.
- Pinned vector (in `tests/unit/server/relays/pure.test.ts`):
  `blueprintHash({ n: [1, 2.5, "é"], meta: { title: "x", slug: "y" } })` =
  `7aabb678e04f7850d6878f922d518c0af1c344ad6b54f9599c584d483294139d`.

If you prefer a different definition, tell WP14b **before** any Zerops seed runs. Rows seeded with one definition
would not match the other, and the recorded-bundle replay check (P§10.4) compares hashes.

## 2. Gallery JSON files (`data/relays/*.json`)

- `seedGallery()` hashes the **parsed** blueprint (`BlueprintSchema` output) and never rewrites it. Keep the files free
  of unknown keys, because zod strips them, and a hash of the raw file would then differ from the stored hash. WP11 and
  WP17 should hash `BlueprintSchema.parse(file)` too.
- The flagship is recognised by its file name, `baton-add-driver.json` (`FLAGSHIP_FILES` in `src/server/relays/seed.ts`).
  The relay slug is `meta.slug`, which must be unique across the gallery files.
- Only top-level `*.json` files are seeded (not `*.presets.json`, not `cards/**`).

## 3. Kernel port (WP14b swaps it after your WP14a·2 merge)

`src/server/relays/kernel.ts` is a port. Until `src/core/relay/{lint,migrate}.ts` are on `main`, it parses with
`BlueprintSchema` and reports `SCHEMA` issues only. After your merge, WP14b·2 swaps in
`parse: lintBlueprintJson` (after `migrateBlueprint`) and `hash: blueprintHash`. Please keep those two signatures:
`lintBlueprintJson(json) → { blueprint: Blueprint | null; issues: LintIssue[] }` and `blueprintHash(bp) → string`.

## 4. FYI: the blank relay

`POST /api/relays {kind:"blank"}` builds `src/server/relays/blank.ts` (one `person_name` field, confirm and close
stages, the `AI assistant` / `not a person` / `recorded` opening). It passes `BlueprintSchema` for every industry.
WP14b·2 will also run it through your full lint. If a rule you add makes it fail, send a request file.
