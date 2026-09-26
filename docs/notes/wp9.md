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

---

# WP9·2 (D1 15:30–18:30): takes → assets — **no recording happened, so the takes are simulated**

## Done

- **Checked first, as the unit required:** `data/calls/` in the main checkout holds `README.md` and nothing else —
  no manifest, no sidecars. **No real takes exist.** Nothing was publishable from a recording; the fallback ran.
- **A simulated-take pipeline** (`src/core/scenario/sim-take.ts` + `scripts/calls/sim-take.ts`): gpt-6-luna writes a
  two-party dialogue from `data/scenarios/<id>.json` (facts, beats, the rep hand-off line, the acceptance) →
  the hand-off line is forced to the scenario's exact wording → `gpt-4o-mini-tts-2025-12-15` voices every turn
  (`cedar` rep, `marin` customer) → the clips are laid out on one call clock and written in the **recording kit's own
  format**, 8 kHz, 2 channels, to `data/sim-takes/` (raw + split + scripts + manifest).
- **s01 and s02 generated and built.** `calls:build` (with `--check` clean, 0 stale files) produced: featured
  `s01_sim_20260925T110000Z` with `assets` on disk (`rep`/`customer` µ-law + peaks), `decisionPointMs` 124808,
  `handoff.acceptStartMs` 129969, plus `s02_sim_20260925T110000Z` in the picker. `pc_ctx` STT caches and
  `public/data/cached-turns/*.json` exist for both.
- **Labelled as generated, everywhere:** `provenance.kind = "simulated"` in the sidecar, a new
  `src/generated/call-provenance.json` (callId → `humanHalf`, `detail`, `scriptModel`, `ttsModel`, `voices`), and
  `inEval: false` on every simulated call.
- **Requests filed:** `wp9-to-wp13.md` (k = 0 recorded takes; the s01 line; why tail share is not derivable),
  `wp9-to-wp14a.md` (no `TUNING_8K` request + live rep-line finals for `repLinePatterns`), and items 4–7 appended to
  `wp9-to-integrator.md` (the `calls:sim` script, what `calls.json` now holds, two new committed output trees, and
  the provenance strip).

## Decisions

- **A separate input dir, never `data/calls/`.** Generated audio and real voices never share a tree; the write guard
  refuses `data/calls` in *any* checkout, not just main (it was main-only; hardened this unit).
- **Simulated takes are a per-scenario FALLBACK, not a layer.** `loadKit` loads a stand-in only for a scenario with
  no usable real take, so the recordings take over by themselves: recording s01 removes the generated s01 from
  `calls.json`, `public/calls/` and the picker on the next `calls:build`. No cleanup step, nothing to remember. A
  test pins it, and a second test ignores anything in the sim dir that does not label itself simulated.
- **Never in the eval set.** A simulated take is `inEval: false` and its label is `reviewed: false` with **no**
  word-level mentions invented, so §7.6 / JP-I3 numbers can only ever come from recorded speech. A test fails if a
  simulated call is ever marked `inEval`.
- **The `TUNING_8K` check was deliberately NOT run.** It was budgeted and affordable, but TTS speech has no breaths,
  no overlap, no filler and machine-even pacing, so an end-of-turn grid over it would look like evidence and be
  worse than none. `TUNING_8K` stays provisional at 160/1000; today's caches match the current params, so they are
  not STALE.
- **s01's hand-off line** (the answer `wp13-to-wp9.md` asked for): the featured take carries the new P§1.3 wording
  verbatim — "OK if my assistant finishes the paperwork? I'll be one tap away if you need me." — **but by
  construction, not by evidence**, because the generator forces it. It does not unlock a freed-rep-time claim.

## [VERIFY] results

| check | result |
|---|---|
| Real takes present? | **No.** `data/calls/` = `README.md` only. Fallback path taken |
| `calls:build --check` | clean: 22 scenarios, 2 sidecars → 2 usable, 2 published, **0 in eval**, featured `s01_sim_…` (SIMULATED), **0 stale files** |
| Acceptance 2 (one featured, publishable, with assets) | pass (test) |
| Acceptance 3 (cached turns for every picker call; s01 `decisionPointMs`) | pass — both calls have cached turns; `decisionPointMs` 124808 = `handoff.lineStartMs` |
| Acceptance 4 (`scenarioId` resolves through `policyToAccount`) | pass — ran it: s01 → Northbeam Mutual NBM-4418207 / $96, s02 → Bluestem Casualty BSC-2290316 / $118, both valid `AccountRecord`s whose facts match what is spoken in the audio |
| Take format | s01 135.49 s, s02 92.25 s, both **2 ch / 8 kHz / PCM16**, `recording_channels: 2` |
| Hand-off labels vs live STT | s01 line ends 129640, accept 129969–131197; the STT final lands at 130400 (rep) and 132000 (customer) — ~0.8 s after, as expected |
| Live STT wording | "OK" → **"Okay,"**; the current `repLinePatterns` still match both takes (pattern 1); **pattern 2 misses s02** → flagged to WP14a |
| Rule 19 | clean: none of the three banned words appear in any new string (scanned the new code, the generated JSON and these notes) |
| `npm run typecheck` | clean (after `git merge main`) |
| `npm test` | **1672 passed / 126 files**, 0 failed (after the merge; 1319 before it) |

