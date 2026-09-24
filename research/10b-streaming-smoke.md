# 10b: AssemblyAI Streaming STT v3 smoke tests (live, 2026-09-24)

All results come from the live `wss://streaming.assemblyai.com/v3/ws` API on this project's account. Nothing is copied from the docs.

- **Code:** `spikes/streaming/`. The reusable module is `client.ts`, with `browser-capture.ts` beside it.
- **Raw logs:** `spikes/out/streaming-<test>[-<case>].jsonl`. Every server event is logged verbatim. Audio is logged as byte tallies, keys and tokens are masked.
- **Per-test summaries:** `spikes/out/streaming-<test>.summary.json`.

Citations use the IDs from `00-synthesis.md` §7: C# for contradictions, T# for tests.

| | |
|---|---|
| Sessions opened | 53 reached `Begin`. Another 14 were rejected before `Begin`. |
| Billed | **870 session-seconds (14.5 min)**, about **$0.11** at the $0.45/h U3.5 Pro base rate. Add-ons (diarization, PII, prompt) are extra but negligible. |
| Clean shutdown | Every session was closed. 45 ended with `Terminate` → `Termination`. The other 8 were closed by the server with an `Error` (each billed 5 s or less, and none sent a `Termination`). |
| Artifacts | No stored agents, webhooks or tokens remain. Streaming creates no server-side objects. |
| Re-run | From `spikes/`: `npx tsx streaming/smoke.ts <test…>`, `npx tsx streaming/selftest.ts` (offline, 10 checks) and `npx tsx streaming/e2e-client.ts` |
| Type-check | `npx tsc --noEmit -p streaming/tsconfig.json` passes. It uses a separate tsconfig so the shared root config is left alone. |

The fixtures are the harness set (see `spikes/README.md`):

- `dialog_mono_16k.wav`: a 69.13 s insurance-claim call with 16 turns, 250 ms gaps and 21 ground-truth entities.
- `dialog_stereo_16k.wav`: the same call split into L = adjuster, R = claimant.
- `question_16k.wav`, `question_24k.wav` and `question_8k.mulaw`: 7.3 s each, order number `481529`.
- `codeswitch_16k.wav`: a 12 s Hinglish clip, order number `481529`.

Audio was paced at real time in 50 ms binary frames. Each frame was released only once its audio "existed", the way a mic delivers it. Unless a test says otherwise, `wallMs` is measured from the first audio frame.

---

## 0. Top findings

1. **C1 resolved: `universal-3-5-pro` is the model ID. `universal-3-5-pro-realtime` is rejected.** The rejection is an `Error` 3006 whose text lists the server's real enum of **11 IDs**. Among them: `u3-rt-pro` still works today, `universal-3-6` / `universal-3-6-pro` work but are undocumented, and `universal-3-7-preview` / `u3-rt-agent` accept `Begin` and then die with 3005.
2. **Temporary tokens are not single-use.** One 60 s token opened **3 sessions in sequence and 2 at the same time** (verified with distinct session IDs). The limit that actually applies is the redemption window: after it, the server returns `1008 "Signature has expired"`. Mint per connect with a **short** `expires_in_seconds` and always set `max_session_duration_seconds`. The cap shows up in `Begin.expires_at`.
3. **The WebSocket rejects `Authorization: Bearer <key>`** with `Error 1008 "Invalid API key"`. The token endpoint accepts both Bearer and a raw key. Every auth failure arrives **after** the upgrade as an `Error` frame followed by close 1008, and a browser-like client sees it too (it is not a bare 1006).
4. **Accuracy on clean audio is excellent.** U3.5 Pro scored **0.0% normalized WER** on 138 words, **21/21 entities** (`HP7740391`, `415-555-0137`, `$3,450`, `CL44812`, …) and 481529 in every clip. This held for 16 kHz PCM, 8 kHz mu-law, and 24 kHz audio resampled by our worklet code.
5. **Latency (U3.5 Pro, word-anchored):**
   - A final arrives **about 420 ms after the last word ends** (p50; p90 about 450 ms).
   - `SpeechStarted` and the first partial arrive **together**, 0–1 ms apart:
     - about **1.17 s** after speech onset in `balanced` (the default);
     - about **0.58 s** in `mode=min_latency`, with identical final latency and WER.
   - `ForceEndpoint` returns a final in **267 ms** (p50 over 49 calls).
6. **The last turn only finalizes when audio keeps flowing.** If you stop sending frames (end of file, muted mic), the final waits for `Terminate` or `ForceEndpoint`. Appending 2 s of silence brought the final 324 ms after the last word.
7. **Diarization (`speaker_labels=true`) has two problems.**
   - It cuts finals on a **fixed ~10 s audio grid** and drops the words that straddle a cut. The policy number came out as `HP7740.` with `391` lost.
   - Partials carry no labels.

   Word-level speaker accuracy was 85.4% live and **99.3% after the end-of-session `SpeakerRevision`**. **For two-party calls, run one session per channel instead.** That gave 27/27 finals attributed correctly, finals at a p50 of 356 ms, and all 21 entities, with 4.3% WER.
8. **Word timestamps are padded at turn edges.** After silence, the first word's `start` is reported about **1 s early** (p50 −990 ms) and the last word's `end` about 240 ms late (p50; up to 1.3 s). Audio citations need padding, or should use async word timestamps.
9. **Hinglish needs `language_codes: ["en","hi"]` (English first).**
   - With the default, `["hi"]`, or `["hi","en"]`, the whole utterance, English included, is transliterated into Devanagari, and the digits are spelled out as words (`फोर एट वन…`).
   - With `["en"]` or `["en","hi"]`, English stays in Latin script and the order number comes out as `481529`.
   - A single-element list does **not** make the session monolingual.
10. **Limits are enforced by the server, and they kill the session.**
    - `agent_context` and `prompt` are capped at **1750 chars** (C15 resolved). The limit is also enforced mid-stream: an `UpdateConfiguration` with an oversize value closes the session with 3006.
    - `keyterms_prompt` is capped at **100 items**.
    - `language_codes` is validated against **33 values**, including `ca` (C17).
11. **`Begin.configuration` echoes only 8 fields:** model, mode, api_version, speaker_labels, redact_pii, filter_profanity, domain and voice_focus. Turn, VAD, prompt and keyterm settings, and typos in them, **cannot** be verified from `Begin`. C14 therefore cannot be settled this way.
12. **T11/C28 is blocked by the account.** The LLM Gateway returns HTTP 400 "Your account does not have access to this LLM Gateway model" for all 5 models tried. The in-stream `llm_gateway` param is then **silently ignored**: the session runs normally with no `LLMGatewayResponse`, `Error` or `Warning`.

---

## 1. Results table

