# 10a: Voice Agent API smoke tests (live, 2026-09-24)

**What this is:** hands-on tests of `wss://agents.assemblyai.com/v1/ws` and its REST surface (`/v1/token`, `/v1/agents`, `/v1/sessions`) that resolve the open questions in `00-synthesis.md` §7. It covers:

- C4, C5, C6, C7, C8, C9, C10, C19, C20, C21, C22, C23, C24 and C25.
- Tests T2, T3, T4, T5, T6, T7 (partial), T8 (read-only), T9 and T10.

**Code:** everything lives in `spikes/voice-agent/`. The reusable module is **`spikes/voice-agent/client.ts`** (see §15).

**Raw event logs:** `spikes/out/va-<test>.jsonl`.
- Audio payloads are logged as `{bytes}`.
- Keys, temp tokens and resume tokens are masked.
- `scan-secrets.ts` confirms no plaintext secret appears in any output file.

**Setup:**
- **Client location:** India (Cloudflare `MAA`). WebSocket open takes 500–560 ms and a warm REST GET takes 170–220 ms, so the round trip is about 170 ms. Every latency below is measured at the client, which puts roughly one network trip in each direction inside the number.
- **Spend:** 31 Voice Agent sessions totalling 707 s, about **$0.88** at $4.50/h. OpenAI TTS, transcription and chat probes, one async STT job of about 110 s of stereo audio, and one Gateway qwen call add cents.
- **Cleanup:** every stored agent was deleted. A final listing on both `agents.assemblyai.com` and `agents.us.assemblyai.com` shows 0 agents, 0 webhook subscriptions and 0 phone numbers (`cleanup-check.ts`).

---

## 0. Verdict table

| # | Test | IDs | Status | One-line conclusion |
|---|---|---|---|---|
| 1 | Token minting and auth styles | T2, C4, C23 | **PASS** | Raw key and `Bearer` both work, on `/v1/token` and on the WS `Authorization` header. The `product=voice_agent` parameter is accepted and has no effect. `?token=` connects. |
| 1b | Token single-use / `max_session_duration_seconds` | T2 | **FAIL** (vs docs) | A token opened 2 sequential **and** 2 concurrent sessions. A `max_session_duration_seconds=60` session was still alive at 102 s. `expires_at` is always now+3600. |
| 2 | Invalid voice, voice list, error shape | T5, C5, C8 | **PASS** | There are **18** voices (adds `iris`, `reid`). `session.error` uses a lower-case `code` (never `error_code`). An invalid **first** update is fatal (close 1008). |
| 3 | Core loop: tool call, reply audio, latency | – | **PASS** | Full loop works and `agent_reply.wav` is saved. Replies start with **silent PCM**. The audible answer comes about 5.8 s after end of speech on the tool path. |
| 3b | Barge-in | – | **PASS** | `reply.done{status:"interrupted"}` and `transcript.agent{interrupted:true}` (trimmed text) arrive together with `input.speech.started`, 1.1–2.2 s after the user starts talking. |
| 4 | Latency by `transcription_mode` | – | **PASS** | End of speech to audible reply: min_latency **2.1–2.6 s**, balanced 2.9–3.2 s, max_accuracy 4.2–4.5 s. |
| 5 | Text injection | T3, C6 | **PARTIAL** | `reply.create` (and its `instructions`) works. `conversation.message` is schema-validated but **never reaches the model**. |
| 5b | Early `tool.result` (before `reply.done`) | – | **PASS** | Accepted with no errors and correct answers. The audible answer comes **~1.0 s sooner**. |
| 6 | Stored agent and mid-session updates | T9, C22 | **PASS** | Both `system_prompt` and `tools` update mid-session on an `agent_id` session and take effect. |
| 7 | HTTP tool on a stored agent | T4, C7, C21 | **PASS** | AssemblyAI calls the endpoint (156 ms) and the agent uses the body. **`tool.call` still reaches the client.** Header values are omitted on read. |
| 8 | BYO LLM | T6, C9 | **PARTIAL** | OpenAI direct (`gpt-4.1-mini`) works. The Gateway rejects OpenAI and Claude models for this account. Every Gateway config fails **silently** inside the agent. |
| 8b | Gateway access | T7, C10 | **BLOCKED** (account) | `400 "Your account does not have access to this LLM Gateway model"` for gpt-*, claude-*, gemini-*, gpt-oss. Only `qwen3.5-4b-32k-fast` is callable. |
| 9 | Session history, recording, async STT | T10, C25 | **PASS** | Artifacts appear about 7 s after the end. Pre-signed URLs last 1 h. `/v2/transcript` fetches the URL (U3.5 Pro, multichannel, ch1 = user, ch2 = agent). |
| 10 | Telephony read-only, G.711 codec | T8, C19 | **PASS** | Agent ids are not shared with `agents.us`. The `/phone-numbers` list exists on both hosts. `audio/pcmu` both ways works. |
| 11 | Faster-than-real-time audio | – | **PARTIAL** | A 3x burst of a 7.3 s clip produced **no** `audio_rate_violation` and a complete transcript (not reproduced). |
| 12 | Pre-connect and SIP docs (reading only) | C19 | **PASS** (read) | Docs match research note 01. One host inconsistency is noted in §16. |

---

## 1. T2 / C4 / C23: token endpoint and WS auth (`t2-auth.ts`, `va-t2-auth.jsonl`)

**Request:**

```
GET https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=180[&product=voice_agent]
Authorization: <key>            | Authorization: Bearer <key>
```

**Token endpoint results:**

| Variant | Status | Body (truncated) |
|---|---|---|
| raw | 200 (1216 ms cold, ~200 ms warm) | `{"token":"<2578 chars>","expires_in_seconds":60}` |
| Bearer | 200 | same shape |
| raw + `product=voice_agent` | 200 | same shape |
| Bearer + `product` | 200 | same shape |
| no `Authorization` | **422** | `{"detail":[{"type":"missing","loc":["header","authorization"],"msg":"Field required","input":null}]}` |
| bad key | **404** | `{"detail":"Invalid API key"}` |
| `max_session_duration_seconds=30` | 422 | `{"detail":[{"type":"greater_than_equal","loc":["query","max_session_duration_seconds"],"msg":"Input should be greater than or equal to 60","input":"30","ctx":{"ge":60}}]}` |
| `expires_in_seconds=0` | 422 | same shape, `ge: 1` |
| no `expires_in_seconds` | 422 | `"type":"missing"` |

**WS results:**

- **Token connect** (`wss://agents.assemblyai.com/v1/ws?token=…`):
  - The socket opens in about 510 ms.
  - The server sends **nothing** before the first `session.update` (1.5 s wait).
  - After the update the server sends `session.updated`, then about 17 ms later `session.ready`. That is 400–500 ms after sending.
  - `session.ready` keys are `session_id, config, expires_at, resume_token, type, timestamp`.
  - `expires_at` = now + **3595 s**, even though the token asked for 180 s.