## Tests

`tests/unit/core/scenario/sim-take.test.ts` (new, 14 cases): the `data/calls` write guard across checkouts;
`enforceHandoff` (exact wording, acceptance placed right after, inserted when the writer omits it, no acceptance
when the scenario declines); timeline determinism, per-channel placement, TTS silence trimming; the sidecar parses
as a kit sidecar and says "simulated"; labels derived from the timeline and never "reviewed"; the kit layout at
8 kHz/2 ch; **never writes into `data/calls`**; the featured simulated s01 with assets + `acceptStartMs`;
`call-provenance.json`; idempotency; **the stand-in disappears when a real take appears**; an unlabelled take in the
sim dir is ignored. `tests/unit/core/scenario/generated.test.ts` extended: the committed `calls.json` really has one
featured publishable s01 with hand-off labels, cached turns for every picker call, provenance for every call, and
**no simulated take in the eval set**.

## Live spend (WP9·2)

| provider | action | n | actual |
|---|---|---|---|
| openai | `wp9_sim_take` (gpt-6-luna script + TTS, reserved and settled) | 2 | **$0.0667** |
| aai_stt | `wp9_cache_stt_pc_ctx` (2 takes × 2 channels, via `aai-open.ts`) | 6 | **$0.0645** |

Budget was OpenAI ≤ $0.15 (≈$0.083 left) and AssemblyAI ≤ $0.30 (≈$0.235 left). No AssemblyAI spend for
`TUNING_8K` (see the decision above). Nothing on the Zerops side; Zerops stayed read-only.

## Integrator actions