| # | Test | Status | Evidence (short) | Cites |
|---|---|---|---|---|
| 1 | Model IDs (`models`, `models2`) | **PASS** | U3.5 Pro, US-English and US-Multilingual accepted; `-realtime` rejected (3006 + enum); 11-ID enum captured | T1, C1, C2 |
| 2 | Auth (`auth`, `auth2`) | **PASS** | raw header OK; Bearer 1008; token OK via the Node 22 built-in WebSocket; token reused 3× sequentially and concurrently; expired → 1008 | C4 (streaming side), §2.2 |
| 3 | Core dialog (`core`) | **PASS** | 0.0% WER, 21/21 entities, 10 finals / 58 partials / 10 SpeechStarted, final p50 418 ms after the last word | C14, §2.3 |
| 4 | Mode latency (`latency-min` vs `core`) | **PASS** | SpeechStarted p50 581 ms vs about 1167 ms; final 417 vs 418 ms | C13, C14 |
| 5 | Diarization (`diarization`) | **PARTIAL** | labels present; 85.4% → 99.3% word accuracy after revision; 10 s cuts lose words; 7/8 turns mix both speakers | 02 §10 |
| 6 | Per-channel stereo (`stereo`) | **PASS** | 27/27 finals on the right speaker, 21/21 entities, 4.3% WER, final p50 356 ms | 02 §10 |
| 7 | PII (`pii`, `pii-hash`) | **PARTIAL** (works; 1 address missed) | 0 partials; `[PERSON_NAME]`, `[PHONE_NUMBER]` and `[LOCATION_ADDRESS]` in transcript, words and utterance; "1420 Maple Avenue" not redacted; default `hash` gives `######` | 02 §4 |
| 8 | Tuning plus mid-stream control (`tuning`) | **PASS** | prompt + keyterms + turn/VAD params accepted together; UpdateConfiguration/KeepAlive silent; ForceEndpoint 272 ms; Heartbeat every ~5.0 s | C14, C15, §5.4 |
| 9 | Begin echo and typos (`modes`) | **PASS** | echo = 8 fields; `speechModel=` typo → default model; other typos invisible | C14 |
| 10 | Limits (`limits`) | **PASS** | 1750-char caps, including mid-stream; 100-keyterm cap; 33 `language_codes` | C15, C17 |
| 11 | In-stream LLM Gateway (`llm`, `llm-stress`) | **SKIPPED (blocked)** | account has no Gateway access; param silently ignored; 0 responses from 58 finals | T11, C28, C10 |
| 12 | Multilingual (`multilingual`, `…2`, `…3`) | **PASS** (with a caveat) | best: `language_codes:["en"]` or `["en","hi"]`; default turns everything into Devanagari; US-Multilingual romanizes Hindi (`hi` unsupported) | C17 |
| 13 | Telephony mu-law (`mulaw`) | **PASS** | `pcm_mulaw`/8000 in 100 ms frames gives a perfect transcript including 481529 | §2.6 |
| 14 | File tail (`tail-silence`) | **PASS** | with 2 s of silence, the last final lands 324 ms after the last word, before Terminate | — |
| 15 | Error cases (`errors`) | **PASS** | 20 ms → 3007; 1200 ms → 3007; bad JSON / type / inactivity / sample rate / encoding → 3006; a 10× burst is accepted | C12 (partly) |
| 16 | E2E product path (`e2e-client.ts`) | **PASS** | `client.ts` only: token, built-in WebSocket, 24 kHz Float32 quanta, worklet downsampler, 176 × 50 ms frames, 481529, Termination | — |

---

## 2. Per-test detail

### 2.1 T1 / C1: model IDs

**Request.** One session per ID, each streaming `question_16k.wav` in 50 ms frames with 2 s tail, then Terminate:

```
wss://streaming.assemblyai.com/v3/ws?speech_model=<ID>&sample_rate=16000&encoding=pcm_s16le    (Authorization: <raw key>)
```

**Observed.**

| `speech_model` | Result | `Begin.configuration.model` / error | First Turn (wall) | Transcript |
|---|---|---|---|---|
| `universal-3-5-pro` | accepted | `universal-3-5-pro`, `mode:"balanced"` | 1194 ms | "Hi, I'm calling about my order. The order number is 481529, and it still hasn't arrived." |
| `universal-3-5-pro-realtime` | **rejected before Begin** | `{"type":"Error","error_code":3006,"error":"User Input Validation Error: Invalid 'speech_model': Input should be 'universal-streaming-english', 'universal-streaming-multilingual', 'whisper-rt', 'u3-rt-pro', 'u3-rt-pro-beta-1', 'u3-rt-agent', 'universal-3-5-pro', 'universal-3-6-pro', 'universal-3-6', 'universal-3-7-preview' or '_universal-3-5-notetaker'"}`, then close **3006** `"See Error message for details"` | — | — |
| `universal-3-pro` | rejected (the same 3006) | — | — | — |
| `universal-streaming-english` | accepted | `mode:null` | 960 ms | "hi i'm calling about my order the order number is 481529 and it still hasn't arrived" (unformatted; `format_turns` defaults to false) |
| `universal-streaming-multilingual` | accepted | `mode:null` | 844 ms | same text; the only final came after Terminate |
| `u3-rt-pro` | **accepted** (2026-09-24) | `u3-rt-pro`, `balanced` | 1093 ms | correct; the only final came after Terminate |
| `universal-3-6-pro` / `universal-3-6` | accepted | echoed as-is, `balanced`; SpeechStarted present | 1183 / 1095 ms | correct |
| `whisper-rt` | accepted | `mode:null`; Turns carry `language_code:"en"` | 3079 ms | "…481 -529…" |
| `universal-3-7-preview`, `u3-rt-agent` | `Begin` OK, then `{"type":"Error","error_code":3005,"error":"Session Cancelled: An error occurred"}` at about 5 s; close 3005; no Termination | | | |

`Begin` verbatim (U3.5 Pro):

```json
{"type":"Begin","id":"12c77068-02b3-4941-a960-275a65230e31","expires_at":1790221526,"configuration":{"model":"universal-3-5-pro","mode":"balanced","api_version":"2025-05-12","speaker_labels":false,"redact_pii":false,"filter_profanity":false,"domain":null,"voice_focus":null}}
```

**Status: PASS.**

**Conclusion.**

- **C1:** use `universal-3-5-pro`. The `-realtime` suffix from note 07 does not exist on the API.
- **C2:** `u3-rt-pro` is still accepted today, but it echoes itself (no alias to 3.5) and it did not finalize the first sentence mid-clip. Never use it.
- Ignore the undocumented 3-6, 3-7 and agent IDs for the hackathon.
- The rejection enum is a reliable discovery tool.
- The SDK type `u3-pro` is **not** in the server enum.

### 2.2 Auth

**Requests and observations.**

| Case | Request | Result |
|---|---|---|
| Raw header | WS + `Authorization: <key>` | `Begin` after 1225 ms; Terminate gives `{"type":"Termination","audio_duration_seconds":0,"session_duration_seconds":1}` |
| Bearer header | WS + `Authorization: Bearer <key>` | `{"type":"Error","error_code":1008,"error":"Unauthorized Connection: Invalid API key"}`, then close **1008** |
| No auth | WS, no header or token | `…"error":"Unauthorized Connection: Missing Authorization header"}`, then close 1008 |
| Bad token (`ws` package **and** Node 22 built-in WebSocket) | `?token=not-a-real-token-123456` | `…"Invalid API key"`, then close 1008. The browser-like client gets the same frame and code, not 1006 |
| Mint | `GET /v3/token?expires_in_seconds=60` + raw key | 200 in 836 ms, `{"token":"<2583 chars>","expires_in_seconds":60}`. The token is an opaque blob beginning `AQI…`, not a JWT |
| Mint with Bearer | same + `Bearer <key>` | **200**, and the token works on the WS |
| Mint with `max_session_duration_seconds=60` | | 200. `Begin.expires_at` is **now + 58 s**; without the cap it is **now + 10798 s** |
| Mint errors | `expires_in_seconds=0`, `=601`, missing; `max_session_duration_seconds=59`; no Authorization | All **HTTP 422**, FastAPI style: `{"detail":[{"type":"greater_than_equal","loc":["query","expires_in_seconds"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}}]}`. A missing header gives `{"detail":[{"type":"missing","loc":["header","authorization"],…}]}` (422, not 401) |
| Token reuse, sequential | the same token on 3 connects within about 6 s (built-in, `ws`, built-in) | **3 Begins, 3 distinct session IDs** (`3f4d90a3…`, `7123664b…`, `bb80a615…`) |
| Token reuse, concurrent | session A open and idle; B connects with the same token 2.5 s later | **B accepted** (`9c92ef04…`) while A (`0647b508…`) was still open |
| Expired token | `expires_in_seconds=1`, connect 3 s later | `{"type":"Error","error_code":1008,"error":"Unauthorized Connection: Signature has expired"}`, close 1008 |

