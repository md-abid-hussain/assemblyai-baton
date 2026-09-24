# 10: Smoke-test results, consolidated (live, 2026-09-24)

This note merges the four live smoke-test reports into one place: what passed, which research claims were settled, the exact settings the product should use, and what the user has to do next.

| Source report | Scope | Spike code | Raw logs |
|---|---|---|---|
| `10a-voice-agent-smoke.md` | Voice Agent API: `wss://agents.assemblyai.com/v1/ws`, `/v1/token`, `/v1/agents`, `/v1/sessions` | `spikes/voice-agent/` | `spikes/out/va-*.jsonl` |
| `10b-streaming-smoke.md` | Streaming STT v3: `wss://streaming.assemblyai.com/v3/ws`, `/v3/token` | `spikes/streaming/` | `spikes/out/streaming-*.jsonl` + `*.summary.json` |
| `10c-async-gateway-smoke.md` | Async `/v2/transcript`, Speech Understanding, LLM Gateway | `spikes/async/`, `spikes/gateway/` | `spikes/out/async-*.jsonl`, `gateway-*.jsonl` |
| `10d-openai-smoke.md` | OpenAI Responses, Chat Completions, TTS, Agents SDK | `spikes/openai/` | `spikes/out/openai-*.jsonl` |

**How to read this note:**
- IDs `C1`–`C33` (contradictions) and `T1`–`T11` (tests) refer to `00-synthesis.md` §7.
- Section references like "10a §7" point into the source reports, which hold the verbatim requests, responses and timings.
- Every latency was measured from a client in India (about 170 ms round trip to the US endpoints), so each number includes roughly one network trip each way.
- No key, token or base64 audio appears in any log. `voice-agent/scan-secrets.ts` checked the output files, and every logger masks registered secrets.

**Re-verified while writing this note (offline, no network spend):**
- `npx tsc --noEmit` passes for the root, `voice-agent/`, `streaming/`, `async/` (which also covers `gateway/`) and `openai/` tsconfigs.
- Self-tests pass: `scripts/selftest-lib.ts` 19/19, `streaming/selftest.ts` 10/10, `gateway/selftest.ts` 16/16 and `openai/selftest-client.ts` 9/9.

---

## 0. TL;DR

**Totals:** 61 tests. **45 PASS, 10 PARTIAL, 5 FAIL, 1 SKIPPED.** Five of the six FAIL/SKIPPED results have one cause: this account cannot use LLM Gateway models (C10). The sixth (T2b) is a docs claim the live API contradicts.

**The browser-direct architecture in synthesis §2.1 holds.** Voice Agent, Streaming STT, async transcription and OpenAI all work end to end with the settings in §3.

**Changes to the plan:**
1. **The LLM Gateway is locked on this account.** Only `qwen3.5-4b-32k-fast` works, at 2 requests/min, with no tools and no `response_format`. Use the **managed Voice Agent LLM**, and **OpenAI directly** for every in-product agent, until the plan is upgraded.
2. **Temporary tokens are not single-use** on either the Voice Agent or Streaming. On the Voice Agent, **`max_session_duration_seconds` is not enforced** either. Spend control must come from our mint route (auth plus rate limit), a client-side cap (`maxDurationMs`) and always sending `session.end` or `Terminate`.
3. **Voice Agent latency, as a caller hears it:**
   - Plain turns: 2.1–2.6 s (`min_latency`) or 2.9–3.2 s (`balanced`) from end of speech to audible audio.
   - Tool turns: about 4–6 s.
   - Every reply starts with 0.2–2 s of silent PCM, and tool pre-ambles are completely silent.
   - Sending `tool.result` immediately, instead of waiting for `reply.done` as documented, is accepted and saves about 1.0 s.
4. **`conversation.message` never reaches the model.** Push mid-call context with `reply.create.instructions` (one turn) or `session.update {system_prompt}` (durable). Both are verified.
5. **Streaming diarization cuts turns on a fixed ~10 s grid and drops words.** For two-party calls, run one Streaming session per channel. That gave 27/27 finals on the right speaker.
6. **Async sentiment rows carry the wrong speaker 61.5% of the time and leak raw PII**, even with redaction on. Entities are not redacted either. Use `reattributeSentiment()`, or skip sentiment.

---

## 1. Status of every test

### 1.1 Voice Agent API (10a): 11 PASS, 3 PARTIAL, 2 FAIL

| # | Test | IDs | Status | Key evidence | Log (`spikes/out/`) |
|---|---|---|---|---|---|
| VA-1 | Token minting (raw vs Bearer, ± `product`) and WS connect by `?token=` and by header | T2, C4, C23, C24 | **PASS** | `GET /v1/token?expires_in_seconds=60&max_session_duration_seconds=180` returns 200 `{token(2578 chars), expires_in_seconds:60}` for every variant. All three connect styles reach `session.ready`. The server sends nothing until the first `session.update`. Bad, missing or expired auth: the upgrade succeeds, then `session.error {code:"unauthorized"}`, then close 1008 | `va-t2-auth.jsonl` |
| VA-2 | Token single-use and session cap | T2 | **FAIL** (docs contradicted) | One token opened 2 sequential and 2 concurrent sessions. A 60 s cap session was still alive at 102 s. `session.ready.expires_at` is always now + 3595 s | `va-t2b-max-duration.jsonl` |
| VA-3 | Invalid voice, voice list, error shape | T5, C5, C8 | **PASS** | 18 voices. REST returns 422 `validation_error`. An invalid voice in the **first** WS update is fatal (close 1008). Mid-session errors (`immutable_field`, `invalid_format`, `invalid_audio`, `invalid_value`, `agent_id_not_first`) keep the session open | `va-t5-voices-errors.jsonl` |
| VA-4 | Core loop: inline config, AI-disclosure greeting, `lookup_order` tool, real-time audio | – | **PASS** | `tool.call {order_number:"481529"}` answered. Measured from end of speech: `speech.stopped`, `reply.started` and first chunk at +930 ms, `tool.call` +2653, **first audible answer +5829 ms**. The tool pre-amble is 4.0 s of silence. Saved `agent_reply.wav` | `va-core-loop.jsonl`, `va-core-loop-run1.jsonl` |
| VA-5 | Barge-in | – | **PASS** | `input.speech.started`, `transcript.agent{interrupted:true}` (trimmed text) and `reply.done{status:"interrupted"}` arrive within 2 ms of each other, 1.1–2.2 s after the user starts speaking | `va-core-loop.jsonl` |
| VA-6 | Latency by `transcription_mode` | – | **PASS** | End of speech to first audible: min_latency 2.1–2.6 s, balanced 2.9–3.2 s, max_accuracy 4.2–4.5 s. Timeline `time_to_first_audio_ms` (0.8–1.2 s) counts only from turn commit | `va-latency-matrix.jsonl` |
| VA-7 | Text injection: `conversation.message` then `reply.create` | T3, C6 | **PARTIAL** | `reply.create` replies in about 180 ms. `conversation.message` is schema-validated but its content never reaches the model. `reply.create.instructions` and mid-session `system_prompt` do work | `va-t3-text-injection.jsonl`, `va-t3b-conversation-message.jsonl` |
| VA-8 | `tool.result` immediately vs after `reply.done` | – | **PASS** | Immediate: 0 errors, audible answer at 2.84–2.89 s versus 3.79–3.99 s with the documented rule | `va-t3c-early-tool-result.jsonl` |
| VA-9 | Stored agent, `agent_id` binding, mid-session prompt and tool updates, DELETE | T9, C22, C19 | **PASS** | POST 201 (`agent_<hex>`). Later `system_prompt` and `tools` updates each return `session.updated` and take effect. `agent_id` mixed with inline fields is fatal. The id returns 404 on `agents.us`. DELETE returns 204 | `va-t9-stored-agent.jsonl` |
| VA-10 | HTTP tool (postman-echo) on a stored agent | T4, C7, C21 | **PASS** | AssemblyAI called the URL in 156 ms and the agent used the body. **An informational `tool.call` still reaches the client.** On GET, header values are omitted (`{name,last_set_at}`) | `va-t4-http-tool.jsonl` |
| VA-11 | BYO LLM | T6, C9 | **PARTIAL** | Inline `llm` is rejected (fatal). A stored agent with OpenAI direct `gpt-4.1-mini` works (+~1 s on tool turns). Every Gateway config fails **silently**: 7.6 s of silent audio, `reply.done completed`, no transcript, no error | `va-t6-byo-llm.jsonl`, `va-t6-*.wav` |
| VA-12 | Gateway access probe | T7, C10 | **FAIL** (account) | 7 OpenAI/Claude/Gemini/gpt-oss models return 400 "Your account does not have access to this LLM Gateway model". Only qwen works; it streams but has no tools | `va-t6a*.jsonl` |
| VA-13 | Session history, timeline, recording → `/v2/transcript` | T10, C25 | **PASS** | Artifacts about 7 s after end, as pre-signed S3 URLs (eu-west-1, 1 h TTL). `/v2/transcript` fetches the URL directly: U3.5 Pro, multichannel, ch1 = user, ch2 = agent, done in 3.4–4.2 s | `va-t10-session-history.jsonl` |
| VA-14 | Read-only telephony endpoints and a `audio/pcmu` session | T8, C19 | **PASS** | `/v1/phone-numbers` and `/v1/webhook-subscriptions` return 200 (empty) on both hosts. μ-law in (20 ms / 160 B) and out (37.5 ms / 300 B) works | `va-t8-readonly-and-pcmu.jsonl`, `va-pcmu-reply.wav` |
| VA-15 | Faster-than-real-time audio | – | **PARTIAL** | A 3× burst of 7.3 s produced no `audio_rate_violation` and a full transcript (documented behaviour not reproduced) | `va-t-rate-violation.jsonl` |
| VA-16 | Pre-connect and SIP docs (reading only) | C19 | **PASS** (read) | Pre-connect is telephony-only, ≤2 entries, 1–800 ms, fails open. SIP is inbound-only. Numbers are bound on `agents.us` | – |