- **Header connect:** `Authorization: <raw>` and `Authorization: Bearer <key>` both reach `session.ready`.
- **Bad key, no auth, or expired token** (a 1 s token used 3 s later): the WebSocket upgrade **succeeds**, then this arrives and the socket closes with **1008**:

  ```json
  {"code":"unauthorized","message":"Authentication failed","session_id":null,"param":null,"type":"session.error","timestamp":1790210425.654429}
  ```

  It arrives about 0.4 ms after our first send, so the server sends it on open.
- **Token reuse:** the same token, reused 1.5 s after its first session ended, gave a new `session.ready` (`sess_7941…`).

**Status:** PASS for auth styles; see §2 for the lifetime claims.

**Conclusion:**
- **C4 resolved:** raw and Bearer are both accepted everywhere tested. Use raw on the server for consistency with Streaming, Async and Gateway.
- **C23 resolved:** `product` is harmless and unneeded.
- **C24 resolved:** `/v1/ws` is correct.
- Auth failures are **not** silent: a browser would see `open`, then `session.error unauthorized`, then close 1008, not the documented 1006.

## 2. T2b: token lifetime and session cap (`t2b-max-duration.ts`)

**Request:** mint `expires_in_seconds=60&max_session_duration_seconds=60` (Bearer). Connect with `?token=`, `start()`, stream real-time silence, and wait 100 s. In parallel, open a second session with the **same token**.

**Observed:**
- The concurrent same-token session reached `session.ready` (`sess_3ff9…`).
- The capped session was still open at 100 s.
- Our `session.end` returned `{"session_duration_seconds":102.250166,"type":"session.ended","timestamp":1790210675.76,"audio_duration_seconds":null}`.
- `expires_at` was again now + 3595 s.

**Status:** **FAIL** against the docs.

**Conclusion:**
- A temp token is a **multi-use bearer credential for its whole redemption window**.
- `max_session_duration_seconds` is **not enforced**, at least at 60 s.

**Product implications:**
- Keep `expires_in_seconds` ≤ 60.
- Rate-limit and authenticate the mint route.
- Enforce a client-side cap (`SessionOptions.maxDurationMs` in `client.ts`) and always send `session.end`.
- The synthesis budget line that relied on the token cap (§2.2) is not safe as written.

Also observed: `audio_duration_seconds` is always `null` in `session.ended`.

## 3. T5 / C5 / C8: invalid voice, voice catalog, error shapes (`t5-voices-errors.ts`)

**REST request:** `POST /v1/agents {"name":"…","system_prompt":"x","voice":{"voice_id":"not_a_voice"}}`

**REST response: 422**

```json
{"code":"validation_error","message":"voice: Invalid voice 'not_a_voice'. Must be one of: alba, anna, charles, estelle, eve, george, giovanni, iris, jane, jean, juergen, lola, mary, michael, paul, rafael, reid, vera","param":"voice","request_id":"4ba0…","errors":[{"message":"…","param":"voice"}],"detail":[{"type":"value_error","loc":["body","voice"],"msg":"Value error, Invalid voice …"}]}
```

**WS request:** first `session.update` with `output.voice:"not_a_voice"`.

**WS response:** the error below, then **close 1008**:

```json
{"type":"session.error","timestamp":1790210503.02,"code":"invalid_value","message":"Invalid voice 'not_a_voice'. Must be one of: alba, anna, …, vera","param":"output.voice"}
```

**Mid-session probes** (after a valid start). **All of these keep the session open.**

| Probe | Event returned |
|---|---|
| `output.voice:"eve"` | `{"code":"immutable_field","message":"'output.voice' cannot be changed after the first session.update","session_id":"sess_…","param":"output.voice","type":"session.error","timestamp":…}` |
| `output.voice:"not_a_voice"` (mid-session) | `immutable_field` (not `invalid_value`) |
| `greeting:"Hello again"` | `immutable_field`, param `greeting` |
| `output.volume:80` | `session.updated` |
| `{"type":"no.such.event"}` | `{"code":"invalid_format","message":"Unknown message type: no.such.event"}` |
| malformed JSON | `invalid_format` "Invalid JSON format." |
| `input.audio` bad base64 | `invalid_audio` "Invalid audio data" |
| `input.audio` without `audio` | `invalid_format` "Invalid message format for type 'input.audio'" |
| tool with `parameters.properties: 7` | `invalid_value` "'tools[0].parameters.properties' must be an object", param `tools[0].parameters.properties` |
| `tools: []` | `session.updated` |
| `agent_id` after the first update | `agent_id_not_first` "agent_id can only be set on the first session.update" |

**Status:** PASS.

**Conclusion:**
- **C8 resolved:** 18 voice IDs: alba, anna, charles, estelle, eve, george, giovanni, **iris**, jane, jean, juergen, lola, mary, michael, paul, rafael, **reid**, vera. `ivy`, `claire` and `dawn` are **not** valid.
- **C5 resolved:** the field is `code`, lower-case, on every error seen, including `unauthorized`. `timestamp` is epoch seconds as a float, not an ISO string.
- Config-level errors add `session_id` and `param`. Protocol-level errors omit them.
- Tool schemas **are** partially validated.

## 4. Core loop (`core-loop.ts`, `va-core-loop.jsonl` run 2, `va-core-loop-run1.jsonl` run 1)

**Request** (after `?token=` connect, token minted with Bearer, 60 s / 180 s):

```json
{"type":"session.update","session":{
  "system_prompt":"You are Max, the AI voice assistant on Acme Shop's order-support line. Most important rule: never state any order status, carrier, location or date unless it came from a lookup_order result in this conversation. Keep every reply to one or two short sentences. …",
  "greeting":"Hi, you're speaking with Acme Shop's automated AI assistant, and this call may be recorded. How can I help with your order today?",
  "input":{"format":{"encoding":"audio/pcm","sample_rate":24000}},
  "output":{"voice":"alba","format":{"encoding":"audio/pcm","sample_rate":24000}},
  "tools":[{"type":"function","name":"lookup_order","description":"Look up an Acme Shop order by its 6-digit order number …",
    "parameters":{"type":"object","properties":{"order_number":{"type":"string","description":"… May contain spaces when read digit by digit.",
      "pattern":" *([0-9] *){6}","examples":["481529","4 8 1 5 2 9"]}},"required":["order_number"]}}]}}
```

Audio is fed by `RealtimeAudioFeeder`:
- Continuous 50 ms `input.audio` frames (2400 B PCM16), each released only after its duration has elapsed. Maximum lateness was 18–34 ms.
- Digital silence between clips.
- `fixtures/question_24k.wav` (7.30 s; voiced 20–7090 ms, with a 380 ms gap after "…my order.").
- Barge-in clip, OpenAI TTS: "Wait, sorry, stop. Can you just text me the tracking number instead?" (voiced 470–1970 ms and 2490–4470 ms).

### 4.1 Observed event shapes (verbatim, truncated; every server event also carries `timestamp`)

**Session and speech events:**

