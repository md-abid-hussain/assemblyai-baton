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