### 1.2 Streaming STT v3 (10b): 13 PASS, 2 PARTIAL, 1 SKIPPED

| # | Test | IDs | Status | Key evidence | Log (`spikes/out/`) |
|---|---|---|---|---|---|
| ST-1 | Model IDs | T1, C1, C2 | **PASS** | `universal-3-5-pro` accepted. `universal-3-5-pro-realtime` and `universal-3-pro` are rejected before `Begin` with `Error 3006`, whose text lists the server's 11-ID enum. `u3-rt-pro` still accepted | `streaming-models*.jsonl` |
| ST-2 | Auth: raw vs Bearer header, token reuse, expiry | C4 | **PASS** | WS: raw header OK, **Bearer rejected** (`Error 1008 "Invalid API key"`). `/v3/token` accepts both. One token opened 3 sequential and 2 concurrent sessions. Expired token: 1008 "Signature has expired" | `streaming-auth*.jsonl` |
| ST-3 | Core dialog at real time, U3.5 Pro defaults | C14 | **PASS** | 0.0% normalized WER (138 words), 21/21 entities. Final p50 418 ms after the last word. The 250 ms speaker-change gaps never end a turn | `streaming-core.jsonl` |
| ST-4 | `mode=min_latency` vs balanced | C13, C14 | **PASS** | `SpeechStarted` / first partial 581 ms after onset (p50) versus 1167 ms. Final latency and WER unchanged | `streaming-latency-min.jsonl` |
| ST-5 | Diarization (`speaker_labels=true&max_speakers=2`) | – | **PARTIAL** | Word accuracy 85.4% live, 99.3% after `SpeakerRevision`. Finals are cut on a ~10 s grid and lose words (`HP7740.`, with `391` gone). 7 of 8 finals mix speakers | `streaming-diarization.jsonl` |
| ST-6 | One session per stereo channel | – | **PASS** | 27/27 finals on the correct speaker, 21/21 entities, 4.3% WER. Edge word timestamps are off: first `start` about 990 ms early, last `end` about 240 ms late | `streaming-stereo-*.jsonl` |
| ST-7 | PII redaction | – | **PARTIAL** | Finals only (partials are suppressed). Per-word tags are consistent. "1420 Maple Avenue in Springfield" was **not** redacted. The default `hash` turned the order number into `######` | `streaming-pii*.jsonl` |
| ST-8 | Tuning plus mid-stream control | C14, C15 | **PASS** | `prompt` and `keyterms_prompt` work together. `UpdateConfiguration` has no ack but takes effect. `ForceEndpoint` returns a final in about 270 ms (p50 267 ms over 49), but forcing mid-entity raised WER to 13.8%. Heartbeat every 5.0 s | `streaming-tuning.jsonl`, `streaming-llm-stress.jsonl` |
| ST-9 | `Begin` echo and misspelled params | C14 | **PASS** | The echo carries 8 fields only. `speechModel=` falls back to the default silently; other typos are invisible | `streaming-modes*.jsonl` |
| ST-10 | Limits | C15, C17 | **PASS** | `agent_context` and `prompt` are capped at 1750 chars, **fatal (3006) even mid-stream**. 100 keyterms max. `language_codes` accepts 33 values including `ca` | `streaming-limits*.jsonl` |
| ST-11 | In-stream `llm_gateway` | T11, C28, C10 | **SKIPPED** (blocked) | No Gateway access. The parameter is **silently ignored**: 0 `LLMGatewayResponse` from 58 finals, no `Error` or `Warning` | `streaming-llm*.jsonl` |
| ST-12 | Hinglish code-switching | C17 | **PASS** (n = 1 per variant) | `language_codes:["en","hi"]` (or `["en"]`) keeps English in Latin script and gives `481529`. The default, `["hi"]` and `["hi","en"]` write everything in Devanagari and spell digits as words | `streaming-multilingual*.jsonl` |
| ST-13 | Telephony μ-law 8 kHz | – | **PASS** | `pcm_mulaw`/8000 in 100 ms frames gives a perfect transcript including 481529 | `streaming-mulaw.jsonl` |
| ST-14 | File tail silence | – | **PASS** | With 2 s of trailing silence, the last final arrives 324 ms after the last word, before `Terminate`. Without it, the final waits for `Terminate` | `streaming-tail-silence.jsonl` |
| ST-15 | Error cases and close codes | C12 | **PASS** | 20 ms frames or a 1200 ms frame → 3007. Bad JSON, unknown type, inactivity, bad sample rate or encoding → 3006. The close code always equals `error_code`; the reason is always "See Error message for details" | `streaming-errors*.jsonl` |
| ST-16 | End-to-end product path (`client.ts` only) | – | **PASS** | Token, built-in WebSocket, worklet downsampler code, 176 × 50 ms frames, `481529`, `Termination` | `streaming-e2e-client.jsonl` |

### 1.3 Async transcription, Speech Understanding, LLM Gateway (10c): 13 PASS, 4 PARTIAL, 3 FAIL

| # | Test | IDs | Status | Key evidence |
|---|---|---|---|---|
| A1 | Upload | – | **PASS** | 200 `{upload_url:"https://cdn.assemblyai.com/upload/<32-hex>/<uuid>"}` |
| A2 | Request validation (negative cases) | – | **PASS** | `universal-3-pro` **accepted** on async. Unknown PII policies are accepted silently. Invalid combinations return 400 with plain `{"error": "..."}` |
| A3 | Full-feature transcript (mono dialog) | – | **PASS** (sentiment defect) | Done in 8.7 s for 69 s of audio. Word-level speakers 100% correct, 19/19 facts. Sentiment `speaker` is right in only 10/26 rows (38.5%) and its text is **not redacted** |
| A4 | Speech Understanding inline (speaker role + Spanish + custom formatting) | C29 | **PASS** | Roles `{A: Adjuster, B: Claimant}` 100% correct. Custom formatting appears only in `speech_understanding.response`, not in `text` |
| A4b | Golden request: redaction + unredacted + inline SU | – | **PASS** | Done in 11.4 s. `custom_formatting` of a field you also redact returns 400. Translation is made from the redacted text |
| A5 | Post-hoc `POST llm-gateway…/v1/understanding` | C29 | **PASS** | Works without Gateway model access. **Limited to 2 requests / 60 s**. Results are not saved back to the transcript |
| A6 | `/sentences`, `/paragraphs` | – | **PASS** | Sentences carry the correct speaker. Paragraphs have no `speaker` |
| A7 | Multichannel stereo | – | **PASS** | 98.5% channel accuracy. `audio_duration` is not doubled (bill ×2 yourself). **Word times are 80 ms-quantized** |
| A8 | `speech_models` fallback + Hinglish detection | – | **PASS** | U3.5 Pro detected `hi` (0.88). Devanagari plus English, `481529` exact |
| G1 | Model catalog `/v1/models` | C26, C27 | **PASS** | No auth needed. 45 → 47 → 45 models within 30 min. Undocumented `providers[]` / `default_provider` |
| G2 | Access matrix | T7, C10 | **FAIL** (account) | 1/45 accessible (`qwen3.5-4b-32k-fast`, 2 rpm). 44 return the access 400 |
| G3 | Gateway auth | C4 | **PASS** | Raw and Bearer both work. A missing key gives a misleading "upgrade" 401 |
| G4 | Chat completions | – | **PARTIAL** | `gpt-5-nano` and `claude-sonnet-4-6` → access 400. qwen: 200, median 1.14 s |
| G5 | Structured outputs (`json_schema`) | – | **FAIL** (blocked) | Claude/OpenAI → access 400. qwen → 400 "does not support response_format" (unsupported parameters are **rejected**, not ignored) |
| G6 | Tool calling | – | **FAIL** (blocked) | Claude/OpenAI → access 400. qwen → 400 "does not support tools" |
| G7 | Streaming SSE | C9 | **PARTIAL** | qwen streams real SSE (not OpenAI-only). Claude streaming untestable |
| G8 | `transcript_id` + `{{ transcript }}` injection | – | **PASS** | Only the exact tag with spaces is substituted. Redacted transcripts inject redacted text |
| G9 | Regions (`model_region`, EU host) | C26 | **PARTIAL** | `model_region` accepts only `"global"`. The EU host lists 13 models and rejects qwen, although the US catalog says qwen runs in `eu` |
| G10 | `fallbacks` + `json-repair` | – | **PARTIAL** | `json-repair` turns invalid JSON into valid JSON. `fallbacks` do not rescue validation or access errors |
| G11 | Offline client self-test | – | **PASS** | 16/16 (re-run today: 16/16) |