```
session.ready.config = {"id":"sess_…","system_prompt":"…","greeting":"…","input":{"type":"audio","format":{"encoding":"audio/pcm","sample_rate":24000},"turn_detection":null,"keyterms":null,"transcription_mode":null,"continuous_partials":null,"transcription_prompt":null,"language_codes":null,"voice_focus":null,"voice_focus_threshold":null},"output":{"type":"audio","voice":"alba","format":{"encoding":"audio/pcm","sample_rate":24000},"volume":null},"tools":[{…,"timeout_seconds":120,"execution_mode":"interactive","http":null,"response_instructions":null,"deployment_id":null,"session_update":null,"image_tag":null}],"llm":[],"pre_connect_requests":[]}
input.speech.started   {"type":"input.speech.started","timestamp":1790211869.39}
transcript.user.delta  {"item_id":"msg_…","text":"The order number is 481529, and it's","type":"transcript.user.delta",…}
input.speech.stopped   {"type":"input.speech.stopped","timestamp":…}
transcript.user        {"item_id":"msg_…","text":"Hi, I'm calling about my order. The order number is 481529, and it still hasn't arrived.",…}
```

**Reply events:**

```
reply.started          {"reply_id":"resp_9bc31ea8…","item_id":"msg_…","type":"reply.started",…}
reply.audio            {"reply_id":"resp_…","data":{bytes:480},"type":"reply.audio","timestamp":…}      <- 10 ms chunks, delivered at real-time pace
transcript.agent.delta {"reply_id":"resp_…","item_id":"msg_…","delta":"Your ","start_ms":32,"end_ms":145,…}  <- all words arrive in one burst
transcript.agent       {"reply_id":"resp_…","text":"Your order is currently in transit and is expected to arrive on Friday, September","interrupted":true,…}
reply.done             {"reply_id":"resp_…","status":"interrupted","type":"reply.done",…}
```

**Tool and teardown events:**

```
tool.call              {"call_id":"chatcmpl-tool-9ebb68d367b5d129","name":"lookup_order","arguments":{"order_number":"481529"},"type":"tool.call",…}
tool.result (sent)     {"type":"tool.result","call_id":"chatcmpl-tool-9ebb…","result":"{\"found\":true,\"order_number\":\"481529\",\"status\":\"in transit\",…}"}
session.ended          {"session_duration_seconds":35.279485,"type":"session.ended","timestamp":…,"audio_duration_seconds":null}
```

### 4.2 Timeline, run 2 (ms relative to the end of the user's last voiced sample)

| Event | ms |
|---|---|
| `input.speech.started` | 602 ms after speech **onset** (run 1: 611) |
| `input.speech.stopped` = `transcript.user` = `reply.started` = first `reply.audio` | **+930 / +932 / +933 / +939** |
| `tool.call` (inside the reply above) | +2653 |
| pre-amble `reply.done` (completed); our `tool.result` sent immediately after (held 2307 ms by the documented rule) | +4961 |
| answer `reply.started`, first chunk | +5134, +5142 |
| **first AUDIBLE agent audio (> -50 dBFS)** | **+5829** |

The reply that carries the tool call (`resp_9bc3…`) is a **completely silent 4.03 s pre-amble** with no transcript. It is the documented "interactive" filler, but it is silent. Every reply starts with silent PCM:

| Reply | Leading silence |
|---|---|
| greeting | 250 ms |
| answer after tool | 690 ms |
| reply after barge-in | 1760 ms |

The session's own timeline agrees: greeting `time_to_first_audio_ms` 358, reply after barge-in 1674 (§12).

**Run 1:**
- The 380 ms gap after "…my order." ended the turn early: `speech.stopped` came 800 ms after "order." and the agent started a reply.
- The user's continuation ("The order number is 481529…") did **not** interrupt it. The server merged both user segments into one turn.
- The reply's audio was **silent**, yet `transcript.agent` said "I can certainly help you with that. Do you have your six digit order number ready?" (`interrupted:false`).
- The async multichannel transcript of the recording (§12) confirms that sentence was **never spoken**.
- `tool.call` arrived 2.3 s after end of speech, inside that held reply. The answer followed normally.

### 4.3 Barge-in

**Run 2:**
- The barge clip started 1.5 s into the answer audio.
- `input.speech.started`, `transcript.agent{interrupted:true,"text":"Your order is currently in transit and is expected to arrive on Friday, September"}` and `reply.done{status:"interrupted"}` all arrived within 2 ms of each other.
- That was **2.17 s after the user began speaking**; run 1 took 1.07 s. So `input.speech.started` during agent speech signals the barge-in *decision*, not voice onset.
- "Wait, sorry, stop." got no reply of its own.
- "Can you just text me the tracking number instead?":
  - `speech.stopped` came 901 ms after end of speech.
  - First audible reply came 1770 ms after that.
  - The agent said: "I cannot send text messages, but I can read the tracking details out to you instead."

**Audio saved:**

| File | Length | Content |
|---|---|---|
| `spikes/out/agent_reply.wav` (24 kHz mono) | 8.19 s | 4.03 s silent pre-amble + 0.69 s lead-in + the interrupted answer. gpt-4o-transcribe: "Your order is currently in transit and is expected to arrive on Friday," |
| `spikes/out/agent_after_bargein.wav` | 6.56 s | the reply after the barge-in |

**Status:** PASS (both runs).

**Conclusion:**
- The client function tool loop and barge-in work as documented.
- Two things matter for the product:
  - **(a)** Measure latency to the first *audible* chunk, not to `reply.started` or the first `reply.audio`.
  - **(b)** On the tool path, the documented `tool.result` timing rule adds about 2.3 s (fix in §7).

## 5. Latency by transcription mode (`latency-matrix.ts`, `va-latency-matrix.jsonl`)

**Setup:**
- No tools, no greeting, inline config, `input.transcription_mode` set per session.
- Three OpenAI-TTS questions (voice `marin`) streamed as a real-time mic.
- Measured from the end of the voiced audio.

| mode | question | `speech.stopped` | first chunk | **first audible** | timeline `time_to_first_audio_ms` |
|---|---|---|---|---|---|
| balanced | "What time do you open on Saturdays?" | 1907 | 1917 | **2858** | 847 |
| balanced | "Do you ship to Canada?" | 1987 | 1998 | **3235** | 1161 |
| balanced | "Okay, thanks. Are you open on Sunday?" | 1962 | 1965 | **2894** | 859 |
| min_latency | (same) | 1258 | 1267 | **2116** | 807 |
| min_latency | | 1339 | 1350 | **2620** | 1207 |
| min_latency | | 1315 | 1319 | **2239** | 856 |
| max_accuracy | | 3155 | 3160 | **4280** | 1026 |
| max_accuracy | | 3255 | 3263 | **4544** | 1208 |
| max_accuracy | | 3270 | 3274 | **4171** | 851 |

All nine answers were correct ("We open at nine AM on Saturdays.", …).

**How the latency splits:**
- **Endpointing:** end of speech to `input.speech.stopped`, which is also when the reply starts. About 1.3 s in min_latency, 1.9–2.0 s in balanced and 3.2 s in max_accuracy.
- **Silent lead-in:** 0.8–1.3 s. The timeline's `time_to_first_audio_ms` measures exactly this stretch, from the commit to the first audible audio.

For the 7 s statement-style question in §4 (balanced), endpointing was 0.93 s, so it depends on the utterance.

**Status:** PASS (numbers recorded).

