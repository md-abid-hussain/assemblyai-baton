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

---

## From WP14b·3 (D2 Sat Sep 26): the relay half of the QA input

WP14b owns `src/server/qa/build-input.ts` (that file only). The **verify job** that calls it,
`src/server/jobs/verify-takeover.ts`, is yours, so the last three lines of acceptance 6 are a request, not a commit.
Nothing below changes a Baton run: with the new optional argument omitted, every output of `buildQaInput` is what it
is on `main` today, byte for byte, and `tests/unit/server/verify/build-input.test.ts` passes untouched.

### 9. Please pass the relay context in `compute()` and `keytermsOf`

`buildQaInput(sources, relay?)` takes a second, optional `RelayQaContext`:
`{ spec: IntentSpec; toolNames: ReadonlySet<string>; disclosureIds: readonly string[] }`. Build it with
**`relayQaContextFor(() => getRelaysDeps(), relayVersionId)`** from `src/server/engine/qa-context.ts` (WP14b's), which
answers `null` for a Baton case, for an unbound relay graph, and for a compile failure — so the fallback is always
"score with Baton's sets", never a lost verification.

Three edits, all in `verify-takeover.ts`:

1. `loadContext` selects one more column — `relayVersionId: cases.relayVersionId` — and returns it on
   `TakeoverContext`. `cases.policy` is already selected; for a relay case it holds a **stored `AccountRecord`**
   (`$kind: "account"`), which `QaSources.policy` now accepts (it is widened to `PolicyRecord | AccountRecord`, and
   `buildQaInput` converts it with WP14a's `policyFor`, so `Wp8QaInput.policy` is unchanged).
2. line ~315: `buildQaInput({ ...ctx, transcript: t, timeline, durationSec })` →
   `buildQaInput({ ...ctx, transcript: t, timeline, durationSec }, await relayQaContextFor(() => getRelaysDeps(), ctx.relayVersionId))`.
3. line ~264 (the S2 keyterms): `keytermsOf(ctx.snapshot, ctx.policy)` →
   `keytermsOf(ctx.snapshot, ctx.policy, 100, (await relayQaContextFor(() => getRelaysDeps(), ctx.relayVersionId))?.spec)`.
   Without the spec a Dental run sends Baton's entity fields, i.e. no keyterms at all.

Why it matters: P§4.7 widened `ToolNameSchema` and `DisclosureKindSchema` to the id grammar, so without the context a
relay run scores with **`made_up_tool` acceptable, its own tool calls dropped, and no disclosures at all**.
Tests: `tests/unit/server/engine/qa-context.test.ts` (13, no DB, $0) pins both halves of every case — with the
context the Dental ids, without it Baton's, unchanged.

### 10. One defect fixed in `build-input.ts`, and the contract change that would let it be reverted

`TakeoverMetricsReadSchema.disclosures` (`src/core/contracts/ext/wp8-verify.ts`, **your file**) is a
`z.partialRecord(z.enum(["premium_change", "esign_consent"]), …)`. A relay stores its OWN disclosure ids there, so the
record key fails — and because the failure is at the top-level `safeParse`, `readMetrics` returned `{}` and the run
lost **`hud` as well**. Every Dental run was scored with null latency.

`readMetrics` now retries once without the `disclosures` key, so `hud` survives; the relay's texts are read from the
raw value by `disclosuresOf`. A Baton run never reaches the retry. **If you widen `disclosures` (and
`Wp8QaDisclosure.kind`) to `DisclosureKindSchema` — the id grammar, which P§4.7 already applied to `DisclosureKind`
itself — the retry and the `rawDisclosures` helper both delete, and `disclosuresOf` becomes one loop.** WP14b will
make that edit on request; the file is yours, so it is not done here.