### 1.4 OpenAI (10d): 8 PASS, 1 PARTIAL

| # | Test | Status | Key evidence |
|---|---|---|---|
| t01 | `GET /v1/models` | **PASS** | 134 models. Picks: `gpt-6-astra` (reasoning), `gpt-6-sol` (balanced), `gpt-6-luna` (fast), `gpt-4o-mini-tts-2025-12-15` (TTS). Every object carries `shutdown_date` |
| t04 | Parameter probe (51 cases) | **PASS** | Default effort is `medium`. `minimal` is rejected everywhere, and `none` is rejected on astra. `temperature` works only with effort `none`. `max_output_tokens` must be ≥ 16 |
| t02 | Structured output: claim fact graph | **PASS** | All 4 configs found the 5 p.m. vs 7 p.m. contradiction with verbatim quotes. sol/low and astra/low scored 17/17 |
| t03 / t03b | Responses function calling, round trip | **PASS** | Parallel calls with normalized arguments (`HP7740391`). Stateless replay and `previous_response_id` both work |
| t05 | Responses streaming latency | **PASS** | Median time to first token: luna/none 1.17 s, luna/low 1.12 s, sol/low 1.18 s, astra/low 2.23 s. Default effort adds about 0.5 s |
| t08 | Agents SDK `@openai/agents@0.18.0` | **PASS** | Tools plus a zod `outputType` work, streamed and not. The SDK default model is `gpt-5.6-luna` |
| t06 | Streaming TTS to PCM | **PASS** | Time to first byte, median 896 ms. 24 kHz / 16-bit / mono. **HTTP chunks are often odd-length** (a sample is split across chunks) |
| t07 / t07b | Chat Completions streaming + tools (the shape BYO `llm` needs) | **PARTIAL** | The wire format works. **GPT-5.6/6 models return 400 with tools unless `reasoning_effort:"none"`**. `gpt-4.1-mini` works as-is, first token in 592 ms |
| selftest | Offline helpers | **PASS** | 9/9 (re-run today: 9/9) |

---

## 2. Contradictions and tests from synthesis §7

### 2.1 Contradictions C1–C33

Status key: **Resolved** = settled live. **Partly** = the part that matters is settled, a sub-question remains. **Open** = not tested or not testable. **N/A** = not an API question.

| ID | Topic | Status | Resolved value | Evidence |
|---|---|---|---|---|
| C1 | Streaming model ID | **Resolved** | `universal-3-5-pro`. `universal-3-5-pro-realtime` is rejected (3006). The rejection text lists the 11-ID server enum | 10b §2.1, ST-1 |
| C2 | `u3-rt-pro` | **Resolved** (for today) | Still accepted on 2026-09-24. It echoes itself (no alias to 3.5) and finalized the first sentence worse. Never use it | 10b §2.1 |
| C3 | Keyterms price | **Open** | Not visible from the API. Check the billing dashboard | – |
| C4 | Auth header style | **Resolved** | **Voice Agent:** raw and `Bearer` both work on `/v1/token`, the WS header and REST. **Streaming:** both work on `/v3/token`; the WS header accepts **raw only** (Bearer → 1008). **Gateway:** both. **Async and `/v1/understanding`:** raw tested (Bearer not tried). Rule: send the raw key to every AssemblyAI endpoint | 10a §1, 10b §2.2, 10c G3 |
| C5 | `session.error` shape | **Resolved** | Voice Agent sends lower-case `code` (`unauthorized`, `invalid_value`, …), never `error_code`. `timestamp` is epoch seconds as a float. Config errors add `session_id` and `param`. The `error_code` claim describes the **Streaming** `Error` frame (numeric `error_code` plus `error` text) | 10a §3, 10b §2.15 |
| C6 | Client event set | **Partly** | All 7 client events exist and `conversation.message` is schema-validated (`role: user\|system`, string `content`), **but its content never reaches the model**. Use `reply.create.instructions` or `session.update {system_prompt}`. `session.resume` was not exercised | 10a §6 |
| C7 | `tool.call` for HTTP tools | **Resolved** (starter repo right) | An informational `tool.call` reaches the client. AssemblyAI runs the HTTP call itself. Never send `tool.result` for it | 10a §9 |
| C8 | Voice catalog | **Resolved** | 18 voices (§3.4). `ivy`, `claire` and `dawn` are invalid | 10a §3 |
| C9 | BYO LLM via the Gateway / streaming | **Partly** | Inline `llm` is rejected (fatal); BYO needs a stored agent. OpenAI direct `gpt-4.1-mini` works (+~1 s on tool turns). **Every Gateway BYO config fails silently** on this account. Gateway streaming is **not** OpenAI-only (qwen streams SSE). GPT-5.6/6 on Chat Completions with tools need `reasoning_effort:"none"`. **Open:** Gateway Claude as BYO (needs access), and what AssemblyAI sends to a BYO endpoint | 10a §10, 10c G7, 10d t07b |
| C10 | Gateway access | **Resolved** (Claim A confirmed) | 44 of 45 models return `400 "Your account does not have access to this LLM Gateway model"`. The $50 credit does not unlock them. `qwen3.5-4b-32k-fast` is callable at 2 rpm | 10a §10, 10b §2.11, 10c G2 |
| C11 | $50 free credit | **Open** | Not visible from the API. Check the dashboard balance | – |
| C12 | Streaming concurrency close code | **Open** | Not reproduced (the spike held itself to ≤4 opens/min). 1008 is also used for every auth failure, so match 1008 and 3009 by message text | 10b §2.15 |
| C13 | `interruption_delay` server add | **Partly** | Onset to `SpeechStarted` is about 575 ms at `interruption_delay=0` (min_latency). The balanced minus min_latency gap is about 590 ms. The fixed add cannot be separated from outside; budget about 0.6 s | 10b §2.4 |
| C14 | U3.5 Pro streaming defaults | **Open** (unobservable) | `Begin.configuration` echoes only 8 fields, so defaults for `min_turn_silence`, `vad_threshold` etc. cannot be read. Set `mode` (and any tuning) explicitly | 10b §2.4, §2.9 |
| C15 | `agent_context` limit | **Resolved** | 1750 chars for `agent_context` and `prompt`. Exceeding it closes the session with 3006, **even mid-stream**. `sanitizeParams` clips before sending | 10b §2.10 |
| C16 | `previous_context_n_turns` default | **Open** | Not tested. Set it explicitly if used | – |
| C17 | Streaming languages | **Resolved** (validator) | 33 values accepted, including `ca`, `ru`, `ko`, `yue`, `multi`. Only `hi`/`en` quality was tested. For Hinglish, list `en` first | 10b §2.10, §2.12 |
| C18 | Voice Agent EU host | **Partly** | No EU host was tested. Recordings from `agents.assemblyai.com` sessions are stored in S3 **eu-west-1** (`speech-to-speech-production-euw1-sessions`). Matters for any data-residency claim | 10a §11 |
| C19 | Agent host for SIP | **Resolved** | Agent ids are not shared: an agent from `agents.assemblyai.com` returns 404 `agent_not_found` on `agents.us`. `/v1/phone-numbers` exists on both hosts. Numbers are bound on `agents.us`, so create a SIP agent there (live SIP untested) | 10a §8, §12, §14 |
| C20 | Voice Agent concurrency | **Partly** | No limit hit: 2 concurrent sessions from one token worked. `at_capacity` and `concurrency_exceeded` handling stays in `client.ts` | 10a §2 |
| C21 | HTTP tool header masking | **Resolved** | On GET the value is **omitted** (`{name, last_set_at}`), not shown as `"***"`. Encrypted header blobs do appear in the timeline `config_changes` | 10a §9 |
| C22 | Stored-agent mid-session updates | **Resolved** | Works: on an `agent_id` session, later `session.update` of `system_prompt` and of `tools` each return `session.updated` and take effect. Progressive tool reveal works with stored agents | 10a §8 |
| C23 | `product=voice_agent` token param | **Resolved** | Accepted; no observable effect | 10a §1 |
| C24 | WS path | **Resolved** | `wss://agents.assemblyai.com/v1/ws` | 10a §1 |
| C25 | Pre-signed artifact → async | **Resolved** | `POST /v2/transcript` with the pre-signed OGG URL (`speech_models:["universal-3-5-pro"]`, `multichannel:true`) completes in about 4 s. ch1 = user, ch2 = agent. Artifacts appear about 7 s after the end (docs: ~90 s); URLs last 1 h | 10a §11 |
| C26 | Gateway global routing | **Partly** | The US catalog lists `global` on 22 models, including OpenAI `gpt-5.5`/`gpt-5.6-*`. `model_region` accepts only `"global"` (and accepted it even for qwen). The EU host serves 13 models and omits qwen. Claude global routing is untestable (C10) | 10c G1, G9 |
| C27 | Gateway catalog size | **Resolved** (volatile) | 45, then 47, then 45 models within 30 minutes. Always call `GET /v1/models` | 10c G1 |
| C28 | In-stream `llm_gateway` vs rate limit | **Open** (blocked) | Without access the parameter is silently ignored. This account's limit is 2 rpm per model (`x-ratelimit-service: llmgw`); Speech Understanding has its own 2 rpm. The `llm-stress` rig (~41 turns/min) is ready to re-run | 10b §2.11, 10c G2 |
| C29 | Speaker ID request shape | **Resolved** | Both `speakers:[{role\|name, description}]` and `known_values:[…]` work, with identical results. It also works on multichannel transcripts (`{"1":"Adjuster","2":"Claimant"}`) | 10c A5 |
| C30 | Hackathon counts, title length | N/A | Not an API question. Keep the title ≤ 50 chars | – |
| C31 | Judging weights | N/A | Not an API question | – |
| C32 | "Universal-3 Pro" on the event page | N/A | Pitch wording only. Say "Universal-3.5 Pro". (Async still accepts `universal-3-pro`; streaming rejects it) | 10c A2 |
| C33 | Sync STT, 333 free streaming hours | N/A | Not tested. Don't cite in the pitch | – |