**Status: PASS.**

**Conclusion.**

- Server side: mint with a raw key.
- Browser side: connect with `?token=`.
- Idle sessions bill (A idled 6 s and was billed `session_duration_seconds: 7`).
- Tokens are bearer credentials for the whole window, so the §2.2 "single-use" assumption is wrong. Keep the window short (10–30 s) and cap the session.
- C4 on the streaming side: raw key only on the WS; either form on the token endpoint.

### 2.3 Core: `dialog_mono_16k.wav`, U3.5 Pro defaults

**Request.** `?speech_model=universal-3-5-pro&sample_rate=16000&encoding=pcm_s16le`, 1383 frames of 50 ms (1600 bytes each), real time, 2.5 s tail, then Terminate.

**Observed.**

- **Census:** 1 `Begin`, 10 `SpeechStarted`, 68 `Turn` (58 partials and 10 finals), 1 `Termination`. No `Warning`.
- **Termination:** `{"type":"Termination","audio_duration_seconds":69,"session_duration_seconds":73}`, 1239 ms after Terminate. Close 1000 `"Session Ended"`.
- **Partials:** already formatted (`turn_is_formatted:true`) with `utterance:""`. Example:

  ```json
  {"turn_order":0,"turn_is_formatted":true,"end_of_turn":false,"transcript":"Harbor Point","end_of_turn_confidence":0,"words":[{"start":0,"end":428,"text":"Harbor","confidence":0.921459,"word_is_final":false},{"start":442,"end":799,"text":"Point","confidence":0.997168,"word_is_final":false}],"utterance":"","type":"Turn"}
  ```

- **Final:**

  ```json
  {"turn_order":0,"turn_is_formatted":true,"end_of_turn":true,"transcript":"Harbor Point Claims, Daniel Reyes speaking.","end_of_turn_confidence":1,"words":[{"start":0,"end":472,"text":"Harbor","confidence":0.969633,"word_is_final":true},…],"utterance":"Harbor Point Claims, Daniel Reyes speaking.","type":"Turn"}
  ```

- **`SpeechStarted`:** `{"type":"SpeechStarted","timestamp":0,"confidence":0.959314}`, arriving 0.2 ms before the first partial.
- **Finals, verbatim:** "Harbor Point Claims, Daniel Reyes speaking." / "Your name and policy number, please? Hi." / "It's Priya Shah. Policy number HP7740391. Thanks, Ms. Shah." / "What happened? I was rear-ended on Tuesday, September 15th, around 5 PM, outside 1420 Maple Avenue in Springfield. Was anyone hurt? No, just a sore neck." / "The other driver, Mark Donnelly, was on his phone. Do you have a repair estimate? Lakeside Auto Body quoted $3,450, and the tow was $125. Okay." / "Your deductible is $500. What time did the accident happen?" / "It was around 7 PM; it was already getting dark." / "Got it. What's the best number to reach you? My cell is 415-555-0137. And you are still at 88 Birchwood Lane, Springfield? Yes, that's right." / "Great." / "Your claim number is CL44812. An appraiser will call you Friday at 10 AM. Perfect. Thanks, Daniel."
- **WER:** after normalization (case, punctuation, `H P 7 7…` → `hp77…`, `$3,450` → `3450`, `p.m.` → `pm`): **0.0%** (138 words, 0 S / D / I). **Entities: 21/21.**
- **Timing, word-anchored:**
  - First partial / `SpeechStarted` after the first word's `start`: 1102, 1172, 1165, 1193, 1191, 1182, 1088, 1168, 867, 1167 ms (**p50 about 1167 ms**).
  - Final after the last word's `end`: **p50 418 ms, p90 449 ms**, min 291 ms. The one outlier, 2849 ms, is the last turn, which only finalized on Terminate (see §2.14).
  - The first partial arrived 1102 ms after audio start.
- **Turn segmentation:**
  - Finals end at sentence-final punctuation after a pause of roughly 400 ms or more.
  - The **250 ms speaker-change gaps never ended a turn**, so 8 of 10 finals span 2 to 5 script turns (for example "…please? Hi.").
  - U3.5 Pro turns are **not** speaker turns.

**Status: PASS.**

**Conclusion.** The defaults are production quality for clean audio. Latency figures anchored on script turn boundaries are meaningless because turns merge, so measure from word timestamps. For speaker-separated output see §2.5 and §2.6.

### 2.4 Mode latency (C13, C14)

**Request.** Same as core plus `&mode=min_latency`. A 5-case `Begin`-only run also covered `mode=min_latency`, `balanced` and `max_accuracy`.

**Observed (`min_latency`).**

- Census: 13 `SpeechStarted`, 78 `Turn`, 13 finals.
- `SpeechStarted` lag from its own `timestamp`: **p50 581 ms, p90 683 ms** (n=13).
- Final after the last word: p50 417 ms, p90 450 ms.
- WER 0.0%, 21/21 entities.
- More, shorter finals: "Harbor Point claims." / "Daniel Reyes speaking." / "Your name and policy number, please?" / "Hi." …
- Early partials are rougher ("Harvard" before "Harbor"), but the finals are correct.
- `Begin.configuration.mode` echoes `min_latency`, `balanced` or `max_accuracy`. Nothing else changes in the echo.

**Status: PASS.**

**Conclusion.**

- `min_latency` halves the barge-in signal latency (about 1.17 s → about 0.58 s) at no cost to final latency or accuracy on this audio.
- **C13:** onset-to-signal at `interruption_delay=0` is about 575 ms. That covers the fixed server add (docs say 256 or 300 ms), the 50 ms frame, and enough of the first word to recognize it. The balanced − min_latency delta is about 590 ms, which is 500 ms of `interruption_delay` plus about 90 ms. The precise fixed add is not separable from the outside. Budget about 0.6 s.
- **C14:** the default `min_turn_silence` / `vad_threshold` cannot be read from `Begin`. Set `mode` explicitly.

### 2.5 Diarization

**Request.** Core params plus `&speaker_labels=true&max_speakers=2`.

**Observed.**

