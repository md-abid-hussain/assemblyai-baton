# WP17 → WP14b (server engine, `CallCatalog`, migration 0001)

From WP17·1 (branch `wp/wp17`). Types: `src/core/contracts/ext/wp17-sim.ts`. Code: `src/server/sim/**`.

## 1. `CallCatalog.resolve(callId)`: the sim step (PLATFORM §7.5 step 4)

After `src/generated/calls.json` misses, call the `SimCallStore` port:

```ts
import { getSimCallStore } from "@/server/sim/defaults";
const sim = await getSimCallStore().resolveCall(callId);   // SimCallResolution | null
```

- It checks `sim_calls` rows first (audio sims only; a `text_dry_run` row is not a call → null; it touches
  `last_used_at`), then the committed gallery manifest `src/generated/sim-calls.json` (a bundled JSON import; empty
  until WP17·2).
- `sim.entry` is the synthesized `CallManifestEntry` (`source:"twilio8k"`, `picker:"hidden"`, `inEval:false`,
  `decisionPointMs = handoff.lineStartMs`, assets on `/api/sim-calls/<id>/{rep.ulaw,customer.ulaw,peaks.json}`).
- `simulated: true` is already set. You add:
  - **`relayVersionId`**: DB sims carry it (`sim.relayVersionId`). **Gallery sims have `relayVersionId: null`**
    because `seedGallery()` assigns random `rv_` ids: map `sim.relay.slug` + `sim.relay.blueprintHash` to the gallery
    relay's version with that `blueprint_hash` (fallback: the relay's `current_version_id`).
  - **`account`**: `version.blueprint.context.samples[sim.sampleIndex]`.
- Presets ("Try an edit") run a preset version on the SAME sim: the run's version is the preset's, not the sim's.
- Tests can use `MemorySimCallStore` (`@/server/sim/store`) with `setSimCallStore()`.

## 2. Migration 0001 columns WP17 relies on

`PgSimCallStore` and `PgTtsCache` use raw SQL (so they work before and after your `schema.ts` lands). They rely on
`sim_calls(id, kind, relay_version_id, sample_index, script, rep, customer, peaks, duration_ms, handoff, ai_clips,
usd, gallery, created_at, last_used_at)` and `tts_cache(hash, model, voice, text, pcm24k, duration_ms, created_at)`
exactly as in your `747d0be`. Please keep those names and types. (WP17's DB tests create the two tables with
`CREATE TABLE IF NOT EXISTS` copies of your DDL, so they stay green once 0001 is merged.)

## 3. Stored shapes

- `sim_calls.script` holds `SimScriptStored` = the normalized `SimScript` (the handoff turn is the EXACT `repLine`)
  plus `timeline[]` and `relay {slug, title, blueprintHash}`. `SimScriptSchema.parse()` strips the extras for
  `SimCallView.script`.
- `sim_calls.handoff` is a v1 `CallHandoff` (`lineStartMs…`, `declined:false`), i.e. PLATFORM's `repLineStartMs` =
  `lineStartMs`.
- `sim_calls.ai_clips`: `{ confirm | consent | close | "answer:<field>": { hash, text, durationMs } }`.

## 4. `cases.sim_call_id`

When a run plays a sim, set `cases.sim_call_id = callId` (the sim id is also the call id).

---

## 5. The Express start on a gallery sim inherits almost nothing (WP17·2, please rule)

**The measurement.** The Dental gallery sim (`sim_10280948ea62dbbb`, 70.8 s, pass at 63795 ms) settles its three
required `ai_allowed` fields at these times:

| Field | Settled at | Inside the Express window (`pass − 25 s` = 38795 ms)? |
|---|---|---|
| `patient_full_name` | 23895 ms | **no** |
| `procedure` | 33704 ms | **no** |
| `appointment_date` | 44339 ms | yes |

`buildPrefill` (`src/server/cases/prefill.ts:64`) inserts a cached turn with `status:"skipped"` and no events when
`data/cache/extract/<callId>/v3.pc_ctx.json` has no entry for it, and skipped turns are never re-extracted. So on an
Express start the AI inherits **1 of 3** settled fields, and "What the AI inherits" is nearly empty — the opposite of
what §7.5 is for.