**Still open:** C3, C11 (billing dashboard checks); C12, C14, C16 (not reproducible or not observable; mitigations are in `streaming/client.ts`); C28 and the Gateway half of C9 and C26 (blocked on Gateway access); C13, C18, C20 (partly answered; no further test needed for the hackathon).

### 2.2 Tests T1–T11

| ID | Result | One line |
|---|---|---|
| T1 | **PASS** | `universal-3-5-pro` is the streaming model ID (ST-1) |
| T2 | **PASS** (auth) / **FAIL** (lifetime) | Both auth styles work on the Voice Agent. Tokens are reusable, and the session cap is not enforced (VA-1, VA-2) |
| T3 | **PARTIAL** | `reply.create` works; `conversation.message` content is ignored (VA-7) |
| T4 | **PASS** | The HTTP tool works, and an informational `tool.call` reaches the client (VA-10) |
| T5 | **PASS** | 18 voices, `code` field (VA-3) |
| T6 | **PARTIAL** | BYO works with OpenAI direct only. Gateway BYO fails silently (VA-11) |
| T7 | **FAIL** (account) | The Gateway is locked except qwen (VA-12, G2) |
| T8 | **PASS** (read-only) | No SIP call was made; the μ-law session works (VA-14) |
| T9 | **PASS** | Stored agent plus mid-session updates (VA-9) |
| T10 | **PASS** | Recording → async multichannel (VA-13) |
| T11 | **SKIPPED** (blocked) | In-stream `llm_gateway` is silently ignored without access (ST-11) |

### 2.3 Synthesis §2 gotchas the live API contradicted

Update `00-synthesis.md` §2 mentally with these. The product code already follows the right-hand column.

| Synthesis claim | Live behaviour (2026-09-24) | Source |
|---|---|---|
| §2.2 Tokens are single-use | **Reusable** within `expires_in_seconds`, sequentially and concurrently, on both the Voice Agent and Streaming | VA-2, ST-2 |
| §2.2 `max_session_duration_seconds` is the real cap | **Not enforced** on the Voice Agent (a 60 s cap ran 102 s; `expires_at` is always now + ~3600 s). On Streaming it is reflected in `Begin.expires_at` (the cut-off itself was not observed) | VA-2, ST-2 |
| §2.2 Browser auth failures show only as a silent 1006 | Both APIs accept the upgrade, send an error frame, then close 1008. A browser sees the error | VA-1, ST-2 |
| §2.2 Streaming token endpoint needs the raw key | Bearer is also accepted at `/v3/token`; only the **WS header** rejects Bearer | ST-2 |
| §2.3 Faster-than-real-time Voice Agent audio is dropped with `audio_rate_violation` | Not reproduced at 3× for 7.3 s. Keep pacing at real time anyway | VA-15 |
| §2.3 Streaming is throttled to 1.25× | A 10× burst of a short clip was processed at about 1.0×, with no error | 10b §2.15 |
| §2.3 Check `Begin.configuration` to catch typos | Only 8 fields are echoed; turn, VAD, prompt, keyterm and language params are not | ST-9 |
| §2.3 Voice Agent artifacts appear about 90 s after the end; URLs are short-lived | About 7 s; pre-signed URLs last 1 h | VA-13 |
| §2.4 Send `tool.result` only when `reply.done` is the latest event | Sending it immediately is accepted and is about 1.0 s faster. Still drop results for interrupted replies | VA-8 |
| §2.4 Tool `parameters` are not validated | Partly validated (for example, `properties` must be an object) | VA-3 |
| §2.4 Stored-agent mid-session tool updates untested | They work (C22) | VA-9 |
| §2.5 `SpeechStarted` precedes the first `Turn` | Arrives in the same tick as the first partial: about 1.17 s after onset in `balanced`, about 0.58 s in `min_latency` | ST-3, ST-4 |
| §2.8 Demo budget relies on the token's session cap | The cap is not enforced. Enforce it in the client and the mint route | VA-2 |
| §2.9 `universal-3-pro` is rejected | Rejected on Streaming, **accepted** on async | ST-1, A2 |
| §2.9 `u3-rt-pro` cut off around Sep 25 | Still accepted on Sep 24; don't use it | ST-1 |
| §2.3 Voice Agent recording gives word timestamps for evidence | True, but multichannel async word times are 80 ms-quantized. Pad evidence clips by ±300 ms | A7, VA-13 |

---

## 3. Golden config for the product

Everything below was run live on 2026-09-24 unless marked *(untested)*.

### 3.1 Endpoints and auth

| Surface | Endpoint | Auth | Notes |
|---|---|---|---|
| Voice Agent token (server) | `GET https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=900` | `Authorization: <raw key>` (Bearer also works) | 200 `{token, expires_in_seconds}`. Errors: 422 FastAPI `{detail:[…]}`, **404** `{"detail":"Invalid API key"}` for a bad key. `max_session_duration_seconds` must be ≥ 60 |
| Voice Agent WS (browser) | `wss://agents.assemblyai.com/v1/ws?token=<token>` | token in query | Send the first `session.update` right after `open`; the server sends nothing before it |
| Voice Agent WS (Node, e.g. a Twilio bridge) | `wss://agents.assemblyai.com/v1/ws` | `Authorization: <raw key>` header | |
| Voice Agent REST | `https://agents.assemblyai.com/v1/{agents, sessions, sessions/{id}, webhook-subscriptions, phone-numbers}` | raw key | Agent ids are host-specific |
| Voice Agent SIP numbers | `https://agents.us.assemblyai.com/v1/phone-numbers/import`, `PUT …/phone-numbers/{n}/agent` *(untested)* | raw key | Create the SIP agent on `agents.us` too (C19) |
| Streaming token (server) | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=30&max_session_duration_seconds=900` | raw key (Bearer also works here) | `expires_in_seconds` 1–600; errors are 422 `{detail:[…]}` |
| Streaming WS (browser) | `wss://streaming.assemblyai.com/v3/ws?speech_model=universal-3-5-pro&sample_rate=16000&encoding=pcm_s16le&token=<token>` | token in query | Array params (`keyterms_prompt`, `language_codes`, `redact_pii_policies`) are JSON strings in the URL |
| Streaming WS (Node) | same URL without `token` | `Authorization: <raw key>`, **never Bearer** | |
| Async | `https://api.assemblyai.com/v2/{upload, transcript, transcript/{id}, …/sentences, …/paragraphs, …/redacted-audio}` | raw key | Never proxy audio through Vercel (4.5 MB body limit): pass `audio_url` |
| Speech Understanding (post-hoc) | `POST https://llm-gateway.assemblyai.com/v1/understanding` | raw key | **2 requests / 60 s.** Prefer inline SU in `/v2/transcript` |
| LLM Gateway | `https://llm-gateway.assemblyai.com/v1/chat/completions`; catalog `GET …/v1/models` (no auth) | raw or `Bearer` (OpenAI SDK) | EU: `llm-gateway.eu.assemblyai.com` (13 models) |
| OpenAI | `https://api.openai.com/v1/{responses, chat/completions, audio/speech, models}` | `Authorization: Bearer <OPENAI_API_KEY>` | |