- `Begin.configuration.speaker_labels:true`.
- Census: 8 `SpeechStarted`, 29 `Turn` (21 partials and 8 finals), **1 `SpeakerRevision`**, which arrived after Terminate and before Termination.
- **Finals were cut at 10.59, 20.58, 30.67, 40.62, 50.62 and 60.60 s wall.** Their audio spans are 16–9919, 10355–19999 and 20290–29951 ms: a fixed ~10 s grid, cutting mid-phrase ("…outside 1420 Maple" | "Avenue in Springfield."). The words at each cut are lost. The final ends "Policy number HP7740." and the next starts "Thanks,". `391` is gone, so the entities `hp7740391` and `7740391` are missing and WER is 0.7%.
- **Labels:**
  - Finals carry `speaker_label` ("A"/"B") and `speaker_confidence` (for example 0.886574).
  - Every final word carries `speaker` and `speaker_confidence`.
  - **Partials carry no `speaker_label`.**
  - `PENDING` was never seen, and the `speaker` field was never missing.
- A final (truncated):

  ```json
  {"turn_order":1,…,"transcript":"Thanks, Ms. Shah. What happened? I was rear-ended on Tuesday, …, outside 1420 Maple","words":[{"start":10355,"end":11615,"text":"Thanks,","confidence":0.990633,"speaker":"B","speaker_confidence":1,"word_is_final":true},…],"speaker_label":"B","speaker_confidence":0.886574,"type":"Turn"}
  ```

- `SpeakerRevision`: `{"type":"SpeakerRevision","revisions":[{"turn_order":1,"speaker_label":"B","words":[{"start":10355,"end":11615,"text":"Thanks,","confidence":0.796582,"speaker":"A","word_is_final":true},…]},…]}`. It revised 5 turns (1:B, 2:B, 4:A, 5:A, 7:A), and the item keys were `turn_order`, `speaker_label` and `words`.
- **Accuracy vs the script** (word-level, best label mapping A = adjuster, B = claimant): **85.4%** (117/137) live and **99.3%** (136/137) after applying the revision.
- **Turn-level `speaker_label` is meaningless here:** 7 of 8 finals contain both speakers.
- Final after the last word: p50 718 ms, because the cuts are time-driven.

**Status: PARTIAL.** Labels work, but the 10 s cuts drop words.

**Conclusion.** Do not use streaming diarization for entity-critical two-party capture. If you must use it:

- split finals by word-level `speaker`, not by turn;
- apply the `SpeakerRevision` at the end;
- expect lost words at 10 s boundaries.

### 2.6 Per-channel stereo (the recommended alternative)

**Request.** Two concurrent sessions with core params. The left channel (adjuster) goes to one session, the right channel (claimant) to the other, both paced in real time.

**Observed.**

- Left: 13 `SpeechStarted`, 53 `Turn`, billed 72 s. Right: 14 `SpeechStarted`, 72 `Turn`, billed 73 s.
- Merged by time: **27 finals, all 27 inside their own speaker's script turns, all 16 script turns covered, 21/21 entities.**
- WER 4.3% (1 substitution, 3 deletions, 2 insertions). Examples of the errors and fragmentation:
  - "Ms. Shaw" instead of "Ms. Shah";
  - "No, just a sore neck." became "No?" + "a sore neck." (the word "just" was lost);
  - "Thanks, Daniel." was split into two finals, "Thanks." + "Daniel.".
- Final after the last word: **p50 356 ms, p90 434 ms**.
- **Edge-timestamp error:** first-word `start` minus script start: p50 **−990 ms** (−1024 to 0). Last-word `end` minus script end: p50 **+240 ms** (+70 to +1344). An example: "Hi!" was reported as 4032–5600 ms, while the claimant actually starts at 5000 ms. So a midpoint or last-word-end heuristic can misplace short replies.

**Status: PASS** (after re-scoring with `streaming/rescore-stereo.ts`; the first-pass midpoint scoring was my bug).

**Conclusion.** One session per channel gives exact attribution at 2× the session cost. Each side loses some cross-speaker context, which explains the slightly higher WER. Pad audio citations by about 1 s before and 0.3 s after, or take exact word timings from async.

### 2.7 PII

**Request A.**

```
&redact_pii=true&redact_pii_policies=["person_name","phone_number","location_address"]&redact_pii_sub=entity_name
```

The array is JSON-encoded.

**Observed A.**

- `Begin.configuration.redact_pii:true`.
- **0 partials** (only finals); `SpeechStarted` still fired 10 times.
- Redaction is per word and consistent across `transcript`, `words[].text` and `utterance`:
  - "Harbor Point Claims, [PERSON_NAME] [PERSON_NAME] speaking."
  - "My cell is [PHONE_NUMBER]."
  - "And you are still at [LOCATION_ADDRESS] [LOCATION_ADDRESS] [LOCATION_ADDRESS], [LOCATION_ADDRESS]?"
- **Miss:** "outside 1420 Maple Avenue in Springfield" was **not** redacted.
- The policy and claim numbers stay (no policy was set for them).

**Request B.** `&redact_pii=true`, default policies and substitution, on the question clip.

**Observed B.** "The order number is ######, and it still hasn't arrived." The word text is `"######,"`.

**Status: PARTIAL.** The feature behaves as documented, but `location_address` missed one of the two addresses.

**Conclusion.**

- It works on finals only, and the live UI loses partials.
- Choose the policies explicitly, and add `location_address_street` / `location` if addresses matter.
- The default "all policies" hash also masks number sequences such as order IDs, which you may need to keep.

### 2.8 Tuning and mid-stream control

**Request.** All of these in one URL (no error, so `prompt` and `keyterms_prompt` can be combined on the raw API):

```
&prompt=Insurance claim phone call between adjuster Daniel Reyes of Harbor Point and claimant Priya Shah about a rear-end collision, with policy and claim numbers, addresses, a phone number and dollar amounts.
&keyterms_prompt=["Harbor Point","Daniel Reyes","Priya Shah","Mark Donnelly","Lakeside Auto Body","HP7740391","Maple Avenue"]
&min_turn_silence=200&max_turn_silence=1200&vad_threshold=0.3&session_heartbeat=true
```

The schedule, in audio time:

- 20.0 s: `{"type":"KeepAlive"}`.
- 46.3 s: `{"type":"UpdateConfiguration","agent_context":"Got it. What's the best number to reach you?","min_turn_silence":1000,"max_turn_silence":2500}`.
- 54.0 s: `{"type":"UpdateConfiguration","keyterms_prompt":["Birchwood Lane","CL44812","appraiser"],"min_turn_silence":200,"max_turn_silence":1200}`.
- 62.5 s: `{"type":"ForceEndpoint"}`.

**Observed.**

- No `Error` or `Warning`. KeepAlive and UpdateConfiguration are acknowledged by **nothing**.
- `Begin.configuration` echoes none of the tuning params.
- **Heartbeat** arrived 14 times at 5.00–5.10 s spacing: `{"type":"Heartbeat","total_audio_received_ms":9888,"total_duration_ms":10096,"realtime_factor":0.9983,"max_speech_probability":0.999999}`. The `realtime_factor` fell to 0.6858 during the tail, once audio stopped.
- **ForceEndpoint:** a final after **272 ms**, cut exactly at the forced point: "Your claim number is CL44812." The remainder became the next turn.
- 6 finals (versus 10 at defaults). The 46.3–54.0 s window with `min_turn_silence=1000` merged turns 8–14 into one final, which shows UpdateConfiguration takes effect.
- WER 0.0%, 21/21 entities. The baseline was already perfect, so prompt and keyterm gains cannot be measured on this audio.
- **ForceEndpoint stress** (from `llm-stress`: ForceEndpoint every 1.4 s): **49 sent, 49 finals, p50 267 ms, p90 315 ms, no empty finals**. But **WER rose to 13.8%** and 5 entities were lost ("Policy number HP" | "7740.", and `$3,450`, the phone number and "Lakeside Auto Body" were broken).

