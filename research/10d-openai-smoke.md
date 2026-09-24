# 10d: OpenAI platform smoke test (orchestration agents, BYO TTS, BYO LLM)

Run on 2026-09-24 against `api.openai.com` with this project's key. The requests came from India and hit Cloudflare's NAG edge, so all latencies below include that network path.

- Environment: Node v24.20.0, `openai@7.23.0`, `@openai/agents@0.18.0` with `zod@4.6.5`.
- Code: `spikes/openai/`. Logs: `spikes/out/openai-*.jsonl`.
- Spend: about **$0.20** in total. Most of it ($0.10) was one `gpt-6-astra` extraction.
- Keys were never printed. A scan of every output and source file found 0 key values and 0 base64 dumps. Cloudflare `set-cookie` headers were redacted from the logs.
- No agents, webhooks or files were created.
- Three responses were stored server-side, because `previous_response_id` needs `store:true` and the SDK's default agent stores. They contain only synthetic fixture text and were not deleted. To remove them, call `DELETE /v1/responses/{id}` on:
  - `resp_0d89cd60049d8a16006ab4731b3f8887d08328c74dfbaafe50` (t03 B)
  - `resp_0d89cd60049d8a16006ab4731d02dc87d0a37f342fdce6d4d9` (t03 B)
  - `resp_0c4011696eaf76f5006ab47555d69087d0b433a90cc8e1afa1` (t08 C)
- Every other call used `store:false`.

## Summary

| # | Test | Status | One-line result |
|---|---|---|---|
| t01 | `GET /v1/models` | **PASS** | 134 models. Best reasoning `gpt-6-astra`, balanced `gpt-6-sol`, fast/cheap `gpt-6-luna`, TTS `gpt-4o-mini-tts-2025-12-15`, speech-to-speech `gpt-realtime-2.1` (the "realtime" pick). Objects now carry `shutdown_date` |
| t04 | Parameter probe (51 cases: 32 accepted, 19 rejected) | **PASS** | Default `reasoning.effort` is `medium` on all GPT-6 models. `minimal` is rejected everywhere. `gpt-6-astra` rejects `none`. `temperature`/`top_p` work only with effort `none`. `max_output_tokens` must be ≥ 16 |
| t02 | Responses structured output (claim fact graph) | **PASS** | All 4 configs found the 5 p.m./7 p.m. contradiction with correct turn timestamps and verbatim quotes. sol and astra scored 17/17, luna 16/17 |
| t03 / t03b | Responses function calling, 2 tools, round trip | **PASS** | Parallel calls with normalized arguments (`HP7740391`, `CL44812`). Both stateless replay (`store:false`) and `previous_response_id` work |
| t05 | Responses streaming and latency | **PASS** | Median TTFT: luna/none 1.17 s, luna/low 1.12 s, luna/default 1.70 s, sol/low 1.18 s, astra/low 2.23 s |
| t08 | Agents SDK (`@openai/agents`) | **PASS** | Installs in isolation in 23 s (25 packages). Tool + zod `outputType` works in both streamed and non-streamed runs. The SDK's default model is `gpt-5.6-luna` |
| t06 | Streaming TTS to PCM | **PASS** | TTFB median 896 ms (702–966) for `gpt-4o-mini-tts-2025-12-15` with marin and cedar. Header confirmed as 24 kHz / 16-bit / mono. **HTTP chunks often have odd byte lengths** |
| t07 / t07b | Chat Completions streaming + tools (Voice Agent BYO `llm`) | **PARTIAL** | The streaming wire format and tool round trip work. However, **GPT-5.6/6 models return 400 on `/v1/chat/completions` with tools unless `reasoning_effort:"none"` is sent**, and the default effort is `medium` (C9 / T6 risk) |
| selftest | Offline checks of `client.ts` helpers | **PASS** | 9/9. The streaming 24k→8k mu-law output is bit-identical to the batch `lib/audio.ts` path |

---

## t01: `GET /v1/models`

**Request.** `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`. Then `GET /v1/models/{id}` for 15 ids (`openai/t01-models.ts`).

**Observed.**
- The list call returned 200 in 1477 ms (`openai-processing-ms: 755`): `{"object":"list","data":[…134…]}`.
- Every object now has the shape `{"id","object":"model","created","owned_by","shutdown_date"}`.
- Retrieve example: `{"id":"gpt-6-astra","object":"model","created":1787853604,"owned_by":"system","shutdown_date":null}`.
- Error for an id this key cannot see: `404 {"error":{"message":"The model 'gpt-5.6-cyber' does not exist","type":"invalid_request_error","param":"model","code":"model_not_found"}}`.
- 404 for this key: `gpt-5.6-cyber`, `gpt-daybreak-blue-latest`, `gpt-rosalind-research` (trusted-access models).
- 200: `chat-latest`, `gpt-live-1`, `gpt-transcribe`, the `gpt-5.6-*` models, and the alias `gpt-4o-mini-tts`.