**Token policy (both products):**
- Tokens are bearer credentials for their whole window. Mint **per connect**, with a short window (Voice Agent ≤ 60 s, Streaming 10–30 s).
- Authenticate and rate-limit the mint routes (`/api/va-token`, `/api/stt-token`).
- Minting takes 0.2–1.2 s, so pre-mint on page load or button hover.
- Never log tokens.

### 3.2 Model IDs

| Use | ID | Notes |
|---|---|---|
| Streaming STT | `speech_model=universal-3-5-pro` | Also accepted: `universal-streaming-english`, `universal-streaming-multilingual` (no Hindi). Do **not** use `u3-rt-pro`, `universal-3-6(-pro)`, `universal-3-7-preview`, `u3-rt-agent` or `whisper-rt` |
| Async STT | `speech_models: ["universal-3-5-pro", "universal-2"]` | U3.5 Pro is used; handles Hinglish natively (`hi`) |
| Voice Agent recording → async | `speech_models: ["universal-3-5-pro"]`, `multichannel: true` | ch1 = user, ch2 = agent; billed × 2 |
| Voice Agent LLM | **managed** (omit `llm`) | BYO: see §3.8 |
| LLM Gateway, today | `qwen3.5-4b-32k-fast` only | 2 rpm; no tools, no `response_format`; streams; `json-repair` works |
| LLM Gateway, after upgrade *(untested)* | `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `gpt-5-mini` | Gate every parameter on the model's `supported_parameters` (unsupported ones return 400). The catalog lacks `response_format` for `claude-opus-4-7/4-8/5/5-5`, `claude-sonnet-5`, `gpt-4.1`, `gpt-oss-20b`, `gpt-6-astra` |
| OpenAI: evidence / fact graph | `gpt-6-sol`, `reasoning.effort:"low"` | 17/17 on the claim fixture, about $0.02 per call |
| OpenAI: fast live pass, router, streamed voice text | `gpt-6-luna`, effort `"none"` (or `"low"`) | Time to first token about 1.1–1.2 s |
| OpenAI: hard offline reasoning | `gpt-6-astra`, effort `"low"` or higher (`none` is rejected) | About 5× sol's cost, 2× its latency |
| OpenAI: Voice Agent BYO `llm` | `gpt-4.1-mini` | GPT-5.6/6 fail on Chat Completions with tools unless `reasoning_effort:"none"`, which the BYO config cannot set |
| OpenAI TTS | `gpt-4o-mini-tts-2025-12-15` (pinned) | Voices `marin`, `cedar`. Don't use `tts-1` (slower) or `-2025-03-20` (past its `shutdown_date`) |
| Agents SDK | `@openai/agents@0.18.0` + `zod@^4` | Always set `model` (default is `gpt-5.6-luna`); decide on tracing (`setTracingDisabled`) |

Pin nothing in the Gateway without re-reading `GET /v1/models` (C27), and read `shutdown_date` from OpenAI `/v1/models` at startup or in CI.

### 3.3 Voice Agent voices (C8)

18 IDs: `alba`, `anna`, `charles`, `estelle`, `eve`, `george`, `giovanni`, `iris`, `jane`, `jean`, `juergen`, `lola`, `mary`, `michael`, `paul`, `rafael`, `reid`, `vera`.

- The tests used `alba`.
- Voice and greeting are **immutable** after the first `session.update`.
- A stored agent reads back `output.voice:"ivy"`, but the session uses `voice.voice_id`. Ignore the `ivy`.

### 3.4 Audio formats and chunk sizes

| Path | Format | Frame | Rules |
|---|---|---|---|
| Voice Agent in (browser) | PCM16 mono **24 kHz**, base64 in `{"type":"input.audio","audio":…}` | **50 ms = 2400 B** | Only after `session.ready`. Paced at mic speed. AudioContext at the device rate; resample inside the worklet |
| Voice Agent out | PCM16 24 kHz in `reply.audio.data` | **10 ms = 480 B**, at real-time pace | Jitter buffer about 100–200 ms. Flush on `input.speech.started` / `reply.done{status:"interrupted"}` |
| Voice Agent telephony | `{"encoding":"audio/pcmu"}` in and out (echoed as 8000 Hz) | in: **20 ms = 160 B**; out: **37.5 ms = 300 B** | `0xFF` is μ-law silence |
| Streaming in (browser) | **binary** PCM16 LE mono **16 kHz** | **50 ms = 1600 B** (hard limits 50–1000 ms, else 3007) | `browser-capture.ts` `startMicCapture`: device-rate context, anti-aliased resample, exact 800-sample frames |
| Streaming telephony | `encoding=pcm_mulaw&sample_rate=8000` | **100 ms = 800 B** (batch five Twilio 20 ms frames with `FrameBatcher`) | 8 kHz turns may merge more; tune `min_turn_silence` |
| OpenAI TTS | `response_format:"pcm"`, 24 kHz s16le mono | variable HTTP chunks, **often odd-length** | `openSpeechPcmStream()` carries the odd byte. For Twilio: `Pcm24kToMulaw8k` + `ByteFramer(160)` |
| Async upload | raw bytes to `/v2/upload`, or any fetchable `audio_url` | – | Pre-signed Voice Agent artifact URLs work directly |

**One mic, two sockets:** never feed the same mic to both the Voice Agent and Streaming STT. You pay twice and Streaming transcribes the agent.

### 3.5 Voice Agent session config and event rules

First message after `open` (inline config):

```jsonc
{"type":"session.update","session":{
  "system_prompt":"<identity first, then: never state order status/dates unless they came from a tool result>",
  "greeting":"Hi, you're speaking with <Brand>'s automated AI assistant, and this call may be recorded. How can I help?",
  // omit "greeting" for listen-first; greeting:null is rejected (invalid_format)
  "input":{"format":{"encoding":"audio/pcm","sample_rate":24000},"transcription_mode":"balanced"},
  "output":{"voice":"alba","format":{"encoding":"audio/pcm","sample_rate":24000}},
  "tools":[{"type":"function","name":"lookup_order","description":"…",
    "parameters":{"type":"object","required":["order_number"],"properties":{"order_number":{"type":"string",
      "pattern":" *([0-9] *){6}","examples":["481529","4 8 1 5 2 9"]}}}}]}}
