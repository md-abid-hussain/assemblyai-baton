# spikes/ — AssemblyAI + OpenAI spike harness

A small TypeScript harness for throwaway experiments against the AssemblyAI Voice Agent API,
Streaming STT (v3), the LLM Gateway, async transcription, and OpenAI. `lib/` is written to be
lifted into the real product as-is. Everything runs with `tsx`. There is no build step.

- Node 22 (tested on 22.23.2), npm 10, ESM (`"type": "module"`), TypeScript 7 strict.
- Dependencies (latest as of 2026-09-24): `openai@7.23.0`, `assemblyai@4.41.2`, `ws@8.21.3`,
  `dotenv@18.0.3`. Dev dependencies: `tsx@4.23.15`, `typescript@7.0.2`, `@types/ws@8.18.1`, and
  `@types/node@22.20.4`, which is pinned to the Node 22 runtime on purpose (latest is 26.x).

```sh
cd spikes
npm install
npm run typecheck         # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run selftest          # 19 offline checks of lib/ (no network)
npm run validate          # fixture format/duration/level/channel checks (no network)
npm run validate:content  # + transcribes fixtures with gpt-4o-transcribe (~$0.01)
npm run fixtures          # regenerate fixtures (TTS is cached; re-runs are free)
npm run models            # GET /v1/models on OpenAI -> out/openai-models.jsonl
```

Run a single spike with `npx tsx path/to/spike.ts`.

## Ground rules

- **Secrets.** Keys come only from `../.env`, loaded by `lib/env.ts`. Never print them. Use `mask()`
  or `envSummary()`. The logger scrubs every registered key value, `?token=` query parameters and
  sensitive JSON keys. `.env` is read, never written.
- **Cost.**
  - Voice Agent tokens: `max_session_duration_seconds <= 180`. Always send `session.end` before closing.
  - Streaming STT: always send `{"type":"Terminate"}` and wait for `Termination`.
  - Delete any stored agents or webhooks a spike creates.
- **Logging.** One JSONL file per test in `out/<test>.jsonl`. Audio payloads are logged as
  `{"bytes": n}`, never as base64. Every test ends with `log.result("PASS"|"FAIL"|"PARTIAL"|"SKIPPED", {...})`.
  When a result confirms or contradicts a research claim, cite the ID from `research/00-synthesis.md`
  §7 (C1–C33, T1–T11).
- `out/` and `.cache/` are gitignored (see the root `.gitignore`). `fixtures/` is meant to be committed.

## Layout

```
spikes/
  lib/
    env.ts     secrets + paths
    wav.ts     WAV read/write (PCM16 mono/stereo; mu-law WAV read)
    audio.ts   resample, channels, mu-law, chunking, real-time pacer, silence, levels, trim
    log.ts     JSONL logger with audio/secret redaction, loggedFetch
    tts.ts     OpenAI TTS -> PCM16 24 kHz, disk-cached
  scripts/
    gen-fixtures.ts            build all fixtures (OpenAI TTS)
    validate-fixtures.ts       validate fixtures; --transcribe adds a content check
    selftest-lib.ts            offline unit checks for lib/
    list-openai-models.ts      GET https://api.openai.com/v1/models
    probe-codeswitch-digits.ts cross-transcribe a fixture's digits (3 OpenAI STT variants)
  fixtures/    committed test audio + ground-truth scripts
  out/         JSONL logs + fixtures-validation.json (gitignored)
  .cache/tts/  raw TTS PCM keyed by request hash (gitignored)
```

## lib API

Import with the `.ts` extension, for example `import { pace } from "../lib/audio.ts"`. The project
uses `allowImportingTsExtensions` and `verbatimModuleSyntax`.

### `lib/env.ts`

Importing this module is a side effect. It reads `C:/Users/abid1/Desktop/assembly-ai/.env` with
`dotenv.parse`. Values from `.env` override the shell environment, and inline `# comments` are
stripped. It then asserts that `ASSEMBLYAI_API_KEY` and `OPENAI_API_KEY` exist, contain no
whitespace, and are at least 16 characters long. The check throws without printing the value.
Finally it registers the keys with the logger's scrubber.

