# WP14b → WP15: how `/api/relays/**` behaves (for the Studio)

From WP14b·1 (D1 Fri Sep 25). The shapes are `contracts/v2/api.ts`. These are the behaviours beyond the shapes.

- **Identity:** the workspace is `ws_<visitorId>` from the `bvid` cookie or the `x-baton-visitor` header (the same token
  `/api/cases` returns). There is no other auth.
- **`:id`** accepts the relay id (`rl_…`) or its slug (for `/r/[slug]`).
- **GET `/api/relays`** → `{gallery, mine}`. The first call on a fresh server seeds the gallery; later calls reuse it.
  Gallery order: flagship first, then by seed order.
- **POST `/api/relays`** → **201** + `RelayDetail`.
  - `{kind:"clone", relayId}` also accepts a **version id** (`rv_…`), e.g. a Try-an-edit preset: "Keep editing" clones
    exactly the version the visitor ran.
  - Clones of gallery relays or presets are exempt from the per-visitor quota.
  - Blank, blueprint and own-relay clones: after 5 live relays → 429 `E_RATE_LIMITED`, "You have 5 relays; delete one
    to add another." (the P§10.2 copy); 10 per day per visitor.
  - A bad blueprint → 422 `E_LINT` with `error.lint`.
- **GET `/api/relays/:id`** → `RelayDetail`. It is `readOnly: true` for gallery relays and for someone else's
  `unlisted` relay. A private relay of another workspace → 404.
  - `presets` is non-empty only on gallery relays with a presets file. Clones show `[]` for now; how clones get Try an
    edit is WP14b·3's "preset versions".
- **PUT `/api/relays/:id/draft`** `{blueprint, expectedRev}`:
  - success → 200 `{rev, lint}`;
  - stale rev → **409** `{conflict: true, rev, error: {code: "E_DRAFT_CONFLICT", …}}`;
  - a body that fails `BlueprintSchema` → 422 `E_LINT` with `SCHEMA` issues (nothing stored);
  - gallery or read-only → 403 `E_READ_ONLY`;
  - more than 120 saves an hour → 429 with `Retry-After`.
  Until WP14a's lint merges, the server lint returns schema issues only; your local `lintBlueprintJson` is richer.
- **POST `/api/relays/:id/versions`** → 201 `{versionId, version, hash, created: true}` for new content, or **200** with
  the existing version (`created: false`) when the draft is unchanged (content-addressed).
- **PUT `/api/relays/:id`** `{visibility: "private" | "unlisted"}` → `RelayDetail`. **DELETE** → 204 (soft delete).
- **GET `/api/relays/:id/compiled?version=rv_…|draft`** → `CompiledRelayView`, or **503 `E_MAINTENANCE`** until
  WP14b·2 wires the kernel compiler. Keep your local preview as the default and treat the 503 as "no server compile".
- **Archived relays:** at the global cap (400 live), a relay idle for more than 1 h may be archived. It then disappears
  from `mine` and reads 404. The UI copy "Your relays live in this browser's anonymous workspace" already covers this.
  Say so in the empty state if you like.

## WP14b·2 update: the server compile and relay runs

- **GET `/api/relays/:id/compiled`** is wired: `CompiledRelayView` (greetings for every sample × the 4 canned states;
  prompts, tools and the first-update check for sample 0 in `one_pending`; `extractor.strictOk`). It still answers
  **503 `E_MAINTENANCE`** until WP14a's kernel is bound on the server (after WP14a·2/·3 merge), and **422 `E_LINT`**
  (with `lint`) when the draft or version has lint errors. Compare `hash` with your local compile.
- **POST `/api/cases` with `relayId` or `relayVersionId`** (Test runs, presets): 404 across workspaces, 422 `E_LINT`,
  **422 `E_MODERATION_FLAGGED`** with a top-level `categories: string[]` (show "Edit the flagged text"), 503
  `E_MAINTENANCE` while the kernel is unbound or for non-Baton relays until WP14b·3 (D2). A `relayId` you own
  snapshots your draft first (the same version as `POST /versions` when nothing changed).

## WP14b·4 update: `GET/PUT /api/relays/:id/source` has landed — Save can move off `/draft`

TASKS-v3 §7 (WP15·1) says Save uses `PUT /api/relays/:id/draft` "until WP14b·4's `/source` lands". It has landed
(`src/app/api/relays/[id]/source/route.ts`). Both routes keep working; `/source` is the one that keeps the
author's text.

**Why it matters for the Code tab:** `/draft` takes a blueprint, so a save through it **loses the file** —
comments, key order, formatting. The canonical blueprint is still `relays.draft` and the hash is still
`sha256(canonicalJson(bp))`, so a **comment-only or formatting-only edit changes the text and not the hash**, and
still creates no version. That is only true through `/source`.

```
GET /api/relays/:id/source?format=yaml|json&version=N
  → 200 RelaySourceView { relayId, version, rev, hash, format, text, stored }
```

- `stored:false` means nothing was ever saved as text (a relay written through the forms, or a gallery relay
  seeded from JSON) and the server serialized the canonical draft for you. **The Code tab opens on any relay** —
  render it exactly the same way; "generated" is a label, not a different mode.
- `format` converts. YAML→YAML keeps comments; anything→JSON loses them, which is the codec's documented rule.
- `version=N` is that version's text **as it stood at snapshot time**; a later draft edit never rewrites it.
- A foreign id is 404, same body as an unknown id. A gallery relay reads 200.

```
PUT /api/relays/:id/source   { source: { format, text }, expectedRev }
  → 200 { rev, hash, diagnostics }        saved
  → 409 { rev, hash }                     stale expectedRev — never a silent overwrite
  → 422 { diagnostics }                   syntax / zod / credential error — nothing saved
  → 403 E_READ_ONLY                       a gallery relay
```

Three behaviours worth wiring the UI to rather than guessing:

1. **Lint errors save; syntax, zod and credential errors do not.** Lint blocks Test and Publish, not Save
   (P§3.4). So a 200 can still carry `diagnostics` — show them, do not treat the save as failed.
2. **`diagnostics` carry ranges** (`CodeDiagnostic`), so they place as Monaco markers directly; on the textarea
   fallback (K-MONACO) the line number is enough.
3. **409 carries the current `rev` and `hash`**, deliberately, so you can offer a diff instead of a reload. The
   server never merges.

Body cap is `MAX_SOURCE_BYTES` (256 KiB), refused before parse. Import/create-from-source is
`RelaySourceStore.create` — say the word and WP14b will expose it on `POST /api/relays` as
`{ kind: "source", source }` rather than having the Studio round-trip through a parse; it is a small addition to
a WP14b file and the store method already exists.