**Status: PASS.**

**Conclusion.**

- UpdateConfiguration is live and fire-and-forget.
- Raising `min_turn_silence` before an entity question does keep the entity in one turn.
- **Never ForceEndpoint while the user may be mid-entity.**
- The heartbeat is a cheap liveness and throughput monitor.

### 2.9 `Begin` echo and misspelled params

**Request.** `?sample_rate=16000&speechModel=universal-streaming-english&min_turn_silense=999&speaker_lables=true`

**Observed.** `Begin.configuration.model:"universal-3-5-pro"` (the default), `speaker_labels:false`, with no error or warning. Separately, `universal-streaming-english` with `format_turns=true&end_of_turn_confidence_threshold=0.6` was accepted, and the echo shows `mode:null` and nothing about either parameter.

**Status: PASS.**

**Conclusion.** Only these typos are detectable from the echo: model, mode, speaker_labels, redact_pii, filter_profanity, domain and voice_focus. For everything else, rely on typed params (`client.ts` `StreamingParams`).

### 2.10 Limits (C15, C17)

| Request | Result |
|---|---|
| `agent_context` = 1800 chars in the URL | `{"type":"Error","error_code":3006,"error":"User Input Validation Error: Invalid 'agent_context': Value error, agent_context exceeds maximum length of 1750 characters (got 1800)"}` before `Begin`; close 3006 |
| `UpdateConfiguration.agent_context` = 2500 chars mid-stream | the same error after 952 ms, then **the session is closed with 3006** (no Termination) |
| `prompt` = 1800 chars | 3006 `"prompt exceeds maximum length of 1750 characters (got 1800)"` |
| 101 `keyterms_prompt` items | 3006 `"Invalid 'keyterms_prompt': Value error, Max 100 items"` |
| one 60-char keyterm | accepted silently, with no warning |
| `language_codes=["ca"]` | accepted (`Begin`) |
| `language_codes=["xx"]` | 3006 `"Invalid 'language_codes.0': Input should be 'en', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'nl', 'sv', 'no', 'da', 'fi', 'hi', 'vi', 'ar', 'he', 'ja', 'ur', 'zh', 'ru', 'ko', 'ca', 'gl', 'ro', 'et', 'fa', 'yue', 'af', 'mr', 'zu', 'xh', 'nn' or 'multi'"` |

**Status: PASS.**

**Conclusion.**

- **C15:** the limit is 1750 and it is **fatal** when exceeded, including mid-stream. `client.ts` `sanitizeParams` clips `agent_context` (keeping the end), `prompt` and keyterms before sending.
- **C17:** the validator accepts 33 values including Catalan. Only `hi`/`en` quality was tested.

### 2.11 T11 / C28: in-stream `llm_gateway`

**Request.** On `question_16k.wav`:

```
&llm_gateway={"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"Classify the caller's intent in at most four words.\n\nCaller said: {{turn}}"}],"max_tokens":20}
```

The JSON is URL-encoded. The stress variant ran it on the dialog with ForceEndpoint every 1.4 s, giving 58 finals in about 70 s.

**Observed.**

- `Begin` is normal and the echo shows nothing about the gateway.
- 2 finals and **0 `LLMGatewayResponse`**, with no `Error` or `Warning`.
- Stress run: 58 finals, 0 responses.
- A direct `POST https://llm-gateway.assemblyai.com/v1/chat/completions` (5 max tokens) for `gemini-2.5-flash-lite`, `claude-haiku-4-5-20251001`, `gpt-5-nano`, `gpt-4.1` and `gemini-2.5-flash` returned **HTTP 400** every time: `{"metadata":{"errors":["Your account does not have access to this LLM Gateway model"]},"request_id":"4a8e047b-…","message":"invalid request body","code":400}`. See `out/streaming-llm-http-probe*.jsonl`. `GET /v1/models` works and lists 47 models.

**Status: SKIPPED (blocked by account tier).**

**Conclusion.**

- This matches C10: the Gateway needs billing enabled beyond the free credit.
- The streaming server **does not surface** Gateway failures. Your code must treat "no `LLMGatewayResponse` within N seconds" as a failure.
- Re-run `llm` and `llm-stress` after adding a card to settle C28, which asks whether in-stream calls count toward 30 req/min per model. The `llm-stress` rig already generates about 41 turns per minute.

### 2.12 Multilingual code-switch (`codeswitch_16k.wav`)

The ground truth is "मेरा order अभी तक नहीं आया, can you please check the status? Order number है 481529. और हाँ, delivery कल तक हो जाएगी क्या?"

| Params (plus U3.5 Pro base) | Transcript | Language fields per final |
|---|---|---|
| `language_detection=true` | मेरा ओर्डर अभी तक नहीं आया। **कैन यू प्लीज चेक द स्टेटस?** ऑर्डर नंबर है। **फोर एट वन फाइव टू नाइन** और हाँ डिलीवरी कल तक हो जाएगी क्या? | hi 0.81 / hi 0.69 / hi 0.63 / hi 0.82 |
| `+language_codes=["hi","en"]` | byte-identical to the row above | identical |
| `+language_codes=["hi"]` | byte-identical to the row above | identical |
| `+prompt="Customer support call in Hinglish…"` | …आया। Can you please check the status? Order number है। फोर एट वन फाइव टू नाइन … | hi / en 0.55 / en 0.58 / hi |
| `+language_codes=["en"]` | **मेरा ओर्डर अभी तक नहीं आया। Can you please check the status? Order number है 481529. और हाँ, delivery कल तक हो जाएगी क्या?** | hi 0.81 / en 0.83 |
| `+language_codes=["en","hi"]` | मेरा ओर्डर … आया। Can you please check the status? ऑर्डर नंबर है। **481529** और हाँ, delivery कल तक हो जाएगी क्या? | hi / en / en / hi |
| `universal-streaming-multilingual` + `language_detection=true` | meta ordered abhitak nehiaya can you please check the status order number here 481 529 oha delivery kaltak hojai gikia | **tr 0.25** / en 0.58 / en 0.50 / en 0.55 / (an empty final with null) |

`language_code` and `language_confidence` appear on **finals only**. For example:

```json
{"turn_order":0,…,"transcript":"मेरा ओर्डर अभी तक नहीं आया।",…,"language_code":"hi","language_confidence":0.814682,"type":"Turn"}
```

**Status: PASS**, with a caveat: n=1 per variant.

**Conclusion.**

- For Hinglish, use `language_codes:["en","hi"]` (or `["en"]`). Order matters: the first code sets the script bias.
- A single-element list does not force a monolingual session.
- US-Multilingual does not support Hindi.
- Per-final `language_code` is usable for routing (it detected hi→en→en→hi).

### 2.13 Telephony: mu-law 8 kHz