| Export | Notes |
|---|---|
| `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY` | `string`, asserted |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | `string \| undefined` (optional) |
| `keys` | frozen `{ assemblyai, openai }`. `JSON.stringify` and `console.log` print masked values |
| `mask(v)` | `"sk-...cA(164)"` style: first 3 chars, last 2 chars, length |
| `envSummary()` | safe-to-print `{ NAME: masked \| "<set>" \| "<empty>" }` |
| `scrubSecrets(text)`, `secretValues()` | mask any loaded secret found in a string |
| `PROJECT_ROOT`, `SPIKES_ROOT`, `OUT_DIR`, `FIXTURES_DIR`, `ENV_PATH` | absolute paths |

### `lib/wav.ts`

| Export | Notes |
|---|---|
| `readWav(path)` / `decodeWav(bytes)` → `WavData` | `{ sampleRate, channels, bitsPerSample: 16, formatTag, samples: Int16Array (interleaved), frames, durationMs }` |
| `writeWav(path, samples, sampleRate, channels = 1)` | 44-byte header PCM16. Creates parent directories |
| `encodeWav(samples, sampleRate, channels = 1)` → `Buffer` | in-memory WAV, for example for multipart uploads |

`decodeWav` handles the following:

- Format tag 1 (PCM) and 0xFFFE (extensible) with a PCM16 subformat.
- Format tag 7 (8-bit mu-law WAV), which it decodes to PCM16.
- Streaming-style headers whose sizes are 0 or 0xFFFFFFFF.
- Odd chunk padding.

### `lib/audio.ts`

PCM16 is an `Int16Array`. Multichannel audio is interleaved (`L R L R …`). The wire format is
little-endian bytes. Durations are audio milliseconds unless stated otherwise.

| Group | Exports |
|---|---|
| bytes/samples | `pcm16ToBytes(Int16Array) → Buffer`, `bytesToPcm16(Uint8Array) → Int16Array` (copy, safe at any offset), `pcm16ToBase64`, `base64ToPcm16`, `float32ToPcm16`, `pcm16ToFloat32` |
| durations | `msToFrames(ms, rate)`, `framesToMs(frames, rate)`, `durationMs(samples, rate, ch = 1)`, `bytesPerMs(rate, bytesPerSample = 2, ch = 1)` |
| resample | `resampleLinear(mono, fromRate, toRate, { antiAlias = true })`: linear interpolation. When downsampling it first applies a 63-tap Blackman-windowed-sinc low-pass at 0.45 × the target rate. `resampleInterleaved(samples, ch, from, to)`, `lowpassFir(mono, rate, cutoffHz, taps = 63)` |
| channels | `interleave(...monoChannels)` (zero-pads to the longest), `deinterleave(samples, ch) → Int16Array[]`, `downmixToMono(samples, ch)`, `concatPcm16(parts)` |
| mu-law (G.711) | `mulawEncode(Int16Array) → Uint8Array`, `mulawDecode(Uint8Array) → Int16Array`, `mulawEncodeSample`, `mulawDecodeSample`, `MULAW_SILENCE = 0xFF` |
| silence | `silencePcm16(ms, rate, ch = 1)`, `silenceMulaw(ms, rate = 8000)`, `silenceChunks(chunkMs, rate, { encoding: "pcm16" \| "mulaw", channels, totalMs })`: a generator of wire chunks |
| chunking | `chunkPcm16(samples, rate, chunkMs, ch = 1, { padLast, dropLast })` (subarray views), `chunkBytes(bytes, rate, chunkMs, bytesPerSample = 2, ch = 1, opts)` |
| pacing | `pace(iterable, durationMs \| (chunk) => ms, opts)` and `paceAudio(bytes, { sampleRate, chunkMs = 50, bytesPerSample = 2, channels = 1, ...opts })`. Both are async generators that yield `{ data, index, audioOffsetMs, durationMs, wallMs, lateMs }` |
| levels / trim | `rmsDbfs`, `peakDbfs`, `trimSilence(mono, rate, { thresholdDb = -45, windowMs = 10, padMs = 40 }) → { samples, start, end }` |