**Conclusion:**
- The advertised "~1 s end-to-end" corresponds to the server-side `time_to_first_audio_ms`. What a caller perceives is **2.1–3.2 s** (min_latency / balanced) on plain turns and **~4–6 s** on tool turns.
- `min_latency` saves about 0.7 s over `balanced` on short questions.

## 6. T3 / C6: text injection (`t3-text-injection.ts`, `t3b-conversation-message.ts`)

**Requests** (text-only session, no audio ever sent):

1. `{"type":"conversation.message","role":"user","content":"Hi, what's the status of order 4 8 1 5 2 9?"}` then wait 5 s.
2. `{"type":"reply.create"}`.
3. `conversation.message` with `role:"system"` ("…the caller's first name is Priya…"), then `reply.create` with instructions "Thank the caller by first name…".
4. Shape probes and recall probes (`t3b`).

**Observed:**

| Step | Result |
|---|---|
| 1 | No events at all. A message alone never triggers a reply (as documented). |
| 2 | Reply after 187 ms: "Hi, I'm Max. How can I help you today?" The injected order question was **ignored**. |
| 3 | "Thanks for being a Gold member, **Sarah**." The instructions were used; the system message was not (Priya was replaced by an invented name). |
| t3b schema | Only `{role:"user" or "system", content:<string>}` is accepted. No fields, role only, content only, role `assistant` or `bogus`, numeric or array content, nested `message`, or a `text` field all give `invalid_format` "Invalid message format for type 'conversation.message'" (session stays open). |
| t3b recall | After "My favourite fruit is mango.", `reply.create` asked for the fruit and got "**unknown fruit**". A system message demanding "banana protocol engaged" was ignored. The same facts placed inside `reply.create.instructions` gave "Hello Priya, your favorite fruit is papaya." `session.update {system_prompt:"…exactly: 'kiwi confirmed'"}` then `reply.create` gave "kiwi confirmed". |
| T9 speech variant | A `role:"system"` message ("address the caller as Priya") sent just before real speech was also ignored. |

**Status:** PARTIAL.

**Conclusion (C6):**
- The seven client event types exist and `conversation.message` is validated, but **its content does not reach the model** in either text-only or spoken sessions.
- To push context mid-call, use `reply.create.instructions` for one turn or `session.update {system_prompt}` for durable context. Both are verified.
- `client.ts` therefore exposes `replyNow(instructions)` and marks `sendConversationMessage()` as ineffective.

Also: `greeting: null` on the first update returns `invalid_format` "Invalid message format for type 'session.update'" (the socket stayed open). **Omit** `greeting` instead.

## 7. `tool.result` timing: documented rule vs immediate (`t3c-early-tool-result.ts`)

**Request:**
- Inline config with `lookup_order`.
- Each turn triggered by `reply.create {"instructions":"The caller just asked for the status of order 4 8 1 5 2 9. Look it up now."}`.
- Dispatcher `policy` alternated between `reply_done` (documented) and `immediate`.
- This run used the final `client.ts` (`ReplyTracker`, `maxDurationMs`).

| policy | `tool.call` | `tool.result` sent | pre-amble `reply.done` | **answer audible** | errors |
|---|---|---|---|---|---|
| reply_done | 878 | 3183 | 3182 (3.0 s of silence) | **3989** | 0 |
| immediate | 1401 | 1402 | 1577 | **2891** | 0 |
| reply_done | 661 | 2961 | 2961 | **3791** | 0 |
| immediate | 664 | 665 | 837 | **2835** | 0 |

All four answers were correct, for example "Your order seven three six two zero four is out for delivery…".

**Status:** PASS.

**Conclusion:**
- The server holds a silent pre-amble open for about 2.3 s after `tool.call`, unless the result arrives first.
- Sending `tool.result` as soon as the handler returns is accepted and cuts about **1.0 s** from the audible answer.
- Use `policy:"immediate"` for fast local tools.
- Keep dropping results after an interrupted `reply.done`, although an immediate result may already be sent by then.

## 8. T9 / C22: stored agent and mid-session updates (`t9-stored-agent.ts`)

**Requests:**
1. `POST /v1/agents {"name":"va-smoke-t9-stored","system_prompt":"You are Max, a terse test assistant…","voice":{"voice_id":"alba"}}`
2. WS `session.update {"agent_id":"agent_f5d1…"}`, then later `session.update {"system_prompt":"…exactly the two words: kiwi confirmed."}`, then `session.update {"system_prompt":"…call lookup_order…","tools":[lookup_order]}`.

**Create response: 201**

```json
{"id":"agent_f5d1111ce5db4cf5b11b79fa5da83074","name":"va-smoke-t9-stored","system_prompt":"…","greeting":null,"tools":[],"pre_connect_requests":[],"voice":{"voice_id":"alba"},"input":{"type":"audio","format":{"encoding":"audio/pcm","sample_rate":24000},"turn_detection":null,"keyterms":null},"output":{"type":"audio","voice":"ivy","format":{…},"volume":null},"transfer_targets":[],"outbound_trunk_id":null,"caller_id":null,"llm":[],"created_at":"2026-09-24T00:52:06.150269","updated_at":"…"}
```

- The agent id is `agent_<32 hex>`, not a UUID.
- The record says `output.voice` is **"ivy"**, but the session used `voice.voice_id` = alba (per `session.ready`).
- `GET /v1/agents` returns `{"agents":[{id,name,created_at,updated_at}],"has_more":false,"response_metadata":{"next_cursor":""}}`.

**Session results:**

- `session.ready` with the stored prompt.
- Prompt update gave `session.updated`, echoing the new prompt; the next `reply.create` said "kiwi confirmed".
- Tools update gave `session.updated` with tools `["lookup_order"]`.
- `reply.create` with instructions gave:
  - a silent pre-amble;
  - `tool.call {"order_number":"481529"}` at +669 ms;
  - the answer "Your order four eight one five two nine is currently in transit…".
- Real speech after the tools update called the tool correctly.

**Other sessions:**

| Case | Result |
|---|---|
| `{agent_id, system_prompt}` in one message | `{"code":"invalid_value","message":"agent_id is mutually exclusive with other session fields","param":"agent_id",…}` then close 1008 (**fatal**) |
| unknown agent id | `{"code":"agent_not_found","message":"Agent not found","param":"agent_id",…}` then close 1008 |
| C19: `GET https://agents.us.assemblyai.com/v1/agents/agent_f5d1…` | `404 {"code":"agent_not_found","message":"Agent not found","param":null,"request_id":"…"}`; the US agent list is empty |
| `DELETE /v1/agents/{id}` | 204; a `GET` afterwards gives 404 |

**Status:** PASS.

**Conclusion:**
- **C22 resolved:** a stored-agent session accepts later `system_prompt` and `tools` updates, so progressive tool reveal works with stored agents.
- **C19 confirmed:** ids are not shared across hosts.

## 9. T4 / C7 / C21: HTTP tool (`t4-http-tool.ts`, two runs)

**Request:** `POST /v1/agents` with this tool:

```json
{"name":"check_order_status","description":"Check the shipping status …","parameters":{…order_number pattern…},
 "execution_mode":"interactive","timeout_seconds":10,
 "http":{"url":"https://postman-echo.com/get?source=aai-voice-agent-smoke","http_method":"GET","headers":[{"name":"X-Smoke-Test","value":"smoke-header-value-not-secret"}]}}
```

Triggered by `question_24k.wav` speech. No `tool.result` was ever sent.

**Observed (run 1):**

| Time | Event |
|---|---|
| +924 ms | `speech.stopped` (single turn this time) |
| +926 ms | silent pre-amble `reply.started` |
| **+1801 ms** | **`tool.call {"call_id":"chatcmpl-tool-ba7eeb8dc42f829b","name":"check_order_status","arguments":{"order_number":"481529"}}` reaches the client** |
| +1956 ms | pre-amble `reply.done` |
| +1957 ms | answer: "I have confirmed that I received order number 4 8 1 5 2 9." |

**The timeline artifact's `tool_calls[0]`:**

```json
{"result":"{\"args\":{\"source\":\"aai-voice-agent-smoke\",\"order_number\":\"481529\"},\"headers\":{…\"x-smoke-test\":\"smoke-header-value-not-secret\",\"user-agent\":\"Python/3.13 aiohttp/3.14.3\"…},\"url\":\"https://postman-echo.com/get?source=aai-voice-agent-smoke&order_number=481529\"}","duration_ms":156,"is_error":false,"timed_out":false}
```

- URL query parameters were merged with the arguments, and the header was sent.
- `GET /v1/agents/{id}` returns the tool header as `[{"name":"X-Smoke-Test","last_set_at":"2026-09-24T00:54:02.695543"}]`, with the value **omitted**.
- `session.ready.config.tools[0].http` = `{"url":…,"method":"GET","headers_ciphertext":"","headers_encrypted_data_key":"","headers_kms_key_id":""}`.
- The **timeline** `config_changes` contain the *non-empty* encrypted header blob, the data key and the KMS key id. They are encrypted, not plaintext.

**Run 2:** no handler was registered. `ToolDispatcher` learned from `session.ready` that the tool has an `http` block and recorded the call as `dropped:"server_side"` (never answered). The answer was the same.

**Status:** PASS.

**Conclusion:**
- **C7 resolved in favour of the starter repo:** `tool.call` *is* emitted for HTTP tools, and it is informational. Never answer it; `client.ts` handles this automatically.
- **C21 resolved:** header values are omitted on read, not returned as `"***"`.

## 10. T6 / T7 / C9 / C10: bring-your-own LLM (`t6a*.ts`, `t6-byo-llm.ts` runs 1 and 2)

**Direct probes (`t6a`, `t6a2`, `t6a3`):**

- **`GET https://llm-gateway.assemblyai.com/v1/models`** returned 200 and lists 47 ids, including claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-5-5, gpt-4.1, gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.6-*, gpt-6-*, gemini-2.5/3.x, qwen3.5-4b-32k-fast, gpt-oss-*, kimi-k3, glm-5.3 and others.
- **`POST …/chat/completions`**:
  - `gpt-5-mini`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `gpt-4.1`, `gpt-5-nano`, `gemini-2.5-flash-lite` and `gpt-oss-20b` all returned **400** `{"metadata":{"errors":["Your account does not have access to this LLM Gateway model"]},"request_id":"…","message":"invalid request body","code":400}`. Raw and Bearer auth behaved the same.
  - `qwen3.5-4b-32k-fast` returned **200**, both non-streaming and **streaming** (SSE).
  - qwen with `tools` returned `400 "model qwen3.5-4b-32k-fast does not support tools"`.
- **OpenAI direct** `gpt-4.1-mini` streaming: first content token 790 ms from India.

**Inline test.** A first `session.update` containing `llm:[…]` gave the error below, then close 1008:

```json
{"code":"invalid_value","message":"BYO LLM config is not allowed on session.update; define it on a stored agent via POST /v1/agents","param":"llm"}
```

**Stored-agent sessions:**
- Each config was set up as `POST /v1/agents {…,"llm":[{"base_url":…,"model":…,"api_key":…}]}`, which returned 201.
- Each session was bound with `{agent_id}`, then got `session.update {tools:[lookup_order]}`.
- Each ran one `reply.create` text turn and one `question_24k.wav` speech turn.

| config | text: first chunk / **audible** | speech: `stopped` | `tool.call` | **answer audible** | what the caller heard |
|---|---|---|---|---|---|
| managed (baseline) | 186 / **1123** | +885 (run 1: +1028) | +2478 (2681) | **+5631** | "Your order is in transit and is expected to arrive on Friday, September 26th." |
| OpenAI direct `gpt-4.1-mini` (`https://api.openai.com/v1`) | 174 / **1184** | +921 (977) | +2998 (3054) | **+6582** | "Your order 481529 is in transit and is estimated to be delivered on Friday, September 26…" (tool argument arrived as `"4 8 1 5 2 9"`) |
| Gateway `gpt-5-mini` | 167 / **never** | – | – | – | 7.6 s of **silence** |
| Gateway `claude-haiku-4-5-20251001` | 177 / **never** | – | – | – | 7.6 s of silence |
| Gateway `qwen3.5-4b-32k-fast` (with tools) | 169 / **never** | +937 | none | never | 7.6 s and 7.9 s of silence |
| Gateway qwen, no tools | 171 / **never** | – | – | – | 11.9 s of silence, no `reply.done` within 12 s |

**How the Gateway failures looked:**
- Every Gateway config produced `reply.started`, a reply made entirely of silent `reply.audio`, then `reply.done{status:"completed"}`.
- There was **no `transcript.agent` and no `session.error`**.
- The saved WAVs contain no voiced segments; gpt-4o-transcribe hallucinates random text on them.

**Where the key ends up:**
- `GET /v1/sessions/{id}` for BYO sessions shows `config.llm[0]` keys `model, base_url, api_key_ciphertext, api_key_kms_key_id, api_key_encrypted_data_key`. That is an encrypted envelope, and no plaintext key appears anywhere (`check-llm-exposure.ts`).
- Those session records remain on the account.

**Status:** PARTIAL.
- OpenAI direct: PASS.
- Gateway: BLOCKED by account access (C10). qwen shows the Voice Agent does not work through the Gateway even when the model is accessible; the probable cause is that tools are unsupported, but it failed without tools too.

**Conclusion:**
- **C9:**
  - BYO works with OpenAI direct.
  - It costs about 1 s more than the managed LLM on the tool path and gives no gain on plain turns.
  - Gateway streaming is *not* OpenAI-only (qwen streams), but Gateway BYO could not be validated on this account.
- **C10 confirmed:** Gateway access is gated per model and per account.
- **Recommendation:** use the **managed LLM**. If you must run BYO, detect the silent failure (a `reply.done` with no audible audio and no transcript; `ReplyTracker.kind === "silent_no_output"`) and fall back.

## 11. Session history (T10 / C25): `t10-session-history.ts`, `fetch-timeline.ts`

**Requests:**
- `GET /v1/sessions?limit=3`
- `GET /v1/sessions/{id}`, polled every 10 s (up to 3 min)
- fetch the timeline and metadata artifacts
- re-fetch the session, then `POST https://api.assemblyai.com/v2/transcript {"audio_url":<pre-signed audio url>,"speech_models":["universal-3-5-pro"],"multichannel":true}`

