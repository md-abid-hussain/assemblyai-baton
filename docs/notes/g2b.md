# G2b notes: WP23 + WP16 + WP17 + WP18 + WP9 onto `main` (D1 Fri Sep 25, ≈21:15–22:00 IST)

**Status: merged and green on `main` at `fb9f5b8`.** Typecheck clean; the full unit suite is **2306 passed, 0 skipped
(165 files)**, run twice; the parity suite is green; `npm run build` is OK; migrations apply on a fresh throwaway
database and re-run as a no-op. Nothing live was called: **$0 AssemblyAI, $0 OpenAI, $0 Polar, $0 Zerops**.
**Not done here, by instruction: `git push` and the deploy — the orchestrator owns both.**

## 1. Merges (all `--no-ff`, in the planned order)

| Commit | Merge | Branch tip | Conflicts | What it brings |
|---|---|---|---|---|
| `b6e19df` | `wp/wp23` | `6f52a02` | none | WP23·1: the isomorphic blueprint codec (`src/core/relay-code/**`), the generated `public/schemas/blueprint-2.0.json`, the Baton YAML example, the `scripts/devtools/**` generators, `yaml` + dev `ajv` |
| `83136f5` | `wp/wp16` | `244cf93` | none | WP16·1: the connector runtime core — SSRF address/URL/DNS guards, pinned-DNS lookup, `http_action`, HMAC, echo, `lookup_table`, arg validation, the call log and limits, plus `SecretStore` and `ipaddr.js` |
| `70fb3bc` | `wp/wp17` | `75f1dcb` | none | WP17·1–3: TTS, the Dental curated relay + 2 Try-an-edit presets, the gallery sim and its assets, `sim_script`, on-demand `/api/sim-calls`, async drafting (`/api/drafts`), TEXT DRY RUN, the v3 org hooks |
| `82fb088` | `wp/wp18` | `1116d4d` | none | WP18·1: the publish service and published-config compiler, the connector gateway, the one published-run state route, `case.verified` in the verify job, the org hooks |
| `9247515` | `wp/wp9` | `f3dfc01` | none | WP9·2–3: the simulated s01/s02/s03 takes, `calls:build` with the sim-takes overlay, the `pc_ctx` STT caches and cached turns, `src/generated/{calls,call-provenance,call-scenarios}.json` |

**No conflicts in any of the five**, so no ownership ruling (TASKS-v3 §6 / TASKS-v2 §4) had to be applied.
`git branch --no-merged main` is now **empty**: every work-package branch in the repo is on `main`.

### `package.json` / `package-lock.json`

The two dependency-touching branches edit disjoint lines (`wp/wp16` → `ipaddr.js` in `dependencies`; `wp/wp23` →
`yaml` in `dependencies` and `ajv` in `devDependencies`), so git merged both without a conflict and all three lines
are present.