Pacer semantics:

- The schedule is absolute (`t0 + cumulative audio ms / speed`), so timer jitter does not accumulate.
- `release: "end"` is the default. It releases a chunk only once that much audio could have been
  recorded, which makes it mic-like and never ahead of the wall clock. Use this for the Voice Agent,
  which drops audio sent faster than real time and raises `audio_rate_violation` (synthesis §2.3).
- `release: "start"` releases each chunk at the start of its slot, one chunk ahead.
- `speed` sets a multiple of real time. Streaming STT throttles above 1.25× (§2.3).
- `resyncAfterLateMs` (default 250) re-anchors the clock after a stall instead of bursting.
- `signal` aborts the generator.

Usage recipes (formats taken from research synthesis §1.1 and §2.3; the harness does not verify them):

```ts
// Voice Agent: PCM16 24 kHz mono, base64 in JSON, ~50 ms, real time
for await (const c of paceAudio(pcm16ToBytes(pcm24k), { sampleRate: 24000, chunkMs: 50 }))
  ws.send(JSON.stringify({ type: "input.audio", audio: Buffer.from(c.data).toString("base64") }));

// Streaming STT v3: binary PCM16 16 kHz frames, 50–1000 ms each (<50 ms -> close 3007)
const { samples } = readWav(".../question_16k.wav");
for await (const c of paceAudio(pcm16ToBytes(samples), { sampleRate: 16000, chunkMs: 50 }))
  ws.send(c.data);
ws.send(JSON.stringify({ type: "Terminate" }));

// Twilio-style mu-law 8 kHz, 20 ms = 160 bytes
paceAudio(readFileSync(".../question_8k.mulaw"), { sampleRate: 8000, bytesPerSample: 1, chunkMs: 20 });
```

The Voice Agent event shape `{"type":"input.audio","audio":"<base64>"}` above comes from research
note 01 §6.1 and §7. Confirm it in the Voice Agent spike.

### `lib/log.ts`

| Export | Notes |
|---|---|
| `createLogger(test, { dir, append, echo, maxString = 4000, maxArray = 500 })` → `JsonlLogger` | writes to `out/<test>.jsonl`. Truncates the file unless `append` is set |
| `log.in(evt)` / `log.out(evt)` | server→client and client→server events. `evt.type` is lifted to the top level |
| `log.ws(dir, raw, isBinary)` | pass a `ws` "message" payload straight in. JSON text is parsed and returned, binary is logged as `{binary, bytes}` |
| `log.note(msg, data?)`, `log.error(err)`, `log.event(dir, data, extra?)` | |
| `log.result(status, details)` | the final verdict line |
| `log.tally(key, bytes)` / `flushTallies()` | count high-volume audio frames without writing one line per frame. `close()` flushes |
| `log.elapsed()` | ms since the logger was created |
| `loggedFetch(log, url, init & { label })` → `{ status, ok, ms, headers, json, text }` | logs the redacted request and response with timing |
| `redact(value)`, `registerSecrets(...v)`, `maskValue(v)`, `base64ByteLength(b64)` | |

Every line has the shape `{"t": ISO, "ms": sinceStart, "dir": "in"|"out"|"note"|"error"|"http"|"result", "type"?, "data": …}`.

Redaction rules:

- Buffers, typed arrays and ArrayBuffers become `{bytes}`.
- Base64 strings of 16 characters or more under the keys `audio`, `data`, `delta`, `chunk`,
  `payload`, `audio_data`, `audio_base64`, `b64`, `pcm` or `bytes_b64` become `{bytes}`. This covers
  Twilio `media.payload`.
- Any base64-looking string of 512 characters or more becomes `{bytes, b64: true}`.
- Values under `authorization`, `token`, `api_key`, `temp_token` and similar keys are masked.
- `?token=` / `?key=` URL parameters and any registered secret value are masked wherever they appear.

### `lib/tts.ts`