1. Add `"calls:sim": "tsx --conditions=react-server scripts/calls/sim-take.ts"` to root `package.json`
   (`wp9-to-integrator.md` item 4; the file is not WP9's).
2. `src/generated/calls.json` is no longer empty, and **today it is generated audio** — the provenance strip must say
   so (item 7). Shipping a simulated take under "✓ Verified from recording" would be a false claim.
3. Two new committed trees: `public/data/cached-turns/` and `data/cache/stt/`. The privacy decision in item 3
   applies to them once *real* takes exist.
4. WP14a: read `wp9-to-wp14a.md` before wiring `repLinePatterns` (AND vs OR decides whether s02 ever fires).
   WP13: read `wp9-to-wp13.md` before writing any freed-rep-time number — **k = 0**.

## Next unit start (WP9·3, picker takes + cached turns)

Start by re-checking `data/calls/`: **if the user has recorded by then, that is the whole job** — run `calls:build`,
label the real takes, review ≤ 4, cache `pc_ctx`, and the stand-ins remove themselves; then send WP13 the real k and
s01's actual line, and run the real `TUNING_8K` check (~$0.05) for WP14a. If there is still no recording, WP9·3 adds
the remaining picker takes the same simulated way (s05 and one **declined** call — `customer_response` ≠ accepts,
which exercises the declined branch nothing covers today) at ≈$0.033 per take, and leaves `TUNING_8K` alone.

---

# WP9·3 (D1 18:30–21:30): picker takes, `pc_ctx` cache, cached turns — **still no recording; the declined take added**

## Done

- **Re-checked `data/calls/` first, as WP9·2 instructed.** The main checkout still holds `README.md` and nothing
  else: **no real takes**. So the whole-job-in-one-run path (label real takes, real `TUNING_8K`, real k for WP13)
  did not open, and the simulated fallback ran again for one more scenario.
- **s03 generated: the declined hand-off.** `s03_sim_20260925T110000Z`, 154.5 s, 21 turns, 2 ch / 8 kHz, built the
  same way as s01/s02 (gpt-6-luna script → forced hand-off wording → `cedar`/`marin` TTS → kit format). It is the
  only take in which the customer **refuses** the assistant and the rep finishes the tail himself, so
  `handoff.declined = true` and `acceptStartMs = null`.
- **`pc_ctx` STT cache + cached turns for it**, via `aai-open.ts`: 246 messages, 43 finals, 27 `agent_context`
  updates, 314.0 s billed → `data/cache/stt/s03_sim_20260925T110000Z/pc_ctx.jsonl`, and
  `public/data/cached-turns/s03_sim_20260925T110000Z.json` (rep 114 turns, customer 83) for cached replay.
  s01 and s02 were already cached and were skipped by the resumable runner — no re-spend.
- **`calls:build` clean, `--check` 0 stale.** 22 scenarios, 3 sidecars → 3 usable, 3 published, **0 in eval**,
  featured still `s01_sim_…`; picker `main` = s01, s02, `more` = s03. Provenance covers all three.
- **Request filed:** `wp9-to-wp14a.md` section 3 — the declined fixture plus a measured trap (below) that would
  make auto-baton accept a call the customer declined.

## Decisions

- **s03, not s14 or s17, for the declined call.** All three decline, but s14 and s17 decline *through* background
  noise, interruptions and a second voice — none of which TTS produces. Simulating them would put the hardest
  acoustic cases in the picker as clean studio speech, which misrepresents them. s03 declines in a quiet room, so
  the simulation only has to carry the words, which is the part it can carry honestly.
- **s05 deliberately not generated.** Two reasons, and the second is the real one:
  1. Budget: the OpenAI grant carried over from WP9·2 had ≈$0.083 left and s03 used $0.0458, leaving ≈$0.0375
     against a ≈$0.048 pre-flight estimate. It would not fit without widening a budget nobody widened.
  2. **It would not do its job anyway.** s05's whole point is that *the rep never asks the license state* — an
     extraction-gap case, i.e. an **eval** case. Every simulated take is `inEval: false` by construction (§7.6 /
     JP-I3), so a generated s05 could never be counted for the thing s05 exists to measure. It would be a third
     accepting take in the picker and nothing more. s05 is worth ≈$0.048 **as a recording** and ≈$0 as a
     simulation; it stays on the recording list.

  So the picker ships 3 takes (s01 featured + s02 + s03), inside TASKS-v2's "≤ 3 picker takes".
- **`TUNING_8K` still not run**, for the WP9·2 reason unchanged: generated speech has no breaths, no overlap and
  machine-even pacing, so an end-of-turn grid over it would look like evidence and be worse than none. Stays
  provisional at 160/1000; today's caches match the current params, so they are not STALE.
- **The declined take gets tests, not just data.** A fixture that only sits in `public/` is a fixture nobody
  notices breaking, so the ordering it proves is pinned in `tests/` (below).

## [VERIFY] results

| check | result |
|---|---|
| Real takes present? | **No**, third check. `data/calls/` = `README.md` only. Fallback path again |
| `calls:build --check` | clean: 22 scenarios, 3 sidecars → 3 usable, 3 published, **0 in eval**, featured `s01_sim_…` (SIMULATED), **0 stale files** |
| Acceptance 2 (one featured, publishable, with assets) | pass — still exactly one (s01), unchanged by this unit |
| Acceptance 3 (cached turns for every picker call; s01 `decisionPointMs`) | pass — all 3 calls have cached turns; s01 `decisionPointMs` 124808 |
| Acceptance 4 (`scenarioId` → `policyToAccount`) | pass — ran all three: s01 NBM-4418207 $96→$142, s02 BSC-2290316 $118→$171, **s03 SRI-7730158 $131→$188, $18.40 due**; all valid `AccountRecord`s, and s03's numbers are the ones actually spoken in the audio |
| Declined branch | `handoff.declined = true`, `acceptStartMs`/`acceptEndMs` `null`, `tailStartsMs` = `lineEndMs` = 117336 |
| Hand-off labels vs live STT | label 112502–117336; the rep line's STT words span 111488–117525 and the final lands at 118000 (~0.7 s after), matching the s01/s02 lag |
| Live STT wording | `OK` → **`Okay,`** and `?` → `,` again, as in WP9·2. Both `repLinePatterns` match the s03 rep line |
| Decline vs acceptance patterns | `"I'd rather just finish with you, if that's all right."` matches **neither** rep pattern and **not** the acceptance pattern — correct refusal |
| **Arrival-time trap** | **found and measured** — see below |
| Rule 19 | clean: none of the three banned words in any file this unit touched (scanned the diff) |
| `npm run typecheck` | clean |
| `npm test` | **1678 passed / 127 files**, 0 failed (was 1672 / 126) |

### The trap, because it is the one finding here that can cost a demo

The customer's answer to the *previous* question arrives while the rep's hand-off line is still playing:

| arrival `recvMs` | word span | final |
|---|---|---|
| 112800 | 111392–112351 | `That's fine.` |
| 121800 | 118432–121210 | `I'd rather just finish with you, if that's all right.` |

The rep line is 112502–117336. `That's fine.` **ends 151 ms before the line starts** but **arrives 298 ms after**,
and it matches the acceptance pattern. An acceptance matcher that opens its window on the rep line and then tests
customer finals **by arrival time** reads it as consent and hands off a call the customer **declined**. Matching by
**word end timestamp** is correct. Filed to WP14a as `wp9-to-wp14a.md` section 3; pinned by a test here so it
cannot regress quietly.

## Tests

- `tests/unit/core/scenario/declined-handoff.test.ts` (new, 4 cases): the declined take and its STT cache exist;
  the first customer final whose *speech* starts after the rep line is a refusal, not an acceptance; **matching by
  arrival time would false-accept** (asserts a stale-but-arrived-late final exists, that it matches the acceptance
  pattern, and that the word-timestamp rule skips it) — if that gap ever disappears the test fails loudly rather
  than silently stopping guarding; labels carry no acceptance, `tailStartsMs` = `lineEndMs`, `reviewed: false`.
- `tests/unit/core/scenario/generated.test.ts` (+2 cases): every take's `handoff.declined` agrees with its
  scenario's `customer_response`, with acceptance labels present iff accepted; and the picker covers **both**
  outcomes (at least one accepted and one declined take).

## Live spend (WP9·3)

| provider | action | n | actual |
|---|---|---|---|
| openai | `wp9_sim_take` (s03: script $0.0022 + TTS $0.0436, reserved and settled) | 1 | **$0.0458** |
| aai_stt | `wp9_cache_stt_pc_ctx` (s03, 2 channels, via `aai-open.ts`) | 1 | **$0.0393** |

**Against budget:** AssemblyAI ≤ $0.40 for this unit → used **$0.0393**, ≈$0.36 unused. OpenAI: the unit brief
named no OpenAI figure, so I spent inside the ≈$0.083 left from WP9·2's $0.15 grant and stopped there; ≈$0.0375
remains. Zerops stayed read-only; nothing else was called.

**One number the integrator should see:** WP9's TASKS-v2 section 7 line is **OpenAI $0.05**, and WP9 has now spent
**$0.1125** of OpenAI across ·2 and ·3 (both units' briefs allowed it; the section 7 table was written before the
no-recording fallback existed, when WP9 had no generation step at all). AssemblyAI is the opposite — **$0.1038 of
$1.00**, because there are no real takes to transcribe. Net across both providers WP9 is ≈$0.83 **under** its
combined line. Flagging it so the table can be reconciled rather than discovered.

**Ledger note:** this worktree's `spend_ledger` was empty at unit start (the `baton_wp9` database has been
recreated since WP9·2), so the ·2 figures above come from these notes, not from a query. The ·3 rows were reserved
and settled normally and are in the table now. The ledger is per-worktree and is not a durable cross-unit record;
these notes are.