**Why WP17 cannot just ship the fact-events cache.** `getExtractCache` is keyed by `callId` alone, and served only
when `cache.extractorVersion === engine.extractor.version`. A relay's extractor version is
`extractorVersionOf(prompt, format, model, effort)`, i.e. a function of the **blueprint**, and the two "Try an edit"
presets are different blueprints (`7aaeb41c…`, `f31f4a8c…`) that play the **same audio and the same callId**. One
file per callId can therefore serve at most one of the three variants; the other two fall back to turns-only.

**Two ways out. Your call — both are in your paths, not mine.**

1. **Start gallery sims at 0** (preferred, and free). A sim is 71 s; "Express · about 3 min" vs "Full call · about
   5 min" is a rule for the 5-minute recorded takes. If a `simulated` call starts at `startOffsetMs = 0`, every fact
   is extracted live as the call plays, all three variants behave identically, no cache is needed and no prefill
   version can go stale. It also keeps the demo honest: nothing is pre-inserted.
2. **Key the extract cache by extractor version** — `getExtractCache(callId, extractorVersion)` reading
   `data/cache/extract/<callId>/v3.pc_ctx.<extractorVersion>.json`. If you want this, say so and WP17·3 will
   generate the three files from the committed cached turns (≈ $0.02 OpenAI each, ledger-settled) and commit them;
   the writer is deterministic apart from the extractor calls.

Nothing else in WP17·2 depends on the answer: the cached **turns** (`public/data/cached-turns/sim_10280948ea62dbbb.json`,
pc_ctx, both channels, 13 rep + 10 customer finals before the pass) are committed and the transcript carries every
fact the script settles (`tests/unit/server/sim/dental-gallery.test.ts`).

---

## 6. `sanitizePatch` drops every extraction event of a non-Baton relay (WP17·3, live-measured)

**This one blocks every drafted, blank and user-made relay, not just my unit.** It is in your paths
(`src/server/openai/extractor.ts`, WP14b from G1), so I have not touched it.

`OpenAIExtractor.attempt` ends with `sanitizePatch(r.data)`, which validates each event with
`RawPatchEventSchema` (`src/core/contracts/extract.ts`). That schema's `field` is `FieldIdSchema`, i.e.
`z.enum(FIELD_IDS)` — **the 21 legacy Baton field ids** in `src/core/intents/add-driver.fields.ts`. Every event
naming any other field id fails `safeParse`, is counted in `dropped` and disappears. `extractTurn` then returns
`events: []` with **no error**, so the caller sees a healthy, empty extraction.

**Measured live on 2026-09-25** (`scripts/sim/draft-smoke.ts --desk 1 --dry-run --trace`, drafted dental relay):

| | |
|---|---|
| batches | 5 (14-turn script, 3 new turns each) |
| luna's patch | `no_facts:false` on 3 of them, 4 well-formed events, correct `turn_id`s, ids from the relay's own enum |
| events kept | **0** |
| case card | every field MISSING |

The relay's strict format (`extractorFormat(bp)`, `src/core/relay/extractor.ts`) already pins `field.enum` to the
blueprint's ids, so nothing foreign can come back, and `applyExtraction(raw, turns, ctx, spec)` already drops any
event outside `spec.fieldIds`. The zod enum is a second, now-wrong gate.

**Suggested fix (one line, yours):** in `RawPatchEventSchema`, make `field` `z.string()` (or `IdSchema` from
`contracts/v2/blueprint`). `NewFactEventSchema.field` needs the same widening for the events to survive
`applyExtraction`'s own typing. `deriveCaseState` is already spec-driven (`fieldIdsOf(spec, FIELD_IDS)`), so nothing
downstream assumes the union. If you would rather keep the enum for Baton, `sanitizePatch` could take the allowed id
set from the engine's `extractor.format` instead.

**What WP17 did meanwhile.** `src/server/sim/dry-run.ts` makes the extractor call itself — same compiled prompt, same
strict format, same effort and token budget — and parses the patch with a relay-aware schema before handing it to
`applyExtraction`. After that change the same desk settles 3 of 5 fields from 7 events. The **live run** path
(`src/server/cases`) still goes through `OpenAIExtractor` and is still affected.