```

Or `{"type":"session.update","session":{"agent_id":"agent_<hex>"}}` **alone** for a stored agent. Mixing `agent_id` with inline fields is fatal.

**Event handling rules:**
1. **Validate the config before connecting.** A bad first `session.update` (invalid voice, `agent_id` mixed with inline fields, unknown agent, inline `llm`) closes with 1008. Retry with a freshly minted token.
2. **Errors:** read lower-case `code` (`errorCode()`). `timestamp` is epoch seconds (float). Retryable: `at_capacity`, `concurrency_exceeded`, `internal_error`, `server_error`.
3. **Function tools:** answer `tool.call` with `{"type":"tool.result","call_id","result":"<JSON string>"}` **as soon as the handler returns** (`ToolDispatcher.policy = "immediate"`, about 1.0 s faster). Drop the result if the reply was interrupted. `call_id` looks like `chatcmpl-tool-…` (managed) or `call_…` (OpenAI BYO); `reply_id` is a normal `resp_…`.
4. **HTTP tools** (stored agents only): a `tool.call` still arrives. **Never answer it.** `ToolDispatcher` detects these from `session.ready.config.tools[].http`.
5. **Barge-in:** `input.speech.started`, `transcript.agent{interrupted:true}` and `reply.done{status:"interrupted"}` arrive together, 1.1–2.2 s after the user starts talking. Flush playback on the first of them.
6. **Silence:** every reply starts with 0.2–2 s of silent PCM, and tool pre-ambles are fully silent with no transcript. Show a "thinking" state from `reply.started` until `ReplyInfo.firstAudibleAtMs`. Measure latency to the first **audible** chunk.
7. **Captions:** `transcript.agent.delta` words arrive in one burst. Schedule them by `start_ms` relative to the reply's first audio. **`transcript.agent` can contain text that was never spoken** (after a premature end of turn). Don't caption replies whose `ReplyTracker.kind` is `unspoken_text` or `tool_preamble`.
8. **Mid-call context:** `session.update {system_prompt}` for durable changes (works on stored-agent sessions too); `replyNow(instructions)` for one turn (it can also trigger tools). **Do not rely on `conversation.message`.**
9. **Turn mode:** `balanced` by default. `min_latency` saves about 0.7 s on short questions (validate on ID capture first). Switch to `max_accuracy` (+1.3 s) only while capturing IDs. Don't set `min_silence`/`max_silence`.
10. **Ending:** always send `session.end`, wait for `session.ended`, then close (`s.end()`, also on `pagehide`). Enforce your own cap with `maxDurationMs` (for example 5 min). `session.ended.audio_duration_seconds` is always `null`.
11. **Evidence:** store `session_id`. About 7 s after the end, `GET /v1/sessions/{id}`, then `POST /v2/transcript {audio_url, speech_models:["universal-3-5-pro"], multichannel:true}` within the URL's 1 h lifetime. The timeline gives per-turn `time_to_first_audio_ms`, tool durations and interruptions (`time_to_first_audio_ms` is `null` on tool turns).

**Latency to expect:**

| Turn type | End of speech → first audible reply |
|---|---|
| Plain Q&A, `min_latency` | 2.1–2.6 s |
| Plain Q&A, `balanced` | 2.9–3.2 s (0.93 s endpointing on a long statement) |
| Plain Q&A, `max_accuracy` | 4.2–4.5 s |
| Tool turn, documented `tool.result` rule | +5.8 s (speech-triggered) |
| Tool turn, immediate `tool.result` | about 1.0 s less (2.84–2.89 s vs 3.79–3.99 s when triggered by `reply.create`) |

### 3.6 Streaming STT params and event rules

`GOLDEN_PARAMS = { speech_model: "universal-3-5-pro", sample_rate: 16000, encoding: "pcm_s16le" }`, plus per scenario:

| Scenario | Add | Notes |
|---|---|---|
| Live transcript / notes | `mode=balanced` (explicit) | Final about 420 ms after the last word |
| BYO voice agent / barge-in | `mode=min_latency` | Stop TTS on `SpeechStarted` or the first partial (they arrive together, ~0.58 s after onset). Push the actually spoken agent text via `UpdateConfiguration.agent_context` (≤ 1750 chars) |
| Two-party call with attribution | **one session per channel**, no `speaker_labels` | Exact attribution, 2× cost |
| Mono, unknown speakers | `speaker_labels=true&max_speakers=2` | Use word-level `speaker`, apply `SpeakerRevision`, expect lost words at ~10 s cuts; re-run async for entities |
| PII-safe capture | `redact_pii=true&redact_pii_policies=["person_name","phone_number","location_address","location_address_street"]&redact_pii_sub=entity_name` | Finals only; no partials |
| Hinglish | `language_codes=["en","hi"]&language_detection=true` | **English first** |
| Vocabulary | `keyterms_prompt=[…]` (≤ 100 items, ≤ 50 chars each) + `prompt=<20–50-word scenario>` (≤ 1750 chars) | Both together are accepted |
| Liveness | `session_heartbeat=true` | `Heartbeat` every 5.0 s with `realtime_factor` |

**Event rules:**
1. Replace partial text per `turn_order`; never append. A final has `end_of_turn:true`. Ignore empty finals. U3.5 Pro partials are already formatted (`TurnTracker` does all of this).
2. **The last turn needs audio to finalize.** When the mic pauses or a file ends, send about 1 s of silence or `ForceEndpoint`.
3. **Around entity questions**, send `{"type":"UpdateConfiguration","min_turn_silence":1000,"max_turn_silence":2500}`, then restore it (for example 200 / 1200). No ack comes back. **Never `ForceEndpoint` while the user may be mid-entity** (WER rose to 13.8%).
4. **Shutdown:** stop capture, send `{"type":"Terminate"}`, wait for `Termination` (0.6–1.3 s), then close. Billing runs from open to `Termination` in whole seconds; idle time is billed. Set `inactivity_timeout` as a server-side safety net.
5. **Errors:** parse the `Error` frame `{error_code, error}`; the close code equals `error_code`. Retry with a fresh token on 1006, 1011 and 3005. Don't retry 1008 (auth, or maybe rate limit: read the text), 3006 (input) or 3007 (frame size).
6. **Gateway watchdog:** if `llm_gateway` is set, treat "no `LLMGatewayResponse` within N s" as a failure; the server never reports it.
7. **Word timestamps** at turn edges absorb silence (first word ~1 s early, last word +0.24 to +1.3 s). Pad audio citations by about 1 s before and 0.3 s after, or use async word times.

### 3.7 Async golden request (claim call)

Run exactly as below in 10c A4b (PASS, 11.4 s), except `formal` and the webhook fields *(untested)*:

```jsonc
POST https://api.assemblyai.com/v2/transcript        // Authorization: <raw key>
{ "audio_url": "<upload_url or fresh pre-signed URL>",
  "speech_models": ["universal-3-5-pro", "universal-2"],
  "language_detection": false, "language_code": "en",   // echoes "en_us"
  "speaker_labels": true, "speakers_expected": 2,       // stereo: multichannel:true instead
  "keyterms_prompt": ["<insurer>", "<names>", "<streets>", "<IDs>"],
  "entity_detection": true,                             // entities are NOT redacted
  "redact_pii": true,
  "redact_pii_policies": ["person_name","phone_number","location","location_address","location_address_street","location_city",
                          "account_number","number_sequence","date","email_address","us_social_security_number","credit_card_number","date_of_birth"],
  "redact_pii_sub": "entity_name", "redact_pii_return_unredacted": true,
  "redact_pii_audio": true,                             // GET /redacted-audio; URL lives 30 min
  "speech_understanding": { "request": {
    "speaker_identification": { "speaker_type": "role", "known_values": ["Adjuster", "Claimant"] },
    "translation": { "target_languages": ["es"], "match_original_utterance": true, "formal": true } } },
  // NO custom_formatting of any field you also redact (400)
  "webhook_url": "https://<app>/api/aai/webhook?claim=<id>",
  "webhook_auth_header_name": "X-AAI-Webhook-Secret", "webhook_auth_header_value": "<random secret>" }
