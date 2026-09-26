# WP9 → integrator

1. **npm scripts** (root `package.json` is not WP9's). Please add:
   ```json
   "eval:label": "tsx --conditions=react-server scripts/eval/label-ground-truth.ts",
   "eval:review-labels": "tsx --conditions=react-server scripts/eval/review-labels.ts",
   "eval:verify-cache": "tsx --conditions=react-server scripts/eval/verify-cache.ts",
   "calls:synthetic": "tsx scripts/calls/synthetic-take.ts"
   ```
   `calls:build`, `eval:cache-stt` and `eval:extract` already exist and point at the WP9 files.

2. **Registering the manifest (G1 wiring from wp2/wp3 notes).** `src/generated/calls.json` and `scenarios.json` now
   exist (JSON arrays, `CallManifestEntry[]` / `Scenario[]`). `calls.json` is `[]` until the first real takes are
   built; `src/generated/call-scenarios.json` (callId → per-take `Scenario`) is new and additive.

3. **Private transcripts in git (decision needed).** `data/labels/*.json`, `data/labels/*.auto.json`,
   `data/cache/asr/*.json` and `data/cache/stt/**` hold the words of every kept take, including takes whose consent is
   not `public` (audio is never published for those). If that should stay local, add to `.gitignore`:
   ```
   data/cache/asr/
   ```
   and decide whether caches/labels of non-publishable takes are committed (WP9b's sweep needs them on whatever
   machine runs it; the deployed app only needs published takes' caches).

## Added by WP9·2 (D1, simulated takes)

4. **One more npm script** (same reason as item 1):
   ```json
   "calls:sim": "tsx --conditions=react-server scripts/calls/sim-take.ts"
   ```
   It generates the simulated stand-in takes. It is inert without `RUN_LIVE=1` and costs ≈$0.033 per take.

5. **`calls.json` is no longer empty — and today it is simulated.** `src/generated/calls.json` holds two generated
   stand-in takes (featured `s01_sim_…`, plus `s02_sim_…`), so the Baton flagship path, Express and the picker all
   work before the recording session. They are labelled everywhere: `provenance.kind = "simulated"` in the sidecar,
   `humanHalf: "simulated"` in the new `src/generated/call-provenance.json` (callId → how the take came to exist,
   with the model and voice names for the provenance strip), and `inEval: false` so no recorded metric counts them.
   **Nothing needs to be undone when the takes arrive:** `calls:build` uses a stand-in only for a scenario with no
   usable real take, so recording s01 removes the generated s01 from `calls.json`, `public/calls/` and the picker on
   the next build. A test pins that.

6. **Two more committed output trees** (both were untracked before): `public/data/cached-turns/<callId>.json` (the
   cached replay the app serves) and `data/cache/stt/<callId>/pc_ctx.jsonl` (the live Streaming STT cache). Same
   privacy question as item 3 applies to them for *real* takes; for the simulated takes nobody's voice is involved.

7. **The provenance strip needs a "simulated" state.** Whoever owns the strip (WP11 / WP7) should read
   `call-provenance.json` and say so on the page when `humanHalf === "simulated"` — `detail` is a ready sentence:
   "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people." Shipping a generated take
   under "✓ Verified from recording" without that line would be a false claim to the judges.