**`npm install` was still needed, and it mattered.** The shared `node_modules` held **`ipaddr.js@1.9.1`**, not the
2.5.0 the merged lock pins — exactly the trap `docs/notes/requests/wp16-to-wp12.md` item 5 predicts ("if anyone runs
`npm install` from a lockfile without this change, ipaddr.js falls back to 1.9.1 and the WP16 SSRF tests fail").
Some earlier install in another worktree had reverted it. `npm install` in `C:/Users/abid1/Desktop/assembly-ai`
restored 2.5.0; `yaml@2.9.1` and `ajv@8.20.0` were already correct.

**The lockfile itself was then reverted to the merged version, deliberately.** This laptop's npm is 10.9.8, which
predates the `libc` lockfile field, so the install rewrote `package-lock.json` to *drop* `"libc": ["glibc"|"musl"]`
from 38 optional platform packages and to re-order one entry. A structural comparison of the two locks
(`packages` key sets identical, 38 packages differing only by the removed `libc` key, no version or integrity change
anywhere) showed that was the **entire** diff — no dependency resolution changed. Keeping the newer, richer lock is
strictly better for Zerops's `npm ci` on musl, so `git checkout -- package-lock.json` after the install leaves the
lock as the branches wrote it and `node_modules` correct on disk. `package-lock.json` is unmodified by this unit.

## 2. Integration fixes (`fb9f5b8`)

The merges themselves broke nothing: typecheck, **2305** tests and the build were green on the merged tree *before*
these. All five are seams the branch notes handed to the integrator, and each only becomes live once both sides are
on `main`.

1. **The sims were never bound, and neither were the publications.** `buildRelaysDeps`
   (`src/server/relays/index.ts`) defaulted `sims` to `() => null` and `publications` to `null`, because `wp/wp17`
   and `wp/wp18` were off `main` when WP14b wrote it. The measured consequence: `CallCatalog` resolved **no**
   simulated call at all (the Dental gallery sim was unreachable from a run, so the whole Try-an-edit path was dead),
   and `RelayDetail.publication` was **permanently null** for every relay, published or not. Both are gaps the notes
   hand over: `requests/wp14b-to-wp17.md` §4 and `requests/wp18-to-wp14b.md` §3.
   - Bound to `getSimCallStore()` and `publicationLookup()` **through `await import(...)`, not a static import.**
     `src/server/publish/deps.ts` and `src/server/sim/service.ts` both import `getRelaysDeps` from this very module,
     so a top-level import here would close a module cycle; and since `publicationLookup` is a `const` arrow, a cycle
     would be a TDZ error at module evaluation rather than a clean failure. The dynamic form also preserves the
     graph's laziness: neither module — and so neither `getDb()` — is touched until a request actually resolves a sim
     or reads a relay's publication.
   - An explicit override still wins, including an explicit `null`; only *omitting* the key now gets the real
     implementation, so every existing test that injects a store or asks for no publications is unaffected.
2. **`POST /api/relays/:id/publish` was not mounted.** Three lines re-exporting `publishRelay`, at
   `src/app/api/relays/[id]/publish/route.ts` — WP14b's path, which is why WP18 could not add it on its own branch
   (`requests/wp18-to-wp14b.md` §1). Every other WP18 route was already mounted. Without it, publishing a relay —
   the whole of WP18·1 — had no HTTP entry point. It now appears in the `next build` route table.
3. **`installPublishing()` was never called.** Added to `src/instrumentation.ts` next to the G2 `[WIRE-CALLS]`
   registration, in its own try/catch. It registers WP18's `livePublications` count source with the v3 entitlements
   registry (`setOrgCounter`), which is what enforces the guest plan's 1 live publication before WP21 exists
   (`docs/notes/wp18.md` §2). It only stores a closure, so boot stays cheap and opens no database connection.
4. **`npm run calls:sim`** added for WP9's `scripts/calls/sim-take.ts` (`wp9-to-integrator.md` item 4 — the script is
   WP9's, the `package.json` line is not).
5. **`examples/relays/dental-deposit.yaml`** generated with `npx tsx scripts/devtools/gen-examples.ts --all`, now
   that WP17's `data/relays/dental-deposit.json` has landed — `docs/notes/wp23.md` integrator action 5 names exactly
   this moment. `baton-add-driver.yaml` regenerated **byte-identical**, so the codec's `serialize` has not drifted,
   and `gen-examples.ts --check` reports "examples are up to date".

**No test was weakened, skipped or relaxed.** No existing test needed changing at all.

### The bindings were checked at run time, not only by the type checker

Against the throwaway database of §4, with no overrides:

| Check | Result |
|---|---|
| `countOrg(ws, "livePublications")` after `register()` | `0` — reaches WP18's `countLivePublications`, i.e. the counter is registered at boot |
| `catalog.resolve("sim_10280948ea62dbbb")` | resolves: `simulated: true`, `durationMs: 70775`. **Was `null` before the fix** |
| the same, after `ensureSeeded()` | `relayVersionId: "rv_ShADypRjpPDBSRqFFo2Ub"`, account keys `customer/org/callDate/facts/tables` — the gallery seed writes 2 relays / 4 versions and the sim maps onto the Dental version, so Try-an-edit has a real run behind it |
| `publicationLookup().forRelay("rly_nope")` | `null`, no throw — the dynamic import resolves and there is no cycle |
| `catalog.resolve("s01_sim_20260925T110000Z")` | resolves as a **recorded-path** call, `simulated: false` — correct for the catalog, and the root of open item §6.1 |

## 3. The featured call (the confirmation this unit was asked for)

`src/generated/calls.json` is a **3-entry array** and is no longer empty:

| Field | Value |
|---|---|
| `callId` | `s01_sim_20260925T110000Z` |
| `scenarioId` / `title` | `s01` — "Add 17-year-old daughter Maya to the Civic (golden demo path)" |
| `featured` | **`true`** (the only entry with it; `s02`/`s03` are `false`) |
| `picker` | `main` |
| `source` / `format` | `twilio8k`, `pcm_mulaw` @ 8000 Hz, 135 493 ms |
| `assets` | **all three present** — `/calls/s01_sim_20260925T110000Z/{rep.76090319.ulaw, customer.7f59e2f5.ulaw, peaks.98932ab0.json}`, and all three exist on disk and in `bundle/public/` |
| `decisionPointMs` / `handoff` | 124 808 ms; line 124 808 → 129 640, accepted 129 969 → 131 197, `declined: false` |
| `inEval` | `false` (no generated take counts in any recorded metric) |

**Provenance: `"simulated"` — with a caveat about *where* it lives.** `CallManifestEntry` is frozen at G0, so the
provenance rides in the sibling generated file `src/generated/call-provenance.json`, exactly as
`src/core/contracts/ext/wp9-data.ts` specifies. There, `s01_sim_20260925T110000Z` reads
`humanHalf: "simulated"`, `scriptModel: "gpt-6-luna"`, `ttsModel: "gpt-4o-mini-tts-2025-12-15"`,
`voices: {rep: "cedar", customer: "marin"}`, and the ready-made strip line *"Simulated audio: script by gpt-6-luna,
voices by gpt-4o-mini-tts. Fictional people."* All three takes carry it. **There is no `provenance` key inside
`calls.json` itself** — a consumer is specified to read `callProvenance[callId]?.humanHalf ?? "recorded"`. Nothing
reads it yet: see §6.1, which is the most important open item in this note.

Side effect worth recording: **the suite has no skipped test any more.** The one skip since G0 was
`tests/unit/core/scenario/generated.test.ts`, gated on `skipIf(calls.length === 0)`. With WP9's takes on `main` its
six assertions — one featured entry with its assets on disk, the hand-off label Express needs, cached turns for every
picker call, and both hand-off outcomes covered — now actually run.

## 4. Checks on `main` at `fb9f5b8`

| Check | Result |
|---|---|
| `npm run typecheck` | clean (also clean on `4f01d85` before the merges, and on the merged tree before the fixes) |
| `npm test` | **2306 passed, 0 skipped (165 files)**, ~19 s, **run twice, identical** |
| parity suite (`tests/unit/core/relay`) | **green: 22 files, 458 tests** |
| tenancy suite (`tests/tenancy/**`) | **not present yet** — it arrives with WP19·2 at C3b (D2 15:00). Nothing to run |
| `npm run build` | OK. `next build`, `bundle:scripts`, then `[assemble-bundle] bundle/ ready: 1933 files, 44.9 MiB, 0 symlink(s) materialized`. `/api/relays/[id]/publish` is in the route table |
| bundle contents | `data/relays/{baton-add-driver,dental-deposit,dental-deposit.presets}.json`, `src/generated/{calls,sim-calls}.json`, `public/calls/{s01,s02,s03,sim-dental-deposit}`, `public/data/cached-turns/*`, `public/schemas/blueprint-2.0.json` — all traced |
| migrations on a **fresh** database | OK (§5) |
| conflict markers in the tree | none |

Baselines for comparison: G2 finish was 1651 / 1 skipped (125 files); C3 was 1741 / 1 skipped (132 files). G2b adds
33 test files and 565 tests. **The shared-Postgres file-level flake recorded in `g2.md` §12 did not appear** in
either of the two full runs.

## 5. Migrations on a throwaway database

Docker `baton-pg` (the same local server the DB-backed suites use), database `g2b_check`, created for this and
dropped afterwards. `DATABASE_URL` was derived from `.env` by swapping only the database name, inside a helper that
prints the host/port/user and **never the URL**.

| Step | Result |
|---|---|
| `npm run migrate` on the empty DB | `applied: 2, publicTables: 25` (`0000_init`, `0001_relays`) |
| `npm run migrate` again | `applied: 0` — "schema up to date (no-op)" |
| tables | all 25, including WP14b's `relays`, `relay_versions`, `relay_publications`, WP16's `connector_secrets` / `connector_calls`, and WP17's `sim_calls`, `tts_cache`, `drafts` |
| gallery seed on that DB | `upserted: [baton-add-driver, dental-deposit]`, `versionsCreated: 4`, `errors: []` |
| cleanup | `DROP DATABASE g2b_check` |

No migration was added by this unit — none of the five branches carries one. `0002_saas` / `0003_audit_guard` are
WP19·2's, at C3b.

## 6. Open issues

### 6.1 **[blocking before the video] Every take on `main` is TTS, and the console still says "recorded role-play"**

WP9 flagged this twice (`wp9-to-integrator.md` item 7; `wp9.md` WP9·3 integrator action 1) and it became real with
this merge, because before it `calls.json` was empty and no take shipped at all. It is **not** fixed here, because
the visible surface is not the integrator's to rewrite and a server-only fix would give false comfort. Both halves,
precisely:

1. **Server.** `src/server/cases/create.ts:116` (`batonV2Fields`) calls `relayRunFields(compiled, …, false)` — the
   `simulated` flag is **hardcoded `false`** on the v2 Baton path. `runProvenance()` in `src/server/engine/run.ts:91`
   therefore returns `humanHalf: "recorded"`, `customerInAiHalf: "recorded"`, `detail: null` for `s01`. The relay-run
   path is correct (it takes `simulated` from the catalog); only the recorded-call path is wrong, and every call on
   `main` is now a generated one.
2. **Client.** `provenance()` in `src/client/store/selectors.ts:268` does not read the server's `provenance` field at
   all. It **hardcodes** `value: "recorded role-play"` with the tooltip *"A role-play call recorded by consented
   volunteers"*, switching only on `source === "twilio8k"` — which `s01` sets. So even with the server fixed, the
   banner a judge reads would still claim a human recording.

The contract already says what to do: `src/core/contracts/ext/wp9-data.ts` specifies the consumer reads
`callProvenance[callId]?.humanHalf ?? "recorded"` and passes it straight into `ProvenanceStripSchema`, whose
`humanHalf` enum already has `"simulated"` and whose `detail` is the ready sentence quoted in §3. `nothing` in `src/`
reads `call-provenance.json` today (checked by grep).

**Until this lands, no recording of the flagship path should be published**, and `"✓ Verified from recording"` on the
QA card (`src/components/qa/qa-card.tsx:140`) sits above generated audio. The planner should assign both halves —
server to WP14b's owner, client to WP7 — before the D3 rough video.

### 6.2 `npm run build` over a stale `bundle/` nests the previous bundle inside the new one

Pre-existing, not caused by this merge, but it directly affects the deploy the orchestrator is about to run.
Next's file tracing follows the previous build's `bundle/` directory into `.next/standalone/bundle`, so each build
embeds the last one. Measured here: a build over the existing `bundle/` produced **2052 files / 81.8 MiB** with
`bundle/bundle/bundle/bundle/bundle/bundle/src/generated/calls.json` six levels deep (six past builds); after
`rm -rf bundle .next` the same tree builds to **1933 files / 44.9 MiB**. G2's recorded 65.7 MiB was inflated the same
way.

**For the deploy: build from a clean `bundle/` and `.next/`.** The lasting fix is one line in WP12's
`next.config.mjs` (`outputFileTracingExcludes` for `bundle/**`) or a clean step in `scripts/assemble-bundle.mjs`;
both are WP12's files and were left alone.

### 6.3 Requests still open to their owners (none is a G2b blocker)

- **WP14b** — `wp17-to-wp14b.md` §6 is the sharpest: `sanitizePatch` silently drops every extraction event whose
  field is not one of the 21 legacy Baton ids, so **every drafted, blank and user-made relay currently extracts
  nothing on a live run**. WP17 measured it with a trace and worked around it in the dry run only. Also §5 (the
  Express start on a gallery sim inherits 1 of 3 settled fields; WP17 recommends `startOffsetMs = 0` for gallery
  sims).
- **WP12** — `wp16-to-wp12.md` (`APP_ENV` in `zerops.yml` `run.envVariables`, `APP_ENV` /
  `CONNECTOR_HOST_ALLOWLIST` / `CONNECTOR_SECRETS_KEY` in `EnvSchema`, `getSecretStore().purgeExpired()` in the purge
  job); `wp17-to-wp12.md` (two purge steps, `.pcm` in the proxy matcher, a `"draft"` `JobKind` + one
  `runner.register` line); `wp18-to-wp12.md` (`runPublicationPurge()` in the purge job); `wp23-to-wp12.md`
  (`.gitignore` for `public/{vendor/monaco,cli,sdk}/`, `copy-monaco` in `npm run build`, three `devtools:*` scripts).
  None breaks anything today: the connector env vars are read from `process.env` with safe defaults (and fail closed
  to the §6.2 host allowlist when `NODE_ENV=production`), and the purge steps are housekeeping.
  - Checked and **no action needed**: `CONNECTOR_SECRETS_KEY` does not have to be added to `SECRET_ENV_NAMES` in
    `src/server/log.ts`. `registerSecretsFromEnv()` already auto-registers every `process.env` value ≥ 16 chars whose
    name matches `/(API_KEY|_TOKEN|SECRET|PASSWORD|_KEY)$/i`, and a 32-byte base64 key is 44 chars.
- **WP16** — `setPublishDeps({ tools })` with WP16's `RelayToolService` is **not** wired, because WP16·2 has not
  built it yet. Until then the published connector gateway answers `{"status":"unavailable"}` and never a 500, which
  is WP18's designed fail-closed behaviour (`wp18.md` §4). Nothing to do at G2b.
- **WP19·2 / C3b** — `wp18-to-wp19.md` §5: `POST /api/connectors/pub/**` must stay **off** any CSRF or same-origin
  middleware (its credential is `X-Changeover-Key`; AssemblyAI's servers carry no cookie), and the §10.1 boundaries
  scanner must follow a single-identifier re-export. Nothing enforces same-origin today —
  `src/server/saas/same-origin.ts` is reachable only from `src/server/saas/principal.ts`, which is not mounted in
  `TENANCY_MODE=legacy` — so this is a constraint on C3b, not a live problem.
- **WP14a** — `wp9-to-wp14a.md` §2 (AND vs OR in `repLinePatterns`, which decides whether s02 ever fires) and §3 (the
  arrival-time acceptance trap, which WP9 calls a correctness bug waiting to happen). WP14a is merged and its branch
  is idle; the planner should route these.
- **WP13** — `k` is still **0**. No recorded take exists, so nothing in `calls.json` supports a freed-rep-time
  number, and s03 must not be read as evidence of any decline rate.

### 6.4 Carried forward unchanged from `g2.md` §5–§6 and `c3.md` §7

The deploy and the push (the orchestrator's), whether the Zerops app secrets are set, the Polar GUI steps, and the
`LIMITS_ROLE=remote` switch every agent running live VA scripts needs once WP18's tightened F6 audit is deployed.
`data/calls/` still holds only `README.md`: **there is still no real recording**, which is why the simulated takes
exist at all.

## 7. Worktree sync

`git -C .wt/<wp> merge --no-edit main` ran in **all 27** worktrees, at `cfa3883` (this note's commit). Every one was
clean beforehand (`git status --porcelain` empty, no stale `index.lock`) and **none had a commit of its own ahead of
`main`** — `git branch --no-merged main` is empty — so **every merge was a fast-forward, no conflicts, nothing
aborted, and no ownership ruling was needed.**

| Worktrees | Before | Result |
|---|---|---|
| `deploy`, `wp1`, `wp2`, `wp3`, `wp4`, `wp5`, `wp5b`, `wp6`, `wp7`, `wp7b`, `wp8`, `wp12`, `wp13`, `wp14a`, `wp14b` | `881b20b` | ff to `cfa3883` |
| `wp15`, `wp20`, `wp21`, `wp22`, `wp24` | `4d2cff3` | ff to `cfa3883` |
| `wp16`, `wp17`, `wp18`, `wp23`, `wp9` | their own tips (`244cf93`, `75f1dcb`, `1116d4d`, `6f52a02`, `f3dfc01`) | ff to `cfa3883` — their work is now in `main` |
| `wp19` | `5d9f08d` | ff to `cfa3883` (its C3 work is in `main`; WP19·2 continues from here) |
| `wp11` | `4f01d85` | ff to `cfa3883` (this worktree appeared during the unit; it was clean and empty of its own commits) |

A second pass after this correction fast-forwards each of them by one more commit.

WP20–WP24 and WP15 now see, on top of C3's contracts v3: WP23's codec and JSON Schema, WP16's connector runtime and
`SecretStore`, WP17's Dental relay, presets, gallery sim and drafting pipeline, WP18's publish service and gateway,
and WP9's three takes with `calls.json` no longer empty.

## 8. Not done here

**Nothing was pushed and nothing was deployed** — `main` is at `fb9f5b8` plus this notes commit, locally. No remote
was contacted at any point in this unit.