**Model picks for this key.** The full list is in `spikes/out/openai_models.json`.

| Role | Id | Notes |
|---|---|---|
| Best reasoning | `gpt-6-astra` | created 2026-08-27, `shutdown_date:null` |
| Balanced | `gpt-6-sol` | created 2026-09-14 |
| Fast/cheap | `gpt-6-luna` | created 2026-09-14. `gpt-5.6-luna` / `-terra` / `-sol` are also available |
| TTS | `gpt-4o-mini-tts-2025-12-15` (pin this) | Also `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`, `-1106` variants, and `gpt-4o-mini-tts-2025-03-20`, which is **past its `shutdown_date` of 2026-07-23 but still served** |
| Realtime / live | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-live-1`, `gpt-realtime-translate`, `gpt-realtime-whisper` | Legacy `gpt-realtime` and `gpt-realtime-mini` have `shutdown_date` 2027-01-20 |
| Transcribe | `gpt-transcribe` (batch), `gpt-live-transcribe` (streaming) | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `-diarize` have `shutdown_date` 2027-02-26 |

**Conclusion.**
- `pickModels()` in `client.ts` reproduces these picks from any id list.
- Use `shutdown_date` from `/v1/models` as the automated deprecation check.

## t04: Parameter-name probe (Responses vs Chat Completions)

**Request.**
- Input "Reply with the single word OK." with `max_output_tokens: 64` and `store: false`.
- 51 variants across models (`openai/t04-param-probe.ts`).

**Observed.** Error strings are verbatim, with the leading "400 " trimmed.

| API | Case | Result |
|---|---|---|
| Responses | no `reasoning` | 200. The response echoes `"reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null}` on luna, sol and astra |
| Responses | `reasoning.effort` = none, low, medium, high, xhigh, max (luna, sol) | 200 |
| Responses | `reasoning.effort:"minimal"` (luna, sol, astra) | `Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.` |
| Responses | `reasoning.effort:"none"` (astra) | `Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.` |
| Responses | `temperature:0.2` at default effort | `Unsupported parameter: 'temperature' is not supported with this model.` |
| Responses | `temperature` or `top_p` with `effort:"none"` | 200. Echoes `temperature: 0.2` |
| Responses | `text.verbosity:"low"`, `prompt_cache_key` | 200 |
| Responses | `reasoning.summary:"auto"` | 200. Echoes `summary: "detailed"` |
| Responses | `service_tier`: `fast`, `priority`, `flex` | 200. **Both `priority` and `fast` echo `service_tier:"fast"`** |
| Responses | `max_output_tokens:8` | `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 8 instead.` |
| Responses | `max_tokens` | `Unknown parameter: 'max_tokens'.` |
| Responses | `response_format` | `Unsupported parameter: 'response_format'. In the Responses API, this parameter has moved to 'text.format'.` |
| Responses | `reasoning_effort` | `Unsupported parameter: 'reasoning_effort'. In the Responses API, this parameter has moved to 'reasoning.effort'.` |
| Responses | strict `json_schema` with `pattern` and `format:"date"` | 200. Output: `{"word":"OK","policy":"HP7740391","date":"2026-09-15"}` |
| Responses | strict schema without `additionalProperties:false` | `Invalid schema for response_format 'bad_probe': In context=(), 'additionalProperties' is required to be supplied and to be false.` |
| Responses | strict schema with a key missing from `required` | `… 'required' is required to be supplied and to be an array including every key in properties. Missing 'extra'.` |
| Chat | `reasoning_effort` = none, low | 200 |
| Chat | `reasoning_effort` = minimal or **max** (luna) | `Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.` |
| Chat | `max_tokens:64` (luna, even with effort `none`) | `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.` |
| Chat | `temperature:0.7` at default effort (gpt-6-luna, gpt-5.6-luna) | `Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.` |
| Chat | `temperature:0.7` + `reasoning_effort:"none"` | 200 |
| Chat | `reasoning:{effort}` (Responses-style name) | `Unknown parameter: 'reasoning'.` |
| Chat | `response_format` `json_schema` strict, `verbosity` | 200 |
| Chat | gpt-4.1-mini with `max_tokens` + `temperature` | 200 (non-reasoning model) |

**Conclusion.**
- `reasoning.effort` values:
  - luna and sol: `none | low | medium | high | xhigh | max`.
  - astra: `low | medium | high | xhigh | max`.
  - The SDK type still lists `minimal`, which the API rejects.
- Chat Completions caps effort at `xhigh`.
- All three GPT-6 models default to `medium`.

## t02: Responses structured output, claim fact graph

**Request** (`openai/t02-structured.ts`, schema in `openai/claim-schema.ts`):