**List shape:** `{"sessions":[{"id","agent_id","status":"completed","public_close_reason":"client_end","duration_seconds",…}],"has_more","response_metadata":{"next_cursor"}}`

**Record keys:** `id, agent_id, status, public_close_reason, duration_seconds, config, created_at, ended_at, artifacts`.

**Artifacts** (each `{type,url,content_type}`):
- `audio` (`audio/ogg`)
- `timeline` (`application/json`)
- `metadata` (`application/json`)

They are pre-signed S3 URLs on **`speech-to-speech-production-euw1-sessions.s3.amazonaws.com`**, so recordings are stored in eu-west-1 even for the US host. Parameters are `AWSAccessKeyId, Signature, x-amz-security-token, Expires`, and **`Expires` = now + 3600 s**. A ranged GET returned 206 `audio/ogg` with magic `OggS`.

**Availability:** in `latency-matrix.ts`, polling started the moment each session ended. Audio and timeline were present on the 2nd poll, **~6.7 s after `session.end`**, for all three sessions.

**Metadata:**

```json
{"session_id":"sess_…","started_at":"…","ended_at":"…","format":"ogg/opus","channels":2,"channel_layout":"stereo (left=user, right=agent)","sample_rate":24000,"file":"sess_…/recording/audio.ogg","uploaded_chunks":5,"dropped_chunks":0}
```

**Timeline:**
- **Top-level keys:** `session_id, started_at_unix_ms, turns, config_changes, ended`.
  - `ended` = `{"reason":"user_initiated"|"participant_disconnected","public_reason":"client_end","duration_seconds":…}`
- **Turn keys:** `turn_id, item_id, status, trigger, requested_instructions, user_transcript, user_speech_started_at_ms, user_speech_ended_at_ms, user_confidence, agent_text, agent_reply_started_at_ms, agent_reply_ended_at_ms, interrupted_at_ms, time_to_first_audio_ms, tool_calls`.
- **`tool_calls[]` keys:** `call_id, name, arguments, result, dispatched_at_ms, result_received_at_ms, duration_ms, is_error, timed_out, parallel_call_id`.
- **`trigger` values:** `greeting`, `user_speech`, `tool_result`, `reply_create`.
- **Oddities:**
  - The HTTP-tool answer turn in T4 is labelled `trigger:"greeting"`.
  - `time_to_first_audio_ms` is `null` for tool turns.
  - `agent_text` includes unspoken text (§4.2, §12).
  - `user_speech_ended_at_ms` is the end-of-turn commit, not the acoustic end.

**Async STT of the recording** (U3.5 Pro, multichannel): `completed` in 3.4–4.2 s, `speech_model_used:"universal-3-5-pro"`, `audio_channels:2`. Utterances for core run 2:

```
ch2  560-7360   Hi, you're speaking with Acme Shop's automated AI assistant, and this call may be recorded. …
ch1  8800-16520 Hi, I'm calling about my order. The order number is 481529, and it still hasn't arrived.
ch2  21280-24800 Your order is currently in transit and is expected to arrive on Friday, September
ch1  23040-26880 Wait, sorry, stop. Can you just text me the tracking number instead?
ch2  29290-33530 I cannot send text messages, but I can read the tracking details out to you instead.
```

**Core run 1 recording:**
- It has **no** ch2 utterance for the held "I can certainly help you with that…" reply, which confirms that reply was never spoken.
- Its interrupted answer was transcribed as "…expected to arrive in the next 24 hours". The agent's trimmed transcript ends at "…expected to", so treat cut-off agent speech in async transcripts with care.

**Status:** PASS.

**Conclusion:**
- **C25 resolved:** `/v2/transcript` fetches the pre-signed artifact URL directly. No download or `/v2/upload` is needed, and it fits in a Vercel function.
- Artifacts are ready in seconds (docs say about 90 s).
- ch1 = user and ch2 = agent, which gives word timestamps for audio-cited evidence (pattern P5).

## 12. T8 (read-only) and G.711 (`t8-readonly-and-pcmu.ts`)

**Read-only endpoints:**
- `GET /v1/phone-numbers` returned 200 `{"phone_numbers":[],…}` on **both** `agents.us.assemblyai.com` and `agents.assemblyai.com`.
- `GET /v1/webhook-subscriptions` returned 200 `{"subscriptions":[],…}` on both hosts.
- Nothing was created.

**μ-law session:** `input.format` and `output.format` = `{"encoding":"audio/pcmu"}`. `session.ready` echoed `{"encoding":"audio/pcmu","sample_rate":8000}`. `fixtures/question_8k.mulaw` was streamed in 20 ms frames (160 B), with `0xFF` silence between clips.
- **User transcripts:** "Hi, I'm calling about my order." / "The order number is 481529, and it still hasn't arrived."
- **Agent:** "I cannot look up orders on this line, but a human will call you back within one business day."
- **Reply audio:** 300-byte chunks (37.5 ms of 8 kHz μ-law), 11.14 s of audio over 11.1 s of wall time. It decodes cleanly (-21 dBFS RMS) and is saved as `out/va-pcmu-reply.wav`.

**Status:** PASS.

**Conclusion:** μ-law passthrough works for a Twilio Media Streams bridge. PCM replies arrive as 10 ms / 480 B chunks; μ-law replies as 37.5 ms / 300 B chunks.

## 13. Faster-than-real-time audio (`t-rate-violation.ts`)

**Request:** `question_24k.wav` sent as 50 ms frames every ~16 ms (7.3 s of audio in 2.42 s, about 3x real time), followed by real-time silence.

**Observed:** no `session.error` (no `audio_rate_violation`), and both user turns were transcribed completely.

**Status:** PARTIAL (the documented behaviour was not reproduced).

**Conclusion:** the server tolerates short bursts. Still pace at real time; `RealtimeAudioFeeder` never runs ahead.

## 14. Pre-connect and SIP: docs reading only (no telephony)

Re-read on 2026-09-24:
- `/voice-agent-api/pre-connect-requests`
- `/voice-agent-api/connect-to-twilio`
- `/docs/llms.txt`

Claims confirmed as written in research note 01 §13:

**Pre-connect requests:**
- Telephony only ("WebSocket and browser sessions never trigger pre-connect requests").
- At most 2 entries, `timeout_ms` 1–800.
- Fails open, except that `{"reject":true}` ends the call.
- The result is injected as the tool result `aai_pre_connect_context {"variables":{…}}`.
- `allow_overrides` accepts only `greeting`.
- Call facts available to `sends`: `caller_number, dialed_number, direction, agent_id, session_id`.

**SIP:**
- Inbound only, originating at `sip:sip.assemblyai.com`.
- Numbers are registered and bound on `https://agents.us.assemblyai.com/v1` (`POST /phone-numbers/import`, `PUT /phone-numbers/{n}/agent`).
- "agent ids are not shared between `agents.assemblyai.com` and `agents.us.assemblyai.com`" (also confirmed live, §8).

