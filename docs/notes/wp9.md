# WP9 notes: takes → assets, labels, STT and extraction caches

Branch `wp/wp9` (merged `main` after G1 before starting). Status 2026-09-25 09:40 IST: the whole pipeline is built and
tested on a SYNTHETIC take; no real take existed yet (recording 10:00–14:30 IST), so the committed `src/generated`
holds the 22 kit scenarios and an empty call list.

## What exists

| Piece | Where | Live? |
|---|---|---|
| Kit schemas (loose zod; sidecar v1, `kit report` manifest, scenario v1) | `src/core/scenario/kit.ts` | no |
| Intent specs (field ids, required set, labels, normalizer per `intent`) | `src/core/scenario/intent-spec.ts` | no |
| `normalizeScenario(kit, sidecar)` | `src/core/scenario/normalize.ts` | no |
| Call plan: usable/chosen take, featured, picker, inEval, decision point | `src/core/scenario/build.ts` | no |
| Assets (µ-law, peaks, content-hashed names) | `src/core/scenario/assets.ts`, `peaks.ts` | no |
| `npm run calls:build` | `scripts/calls/build-assets.ts` (+ `lib/kit-io.ts`) | no |
| Synthetic take generator | `scripts/calls/synthetic-take.ts` | no |
| STT cache runner + reader (`pc_ctx`, `pc_noctx`, `mono_diar`) | `src/core/scenario/stt-run.ts`, `stt-cache.ts`; `scripts/eval/cache-stt.ts` | **AssemblyAI streaming** via `aai-open.ts` |
| Labels (auto) + review CLI | `src/core/scenario/labels.ts`; `scripts/eval/label-ground-truth.ts`, `review-labels.ts` | AssemblyAI async + sol |
| Extraction cache (v1/v2/v3) | `src/core/scenario/extract-replay.ts`; `scripts/eval/extract.ts` | luna |
| Verifier cache | `scripts/eval/verify-cache.ts` | sol |
| Additive types | `src/core/contracts/ext/wp9-data.ts` (per-take scenarios file, STT trailer, auto-label file) | |

## Commands (from a worktree the kit input defaults to the MAIN checkout's `data/calls`)

```
npm run calls:build                                  # src/generated/*, public/calls/<base>/, public/data/cached-turns/
npm run calls:build -- --check                       # exit 1 if any output is stale
npm run eval:cache-stt -- --calls chosen --dry-run   # cost preview
RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp9 npm run eval:cache-stt -- --calls chosen --variants pc_ctx,pc_noctx --max-usd 0.50
RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp9 npm run eval:cache-stt -- --calls pilot --variants mono_diar
npx tsx --conditions=react-server scripts/eval/label-ground-truth.ts --calls pilot          # AAI async + sol
npx tsx --conditions=react-server scripts/eval/review-labels.ts --list
npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId> [--context]
npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId> --edit "driver_dob.statedAtMs=00:41.2" --approve
npx tsx --conditions=react-server scripts/eval/review-labels.ts <callId> --interactive
RUN_LIVE=1 npm run eval:extract -- --version all --calls pilot
RUN_LIVE=1 npx tsx --conditions=react-server scripts/eval/verify-cache.ts --calls pilot
npm run calls:build                                  # again: picks up labels (handoff, decision point, inEval) + cached turns
npx tsx scripts/calls/synthetic-take.ts --out <tmp>/calls [--scenario s01] [--private] [--mono] [--max-ms 24000]
```

Paths: `--calls-dir`/`BATON_CALLS_DIR` (kit output, read-only), `--scenarios-dir`/`BATON_SCENARIOS_DIR`,
`--out`/`BATON_OUT_ROOT` (generated + public), `--data-root`/`BATON_DATA_ROOT` (labels + caches). The pilot set is
the chosen takes of `s01,s02,s03,s05,s10` (`BATON_PILOT` overrides). Every live script refuses without `RUN_LIVE=1`,
has `--dry-run`, a `--max-usd` cap, runs serially, records spend in the limits ledger and is resumable.

## Decisions

1. **Rebased on post-G1 main** (fast-forward merge of `main` into `wp/wp9`, TASKS §0.1) so WP1's `normalizeField`,
   WP3's extractor/verifier and WP4's `buildSttParams` are the real ones, not stand-ins.
