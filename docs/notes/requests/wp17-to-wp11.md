# WP17 → WP11 (customer input): `src/server/openai/tts.ts` and the sim AI-half clips

From WP17·1 (branch `wp/wp17`). `/api/tts` stays cut; `tts.ts` is now WP17's (TASKS-v2 §4.1).

## 1. TTS for your scripts and server code

- **Server:** `getTtsService()` from `@/server/sim/defaults`: pinned `gpt-4o-mini-tts-2025-12-15`, pcm 24 kHz, cached in
  `tts_cache`, ledger reserve → settle from the character count (env `BATON_DEPLOY_ID`). It fails closed without a ledger.
- **Scripts** (e.g. `scripts/tts/**`): build your own instance:
  ```ts
  new TtsService({ openai: () => createOpenAI(key), cache: new FsTtsCache(dir), ledger: () => getLimitsAuthority().ledger, env: () => "dev-wp11" })
  ```
  `FsTtsCache` is in `scripts/sim/lib/fs-tts-cache.ts` (import it, or copy the ~35 lines into `scripts/tts/`).
- `synth({ text, voice, instructions, refId })` → `{ hash, pcm24k, durationMs, cached, usd }`; `synthMany(reqs, 3)`.
- Voices: **`marin` and `cedar` only**. ≤ 600 chars per line. Throws `BatonError` (`E_BUDGET`, `E_OPENAI_TIMEOUT`,
  `E_OPENAI_RATE`, `E_BAD_REQUEST`, `E_INTERNAL`).
- For customer clips use `CUSTOMER_INSTRUCTIONS` (`@/server/sim/voices`) with `marin`: the same text then hashes to the
  same clip everywhere (the shared clips in `SHARED_CUSTOMER_CLIPS` are generated once, globally).

## 2. The AI-half clips of a sim (autopilot, PLATFORM §7.5 step 5)

`SimCallResolution.aiClips` (from `CallCatalog`/`resolveCall`) is keyed by suggestion kind:
`confirm` (always "Yes, that's right."), `consent`, `close`, and `answer:<field>` per `ai_half_answers` entry.
Each is `{ hash, text, durationMs, url }`; `url` serves **raw PCM16 LE mono at 24 kHz** (DB sims:
`/api/sim-calls/<id>/clip.<sha256>.pcm`; gallery sims: a static file under `public/calls/sim-<slug>/`, WP17·2). Feed
it to the VA feeder at 24 kHz as-is.