```jsonc
POST /v1/responses
{ "model": "gpt-6-sol", "instructions": "You are a claims-investigation analyst. Build a fact graph …",
  "input": "Call date: 2026-09-24. …\n\nTranscript:\n[t0 0-4750ms] adjuster (Daniel Reyes): Harbor Point claims, … \n[t3 13440-21660ms] claimant (Priya Shah): I was rear-ended on Tuesday, September 15th, around 5 p.m., …",
  "text": { "format": { "type": "json_schema", "name": "claim_fact_graph", "strict": true,
                        "description": "Parties, timestamped facts and contradictions …",
                        "schema": { "type": "object", "additionalProperties": false,
                                    "required": ["parties","facts","contradictions","open_questions"], … } } },
  "reasoning": { "effort": "low" }, "max_output_tokens": 12000, "store": false }
```

In the schema, every fact carries `{id, kind (enum), subject_party_id|null, asserted_by_party_id, value, normalized|null, turn_index, start_ms, end_ms, quote}`. Every contradiction carries `{id, topic, fact_ids[], description, severity, flagged_in_call}`.

**Observed.**
- Response shape: `{"status":"completed","reasoning":{"context":"all_turns","effort":"low",…},"output":[{"type":"reasoning",…},{"type":"message","content":[{"type":"output_text","text":"{\"parties\":[{\"id\":\"P1\",\"name\":\"Daniel Reyes\",\"role\":\"adjuster\",…"}]}]}`.
- The graphs are saved in `spikes/out/openai_claim_graph_<model>_<effort>.json`.

| Config | Wall time | Input / output tokens (reasoning) | Cost | Score (17 checks) | Contradiction found |
|---|---|---|---|---|---|
| gpt-6-luna / none | 10.0 s | 1193 / 1665 (0) | $0.0010 | 16/17 | t3 vs t9, but `flagged_in_call:true` (wrong) |
| gpt-6-luna / low | 17.0 s | 1193 / 2562 (244) | $0.0014 | 16/17 | same `flagged_in_call` error |
| gpt-6-sol / low | 25.9 s | 1193 / 1938 (203) | $0.0218 | **17/17** | `{"topic":"Accident time","fact_ids":["F5","F14"],"description":"Priya Shah first said the accident happened around 5 p.m., then said it happened around 7 p.m.","severity":"high","flagged_in_call":false}` |
| gpt-6-astra / low | 22.8 s | 1193 / 1851 (0) | $0.1045 | **17/17** | same, `severity:"medium"` |

The 17 checks cover:
- 3 people and Lakeside Auto Body.
- `HP7740391`, `CL44812`, `4155550137`, $3450, $125 and $500.
- The date `2026-09-15`, and the times 17:00 and 19:00.
- The t3/t9 contradiction and its `flagged_in_call:false`.
- Every fact's timestamps equal its turn's timestamps, and every quote is a verbatim substring of its turn.

All models passed both grounding checks. luna/low, sol and astra also raised the "No [injury], just a sore neck" ambiguity as an open question without being asked; luna/none did not.

**Incomplete path.** Setting `max_output_tokens:200` gave `status:"incomplete"` with `incomplete_details.reason:"max_output_tokens"` and 660 characters of truncated JSON in `output_text`. `extractStructured()` raises `IncompleteError` instead of calling `JSON.parse` on that fragment. No refusal was observed.

**Conclusion.**
- Strict `json_schema` works on every GPT-6 tier.
- For judge-facing evidence, use `gpt-6-sol` with effort `low` (about $0.02 per call).
- Use `gpt-6-luna` with effort `none` for cheap live passes. It gets the facts and the contradiction right but misjudges the meta-field.

## t03 / t03b: Responses function calling with a round trip

**Request.**
- Tools use the flat shape: `{type:"function", name:"lookup_policy", description, parameters:{type:"object",additionalProperties:false,required:["policy_number"],properties:{policy_number:{type:"string",description:"… uppercase, no spaces …"}}}, strict:true}`. `get_claim_status` has the same shape.
- User turn: *"… my policy is H P 7 7 4 0 3 9 1 and my claim number is C L 4 4 8 1 2. Is my policy active, what's my deductible, and when will the appraiser call me?"*

**Observed** (round 1 output item, verbatim):

```json
{"id":"fc_07bee283…","type":"function_call","status":"completed","arguments":"{\"policy_number\":\"HP7740391\"}","call_id":"call_nEL663B7gtVfzrYMHl2GBhy5","name":"lookup_policy"}
```

| Case | Rounds (ms) | Calls | Final text |
|---|---|---|---|
| A: luna, replay, `store:false` | 2 (1709 + 1632) | both tools in parallel in round 1, arguments normalized | "Your policy is active, and your deductible is $500. The appraiser is scheduled to call Friday at 10:00 local time." |
| B: luna, `previous_response_id` | 2 (1793 + 1681) | same | same content |
| C: sol, replay, `store:false` | 2 (1770 + 2213) | same | "… call you Friday at 10 a.m. local time." |
| E: luna, `tool_choice:{type:"function",name:"lookup_policy"}` | 1 | only `lookup_policy` | |