2. **Generic where it is free (Changeover).** Kit fact keys, overrides, intent, language and hand-off response parse as
   plain strings; the scenario's `intent` selects an `IntentSpec` (field ids, required fields, labels, normalizer,
   rating fields). Unknown fields are dropped with a warning, never a parse failure. The frozen `Scenario` contract
   still carries only `add_driver`, so `normalizeScenario` refuses other intents explicitly.
3. **`calls.json` lists every usable take** (downloaded, not discarded, known scenario), private ones included
   (`publishAudio:false`, `assets:null`), so the eval set and the Watch set come from one manifest. `picker` is `main` /
   `more` only for the chosen, publishable, 2-channel take of a scenario; `main` needs an accepted hand-off, a positive
   premium change and a start within 30 days (drops s04, s09, s07); declines are `more`.
4. **Featured** = the chosen publishable 2-channel `s01` take; else (warned) the first `main` call. Exactly one.
5. **Chosen take** is recomputed from the sidecars with the kit's own rule (newest `keep`, else newest usable); the
   manifest's `chosen_take` is advisory and a mismatch is a warning (it goes stale after `kit mark`).
6. **MONO rule** is literal: `twilio.recording_channels === 2` and no kit MONO warning. A missing value is not
   trusted. MONO takes are never `inEval`, never in the picker, and get no per-channel STT variant.