**Request.** `?speech_model=universal-3-5-pro&encoding=pcm_mulaw&sample_rate=8000`, with `question_8k.mulaw` sent in 100 ms frames of 800 bytes each (5 Twilio frames batched).

**Observed.**

- `Begin` is normal. The first Turn arrived at 1202 ms.
- The transcript "Hi, I'm calling about my order. The order number is 481529, and it still hasn't arrived." is perfect.
- It came as **one** final, which only arrived after Terminate. At 8 kHz the inter-sentence pause did not end the turn; at 16 kHz it did.
- Termination `audio_duration_seconds:7`, `session_duration_seconds:11`.

**Status: PASS.**

**Conclusion.** Pass Twilio audio through as-is, but batch the 20 ms frames to 50 ms or more (`FrameBatcher`). Turn segmentation on phone audio may be coarser, so tune `min_turn_silence` per call.

### 2.14 File tail

**Request.** `question_16k.wav` plus 2000 ms of digital silence, a 0.5 s tail, then Terminate.

**Observed.** Finals arrived at 2501 ms ("Hi, I'm calling about my order.") and **7703 ms** ("…hasn't arrived."). That is 324 ms after the last word's end, **before** Terminate. Terminate → Termination took 641 ms.

The earlier runs without trailing silence (§2.1) got the second final only 273 ms **after** Terminate.

**Status: PASS.**

**Conclusion.** The server needs audio to observe silence. When a file ends, or a mic is paused, send silence or ForceEndpoint. `streamAudioPaced({ tailSilenceMs })` does this.

### 2.15 Error cases and close codes (C12)

| Case | Request | Verbatim `Error` | Close | Timing |
|---|---|---|---|---|
| 20 ms frames | 640-byte frames at real time | `{"type":"Error","error_code":3007,"error":"Input Duration Error: Input Duration Violation: 20.0 ms. Expected between 50 and 1000 ms"}` | 3007 | **after about 49 frames (977 ms)**, not on the first frame |
| One 1200 ms frame | 38,400 bytes | `…Input Duration Violation: 1200.0 ms. Expected between 50 and 1000 ms` | 3007 | immediate |
| 1000 ms frames | 3 × 32,000 bytes | none. Final "Hi, I'm calling about my order. The order number i…" | 1000 | billed 7 s |
| Invalid JSON | text frame `{not json` | `…"User Input Validation Error: Invalid JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"` | 3006 | about 1 s |
| Unknown type | `{"type":"Bogus"}` | `…"Invalid Message Type: Bogus"` | 3006 | about 1 s |
| `inactivity_timeout=5` | no audio | `…"Session terminated due to inactivity: No messages received for 5 seconds"` | 3006 | 5.01 s |
| `sample_rate=7000` | | `…"Invalid 'sample_rate': Value error, sample_rate must be at least 8,000 Hz"` (before Begin) | 3006 | |
| `encoding=flac` | | `…"'flac' is not a valid Encoding"` (before Begin) | 3006 | |
| Burst 10× | 7.3 s sent in 0.74 s (100 ms frames) | none | 1000 | final at 7295 ms wall, so the server processes at about 1.0× real time for a short clip. Billed 8 s |
| Terminate immediately | | none | 1000 | `session_duration_seconds:1` |

Every close reason was the literal `"See Error message for details"`, even for short messages. Sessions closed by an `Error` never send a `Termination`.

**Status: PASS.**

**Conclusion.**

- The close code always equals `error_code`.
- Read the `Error` frame; the close reason is useless.
- **C12** (1008 vs 3009 for the concurrency limit) was **not reproduced**, because the spike rate-limited itself to 4 opens per minute. 1008 is also used for every auth failure, so handle both 1008 and 3009 by their message text.

### 2.16 End-to-end product path (`streaming/e2e-client.ts`)

**Request.**

1. `mintStreamingToken(key, { expiresInSeconds: 30, maxSessionDurationSeconds: 120 })`.
2. `StreamingSession.connect({ auth:{token}, params:{...GOLDEN_PARAMS, ...PRESETS.voiceAgent} })` through the **default factory**, which picks the Node 22 built-in WebSocket: no headers, browser-equivalent.
3. `question_24k.wav` as Float32 quanta of 128 samples at real time, through the exact worklet code string (`PCM16_DOWNSAMPLER_JS`) from 24 kHz to 16 kHz.
4. 50 ms frames sent with client-side validation on, then 1.5 s of silence quanta, then `terminate()`.

**Observed.**

- Connected 2555 ms after start (mint plus connect).
- `Begin.expires_at` was now + 109 s, reflecting the 120 s cap.
- `SpeechStarted` came 593 ms after audio start.
- 176 frames sent, 0 rejected.
- Finals "Hi, I'm calling about my order." (+2492 ms) and "The order number is 481529, and it still hasn't arrived." (+7799 ms), both before Terminate.
- Termination `{"audio_duration_seconds":9,"session_duration_seconds":9}`, close 1000.

**Status: PASS.**

### 2.17 Billing fields

- `Termination` carries `audio_duration_seconds` and `session_duration_seconds` as **integers**. The session value is roughly the wall time from `Begin` to `Termination`, rounded (for example a 69.13 s dialog with a 2.5 s tail was billed 73 s).
- Terminate → Termination takes about **0.55–0.72 s** when idle and about **1.2 s** with a turn in flight.
- Connect to `Begin` takes about **1.2–1.3 s** on every accepted path. Rejected connects take 0.6–0.9 s.
- Minting a token takes 0.8–1.2 s. Rejected mints (422) come back in about 0.2 s.

---

## 3. Golden config (use these in the product)

**Auth flow.**

- **Server** (a Vercel function; the key never leaves it):

  ```
  GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=30&max_session_duration_seconds=900
  Authorization: <raw ASSEMBLYAI_API_KEY>          // raw works; Bearer also works here but NOT on the WS
  ```

  - Mint **per connect**. The token is reusable until it expires, so keep the window short.
  - Mint on page load or on a button hover to hide about 1 s of latency.
  - Never log the token.
- **Browser:**

  ```
  wss://streaming.assemblyai.com/v3/ws?speech_model=universal-3-5-pro&sample_rate=16000&encoding=pcm_s16le&token=<token>
  ```

- **Server-to-server** (Node, for example a Twilio bridge): use the same URL without `token`, plus the header `Authorization: <raw key>`. **No `Bearer`.**

**Audio.**

- Binary frames only: PCM16 little-endian mono 16 kHz, **exactly 50 ms (1600 bytes)**. The hard limits are 50 to 1000 ms.
- In the browser use `browser-capture.ts` `startMicCapture`: the AudioContext runs at the device rate and the worklet anti-aliases, resamples and batches.
- For telephony use `encoding=pcm_mulaw&sample_rate=8000`, with Twilio's 20 ms frames batched to 100 ms (`FrameBatcher`).

**Params per scenario.** All use `universal-3-5-pro`.