t03b forced a reasoning item using effort `xhigh` and an ambiguous prompt. Round 1 then contained `reasoning` plus two `function_call` items:

- **D1 (no `include`):** accepted. The reasoning item still came back as `{"type":"reasoning","content":[],"encrypted_content":"<1548 chars>","summary":[]}`.
- **D2 (`include:["reasoning.encrypted_content"]`):** accepted.
- **D3 (reasoning item dropped from the replay):** also accepted.

**Conclusion.**
- For a stateless loop, replay `toResponseInputItems(response.output)` plus `{type:"function_call_output", call_id, output:"<JSON string>"}`.
- `toResponseInputItems` is exported from `openai/lib/responses/ResponseInputItems`, as research 09 §3.2 said.
- With `previous_response_id`, you must resend `instructions` because they are not inherited.

## t05: Responses streaming and latency

**Request.** `{model, instructions:"…two short spoken sentences…", input:"Hi, my claim number is CL44812. …", stream:true, store:false, max_output_tokens:400, reasoning:{effort}}`, with 3 repetitions per config.

**Observed event sequence** (gpt-6-luna/none, verbatim types): `response.created → response.in_progress → response.output_item.added → response.content_part.added → response.output_text.delta ×50 → response.output_text.done → response.content_part.done → response.output_item.done → response.completed`.

Sample events:

```json
{"type":"response.output_item.added","item":{"id":"msg_01c7…","type":"message","status":"in_progress","content":[],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":2}
{"type":"response.output_text.delta","content_index":0,"delta":"I","item_id":"msg_01c7…","logprobs":[],"obfuscation":"s4rcFFKgkePUzok","output_index":0,"sequence_number":4}
```

A streamed tool call goes `response.output_item.added → response.function_call_arguments.delta ×9 → response.function_call_arguments.done → response.output_item.done → response.completed`. The argument deltas were `["{\"","policy","_number","\":\"","HP","774","039","1","\"}"]`.

| Config (n=3) | First event, median | **TTFT median (min–max)** | Total median | Reasoning tokens |
|---|---|---|---|---|
| gpt-6-luna / none | 985 ms | **1172 ms** (828–1292) | 1762 ms | 0 |
| gpt-6-luna / low | 547 ms | **1122 ms** (697–1355) | 1898 ms | 0–48 |
| gpt-6-luna / default (medium) | 532 ms | **1701 ms** (1536–1800) | 2167 ms | 73–79 |
| gpt-6-sol / low | 524 ms | **1182 ms** (1126–1196) | 1922 ms | 16–20 |
| gpt-6-astra / low | 529 ms | **2228 ms** (1166–2494) | 3441 ms | 0 |

`SentenceBuffer` on a live luna stream released the first complete sentence at 899 ms. The rejoined sentences equal the full text.

**Conclusion.**
- Always set effort explicitly. The default (`medium`) adds about 500 ms of TTFT on luna.
- Luna at none/low and sol/low are close, at about 1.1–1.2 s from this network.
- Astra is about twice as slow, so keep it off the voice hot path.
- Treat `response.completed`, `response.incomplete`, `response.failed` and `error` all as terminal.

## t08: Agents SDK (`@openai/agents`)

**Install.**
- `npm install` in `spikes/openai/agents-sdk/` with its own `package.json`: `{"@openai/agents":"0.18.0","zod":"^4.0.0"}`.
- Added 25 packages in 22.8 s. Resolved `zod@4.6.5` and a nested `openai@7.23.0`, the same version as the root.
- The root harness was not touched.
- `npm view @openai/agents peerDependencies` returns `{"zod":"^4.0.0"}`.

**Code** (`openai/agents-sdk/t08-agents-sdk.ts`):

```ts
setDefaultOpenAIKey(OPENAI_API_KEY); setTracingDisabled(true);
const lookupPolicy = tool({ name: "lookup_policy", description: "…", parameters: z.object({ policy_number: z.string() }), execute: async ({ policy_number }) => ({ … }) });
const agent = new Agent({ name: "Claims policy checker", instructions: "…Always call lookup_policy…", model: "gpt-6-luna",
  modelSettings: { reasoning: { effort: "low" }, store: false }, tools: [lookupPolicy],
  outputType: z.object({ policy_number: z.string(), policy_active: z.boolean(), deductible_usd: z.number(), spoken_reply: z.string() }) });
await run(agent, "This is Priya Shah, policy H P 7 7 4 0 3 9 1. Is it active and what's my deductible?");
```