**Observed, not documented:**
- Agent records carry `transfer_targets`, `outbound_trunk_id` and `caller_id`.
- Tools carry `dtmf_collected_arguments`, `response_instructions` and `session_update`.
- No docs page mentions any of these, which points to unreleased transfer, outbound and DTMF features.

---

## 15. Golden config (use these exact settings in the product)

**Server side** (Vercel function; the key never reaches the browser):

```ts
// mint (either auth style works; raw matches Streaming/Async/Gateway)
GET https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=900
Authorization: <ASSEMBLYAI_API_KEY>
```

- The token is reusable and concurrent for its whole window, so authenticate and rate-limit this route.
- `max_session_duration_seconds` is not enforced, so it is not a spend cap.

**Browser:**

```ts
const s = new VoiceAgentSession(new WebSocket(tokenUrl(token)), { maxDurationMs: 5 * 60_000 }); // real cap
await s.start({
  system_prompt: PROMPT,                               // identity + anti-fabrication rule first
  greeting: "Hi, you're speaking with <Brand>'s automated AI assistant, and this call may be recorded. How can I help?",
  input:  { format: { encoding: "audio/pcm", sample_rate: 24000 }, transcription_mode: "balanced" },
  output: { voice: "alba", format: { encoding: "audio/pcm", sample_rate: 24000 } },
  tools:  [ /* type:"function", JSON-schema params with pattern + examples, e.g. " *([0-9] *){6}" */ ],
});
// omit `greeting` (never null) for listen-first; voice + format are immutable after this
s.tools.policy = "immediate";             // fast local tools: ~1 s faster answers (§7)
s.tools.register("lookup_order", handler); // result -> JSON string automatically
s.replies.onReplyDone = (r) => { if (r.kind === "silent_no_output") recover(); };
window.addEventListener("pagehide", () => void s.end()); // session.end, then close
```

**Audio in:**
- PCM16 mono 24 kHz, about 50 ms per `input.audio` frame, at mic pace, sent only after `session.ready`.
- The context runs at the device rate; resample inside the worklet.

**Audio out:**
- `reply.audio` arrives as 10 ms / 480 B frames at real-time pace; keep a jitter buffer of about 100–200 ms.
- Flush on `input.speech.started` and on `reply.done{status:"interrupted"}`. These arrive together when the barge-in is decided.
- Show a "thinking" state from `reply.started` until `ReplyInfo.firstAudibleAtMs`. Every reply starts with 0.2–2 s of silence, and tool pre-ambles are fully silent.

**Captions:**
- Word deltas arrive in a burst; schedule them with `start_ms` relative to the reply's first audio chunk.
- Join words carefully (spacing varies).
- Never caption a reply whose `kind` is `unspoken_text` or `tool_preamble`.

**Turn mode:**
- `balanced` is the default.
- `min_latency` saves about 0.7 s on short Q&A. Validate it on the ID-capture flows first.
- Switch to `max_accuracy` (+1.3 s) only while capturing IDs, then switch back.
- Do not set `min_silence` or `max_silence`.

**Mid-call context:**
- `session.update {system_prompt}` for durable changes; it takes effect on the next reply and works on stored-agent sessions too.
- `replyNow(instructions)` for one-off pushes; it can also trigger tools.
- Do **not** rely on `conversation.message`.

**LLM:**
- Use the managed LLM.
- BYO needs a stored agent (`POST /v1/agents {llm:[…]}`); inline `llm` is fatal.
- OpenAI direct `gpt-4.1-mini` works but adds about 1 s on tool turns.
- Gateway models are locked for this account.

**HTTP tools:** stored agents only. Expect an informational `tool.call` and never answer it (`client.ts` auto-detects these).

**Errors:**
- Read `code` in lower case (`errorCode()`).
- A bad **first** `session.update` usually closes the socket with 1008. Validate config before connecting and mint a fresh token to retry.
- Retryable codes: `at_capacity`, `concurrency_exceeded`, `internal_error`, `server_error`.

**Evidence and analytics:**
- Store the `session_id`.
- About 7 s after the end, `GET /v1/sessions/{id}`, then `POST /v2/transcript {audio_url, speech_models:["universal-3-5-pro"], multichannel:true}`. Use it within the URL's 1 h TTL.
- ch1 = user, ch2 = agent.
- Use the timeline for per-turn TTFA, tool durations and interruptions.

**Telephony bridge:** `{"encoding":"audio/pcmu"}` both ways, 20 ms frames, `0xFF` as silence.

**`client.ts` API summary** (`spikes/voice-agent/client.ts`):

| Export | What it does |
|---|---|
| `VoiceAgentRest` | `mintToken`, agent CRUD, `getSession`, `listSessions`, `waitForArtifacts` |
| `connectNode` / `tokenUrl` | Connect from Node (header or token), or build the browser token URL |
| `VoiceAgentSession` | `start`, `update`, `on`, `waitFor`, `sendAudio`, `replyNow`, `end`, `maxDurationMs` |
| `ToolDispatcher` | Policies `reply_done` and `immediate`; skips server-side tools; drops results on interruption |
| `ReplyTracker` | Audible onset, leading silence, captions, `kind` |
| `RealtimeAudioFeeder` | Mic emulation for files and bridges |
| Typed events | The full client/server event unions |
| `errorCode`, `RETRYABLE_ERROR_CODES`, `chunkLevelDb` | Error normalisation and audio level helpers |

---

## 16. Doc discrepancies (docs or research notes vs live API, 2026-09-24)

**Auth, tokens and errors**

1. **Tokens are not single-use.** One token opened 2 sequential and 2 concurrent sessions within its window. *(docs: "each token starts exactly one session")*
2. **`max_session_duration_seconds` is not enforced.** A 60 s cap still ran at 102 s. `session.ready.expires_at` is always now + 3600 s. *(docs: hard cap; default 10800)*
3. **WS auth failures:** the upgrade succeeds, then `session.error {"code":"unauthorized","message":"Authentication failed"}`, then close 1008. *(docs: `UNAUTHORIZED` upper-case; browsers see only 1006 with no `session.error`; synthesis §2.2)* → C5.
4. **Token endpoint errors** are FastAPI-style: 422 `{"detail":[…]}` for missing auth or bad parameters, and **404** `{"detail":"Invalid API key"}` for a bad key. *(docs: 400/401 with `{"error","code","details"}`)*
5. **`session.error`** always carries lower-case `code` (never `error_code`), and `timestamp` is epoch seconds as a float *(docs: ISO string)*. Every server event carries `timestamp`.

**Session configuration**

6. **Voices:** 18 IDs, adding `iris` and `reid` *(docs: 16)*. `ivy`, `claire` and `dawn` (Twilio README) are invalid, although `"ivy"` appears as the stored agent's `output.voice` default → C8.
7. **REST invalid voice** returns **422** `validation_error` *(docs: 400)*.
8. **A bad first `session.update` is fatal** (close 1008) for an invalid voice, `agent_id` mixed with inline fields, an unknown `agent_id`, or inline `llm`. *(docs: client-message errors keep the session alive)*
9. **`agent_id` plus inline fields** returns `invalid_value` "agent_id is mutually exclusive with other session fields" *(docs: `agent_id_not_first`)*. `agent_id_not_first` does occur, but only for a *later* `agent_id`.
10. **`greeting: null`** is rejected with `invalid_format` *(docs: `string | null`)*.
11. **Tool `parameters` are partially validated** ("'tools[0].parameters.properties' must be an object") *(docs: not validated)*.
12. **An invalid voice sent mid-session** returns `immutable_field`, not `invalid_value`.