| Scenario | Add to `GOLDEN_PARAMS` | Notes |
|---|---|---|
| Live transcript / notes (human–human) | nothing, or `mode=balanced` explicitly | 0% WER on the fixture, final about 420 ms after the last word |
| BYO voice agent / barge-in | `mode=min_latency` | stop TTS on `SpeechStarted` **or** the first partial (they arrive together, about 0.58 s after onset); push the actually-spoken agent text via `UpdateConfiguration.agent_context` (≤1750 chars, clipped automatically) |
| Two-party call with attribution | **one session per channel**, no `speaker_labels` | exact attribution; about 2× cost |
| Mono, speakers unknown | `speaker_labels=true&max_speakers=2` | use word `speaker`, apply `SpeakerRevision` at the end, and expect ~10 s cuts with lost words; for entities prefer async afterwards |
| PII-safe capture | `redact_pii=true&redact_pii_policies=["person_name","phone_number","location_address","location_address_street"]&redact_pii_sub=entity_name` | finals only, no partials |
| Hinglish callers | `language_codes=["en","hi"]&language_detection=true` | English first; `["hi"]` or the default transliterates to Devanagari and spells digits as words |
| Domain vocabulary | `keyterms_prompt=[…]` (≤100 items, ≤50 chars each), `prompt="<20–50-word scenario>"` (≤1750 chars) | both can be set together on the raw API |
| Liveness | `session_heartbeat=true` | a Heartbeat every 5.0 s with `realtime_factor` |

**Runtime control.**

- **Before asking for an ID, phone number or email:** send `{"type":"UpdateConfiguration","min_turn_silence":1000,"max_turn_silence":2500}` (optionally with new `keyterms_prompt`). Afterwards restore it with `{"type":"UpdateConfiguration","min_turn_silence":200,"max_turn_silence":1200}` or your mode's values. There is no ack.
- **To force a turn to end:** use `{"type":"ForceEndpoint"}` (final in about 270 ms). Only use it at a point the user has clearly finished; it cuts entities.
- **Turn handling:**
  - Replace partial text per `turn_order`; never append.
  - A final is `end_of_turn:true`.
  - Ignore empty finals (Universal-Streaming sends one on Terminate).
  - On Universal-Streaming with `format_turns=true`, wait for `turn_is_formatted`.
  - `TurnTracker` does all of this.

**Shutdown.**

1. Stop capture.
2. If you still need the last final, send about 1 s of silence or a `ForceEndpoint`.
3. Send `{"type":"Terminate"}`.
4. Wait for `Termination` (about 0.6–1.3 s), then close.

- On `pagehide`, call `terminate()` as a best effort.
- `inactivity_timeout` (5–3600 s) is a server-side safety net against leaked sessions. It closes with 3006 and no Termination.

**Error handling.**

- Parse the `Error` frame (`error_code`, `error`). The close code equals `error_code`, and the reason is always "See Error message for details".
- **Retry with a fresh token** on 1006, 1011 and 3005.
- **Do not retry** on 1008 (auth, or maybe the rate limit: check the text), 3006 (input bug) or 3007 (frame bug).
- Treat a missing `LLMGatewayResponse` as a silent failure.

---

## 4. Browser capture design notes (AudioWorklet)

The implementation is in `spikes/streaming/browser-capture.ts`: `startMicCapture`, `CAPTURE_WORKLET_SOURCE` and `PCM16_DOWNSAMPLER_JS`. The design:

1. **`getUserMedia({audio:{echoCancellation:true, noiseSuppression:false, autoGainControl:true, channelCount:1}})`.** Server models prefer raw audio; do not add client denoising.
2. **`new AudioContext()` at the device rate**, usually 48 or 44.1 kHz. Do not pass `sampleRate`, because that breaks Firefox echo cancellation and garbles Safari (synthesis §2.3).
3. **The worklet receives 128-frame render quanta**, about 2.7 ms at 48 kHz. Sending those directly fails with **3007**, verified. The worklet therefore:
   - low-pass filters with a 31-tap Blackman-windowed sinc at 0.45 × 16 kHz, at unity DC gain (the `assemblyai` SDK's own worklet has no anti-alias filter);
   - resamples by linear interpolation, keeping state across quanta and handling non-integer ratios (44.1 k to 16 k is tested);
   - converts to Int16 (negative × 0x8000, positive × 0x7FFF);
   - fills **exactly 800 samples (50 ms)** and posts `{pcm: ArrayBuffer, samplesSent}` with the buffer **transferred**, with no copies on the main thread.
4. **Main thread:** `session.sendAudio(pcm)` per message. Frames are already legal and paced by the audio clock. `samplesSent / 16000 * 1000` lines up with the server's word-timestamp clock, which is useful for UI sync, but remember the edge padding (§2.6).
5. **Graph:** `source → worklet → GainNode(0) → destination`. This keeps the node pulled by the render graph without playing the mic back. Call `context.resume()` after a user gesture.
6. **Loading the worklet:** it is shipped as a **plain JS string** through a Blob URL, so no static asset is needed.
   - Do **not** build it with `SomeClass.toString()`. Bundlers inject helpers: esbuild/tsx emitted `static{__name(this,"Pcm16Downsampler")}`, which throws `ReferenceError: __name is not defined` inside `AudioWorkletGlobalScope`.
   - `selftest.ts` evaluates the exact string in a `node:vm` sandbox, and `e2e-client.ts` ran it live against the API.
7. **Frame size trade-off:** 50 ms adds on average about 25 ms of queueing. 100 ms halves the message rate but adds latency. Stay at 50 ms for voice agents.
8. **Why it matters: one mic, two sockets.** If the page also runs the Voice Agent, it must not feed the same mic to Streaming STT, because you pay twice and it transcribes the agent. Either give Streaming a different source or gate it while the agent speaks (synthesis §2.3).

---

## 5. Reusable module: `spikes/streaming/client.ts`

This file has no dependency on the spike harness. It works in the browser (native `WebSocket`) and in Node (the built-in WebSocket for tokens, with `ws` loaded lazily for header auth).

| Export | Purpose |
|---|---|
| `mintStreamingToken(apiKey, {expiresInSeconds, maxSessionDurationSeconds})` | server-side token; throws `StreamingHttpError(status, body)` |
| `StreamingSession.connect({auth:{apiKey}\|{token}, params, onFrame?, factory?, sanitize?, validateChunkDuration?})` | resolves on `Begin`; rejects with `StreamingConnectError.details = {closeCode, closeReason, serverError, httpStatus?}` |
| `session.on("turn"\|"speechStarted"\|"speakerRevision"\|"heartbeat"\|"llmGatewayResponse"\|"warning"\|"error"\|"termination"\|"close"\|"message", fn)` | typed events |
| `session.sendAudio(bytes)` | binary frame; throws `RangeError` outside 50–1000 ms |
| `session.updateConfiguration(patch)`, `forceEndpoint()`, `keepAlive()` | mid-stream control, auto-clipped to the server limits |
| `session.terminate({timeoutMs})` → `Termination \| null` | Terminate, then wait for Termination and close |
| `streamAudioPaced(session, bytes, {sampleRate, chunkMs, tailSilenceMs})` | file or test playback at real time, with trailing silence |
| `FrameBatcher` | turns worklet quanta or Twilio 20 ms frames into ≥50 ms frames; `flush()` pads to 50 ms |
| `TurnTracker` | per-turn replace semantics, empty-final filter, `format_turns` double finals, `SpeakerRevision` |
| `GOLDEN_PARAMS`, `PRESETS.{voiceAgent,telephony,hinglish,pii}`, `LIMITS`, `sanitizeParams`, `ACCEPTED_LANGUAGE_CODES`, `CLOSE_CODES`, `isRetryableClose` | the verified defaults and constants |

---

## 6. Doc discrepancies (docs or research notes vs the live API)

| # | Claim (source) | Observed live | Impact |
|---|---|---|---|
| D1 | `universal-3-5-pro-realtime` for streaming (07 §5.1, §8) | rejected, 3006 | **C1 resolved:** use `universal-3-5-pro` |
| D2 | the enum has exactly 3 values (02 header, API reference) | the server enum has 11: adds `whisper-rt`, `u3-rt-pro`, `u3-rt-pro-beta-1`, `u3-rt-agent`, `universal-3-6(-pro)`, `universal-3-7-preview` and `_universal-3-5-notetaker`. `u3-rt-pro` still works; 3-7-preview and u3-rt-agent return 3005 after `Begin` | ignore the undocumented ones |
| D3 | "Each token is one-time use" (02 §3; synthesis §2.2) | **reusable** within `expires_in_seconds`, both sequentially (3×) and concurrently (2×) | security and cost: short windows and a session cap |
| D4 | token endpoint errors are `{error, code, details}` with 400/401 (02 §3) | **422** `{"detail":[{type,loc,msg,input,ctx}]}`, including for a missing Authorization header | parse `detail[]` |
| D5 | token endpoint needs the raw key, no Bearer (02 §2, 05 §11) | Bearer **also accepted** at `/v3/token`; the **WS rejects Bearer** (1008 "Invalid API key") | use the raw key everywhere on Streaming |
| D6 | browser pre-handshake auth failures are silent 1006 (synthesis §2.2, from the Voice Agent note) | on Streaming, auth fails **after** the upgrade with `Error` 1008 + close 1008, which a browser-like client sees | show a real error in the UI |
| D7 | "Always check `Begin.configuration` … to catch typos" (02 §4, §20.10) | the echo covers only 8 fields; turn, VAD, prompt, keyterms, language and heartbeat params are **not** echoed | typed params, not echo checks |
| D8 | C14 defaults readable from `Begin.configuration` (synthesis C14) | not echoed; unresolvable from `Begin` | set `mode` and the params explicitly |
| D9 | `SpeechStarted` "precedes the turn's first Turn message; reliable barge-in" (02 §6.2) | arrives in the **same tick** as the first partial (0–1 ms earlier): about 1.17 s after onset in balanced, 0.58 s in min_latency | use it, but it is not faster than the first partial; use `min_latency` |
| D10 | single-element `language_codes` = monolingual (02 §4, §9) | `["en"]` still wrote Hindi in Devanagari; `["hi"]` transliterated the English. The first code sets the script bias | Hinglish: `["en","hi"]` |
| D11 | language list is 18 (+`ca` = 19) (02 §9; C17) | the validator accepts 33 incl. `ca`, `ru`, `ko`, `ur`, `yue`, `multi` | quality untested beyond hi/en |
| D12 | `agent_context` 1750 vs about 1500 (C15) | 1750 enforced; **exceeding it kills the session, even mid-stream** | clip client-side (`sanitizeParams`) |
| D13 | `llm_gateway` gives a per-turn `LLMGatewayResponse` (02 §6, 03 §9.2) | when the account lacks Gateway access, the param is **silently ignored**: no Error or Warning | watchdog for missing responses |
| D14 | streaming diarization labels turns; continuous partials disabled (02 §10) | also forces **~10 s turn cuts that drop words**; partials unlabeled; 7/8 turns mix speakers | per-channel sessions for 2-party audio |
| D15 | 3007 when a chunk is <50 ms (02 §7–8) | true, but raised after about 1 s of bad frames (49 × 20 ms), not on the first frame | enforce client-side |
| D16 | close reason is only "See Error message for details" for long messages (02 §6) | it is used for **all** errors | always read the `Error` frame |
| D17 | throughput throttled to about 1.25× real time (02 §8) | a 7.3 s clip burst at 10× produced its final at 7.3 s wall (about 1.0×); no error | don't rely on faster-than-real-time for short clips |
| D18 | final `Turn` word timestamps (02 §6.2) | turn-edge words absorb silence: first `start` about 1 s early, last `end` +0.24 to +1.3 s | pad audio citations, or use async timestamps |
| D19 | U3.5 Pro turn detection ends on a `min_turn_silence` pause (128 ms balanced) (02 §5.2) | 250 ms speaker-change gaps never ended a turn; about 400 ms or more inter-sentence pauses did | turns ≠ speaker changes on fast back-and-forth |
| D20 | "Terminate finalizes the open turn" (02 §16), no mention of stopped audio | without trailing audio the last turn waits for Terminate or ForceEndpoint | send silence at end of file or when the mic pauses |
| D21 | Universal-Streaming finals (02 §6) | an extra **empty final** (`""`, `words:[]`) on Terminate; partial `transcript` can be `""` while `words` is populated | filter empties; build partial text from words |
| D22 | `assemblyai` SDK `StreamingSpeechModel` includes `u3-pro` | not in the server enum (it would be rejected with 3006) | don't trust the SDK union |

---

## 7. Not tested / open

- **C12**, the concurrency and rate-limit close code (1008 vs 3009). The spike deliberately stayed at 4 or fewer opens per minute. Handle both codes by their message text.
- **T11 / C28**, whether in-stream Gateway calls count toward 30 req/min per model. This is blocked until billing is enabled; the `llm-stress` rig is ready.
- **C3**, keyterms pricing, and whether add-on charges appear. Check the billing dashboard, which is not visible from the API.
- `voice_focus`, `domain=medical-v1`, `speaker_labels_revision_interval_ms`, `previous_context_n_turns`, `interruption_delay`/`continuous_partials` overrides, and the opus, ogg_opus and aac encodings.
- The EU and US data-zone hosts.
- A real microphone in a real browser. The worklet code ran in a `vm` sandbox and in a live Node end-to-end run, but not inside Chrome, Firefox or Safari.
- Accuracy on noisy, accented or crosstalk audio. All the fixtures are clean TTS, so the 0% WER is an upper bound.

## 8. Files

- `spikes/streaming/client.ts`: the reusable client. It becomes the product module.
- `spikes/streaming/browser-capture.ts`: the AudioWorklet capture (worklet code string plus `startMicCapture`).
- `spikes/streaming/smoke.ts`: every live test (`models models2 auth auth2 core diarization stereo pii pii-hash tuning modes latency-min llm llm-stress multilingual multilingual2 multilingual3 mulaw tail-silence errors limits`). `latency-max` is defined but was not run.
- `spikes/streaming/harness.ts`: the logged session runner, the cross-process rate guard (`out/streaming-session-opens.json`, `STREAM_OPEN_LIMIT` default 4 per minute) and the metrics: word-anchored latency, normalized WER, entity hits and diarization accuracy.
- `spikes/streaming/e2e-client.ts`: the live product-path check.
- `spikes/streaming/selftest.ts`: 10 offline checks (URL encoding, batching, tracker, WER normalization, downsampler, worklet sandbox, limits).
- `spikes/streaming/gateway-probe.ts`: the Gateway access probe.
- `spikes/streaming/rescore-stereo.ts`: stereo re-scoring.
- `spikes/streaming/tsconfig.json`: extends `../tsconfig.json` and adds the `dom` lib.
- `spikes/out/streaming-*.jsonl` and `spikes/out/streaming-*.summary.json`: the evidence. The directory is gitignored.