`ttsPcm24k({ input, voice, model?, instructions?, speed? }, log?)` returns
`{ samples, sampleRate: 24000, bytes, durationMs, cached, ms, requestId? }`.

- It calls `POST /v1/audio/speech` with `response_format: "pcm"`.
- The default model is `gpt-4o-mini-tts-2025-12-15`.
- Results are cached in `.cache/tts/<sha256(request)[:16]>.pcm`, so a repeat request costs nothing.
- It exports `TTS_SAMPLE_RATE = 24000`, `DEFAULT_TTS_MODEL` and `TTS_CACHE_DIR`.

## Fixtures

The validator (`npm run validate`) checks sample rate, channel count, format tag, duration range,
RMS (not silent), clipping, and 16 vs 24 kHz duration parity. For the dialog it also checks that
each turn has a silent opposite channel, that mono equals the speaker's channel, that the gaps are
250 ms of digital silence, and that the script timing matches the audio. Every fixture last passed
on 2026-09-24, including the `--transcribe` content check.

| File | Format | Rate | Ch | Duration | Bytes | Content |
|---|---|---|---|---|---|---|
| `fixtures/question_24k.wav` | WAV PCM16 | 24000 | 1 | 7.300 s | 350,444 | customer question (voice `marin`) |
| `fixtures/question_16k.wav` | WAV PCM16 | 16000 | 1 | 7.300 s | 233,644 | same, resampled (anti-aliased linear) |
| `fixtures/question_8k.mulaw` | **raw** G.711 mu-law, no header | 8000 | 1 | 7.300 s | 58,400 | same, 8 kHz mu-law (Twilio format) |
| `fixtures/dialog_mono_16k.wav` | WAV PCM16 | 16000 | 1 | 69.130 s | 2,212,204 | 16-turn insurance claim call, turns in sequence with 250 ms gaps |
| `fixtures/dialog_stereo_16k.wav` | WAV PCM16 | 16000 | 2 | 69.130 s | 4,424,364 | same timeline. **L = adjuster, R = claimant**, digital silence on the other channel |
| `fixtures/dialog_script.json` | JSON | | | | | `turns[]` (`index, speaker, name, voice, channel, text, start_ms, end_ms, tts_raw_ms`) + `facts` ground truth |
| `fixtures/codeswitch_16k.wav` | WAV PCM16 | 16000 | 1 | 12.010 s | 384,364 | Hinglish utterance (voice `coral`), v2 |
| `fixtures/codeswitch_script.json` | JSON | | | | | romanized transcript, spoken digits, TTS input/voice/instructions |

All audio comes from OpenAI `gpt-4o-mini-tts-2025-12-15`, `response_format: "pcm"` (24 kHz s16le
mono; the response has `content-type: audio/pcm`). Dialog clips were trimmed below −50 dBFS with
20 ms padding, and the codeswitch clip with 60 ms padding. Peaks are −3.5 to −10.7 dBFS and no
fixture has clipped samples.

**question.** The text is *"Hi, I'm calling about my order. The order number is 4 8 1 5 2 9, and it
still hasn't arrived."* Ground truth: order number `481529`.

**dialog.** Adjuster Daniel Reyes (voice `cedar`, left channel) and claimant Priya Shah (voice
`marin`, right channel). The ground truth in `dialog_script.json` `facts`:

- people: Daniel Reyes, Priya Shah, Mark Donnelly
- organizations: Harbor Point, Lakeside Auto Body
- policy number: `HP7740391`
- claim number: `CL44812`
- accident: Tuesday, September 15th, at 1420 Maple Avenue, Springfield
- mailing address: 88 Birchwood Lane, Springfield
- phone: 415-555-0137
- amounts: repair $3,450, tow $125, deductible $500
- appraiser callback: Friday at 10 a.m.
- **Self-contradiction:** accident time "around 5 p.m." (turn 3, 13.44–21.66 s) versus "around 7 p.m."
  (turn 9, 42.04–46.02 s). The adjuster does not flag it.