**Observed.**
- **Non-streamed run:** 3320 ms. `finalOutput = {"policy_number":"HP7740391","policy_active":true,"deductible_usd":500,"spoken_reply":"Your policy is active, and your deductible is $500."}` and `newItems = tool_call_item, tool_call_output_item, message_output_item`.
- **Streamed run:** 2521 ms, first `output_text_delta` at 2215 ms. Event kinds: `raw:response_started ×2, raw:model ×61, item:tool_called, item:tool_output, raw:output_text_delta ×38, item:message_output_created, raw:response_done ×2`.
- **Agent with no `model`:** served by **`gpt-5.6-luna`**. `DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"` and `DEFAULT_OPENAI_API = "responses"` in `@openai/agents-openai/dist/defaults.d.ts`.

**Conclusion.**
- The SDK is usable immediately.
- Always set `model` explicitly.
- Tracing uploads to OpenAI by default. Call `setTracingDisabled(true)`, or keep tracing on deliberately.
- `setOpenAIAPI('chat_completions')` exists. Avoid it with GPT-6 plus tools (see t07b).
- `setOpenAIResponsesTransport('websocket')` also exists. It was not tested.

## t06: Streaming TTS to PCM (BYO-TTS pipeline)

**Request.**
- `POST /v1/audio/speech` with `{"model":"gpt-4o-mini-tts-2025-12-15","voice":"marin"|"cedar","input":"Thanks for calling Harbor Point. I can see your claim, C L 4 4 8 1 2, and an appraiser will call you on Friday at 10 a.m. Is there anything else I can help you with today?","instructions":"Warm, calm and professional phone-agent tone. Moderate pace.","response_format":"pcm"}`.
- The SDK call `oa.audio.speech.create(body)` returns a fetch `Response` whose `body` streams.

**Observed.**
- Response headers: `content-type: audio/pcm`, `transfer-encoding: chunked`, `openai-processing-ms: 435`, `x-ratelimit-limit-requests: 5000`, `x-ratelimit-limit-tokens: 2000000`.
- TTFB equals time-to-headers: the first audio bytes arrive with the headers.

| Run | TTFB | Total | Audio | Total / audio duration | Chunks (odd-length) | Median chunk size |
|---|---|---|---|---|---|---|
| 2025-12-15 / marin #0 | 833 ms | 2293 ms | 9.30 s | 0.25 | 106 (**74 odd**) | 2822 B |
| 2025-12-15 / cedar #0 | 966 ms | 2528 ms | 10.65 s | 0.24 | 116 (**76 odd**) | 2822 B |
| 2025-12-15 / marin #1 | 702 ms | 3204 ms | 12.15 s | 0.26 | 59 (0) | 16376 B |
| 2025-12-15 / cedar #1 | 958 ms | 2914 ms | 10.75 s | 0.27 | 51 (2) | 16376 B |
| alias `gpt-4o-mini-tts` / marin | 755 ms | 2542 ms | 12.55 s | 0.20 | 61 (0) | |
| `tts-1` / alloy | 2657 ms (1222 ms on the first run) | 3907 ms | 11.21 s | 0.35 | 53 (0) | |
| `gpt-4o-mini-tts-2025-03-20` (past shutdown date) | 546 ms | 1908 ms | 10.40 s | 0.18 | 43 (0) | |

For the pinned model, TTFB was a median of **896 ms** over 4 runs (702–966).

- The first chunks of marin #0 were 182, 1368, 1370, 1368, 1370 and 1368 bytes, so **an odd-length HTTP chunk splits a sample across chunks.** `openSpeechPcmStream()` carries the odd byte forward and yields only even-length PCM.
- `response_format:"wav"` returned a header with `sampleRate 24000, channels 1, bitsPerSample 16, formatTag 1`. Its RIFF and data size fields are both `0xFFFFFFFF` (a streaming WAV). `lib/wav.ts` decodes it.
- `stream_format:"sse"` (not in research 09): `content-type: text/event-stream; charset=utf-8` with CRLF line endings. The events are:
  - `data: {"type":"speech.audio.delta","audio":"<b64 PCM>"}` repeated.
  - `data: {"type":"speech.audio.done","usage":{"input_tokens":6,"output_tokens":65,"total_tokens":71}}`.
  - `data: [DONE]`.
- **Twilio path:** `Pcm24kToMulaw8k` plus `ByteFramer(160)` on the real marin audio produced 465 frames of 20 ms each, byte-identical to the batch `resampleLinear` plus `mulawEncode` path.
- Samples: `spikes/out/tts_sample.wav` (marin) and `spikes/out/tts_sample_cedar.wav`, both 24 kHz mono PCM16.

**Conclusion.**
- `gpt-4o-mini-tts-2025-12-15` with `pcm` gives about 0.7–1.0 s to first audio and generates about 4× faster than real time.
- Sentence-level TTS (with `SentenceBuffer`) is viable. Expect about 1.1 s LLM TTFT plus about 0.9 s TTS TTFB, or roughly 2 s to first audio from this network. The websocket-native vendors in research 09 §9 remain faster options.
- Do not use `tts-1`: it is not faster.