**Events and turn-taking**

13. **`conversation.message`** is schema-validated but its content never reaches the model, text-only or before speech *(docs: injects context)* → C6.
14. **HTTP tools emit `tool.call` to the client** *(docs: "No tool.call/tool.result round trip reaches your client")* → C7; the starter repo is right.
15. **Tool-call `reply_id` is not `fc-<call_id>`.** It is a normal `resp_…`. `call_id` is `chatcmpl-tool-…` (managed) or `call_…` (OpenAI BYO).
16. **Silent audio:**
    - Replies start with 0.2–2 s of silent PCM.
    - Tool pre-ambles (the "let me check" filler of interactive mode) are **completely silent** and have **no transcript**.
    - `reply.started` and the first `reply.audio` arrive together with `input.speech.stopped`.
    - None of this is documented. The timeline's `time_to_first_audio_ms` counts to the first audible sample.
17. **`input.speech.stopped` is the end-of-turn commit**, 0.9–3.3 s after the acoustic end depending on mode and utterance.
18. **`input.speech.started` during agent speech** fires only when a barge-in is decided (1.1–2.2 s after the user starts talking). When the agent is silent it fires about 0.6 s after onset.
19. **`transcript.agent` can report text that was never spoken.** When the user resumes after a premature end-of-turn, the reply is held silent, the user turns merge, and the text is still emitted with `interrupted:false`. It also lands in the timeline `agent_text`.
20. **`transcript.agent.delta` words arrive in a burst**, not paced with playback. Spacing is inconsistent: greeting words have no trailing space, LLM words do.
21. **Faster-than-real-time audio** (3x for 7.3 s) was not dropped and raised no `audio_rate_violation` *(docs: dropped plus error)*.
22. **`tool.result` sent before `reply.done`** is accepted and about 1 s faster *(docs: only when `reply.done` is the latest event)*.
23. **`session.ended.audio_duration_seconds`** is always `null`.
24. **Config echoes** contain undocumented fields: `input.continuous_partials`, `tools[].response_instructions`, `deployment_id`, `session_update`, `image_tag`, `dtmf_collected_arguments`. Agent records contain `transfer_targets`, `outbound_trunk_id` and `caller_id`.

**Stored agents, tools and BYO LLM**

25. **Agent ids** look like `agent_<hex>` *(docs example: a UUID)*.
26. **Stored agent `output.voice`** reads as `"ivy"` while the session uses `voice.voice_id`.
27. **HTTP tool header on read** is `{name,last_set_at}`, with the value omitted *(docs summary says masked as "***")* → C21. The timeline `config_changes` do include encrypted header ciphertext, the data key and the KMS key id.
28. **BYO `llm` on read:** the session record `config.llm` exposes `api_key_ciphertext`, `api_key_kms_key_id` and `api_key_encrypted_data_key` *(docs: "reads return only base_url and model")*. Encrypted, not plaintext.
29. **BYO LLM failures are silent:** a completed reply of pure silence, with no transcript and no `session.error`. This held for three Gateway models on this account.
30. **Gateway streaming is not OpenAI-only.** `qwen3.5-4b-32k-fast` streams SSE *(research note 03 §6)* → C9. Model access is per account: "Your account does not have access to this LLM Gateway model" → C10.

**Session history and telephony**

31. **Artifacts appear about 7 s after the end** *(docs: about 90 s)*. Pre-signed URL TTL is 3600 s *(docs: "short TTL")*. Storage is S3 eu-west-1 (`…-euw1-sessions`) even via the US host, which matters for any data-residency claim → C18.
32. **Timeline oddities:**
    - The HTTP-tool answer turn is labelled `trigger:"greeting"`.
    - `time_to_first_audio_ms` is `null` on tool turns.
    - `ended.reason` was `participant_disconnected` in one session that sent `session.end` (`public_reason` was still `client_end`).
33. **`/v1/phone-numbers` also exists on `agents.assemblyai.com`** (200). The docs only use `agents.us.assemblyai.com`.
34. **Host mismatch in the docs:** the pre-connect page's examples use `agents.assemblyai.com`, but numbers are bound on `agents.us`, and agent ids are not shared between hosts. The agent for a SIP number probably has to be created on the host where the number is registered (untested; no telephony here) → C19.
35. **Research note 05 §4.2's `/v1/realtime`** is not needed: `/v1/ws` works → C24.

---

## 17. Scripts and logs

**Run with:** `cd spikes && npx tsx voice-agent/<script>.ts`
**Type-check with:** `npx tsc --noEmit -p voice-agent/tsconfig.json` (clean). The root `npx tsc --noEmit` is also clean.

| Script | Log / output |
|---|---|
| `t2-auth.ts`, `t2b-max-duration.ts` | `va-t2-auth.jsonl`, `va-t2b-max-duration.jsonl` |
| `t5-voices-errors.ts` | `va-t5-voices-errors.jsonl` |
| `core-loop.ts` (+ `core-loop-config.ts`) | `va-core-loop.jsonl`, `va-core-loop-run1.jsonl`, `agent_reply.wav`, `agent_after_bargein.wav` |
| `latency-matrix.ts` | `va-latency-matrix.jsonl` |
| `t3-text-injection.ts`, `t3b-conversation-message.ts`, `t3c-early-tool-result.ts` | `va-t3*.jsonl` |
| `t9-stored-agent.ts` | `va-t9-stored-agent.jsonl` |
| `t4-http-tool.ts` | `va-t4-http-tool.jsonl` (run 2), `va-t4-http-tool-run1.jsonl` |
| `t6a-llm-probes.ts`, `t6a2-gateway-access.ts`, `t6a3-qwen-probe.ts`, `t6-byo-llm.ts` | `va-t6*.jsonl`, `va-t6-<config>.wav` |
| `t10-session-history.ts`, `fetch-timeline.ts` | `va-t10-session-history*.jsonl`, `va-t10-<session>-{timeline,metadata}.json` |
| `t8-readonly-and-pcmu.ts`, `t-rate-violation.ts` | `va-t8-readonly-and-pcmu.jsonl`, `va-pcmu-reply.wav`, `va-t-rate-violation.jsonl` |
| Utilities: `analyze-clips.ts`, `analyze-wav.ts`, `check-reply-wav.ts`, `check-llm-exposure.ts`, `scan-secrets.ts`, `cleanup-check.ts` | – |

**Leftovers on the account** (not deleted; they are session records, not agents or webhooks): about 35 session records. Nine of them are BYO sessions from the two `t6-byo-llm` runs, and their `config.llm` holds an *encrypted* key envelope:
- 2 hold the OpenAI key (the OpenAI-direct runs);
- 7 hold the AssemblyAI key (the Gateway configs).

They can be soft-deleted with `DELETE /v1/sessions/{id}` if wanted.