**codeswitch.** Romanized ground truth: *"Mera order abhi tak nahi aaya, can you please check the status?
Order number hai 4 8 1 5 2 9. Aur haan, delivery kal tak ho jayegi kya?"* The TTS input puts the Hindi
words in Devanagari and the English words in Latin script, and spells the digits as English words.
Ground truth: order `481529`. Languages: `hi`, `en`.

### Content check (`--transcribe`, gpt-4o-transcribe, 2026-09-24)

| Fixture | Transcript (excerpt) | Result |
|---|---|---|
| question_16k | "…The order number is 481529, and it still hasn't arrived." | OK |
| question_8k.mulaw (decoded) | same as question_16k | OK: the mu-law path is intelligible |
| codeswitch_16k | "मेरा order अभी तक नहीं आया। Can you please check the status? Order number है 481529. और हाँ, delivery कल तक हो जाएगी क्या?" | OK. whisper-1 also returns 481529 |
| dialog_mono_16k | all 14 expected entities present (names, policy number, date, 5 PM and 7 PM, address, $3,450/$125/$500, phone, claim number, 10 AM) | OK. Some transcribers hear "Shah" as "Shaw" |

## Findings from setting up the harness

- **Confirmed** (research 09 §7 and synthesis §2.9): the OpenAI TTS model is `gpt-4o-mini-tts`, with
  snapshots `-2025-12-15` and `-2025-03-20`. `GET /v1/models` on 2026-09-24 also lists `tts-1` and
  `tts-1-hd`. `response_format: "pcm"` returns headerless 24 kHz 16-bit LE mono, and every response
  had an even byte count. The voices `marin`, `cedar` and `coral` work with
  `gpt-4o-mini-tts-2025-12-15`. The harness does not exercise any C#/T# item from synthesis §7.
- **Gotcha: codeswitch v1 was regenerated.** Putting the ASCII digits "4 8 1 5 2 9" inside a mostly
  Devanagari TTS input made the model speak some digits in Hindi ("ek", "paanch", "do"). The third
  digit came out ambiguous between "ek" and "eight":
  - gpt-4o-transcribe, gpt-audio-1.5 and gpt-audio-mini heard `488529`.
  - whisper-1 heard `481529`.
  - gpt-4o-mini-transcribe heard "फोर एट एक पाँच दो नाइन".

  v2 spells the digits as English words. gpt-4o-transcribe (with and without `language=en`) and
  whisper-1 now all return `481529`.
  Evidence is in `out/probe-codeswitch_16k-v1.jsonl`, and the v1 audio is kept at
  `.cache/codeswitch_16k.v1.wav`. For the product: when a TTS voice reads IDs in a
  non-English sentence, spell the digits out.
- The question and dialog audio were **not** regenerated. On the 2026-09-24 rebuild from the TTS
  cache their files were byte-identical, and only `dialog_script.json` `generated_at` changed.
- The dialog lasts 69.1 s, at the top of the 50–70 s target. It has no crosstalk or overlap, so
  diarization tests on it are an easy case.

## Scripts and logs

| Script | Output |
|---|---|
| `scripts/gen-fixtures.ts [question\|dialog\|codeswitch]` | fixtures + `out/gen-fixtures.jsonl`. Logs each TTS request body with a cache hit or a response (status, ms, bytes, request id) |
| `scripts/validate-fixtures.ts [--transcribe]` | offline: `out/validate-fixtures.jsonl`, `out/fixtures-validation.json`. With `--transcribe`: `out/validate-fixtures-content.jsonl`, `out/fixtures-validation-content.json`. Exits 1 on any problem |
| `scripts/selftest-lib.ts` | 19 checks (WAV round-trip, mu-law known values and SNR, resample and anti-alias, chunking, pacer timing, redaction, masking) + `out/selftest-log.jsonl` |
| `scripts/list-openai-models.ts` | `out/openai-models.jsonl` (134 models on 2026-09-24, 31 matching the audio filter) |
| `scripts/probe-codeswitch-digits.ts [file]` | `out/probe-<file>.jsonl`. Cross-checks the spoken digits with gpt-4o-transcribe and whisper-1 word timestamps |