## t07 / t07b: Chat Completions streaming for the Voice Agent BYO `llm` (C9, T6)

**Request, A (raw fetch):**

```json
POST https://api.openai.com/v1/chat/completions
{"model":"gpt-6-luna","stream":true,"stream_options":{"include_usage":true},"reasoning_effort":"none",
 "messages":[{"role":"system","content":"You are a claims voice agent …"},{"role":"user","content":"My claim number is C L 4 4 8 1 2 and policy H P 7 7 4 0 3 9 1. …"}],
 "tools":[{"type":"function","function":{"name":"lookup_policy","description":"…","parameters":{…},"strict":true}}, …]}
```

**Observed wire format.**
- 200 with `text/event-stream; charset=utf-8` and **LF** line endings.
- 18 `data:` lines, and the last line is `data: [DONE]`.

```json
{"id":"chatcmpl-ERRz…","object":"chat.completion.chunk","created":1790211187,"model":"gpt-6-luna","service_tier":"default","system_fingerprint":null,"usage":null,"choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}],"obfuscation":"VuriCHlJ6GEYQ"}
{… "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_3WKt…","type":"function","function":{"name":"get_claim_status","arguments":""}}]},"finish_reason":null}] …}
{… "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}] …}
{… "choices":[],"usage":{"prompt_tokens":277,"completion_tokens":55,"total_tokens":332,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0,…}}}
```

**B, SDK round trip** (`streamChat()`):
- Round 1: `finish_reason:"tool_calls"` with calls `get_claim_status({"claim_number": "CL44812"})` and `lookup_policy({"policy_number": "HP7740391"})`. TTFT 1208 ms.
- Round 2 (assistant `tool_calls` plus `role:"tool"` messages): `finish_reason:"stop"`, TTFT 1172 ms, "The appraiser is scheduled to call Friday at 10:00 local time. Your deductible is $500."

**The blocker for direct BYO use.** Model plus tools with no `reasoning_effort` fails:

> `400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` (param `reasoning_effort`)

| Chat + tools, no `reasoning_effort` | Result |
|---|---|
| gpt-6-luna, gpt-6-sol, gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra (and gpt-5.6-luna in t07) | **400** (message above) |
| gpt-5.5, gpt-5.4-mini, gpt-5-mini, gpt-4.1-mini, gpt-4o-mini | 200 |
| gpt-6-luna / gpt-6-sol with effort `none` | 200 |
| gpt-6-luna / gpt-6-sol with effort `low` or `high` | 400 (same message) |
| gpt-6-luna with **no tools**, default effort | 200 |

With effort `none`, luna accepts `temperature:0.7`, `top_p`, `max_completion_tokens`, `parallel_tool_calls:false`, `tool_choice:"auto"` and `user`. It still rejects `max_tokens` with "Use 'max_completion_tokens' instead."

**Shim.** A generic-client body `{model:"gpt-6-luna", tools, temperature:0.7, max_tokens:256}` returns 400 as-is. After `normalizeChatBodyForReasoningModel()` it returns 200 with `finish_reason:"tool_calls"` and a 722 ms TTFT.

**TTFT with tools present** (conversational turn, n=3, median):

| Model / effort | TTFT median (min–max) | Total |
|---|---|---|
| gpt-4.1-mini / default | 592 ms (590–695) | 1053 ms |
| gpt-5.6-luna / none | 726 ms (647–815) | 1076 ms |
| gpt-6-luna / none | 754 ms (726–756) | 1177 ms |
| gpt-5.6-terra / none | 799 ms (756–849) | 1347 ms |
| gpt-6-luna / default, gpt-5.6-luna / default | 400 (tools + effort) | |

**Conclusion.**
- **C9, OpenAI side:** `api.openai.com/v1/chat/completions` is a standard OpenAI-compatible streamed endpoint with tools (`data:` lines, `data: [DONE]`, `tool_calls` deltas, `finish_reason:"tool_calls"`).
- The BYO `llm` config carries only `{base_url, model, api_key}`, so we cannot set `reasoning_effort` there. **Pointing the Voice Agent directly at `api.openai.com` with a GPT-5.6 or GPT-6 model will fail on any turn that sends tools, unless AssemblyAI itself sends `reasoning_effort:"none"`.** Only T6 can show what AssemblyAI sends.
- Options, in order of preference:
  1. For direct BYO, use `gpt-4.1-mini`, which is the fastest here and accepts every generic parameter.
  2. Put a thin HTTPS proxy on Vercel as `base_url` that applies `normalizeChatBodyForReasoningModel()` and streams the SSE through unchanged.
  3. Use the AssemblyAI LLM Gateway (T6).
- Chunks carry a non-standard `obfuscation` field. Strict OpenAI-compatible parsers must ignore unknown fields.

---

## Golden config (use these exact settings in the product)