```

- Expect 7–20 s for a 70 s call. `audio_duration` is an integer rounded up.
- **Display:** `utterances[].speaker` already holds the role.
- **Internal analysis:** `unredacted_utterances` still say `A`/`B`; relabel with `applySpeakerMapping()`.
- `translated_texts.es` is made from the redacted text, so it is safe to share.
- **Avoid:** raw `sentiment_analysis_results` (wrong speakers, `[Speaker:x]` tags, unredacted PII) and `paragraphs` (no speaker).
- Unknown PII policy names are accepted silently, so validate against `PII_POLICIES`.

### 3.8 LLM choices

| Need | Choice now | After Gateway upgrade |
|---|---|---|
| Voice Agent LLM | **Managed** (omit `llm`) | Managed. Gateway Claude BYO needs a new T6 run first: it failed silently here |
| Voice Agent BYO (only if required) | Stored agent, `llm:[{"base_url":"https://api.openai.com/v1","model":"gpt-4.1-mini","api_key":"sk-…"}]` (+~1 s on tool turns). Watch for `ReplyTracker.kind === "silent_no_output"` and fall back | Re-test; consider a Vercel proxy that applies `normalizeChatBodyForReasoningModel()` if GPT-6 is wanted |
| Structured extraction, evidence graph | OpenAI Responses, `gpt-6-sol` effort `low`, strict `json_schema` | Gateway `claude-sonnet-4-6` with `response_format` (check `supported_parameters`) |
| Orchestrator tool loops | OpenAI Responses `runToolLoop()` (`gpt-6-luna` none/low) | Gateway `runToolLoop()` with `normalizeFinishReason()` |
| Short transcript summaries or labels | Gateway qwen with `transcript_id` + `{{ transcript }}` (2 rpm, demo only) or OpenAI | Gateway model of choice |
| Speaker roles, translation | Inline Speech Understanding in `/v2/transcript` | Same |

**OpenAI parameter rules** (400 otherwise):
- **Responses:** use `max_output_tokens` ≥ 16, `text.format`, `reasoning.effort`. `temperature`/`top_p` only with effort `none`. Effort values: luna/sol `none|low|medium|high|xhigh|max`; astra `low…max`; never `minimal`.
- **Chat Completions:** use `max_completion_tokens` (never `max_tokens` on reasoning models), `reasoning_effort` (max `xhigh`), and `reasoning_effort:"none"` whenever tools are present on GPT-5.6/6.
- **Always set effort explicitly.** The default `medium` adds about 0.5 s to the first token.
- Terminal stream events: `response.completed`, `response.incomplete`, `response.failed`, `error`. Handle `status:"incomplete"` (`IncompleteError`).

### 3.9 TTS (BYO pipeline only; the Voice Agent has its own voices)

`POST /v1/audio/speech {"model":"gpt-4o-mini-tts-2025-12-15","voice":"marin","response_format":"pcm","instructions":"<tone>"}`:
- First audio in about 0.7–1.0 s (median 896 ms); generation runs about 4× faster than real time.
- A sentence pipeline (`SentenceBuffer` + TTS) gives roughly 2 s to first audio from this network (about 1.1 s LLM plus 0.9 s TTS).
- `stream_format:"sse"` also works (`speech.audio.delta`, then `speech.audio.done`).

### 3.10 Cost controls

| Product | Rule |
|---|---|
| Voice Agent ($4.50/h) | `session.end` always (bare close bills 30 s more). Client cap `maxDurationMs`. Token window ≤ 60 s. Authenticated, rate-limited mint route. **The token's `max_session_duration_seconds` is not a cap** |
| Streaming ($0.45/h + add-ons) | `Terminate` → wait for `Termination` (un-terminated sessions bill up to 3 h). `inactivity_timeout`. Token `max_session_duration_seconds` (shows in `Begin.expires_at`) |
| Async ($0.21/h U3.5 Pro) | Multichannel bills × channels (`billableSeconds()`). SU tasks are priced per task |
| Gateway | Locked (qwen at 2 rpm). SU post-hoc is 2 rpm |
| OpenAI | `gpt-6-astra` costs about 5× sol per extraction ($0.10 vs $0.02 here). Use `store:false` unless `previous_response_id` is needed |

---

## 4. Blockers the user must act on

1. **Unlock the LLM Gateway (C10).**
   - **What:** in the AssemblyAI dashboard, add a payment method or upgrade the plan. The $50 credit alone does not unlock any OpenAI, Claude or Gemini Gateway model (44 of 45 return 400).
   - **Unblocks:** T7, Gateway structured outputs and tools (G5, G6), Gateway BYO for the Voice Agent (T6), in-stream `llm_gateway` and its rate limit (T11, C28), Claude global routing (C26), and presumably the 30 rpm limit instead of 2 rpm (unverified).
   - **Until then:** nothing is blocked for the product. Use the managed Voice Agent LLM and OpenAI directly, which matches the model-routing decision.
   - **After upgrading, re-run** (from `spikes/`): `npx tsx gateway/access.ts`, `npx tsx gateway/smoke.ts`, `npx tsx voice-agent/t6-byo-llm.ts`, `npx tsx streaming/smoke.ts llm llm-stress`.
2. **Decide how the public demo is gated.** Voice Agent tokens are reusable for their window and the session cap is not enforced (VA-2), so the product's own mint route is the only spend control. Choose the access rule for judges (for example a shared passcode or judge link, per-IP limits, and a daily session budget). At $4.50/h, 100 five-minute sessions cost about $37.50. Also check whether the dashboard offers usage alerts *(not verified)*.
3. **Approve a live telephony test, or drop telephony from scope.** Twilio credentials are present in `.env`, but no call was placed. A live test needs:
   - a public bridge server (Railway or Render, not Vercel Hobby), or importing the Twilio number into `agents.us.assemblyai.com` (this changes account state);
   - Twilio call minutes.

   The μ-law codec path already works (VA-14, ST-13).
4. **Decide on leftover data** (none of it is an agent or webhook; see §7):
   - About 35 Voice Agent session records. 9 are BYO sessions whose config holds an **encrypted** key envelope: 2 for the OpenAI key, 7 for the AssemblyAI key. Soft-delete them with `DELETE /v1/sessions/{id}` if wanted. Rotating the OpenAI key is optional; it was never stored in plaintext.
   - About 10 async transcripts (synthetic fixture audio). Deletion is permanent. 10c says they expire on a 30-day TTL.
   - 3 stored OpenAI responses (synthetic text). `DELETE /v1/responses/{id}`.
5. **Check the billing dashboard** for things the API cannot show: the remaining credit (C11), whether keyterms and add-ons are charged on U3.5 Pro streaming (C3), and actual spend versus §6.

---

## 5. Reusable modules (`spikes/`)

All of these type-check under TypeScript strict mode. The offline self-tests pass (§0).

### 5.1 Product-grade modules

| Module | Runs in | API (main exports) |
|---|---|---|
| `voice-agent/client.ts` (1206 lines) | Node; browser if `connectNode` is split out (see 5.3) | **Constants:** `VA_WS_URL`, `VA_REST_BASE`, `VA_US_REST_BASE`, `LLM_GATEWAY_BASE`, `VA_SAMPLE_RATE`, `tokenUrl(token)`. **`VoiceAgentRest(apiKey, {base, authStyle, onHttp})`:** `mintToken({expiresInSeconds, maxSessionDurationSeconds, product})`, `createAgent/getAgent/listAgents/updateAgent/deleteAgent`, `getSession`, `listSessions`, `waitForArtifacts`, `request`. **`VoiceAgentSession(ws, {onEvent, maxDurationMs})`:** `start(config)` → `session.ready`, `update(config)` → `session.updated \| session.error`, `on(type \| "*")`, `waitFor(type)`, `waitForClose`, `send`, `sendAudio(bytes)`, `replyNow(instructions?)`, `sendConversationMessage` (kept, but documented as ineffective), `end()`; properties `tools`, `replies`, `sessionId`, `ready`, `timeline`. **`ToolDispatcher`:** `policy: "reply_done" \| "immediate"`, `register(name, handler)`, `markServerSide(...)`, `traces`. **`ReplyTracker`:** `replies`, `onReplyDone`, `ReplyInfo {firstAudibleAtMs, leadingSilenceMs, words, interrupted, kind: speech \| tool_preamble \| unspoken_text \| silent_no_output}`. **`RealtimeAudioFeeder(session, {sampleRate, chunkMs, silenceByte})`:** `start`, `play(bytes)`, `clear`, `stop`, `idle`. **Node:** `connectNode({token \| apiKey, authStyle, url})`, `connectWithToken(rest, mint, opts)`. **Errors and helpers:** `SessionError`, `UpgradeRejectedError`, `VoiceAgentHttpError`, `errorCode()`, `RETRYABLE_ERROR_CODES`, `chunkLevelDb`, `bytesToBase64`, `base64ToBytes`, typed client and server event unions |
| `voice-agent/core-loop-config.ts` | any | `LOOKUP_ORDER_TOOL` (spoken-digit `pattern` + `examples`), `SYSTEM_PROMPT` (anti-fabrication rule), `GREETING` (AI disclosure + recording notice), `lookupOrder()` mock. Seed for product prompts |
| `streaming/client.ts` (842 lines) | Node + browser (`ws` loaded lazily, only for header auth) | `mintStreamingToken(apiKey, {expiresInSeconds, maxSessionDurationSeconds})`. `StreamingSession.connect({auth:{apiKey}\|{token}, params, baseUrl, connectTimeoutMs, factory, onFrame, sanitize, validateChunkDuration})` resolves on `Begin`. Session: `on("turn" \| "speechStarted" \| "speakerRevision" \| "heartbeat" \| "llmGatewayResponse" \| "silence" \| "warning" \| "error" \| "termination" \| "message" \| "close")`, `sendAudio` (enforces 50–1000 ms), `updateConfiguration` (auto-clipped), `forceEndpoint`, `keepAlive`, `sendRaw`, `terminate({timeoutMs})` → `Termination \| null`, `abort`. Helpers: `buildStreamingUrl`, `sanitizeParams`, `LIMITS`, `GOLDEN_PARAMS`, `PRESETS.{voiceAgent, telephony, hinglish, pii}`, `ACCEPTED_LANGUAGE_CODES`, `CLOSE_CODES`, `isRetryableClose`, `FrameBatcher`, `streamAudioPaced`, `TurnTracker`. Errors: `StreamingHttpError`, `StreamingConnectError.details` |
| `streaming/browser-capture.ts` | browser | `startMicCapture({onFrame(pcm, samplesSent), targetRate, chunkMs, deviceId})` → `MicCapture`; `CAPTURE_WORKLET_SOURCE`, `PCM16_DOWNSAMPLER_JS` (a plain JS string loaded through a Blob URL), `CAPTURE_PROCESSOR_NAME`. Tested in a `vm` sandbox and a live Node run, **not yet in a real browser** |
| `async/client.ts` (620 lines) | Node / Vercel (no dependencies) | `AssemblyAIAsyncClient({apiKey, region, fetch, timeoutMs, getRetries, rateLimitRetries, onRateLimit})`: `upload`, `submit`, `get`, `waitForCompletion`, `transcribe`, `sentences`, `paragraphs`, `redactedAudio`, `waitForRedactedAudio`, `wordSearch`, `subtitles`, `delete`, `understanding` (retries 429 using `retry-after`). Webhooks: `webhookParams`, `verifyWebhookHeader` (constant-time), `parseWebhook`. Helpers: `formatUtterances`, `stripSpeakerTags`, `reattributeSentiment` (38.5% → 96.6%), `applySpeakerMapping`, `billableSeconds`. Types: `TranscriptParams`, `Transcript`, `UnderstandingResult`, …, `PII_POLICIES` (51). Errors: `AssemblyAIHttpError`, `TranscriptFailedError` |
| `gateway/client.ts` (325 lines) | Node / Vercel (`openai` SDK) | `createGatewayClient({apiKey, region, fetch, maxRetries, timeoutMs})` → `OpenAI` (never falls back to `OPENAI_API_KEY`). `listGatewayModels`, `modelSupports`, `unsupportedParams` (pre-flight check). `gatewayChat` → `{completion, ms, headers}`, `gatewayStream` → `{text, ttftMs, totalMs, finishReason, usage}`, `runToolLoop`. Helpers: `normalizeFinishReason`, `completionText`, `parseJsonContent`, `extractToolCalls`, `usageTokens`, `jsonSchemaFormat`, `TRANSCRIPT_TAG`. Claude/GPT paths are covered offline only |
| `openai/client.ts` (760 lines) | Node / Vercel (`openai` 7.x + `lib/audio.ts`) | `MODELS`, `createOpenAI`, `pickModels`, `listModelIds`. `extractStructured` (`RefusalError`, `IncompleteError`). `ToolSpec`, `toResponsesTool`, `toChatTool`, `runToolLoop` (replay or `previous_response_id`). `streamText`, `SentenceBuffer`. `openSpeechPcmStream`, `TTS_PCM_RATE`, `StreamingDecimator`, `Pcm24kToMulaw8k`, `ByteFramer`. `streamChat`, `normalizeChatBodyForReasoningModel` |
| `openai/claim-schema.ts` | any | `CLAIM_FACT_GRAPH_FORMAT` (strict schema: parties, timestamped facts, contradictions, open questions), `CLAIM_EXTRACTION_INSTRUCTIONS`, `ClaimFactGraph` types, `formatTranscript`, `scoreGraph`, `loadDialog` |
| `lib/audio.ts`, `lib/wav.ts` | Node (`audio.ts` also usable in the browser) | Resampling with anti-aliasing, channel split/merge, μ-law encode/decode, chunking, a real-time `pace`/`paceAudio` generator, silence, levels, trim. WAV read/write, including streaming and μ-law WAV headers |

### 5.2 Test tooling (keep in the repo, don't ship)

- `voice-agent/harness.ts`: logger wiring, `Recorder`, `speechTurn`/`awaitTurn` metrics, `firstAudibleAfter`, `loadFixturePcm`, `transcribeWav`.
- `streaming/harness.ts`: logged session runner, cross-process open-rate guard, WER, entity and diarization scoring.
- `async/compare.ts`, `async/http-log.ts`.
- `lib/log.ts`: JSONL logger with audio and secret redaction, `loggedFetch`.
- `lib/env.ts`: reads `../.env` as an import side effect and requires both keys.
- `lib/tts.ts`: cached OpenAI TTS for fixtures.
- Fixtures: `fixtures/*.wav`, `question_8k.mulaw`, `dialog_script.json` (ground truth, including the 5 p.m. vs 7 p.m. contradiction), `codeswitch_script.json`.
- Utilities: `voice-agent/scan-secrets.ts`, `voice-agent/cleanup-check.ts`, `voice-agent/check-llm-exposure.ts`.

### 5.3 Fix when promoting to the product

1. `voice-agent/client.ts` imports `ws` at the top level. Move `connectNode`/`connectWithToken` into a Node-only file so the browser bundle does not pull in `ws`.
2. `openai/client.ts`:
   - The `MODELS.fast` comment calls `gpt-6-luna` the "BYO Voice Agent LLM", but t07b shows it fails with tools on Chat Completions. Use `gpt-4.1-mini` for BYO.
   - The `ReasoningEffort` type still includes `minimal`, which the API rejects.
3. `async/` and `gateway/` are not in the root `tsconfig.json` `include`; they have their own tsconfigs. Merge them when promoting.
4. `streaming/selftest.ts` prints "9 checks passed" before its 10th (async) check prints `ok`. Cosmetic.
5. `lib/env.ts` is spike-specific (fixed `.env` path, both keys mandatory). The product needs its own env handling (Vercel env vars).

---

## 6. Approximate spend

| Area | Usage | Estimate |
|---|---|---|
| Voice Agent (10a) | 31 sessions, 707 s at $4.50/h | **$0.88** |
| Streaming STT (10b) | 870 billed session-seconds at $0.45/h, add-ons negligible | **$0.11** |
| Async + Speech Understanding + Gateway (10c) | About 395 billable audio-seconds, 9 SU task calls, about 25 qwen calls | **$0.04** |
| Async on Voice Agent recordings (10a T10) | A few multichannel jobs on short recordings | about $0.01 |
| OpenAI (10d) | Models, structured output (one `gpt-6-astra` call was $0.10), tools, streaming, TTS, Agents SDK | **$0.20** |
| OpenAI (fixtures, validation, 10a probes) | TTS for fixtures and barge-in clips, `gpt-4o-transcribe` checks, `gpt-4.1-mini` probes | about $0.03 |
| **Total** | | **about $1.27**: about $1.04 of AssemblyAI credit and about $0.23 on the OpenAI key |

Re-running the Gateway suites after an upgrade (blocker 1) should add well under $0.50.

---

## 7. Leftover artifacts on the accounts

| Where | What | State |
|---|---|---|
| Voice Agent, both hosts | Stored agents, webhook subscriptions, phone numbers | **0 / 0 / 0**, confirmed by `cleanup-check.ts` at 01:20 UTC |
| Voice Agent sessions | About 35 session records. 9 BYO records hold an encrypted `llm` key envelope (2 OpenAI, 7 AssemblyAI) | Not deleted (outside the task's cleanup scope). `DELETE /v1/sessions/{id}` soft-deletes |
| Async transcripts | 10 from 10c (IDs in 10c §7), plus the multichannel transcripts of Voice Agent recordings from 10a T10 | Not deleted (deletion is permanent) |
| Streaming | – | Creates no server-side objects |
| OpenAI | 3 stored responses (IDs in 10d header). No files, assistants or agents | Not deleted |

---

## 8. Not tested yet (next checks, none blocking)

- **A real microphone in real browsers** (Chrome, Firefox, Safari) for both the Voice Agent and the Streaming worklet. Everything so far used paced fixture audio.
- **Noisy, accented or crosstalk audio.** All fixtures are clean TTS, so 0% WER is an upper bound.
- **Voice Agent:** `session.resume`, `hold` execution mode, voice focus, webhooks (`X-AAI-Signature`), and the EU host (C18).
- **Streaming:** `voice_focus`, `domain=medical-v1`, `previous_context_n_turns` (C16), `interruption_delay` overrides, opus/ogg/aac encodings, EU/US data-zone hosts, and the concurrency close code (C12).
- **Async:** webhooks end to end (needs a public URL), inline summarization.
- **OpenAI:** Responses over WebSocket (`setOpenAIResponsesTransport('websocket')`).
- **Open question for T6:** what AssemblyAI sends to a BYO `llm` endpoint (`reasoning_effort`? `max_tokens`?). Test with a request-capturing proxy as `base_url` before using any GPT-5.6/6 model there.