## Integrator actions

1. **Unchanged and still open from WP9·2:** add `"calls:sim"` to root `package.json` (`wp9-to-integrator.md` item
   4); the provenance strip must say the takes are generated (item 7) — **shipping any of these three under
   "✓ Verified from recording" would be a false claim**, and that now covers s03 too.
2. **WP14a: read `wp9-to-wp14a.md` section 3 before wiring the acceptance matcher.** Section 2's AND-vs-OR question
   is still open; section 3's arrival-time trap is new and is a correctness bug waiting to happen, not a preference.
3. `public/calls/` and `public/data/cached-turns/` each gained one entry (s03); `data/cache/stt/` gained one tree.
4. **WP13: k is still 0.** No recorded take exists; nothing in `calls.json` supports a freed-rep-time number, and
   s03 in particular must not be read as evidence that customers decline at any rate.

## Next unit start (WP9·4, if there is one)

Check `data/calls/` again first — the answer has been "no" three times, and the moment it is "yes" the simulated
stand-ins remove themselves on the next `calls:build` with no cleanup step. If real takes exist: `calls:build`,
label them, the user reviews ≤ 4 (≈10 min), `pc_ctx` cache (≈$0.03/take), the real `TUNING_8K` check (~$0.05) to
WP14a, and the real k + s01's actual hand-off line to WP13 — that is the whole job and it retires this fallback.
If still none: **stop adding simulated takes.** Three is enough to carry the flagship path and the picker, and a
fourth buys picker filler at the price of more generated audio to caption honestly. Spend the time on the WP14a
acceptance-matcher fix instead.