```ts
// spikes/openai/client.ts - MODELS
reasoning: "gpt-6-astra"   // reasoning.effort ∈ low|medium|high|xhigh|max  (NO none/minimal)
balanced:  "gpt-6-sol"     // effort ∈ none|low|medium|high|xhigh|max
fast:      "gpt-6-luna"    // effort ∈ none|low|medium|high|xhigh|max
tts:       "gpt-4o-mini-tts-2025-12-15"  // voices marin / cedar, response_format "pcm" (24 kHz s16le mono)
```

| Use | Call | Exact settings |
|---|---|---|
| Evidence / fact-graph extraction (judge-facing) | `extractStructured()` → `POST /v1/responses` | `model:"gpt-6-sol"`, `reasoning:{effort:"low"}`, `text:{format:{type:"json_schema",name,schema,strict:true}}`, `store:false`, `max_output_tokens:12000`. Every object needs `additionalProperties:false` and every key in `required`; model optional fields as `["string","null"]`. `pattern` and `format:"date"` are allowed. Handle `status:"incomplete"` and `refusal` |
| Cheap live pass / router / classifier | same | `model:"gpt-6-luna"`, `reasoning:{effort:"none"}`. You may add `temperature` only with effort `none` |
| Hard reasoning (offline) | same | `model:"gpt-6-astra"`, `reasoning:{effort:"low"}` or higher. About 5× the cost of sol and 2× the TTFT |
| Tool loop (orchestrator) | `runToolLoop()` | Flat tools `{type:"function",name,description,parameters,strict:true}`, `state:"replay"`, `store:false`, `include:["reasoning.encrypted_content"]`. Replay `toResponseInputItems(r.output)` plus `{type:"function_call_output",call_id,output:JSON string}`. Force a tool with `tool_choice:{type:"function",name}` |
| Streamed voice reply (BYO pipeline) | `streamText()` + `SentenceBuffer` | `model:"gpt-6-luna"`, `reasoning:{effort:"none"}` or `"low"`, `stream:true`, `store:false`. Terminal events are `response.completed`, `response.incomplete`, `response.failed` and `error` |
| TTS | `openSpeechPcmStream()` | `{model:"gpt-4o-mini-tts-2025-12-15", voice:"marin", response_format:"pcm", instructions}`. Carry odd bytes (built in). For Twilio, use `Pcm24kToMulaw8k` then `ByteFramer(160)` |
| Voice Agent BYO `llm` (direct) | AssemblyAI config | `{"base_url":"https://api.openai.com/v1","model":"gpt-4.1-mini","api_key":"sk-…"}`. **Do not** use gpt-6 or gpt-5.6 here unless T6 shows AssemblyAI sends `reasoning_effort:"none"`, or you front it with the `normalizeChatBodyForReasoningModel()` proxy |
| Chat Completions (any) | `streamChat()` | `max_completion_tokens` (never `max_tokens`), `reasoning_effort` (not `reasoning`, and at most `xhigh`), `stream_options:{include_usage:true}`, nested tools `{type:"function",function:{…}}`, `reasoning_effort:"none"` whenever tools are present on GPT-5.6/6 |
| Agents SDK | `spikes/openai/agents-sdk` | `@openai/agents@0.18.0` + `zod@^4`. `setDefaultOpenAIKey()`, explicit `model:"gpt-6-luna"`, `modelSettings:{reasoning:{effort:"low"},store:false}`, zod `outputType`. Decide on tracing explicitly (`setTracingDisabled`) |
| Fast mode | any | `service_tier:"fast"` (`"priority"` is an alias that echoes `"fast"`). About 2× price. Not needed at these latencies |
| Deprecation guard | `GET /v1/models` | Read `shutdown_date` on every model you pin, at startup or in CI |

Parameter names that fail with 400:

- On Responses: `max_tokens`, `response_format`, `reasoning_effort`, `max_output_tokens` below 16, `temperature` at a non-`none` effort, and the effort values `minimal` (all models) and `none` (astra).
- On Chat: `max_tokens` and `reasoning` on reasoning models, the effort values `max` and `minimal`, and tools at any effort other than `none` on GPT-5.6/6.

## Doc discrepancies