7. **`src/generated/call-scenarios.json`** (new, additive): callId → that take's `Scenario` (its own overrides).
   `scenarios.json` carries one Scenario per kit scenario (the chosen take's overrides). The eval must use the per-take
   truth because two takes of one scenario can carry different `fact_overrides`.
8. **Idempotency:** no timestamps in any generated file; files are rewritten only when bytes change; stale hashed
   files, unpublished take dirs and orphan cached-turn files are pruned; a missing calls dir is an error (a typo must
   not prune `public/calls`). `--check` reports drift.
9. **Audio:** split WAV PCM16 → G.711 µ-law with WP0a's encoder; the STT cache feeds the SAME bytes. Unequal channel
   lengths (never for kit takes) are padded with silence and warned.
10. **STT cache format:** one `SttCacheRecord` per server message, `recvMs` = audio ms sent to that session INCLUDING
    the frame just sent (the server's reply has heard it); `Begin` at 0; a per-channel `BatonCacheMeta` trailer
    (params, params hash, billed seconds, provider session id, agent_context update count, runner version). No trailer
    = incomplete = never used. 100 ms frames at 1× real time, then 1500 ms of µ-law silence, then Terminate.
    `pc_ctx` sends `UpdateConfiguration{agent_context}` on every NEW rep final (first final per turn_order).
    `Begin.configuration` must echo model + mode or the run aborts (dev rule of §5.1.6).
11. **Stale caches:** the trailer's params hash is compared with today's `buildSttParams` output; a changed
    `TUNING_8K` (WP4 re-decides it on real takes, T-D1-6) shows as STALE and `--refresh-stale` re-runs it.
12. **Cached turns** (`public/data/cached-turns/<callId>.json`) only for published 2-channel takes with a complete
    `pc_ctx` cache; Turn messages only (partials + finals), `transcribedAt` from the trailer.
13. **Labels:** the take's split files are rebuilt into a 2-channel WAV (ch1 rep, ch2 customer) → async multichannel
    U3.5 Pro with keyterms = policy keyterms + truth words; the transcript is cached in `data/cache/asr/` so the sol
    locator can be re-run for $0 AAI. sol returns utterance ids + verbatim quotes; quotes are mapped to word times
    (exact → fuzzy ≥60% → whole utterance + `low_confidence`). `valueNorm` = the take's truth; the value sol heard is
    only used for the `value_mismatch` flag. Acks by the same party or before the mention are ignored. A reviewed
    labels file is never overwritten. `--approve` is refused while `labelProblems()` reports anything.
14. **Extraction cache** uses WP3's `OpenAIExtractor` bound to WP1's engine with the version's artefacts (v1 =
    `EXTRACTOR_PROMPT_V1`, v2/v3 = V3), single-turn calls in recvMs order, state derived from the events so far,
    one retry for a failed turn. Events keep their order (WP3 re-ids them by index). A cache with the current
    `extractorVersion` is skipped. Case id in the replay: `eval-<callId>`.
15. **Verifier cache** runs start on the 30 s grid: the next run is the first tick after the previous one finished;
    no run when no new final arrived.

## Measured (Day 1)

- **Live STT smoke (synthetic take, 24 s, `pc_ctx`, 2026-09-25 09:34 IST):** 50 messages, 7 finals, 4 agent_context
  updates, `Begin.configuration` = `universal-3-5-pro` / `min_latency`, final lag (recvMs − last word end)
  347–467 ms, billed 26 s per channel (24 s audio + 1.5 s tail + connect), ≈ $0.0065. Total WP9 live spend so far:
  **≈ $0.007 AssemblyAI, $0 OpenAI**.
- `calls:build` on 3 synthetic takes (69 s each): ≈ 1.2 s. Tests: 10 files / 100+ cases under
  `tests/unit/core/scenario/`, all $0.

## Tests (`tests/unit/core/scenario/`)

- `normalize.test.ts`: all 22 kit scenarios parse and normalize; truth round-trips through WP1 `normalizeField`;
  policy equals WP3's `policyFromKitScenario`; dueToday equals WP1 `resolveDueToday`; overrides; unknown fields.
- `build.test.ts`: chosen take, exactly-one featured, fallback feature, MONO exclusion, picker tiers, private takes,
  decision point, stale-manifest warning, per-take overrides.
- `calls-build.test.ts`: end to end on synthetic takes in a temp dir (acceptance 1): featured has assets on disk,
  µ-law decodes back to the split audio, private takes get no public dir, cached turns from a pc_ctx cache, inputs
  untouched (bytes + mtimes), idempotent (second run and `--check` change nothing), pruning, missing calls dir.
- `stt-run.test.ts`, `stt-cache.test.ts`: runner over fake sessions (recvMs, agent_context once per rep final, pacing,
  early close, mono, trailers, JSONL), finals/duplicates, TurnInput ids, mono attribution.
- `labels.test.ts`: transcript → utterances, quote matching, flags, hand-off, review edits and problems.
- `extract-replay.test.ts`, `pipeline.test.ts`: sequential replay with derived state and retry; verifier cadence;
  synthetic take → STT cache → WP3 extractor (fake OpenAI client) → v1/v3 caches pinned to WP1's versions.
- `generated.test.ts`: the committed `src/generated` + `public/` agree (featured check skipped while no takes).

## Known gaps / next

- **No real takes yet.** As soon as `data/calls/raw` has sidecars: `npm run calls:build`, commit `src/generated`,
  `public/calls`; then STT caches (≈$0.017 per 2-min take for pc_ctx+pc_noctx; cap $0.50 today), then labels for
  the pilot (≈$0.01 AAI + ≈$0.03 sol per take), extraction and verifier caches.
- **TUNING_8K is provisional** (WP4 re-decides on 2 real takes). Caches made before that show as STALE; budget
  a re-run (~$1.6 for everything) or keep them if WP4 keeps 160/1000.
- Labels, the extraction cache and the verifier cache have not run live (only the STT cache was allowed live
  today). Their wiring is covered by $0 tests with fake clients; the sol locator prompt is untested on real speech.
- Hinglish labelling uses `language_detection` + `code_switching` on the async API: not yet tried live.
- `data/golden/` (16 kHz calls) and `pc_ctx_8k` are not implemented (optional in DESIGN).
- `recordedAiBundle` is detected from `public/replays/<id>/{meta,bundle,events}.json` carrying `callId` (or a dir
  named after the callId); WP11 should confirm the naming. `customerTailPack` = `public/tts/voice/<sid>/manifest.json`.
- Transcripts of PRIVATE takes (labels, `data/cache/{asr,stt}`) are committed like the rest of `data/`; they are
  fictional role-play content but real voices' words. See the integrator request if that should be git-ignored.

## Hand-offs

- **WP3:** `src/generated/{calls,scenarios}.json` exist (arrays), plus `call-scenarios.json`; extraction caches at
  `data/cache/extract/<callId>/v3.pc_ctx.json` pinned to `EXTRACTOR_VERSION_V3`; cached turns at
  `public/data/cached-turns/<callId>.json`. `normalizeScenario` keeps WP3's policy mapping (a test pins it).
- **WP4:** cached turns follow `CachedTurnsFileSchema`; per-take pc_ctx caches in `data/cache/stt/<id>/pc_ctx.jsonl`
  can feed T-D1-6 comparisons (the trailer has the params).
- **WP9b:** caches + labels as above; per-take truth in `src/generated/call-scenarios.json`; `tailStartsMs` /
  `diagnosisEndsMs` in labels; `inEval` in `calls.json`; mono_diar TurnInputs via `monoTurnInputs`.