| # | Source claim | Observed 2026-09-24 | Evidence |
|---|---|---|---|
| D1 | research 09 §1.3 "[CORRECTED]" says there is no o1 shutdown on 2026-10-23 and calls it a hallucination | **`o1`, `o1-2024-12-17`, `o1-pro`, `o3-mini`, `o4-mini` and `gpt-4.1-nano` all have `shutdown_date: "2026-10-23"`** in `/v1/models`. The original claim was right for o1 | `out/openai_models.json` |
| D2 | research 09 §6.2 / §10 say the Zod requirement is "genuinely unresolved" and the `@openai/agents` version is unverified | `@openai/agents@0.18.0` (modified 2026-09-10) has `peerDependencies {"zod":"^4.0.0"}`. Zod 4 is confirmed | `npm view`, t08 |
| D3 | research 09 §6.2 quickstart implies an Agent without `model` uses the flagship | The SDK default is `gpt-5.6-luna` over the `responses` API | t08 case C |
| D4 | research 09 §7.5 marks TS PCM streaming as "[UNVERIFIED]" | Confirmed: `audio.speech.create({response_format:"pcm"})` returns a streaming `Response`. **Chunks are often odd-length**, so the sample boundary must be carried. Neither the docs nor research mentions this | t06 |
| D5 | research 09 §7 does not mention SSE for TTS | `stream_format:"sse"` works: `speech.audio.delta{audio}`, then `speech.audio.done{usage}`, then `data: [DONE]`, with CRLF line endings | t06 |
| D6 | research 09 §9 says there is no published TTFB | Measured TTFB median 896 ms (702–966) and generation at about 0.25× real time. `tts-1` is not faster (1.2–2.7 s) | t06 |
| D7 | Harness README: "snapshots `-2025-12-15` and `-2025-03-20`" | `gpt-4o-mini-tts-2025-03-20` has `shutdown_date` 2026-07-23, which has passed, yet it still serves requests. Do not pin it | t01, t06 |
| D8 | openai-node 7.23.0 types list `ReasoningEffort` including `minimal` | Every GPT-6 model rejects `minimal`. astra rejects `none`. Chat Completions rejects `max` on luna | t04 |
| D9 | OpenAI's reasoning guidance (general docs, not quoted in research 09) says `store:false` needs `include:["reasoning.encrypted_content"]` to get replayable reasoning | `encrypted_content` came back without `include`, and replay with the reasoning items dropped entirely was also accepted. Keep `include` for forward-compatibility | t03b |
| D10 | research 01 §10 BYO example `{"base_url":"https://api.openai.com/v1","model":"gpt-5-mini"}` implies any OpenAI model works as a BYO LLM | `gpt-5-mini` works, but **every GPT-5.6/6 model returns 400 on chat.completions with tools unless `reasoning_effort:"none"`** (the default is `medium`). This is new input for **C9 / T6** | t07, t07b |
| D11 | research 09 §5 lists four streaming event types plus extras | Also present: `phase:"final_answer"` on message items, an `obfuscation` padding field on deltas (both Responses and Chat chunks), `sequence_number`, and a response echo of `reasoning.context:"all_turns"` and `mode:"standard"`. `reasoning.summary:"auto"` resolves to `"detailed"` | t05, t04, t07 |
| D12 | research 09 §1.1: `service_tier` `"priority"` or `"fast"` | Both are accepted, and both echo `service_tier:"fast"`. `flex` is also accepted | t04 |
| D13 | research 09 §5: the WebSocket mode shape is "[UNVERIFIED]" | Still not tested. `openai@7.23.0` ships `resources/responses/ws` and `lib/responses/responses-websocket-session`, and the Agents SDK has `setOpenAIResponsesTransport('websocket')` | SDK files |
| D14 | research 09 §1: GPT-6 Sol/Luna "announced Sep 22" and Astra "released Sep 3" | The `created` dates are 2026-09-14 (sol, luna) and 2026-08-27 (astra), before the announcements. This does not matter in practice | t01 |
| D15 | Harness README: "Node 22 (tested on 22.23.2)" | This machine runs **Node v24.20.0**. Everything type-checks and runs, and `@types/node` 22 still works | `process.version` |

Items from synthesis §7:

- **C9:** partly confirmed on the OpenAI side (streamed chat completions with tools works), with the reasoning-effort caveat in D10.
- **T6** is still open, and it now has a concrete question: *what does AssemblyAI send to a BYO `llm`* (`reasoning_effort`? `max_tokens`? `temperature`?). Test it with a request-capturing proxy as `base_url`, or with `gpt-4.1-mini` versus `gpt-6-luna`.
- No other C# or T# item applies to OpenAI.

## Reproduce

```sh
cd spikes
npx tsc -p openai/tsconfig.json && npx tsc -p openai/agents-sdk/tsconfig.json
npx tsx openai/selftest-client.ts            # offline
npx tsx openai/t01-models.ts                 # then t04, t02, t03, t03b, t05, t06, t07, t07b
cd openai/agents-sdk && npm install && cd ../.. && npx tsx openai/agents-sdk/t08-agents-sdk.ts
```

Files:

- `spikes/openai/client.ts`: the reusable module.
- `spikes/openai/claim-schema.ts`: the fact-graph schema and scorer.
- `spikes/openai/t0*.ts`: the tests.
- `spikes/openai/agents-sdk/`: the isolated Agents SDK install.
- `spikes/out/openai_models.json`, `openai_claim_graph_*.json`, `tts_sample*.wav`, `openai-*.jsonl`: outputs.
