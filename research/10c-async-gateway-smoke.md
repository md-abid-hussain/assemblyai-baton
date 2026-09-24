# 10c: Live smoke tests of async transcription, Speech Understanding and the LLM Gateway

**Run date:** 2026-09-24, 00:38–01:20 UTC.

**Account:** the hackathon account (the `.env` AssemblyAI key, on free credits).

**Code:**
- `spikes/async/` holds the async client, smoke runner, ground-truth scorer and logging fetch.
- `spikes/gateway/` holds the Gateway client, smoke runner, catalog dump, access matrix and offline self-test.

**Logs:**
- Test logs are in `spikes/out/async-*.jsonl` and `spikes/out/gateway-*.jsonl`.
- Full responses are in `spikes/out/async-*.transcript.json`, `spikes/out/async-su-posthoc.*.json` and `spikes/out/gateway_models.json`.
- Per-test summaries are in `spikes/out/async-summary.json` and `spikes/out/gateway-summary.json`.

**Spend:** about **$0.04** in total.
- About 395 s of billable async audio, including ×2 for the stereo file.
- 9 Speech Understanding task calls.
- About 25 tiny calls to `qwen3.5-4b-32k-fast`.
- No agents or webhooks were created, so nothing needed deleting.
- Transcripts were not deleted, because `DELETE /v2/transcript/{id}` is permanent. Their IDs are in §7. They expire on the default 30-day time-to-live (TTL).

IDs such as C10 and T7 refer to `00-synthesis.md` §7.

---

## 0. TL;DR

**Verdicts**

| Area | Verdict | One line |
|---|---|---|
| Upload + `/v2/transcript` + poll | **PASS** | A 69 s dialog is done in 7–12 s wall time (RTF 0.09–0.28). Speaker labels are 100% correct at word level, and all 19 ground-truth facts appear in the transcript. |
| Entities, redaction, unredacted text, redacted audio | **PASS** | Everything works. There are gotchas: entities and sentiment rows leak PII, and the redacted-audio URL lives 30 min. |
| Sentiment analysis | **PASS, with a defect** | The `speaker` field is right only 38.5% of the time. 17 of 29 rows contain raw `[Speaker:1]` tags. The text is **not** redacted. `reattributeSentiment()` fixes speakers to 96.6%. |
| Speech Understanding inline (speaker role ID + Spanish + custom formatting in one request) | **PASS** | The role mapping `{A: Adjuster, B: Claimant}` is 100% correct. It works together with PII redaction. Custom formatting of phone numbers and dates **conflicts** with redaction of the same fields (400). |
| Speech Understanding post-hoc `POST llm-gateway…/v1/understanding` | **PASS** | Works without Gateway access. It is **rate-limited to 2 requests per 60 s**. It returns a slim object, not a full transcript, and nothing is persisted. |
| C29 (`speakers` vs `known_values`) | **Resolved: both work** | Both return the same mapping. Speaker ID also works on **multichannel** transcripts (`{"1":"Adjuster","2":"Claimant"}`). |
| Multichannel stereo | **PASS** | Speaker/channel is `"1"`/`"2"` and 98.5% correct. `audio_duration` is 70, not doubled. Word timestamps are **coarse** (median word length 80 ms). |
| `speech_models` fallback + code-switching | **PASS** | Hinglish was routed to U3.5 Pro as `hi`. Output is Devanagari plus English, and `481529` is exact. |
| `/sentences`, `/paragraphs` | **PASS** | Sentences carry correct speakers (100%). Paragraphs have **no** `speaker` field. |
| **LLM Gateway (T7/C10)** | **Blocked by C10** | Only 1 of 45 models, `qwen3.5-4b-32k-fast`, is callable, at **2 requests/min**. The other 44 return `400 "Your account does not have access to this LLM Gateway model"`. Claude, OpenAI, structured outputs and tool calling could not be tested live. |
| Gateway on qwen | **PASS** | Chat works (median 1.14 s), both `Bearer` and raw-key auth work, and SSE streaming works (partly contradicts "OpenAI only"). `transcript_id` injection works, with redacted transcripts injecting redacted text. `json-repair` fixes malformed JSON. `fallbacks` do not rescue validation or access errors, and unsupported parameters are rejected with a 400. |

**What changes the architecture**
1. **The Gateway needs an upgraded (paid) account for any real model (C10 confirmed).** Until then, the in-product agents keep using OpenAI directly (`OPENAI_API_KEY`), which matches the model-routing decision. The Gateway free path is qwen at 2 requests/min, which is fine for a demo and useless under load.
2. **Speech Understanding has its own rate limit of 2 requests/min** (`x-ratelimit-service: speech-understanding`). Request speaker ID and translation **inline** in `POST /v2/transcript` (tested). Inline summarization is documented but was not tested here. Use post-hoc `/v1/understanding` only as a fallback. The client retries on 429 using `retry-after`.
3. **For the "audio-cited evidence" feature, use mono + `speaker_labels` word times, not multichannel.**
   - Multichannel word boundaries are quantized: 90 of 137 words are exactly 80 ms long, and word starts are off by 126 ms on average versus mono.
   - Map roles with Speaker ID, which works on both mono and multichannel.
4. **Never show or store sentiment rows or entities as "redacted" data.** They carry raw PII even when `redact_pii` is on.

---

## 1. Method

**Code**
- `async/client.ts` is fetch-based with no dependencies. `gateway/client.ts` wraps the OpenAI SDK with a swapped `baseURL`. Both are reusable.
- `async/http-log.ts` is a `fetch` wrapper. It logs every request and response (key masked, binary bodies logged as `{bytes}`, SSE bodies not buffered) into the JSONL logger from `lib/log.ts`.
- `async/compare.ts` scores transcripts against `fixtures/dialog_script.json`:
  - fact recall on normalized text (19 facts);
  - word-level speaker accuracy, by the ground-truth turn at each word's midpoint;
  - utterance/turn alignment;
  - a redaction matrix;
  - sentiment speaker accuracy;
  - a word-timing comparison.

**Fixtures:** `dialog_mono_16k.wav` (69.13 s, 16 turns), `dialog_stereo_16k.wav` (left = adjuster, right = claimant), `question_16k.wav` (7.3 s), `codeswitch_16k.wav` (12.01 s).

**Re-run:**
```sh
cd spikes
npx tsx async/smoke.ts                    # all async tests (add --reuse to reuse upload/transcript ids from out/async-state.json)
npx tsx async/smoke.ts --only=golden      # single test
npx tsx gateway/models.ts                 # catalog -> out/gateway_models.json
npx tsx gateway/access.ts                 # per-model access matrix -> out/gateway-access.json
npx tsx gateway/smoke.ts                  # gateway tests (paces on 429; ~15 min on a 2 rpm budget)
npx tsx gateway/selftest.ts               # 16 offline checks of both clients (mock fetch + saved live responses)
npx tsc -p async/tsconfig.json --noEmit   # typecheck (async + gateway + lib)
```
`async/` and `gateway/` each have their own `tsconfig.json` that extends the root one. The root `include` does not cover them yet, so add them when these modules are promoted.

---

## 2. Tests

### A1. Upload: PASS

**Request:** `POST https://api.assemblyai.com/v2/upload` with headers `Authorization: <key>` and `Content-Type: application/octet-stream`. The body is the raw WAV bytes.

**Observed:** `200 {"upload_url":"https://cdn.assemblyai.com/upload/<hex32>/<uuid>"}`.

| File | Bytes | Upload time |
|---|---|---|
| mono | 2,212,204 | 3.55 s |
| stereo | 4,424,364 | 4.06 s |
| question | 233,644 | 2.13 s |
| code-switch | 384,364 | 0.34 s |

**Conclusion:** Works as documented. The URL format is `upload/<32-hex>/<uuid>`, not the single UUID shown in the docs. Upload needs raw bytes, so from Vercel pass a URL instead: the 4.5 MB body limit applies (§2.7).

### A2. Request validation (negative cases): PASS (exploratory)

All cases used the 7.3 s question clip. Anything that was accepted was transcribed, for ≈$0.0005 each.

| Request | Observed |
|---|---|
| `speech_models:["universal-3-pro"]` | **Accepted**, and `speech_model_used:"universal-3-pro"`. The text was correct. |
| `redact_pii_policies:["person_name","gender"]` ("fabricated" policy per research 04) | **Accepted silently.** The policy list is echoed back unchanged and nothing is validated. |
| `language_detection:false` with no `language_code` | **Accepted.** It defaulted to `language_code:"en_us"`. |
| `language_code:"en"` / `"en_us"` | Both accepted. Both are echoed as `"en_us"`. |
| `redact_pii_return_unredacted:true` without `redact_pii` | `400 {"error":"`redact_pii_return_unredacted` can only be set to True if `redact_pii` is True"}` |
| `speakers_expected` + `speaker_options` | `400 {"error":"Both speaker_options and speakers_expected can not be used in the same request."}` |
| `speech_understanding.speaker_identification` without `speaker_labels` | `400 {"error":"speaker_labels or multichannel required"}` |
| Redaction of `phone_number`/`date` + `custom_formatting` of `phone_number`/`date` | `400 {"error":"redact pii phone_number not compatible with formatting phone_number; redact pii date not compatible with formatting date"}` (seen in A4b) |

**Conclusion:**
- Unknown PII policies and the retired `universal-3-pro` are **not rejected**, so validate on our side (`PII_POLICIES` in `async/client.ts`).
- Synthesis §2.9 says `universal-3-pro` is "rejected". That is contradicted for async; it still works today.

### A3. Full-feature transcript (mono dialog): PASS

**Request:**
```json
{
  "audio_url": "<upload_url>",
  "speech_models": ["universal-3-5-pro"],
  "language_detection": false, "language_code": "en",
  "speaker_labels": true, "speakers_expected": 2,
  "entity_detection": true, "sentiment_analysis": true,
  "keyterms_prompt": ["Harbor Point","Daniel Reyes","Priya Shah","Mark Donnelly","Lakeside Auto Body","Birchwood Lane","Maple Avenue","Springfield","deductible","appraiser"],
  "redact_pii": true,
  "redact_pii_policies": ["person_name","phone_number","location","location_address","location_address_street","location_city","account_number","number_sequence","money_amount","date","organization"],
  "redact_pii_sub": "entity_name", "redact_pii_return_unredacted": true,
  "redact_pii_audio": true, "redact_pii_audio_quality": "mp3"
}
```

**Timing (id `68453b7e…`):**
- Submit took 1,445 ms. The job reached `processing` at 2.3 s and `completed` at **8.7 s**.
- `audio_duration: 70` for 69.13 s of audio, giving RTF 0.12.
- In other runs the same file completed in 7.8 s (plain), 11.4 s (redaction + SU) and 19.5 s (3 SU tasks inline).

**Response shape.** The 80 top-level keys are listed in `out/async-full.report.json`. Notable ones:

| Key | Notes |
|---|---|
| `language_code:"en_us"` | `"en"` is normalized to `"en_us"` |
| `speech_model_used:"universal-3-5-pro"` | |
| `audio_duration:70` | Integer, rounded **up**: 7.3→8, 69.13→70, 12.01→13 |
| `words(137)`, `utterances(16)` | |
| `unredacted_text`, `unredacted_words(137)`, `unredacted_utterances(16)` | Same counts as the redacted versions, so they align 1:1 |
| `entities(22)`, `sentiment_analysis_results(29)` | |
| `speaker_options:{min_speakers_expected:2,max_speakers_expected:2,advanced_speaker_segmentation:true}` | This is the field research 04 flagged as `[UNVERIFIED]`. The server sets it. |
| `content_safety_labels:{status:"unavailable",…}`, `iab_categories_result:{status:"unavailable",…}` | Present even though they were not requested |
| `project_id`, `token_id` | Numbers; undocumented |
| `remove_audio_tags:"all"` | |
| `speech_understanding:null`, `translated_texts:null` | |

Shapes of individual items:
```json
// word (redacted)            {"text":"[ORGANIZATION]","start":16,"end":435,"confidence":0.9995956,"speaker":"A"}
// utterance                  {"speaker":"A","text":"[ORGANIZATION] [ORGANIZATION] [ORGANIZATION]. [PERSON_NAME] [PERSON_NAME] speaking. Your name and policy number, please?","confidence":0.9877636,"start":16,"end":4678,"words":[...]}
// unredacted utterance       {"speaker":"A","text":"Harbor Point Claims. Daniel Reyes speaking. Your name and policy number, please?", ... same timings}
// entity                     {"entity_type":"person_name","text":"Daniel Reyes","start":1709,"end":2322,"speaker":"A"}   <- has undocumented "speaker"
// sentiment row              {"sentiment":"NEUTRAL","speaker":"A","text":"Policy number HP7740391.","start":6968,"end":11062,"confidence":0.6624614}
```

**Unredacted text (verbatim).** The emphasis marks the two points where the text differs from the script.
> Harbor Point Claims. Daniel Reyes speaking. Your name and policy number, please? Hi, it's Priya Shah. Policy number HP7740391. Thanks, Ms. Shah. What happened? I was rear-ended on Tuesday, September 15th, around 5 PM, outside 1420 Maple Avenue in Springfield. Was anyone hurt? No, just a sore neck. The other driver, Mark Donnelly, **Was** on his phone. Do you have a repair estimate? Lakeside Auto Body quoted $3,450, and the tow was $125. Okay. Your deductible is $500. What time did the accident happen? It was around 7 PM. It was already getting dark. Got it. What's the best number to reach you? My cell is 415-555-0137. And you are still at 88 Birchwood Lane, Springfield? Yes, that's right. Great. Your claim number is CL44812. An appraiser will call you Friday at **10:00 AM**. Perfect. Thanks, Daniel.

**Redacted text (start).**
> `[ORGANIZATION] [ORGANIZATION] [ORGANIZATION]. [PERSON_NAME] [PERSON_NAME] speaking. … Policy number [ACCOUNT_NUMBER]. … on [DATE], [DATE] [DATE], around 5 PM, outside [LOCATION_ADDRESS_STREET] [LOCATION_ADDRESS_STREET] [LOCATION_ADDRESS_STREET] in [LOCATION_CITY]. … quoted [MONEY_AMOUNT] … My cell is [PHONE_NUMBER]. And you are still at [LOCATION_ADDRESS] [LOCATION_ADDRESS] [LOCATION_ADDRESS], [LOCATION_CITY]? … Your claim number is [NUMBER_SEQUENCE].`

Redaction is **one tag per original word**, so "Harbor Point Claims" becomes three `[ORGANIZATION]` tags. A contiguous address is tagged `location_address`, and a fragment is tagged with the granular subtype, as documented.

**Comparison with `dialog_script.json`:**

| Check | Result |
|---|---|
| Fact recall (unredacted) | **19/19**: names, org names, HP7740391, CL44812, 415-555-0137, both addresses, Springfield, Tuesday September 15th, 5 PM, 7 PM, Friday 10 AM, $3,450, $125, $500 |
| Word-level speaker accuracy | **100%** (A = adjuster, B = claimant) |
| Utterances vs turns | 16/16. Mean absolute start offset 300 ms, and the audio starts are about 250 ms early. The phone-number turn's end is 3.2 s early. |
| Entities (22) | `organization`: Harbor Point Claims, Lakeside Auto Body. `person_name`: Daniel Reyes, Priya Shah, Shah, Mark Donnelly, Daniel. `account_number`: HP7740391. `number_sequence`: CL44812. `date`: Tuesday, September 15th. `time`: 5 PM, 7 PM, 10:00 AM. `location` (3), `money_amount` (3), `phone_number`, `injury`: sore neck. `occupation`: appraiser. |
| Redacted in `text` | Every fact covered by the chosen policies. The times (5 PM, 7 PM, 10 AM) remain because `time` was not requested. |

**Sentiment defect (important):**

| Measure | Value |
|---|---|
| Rows | 29 |
| Rows with `speaker:null` | 3 |
| Speaker accuracy vs truth | **10/26 = 38.5%** |
| Rows with inline tags | **17/29**, with values `[Speaker:1]`, `[Speaker:2]`, `[Speaker:Daniel]`, `[Speaker:Priya Shah]` |
| Text redacted? | **No.** All 19 facts are visible in the sentiment text. |

Example rows:
```json
{"speaker":"B","sentiment":"NEUTRAL","text":"[Speaker:1] Was anyone hurt?"}          // truth: adjuster (A)
{"speaker":"A","sentiment":"NEUTRAL","text":"Policy number HP7740391."}              // truth: claimant (B)
{"speaker":null,"sentiment":"POSITIVE","text":"[Speaker:Priya Shah] Perfect."}
```
The sentence segmentation here also differs from `/sentences`: "Thanks, Ms." and "Shah." are separate rows.

**Mitigation, if sentiment is used:** `reattributeSentiment(rows, utterances)` in `async/client.ts`.
- It strips `/\[Speaker:[^\]]*\]\s*/g` and re-attributes each row to the utterance with the largest time overlap.
- On this transcript it raises sentiment speaker accuracy from **38.5% to 96.6%** (28/29 rows; verified in `gateway/selftest.ts` against the saved live response).
- The text must still be treated as unredacted PII.

**Redacted audio:**
- `GET /v2/transcript/{id}/redacted-audio` returned ready 1.4 s after completion:
  `{"redacted_audio_url":"https://s3.us-west-2.amazonaws.com/api.assembly.ai.usw2/redacted-audio/<transcript_id>.mp3?AWSAccessKeyId=…&Signature=…&x-amz-security-token=…&Expires=…","status":"redacted_audio_ready"}`
- `HEAD` on the URL returns **403**, because the signature is for GET only.
- A ranged GET (`Range: bytes=0-15`, not saved) returned `206` with `content-type: binary/octet-stream` and `content-range: bytes 0-15/207909`. The file starts with `ID3`, so it is an MP3.
- **The URL expires 30 min after it is issued.** Each new `GET /redacted-audio` mints a fresh 30-minute URL; a re-request 20 min later showed `ttlMin: 30`.

**Conclusion:** Transcription, diarization, entities and redaction are production-ready for the claim-call use case. Sentiment needs the post-processing above.

### A4. Speech Understanding inline (in `POST /v2/transcript`): PASS

**Request:** the base request (U3.5 Pro, `en`, `speaker_labels`, `speakers_expected:2`, keyterms) plus:
```json
"speech_understanding": {"request": {
  "speaker_identification": {"speaker_type":"role","speakers":[
    {"role":"Adjuster","description":"Insurance claims adjuster at Harbor Point who answers the call and asks the questions"},
    {"role":"Claimant","description":"Driver reporting a car accident and filing the claim"}]},
  "translation": {"target_languages":["es"],"match_original_utterance":true},
  "custom_formatting": {"date":"mm/dd/yyyy","phone_number":"(xxx)xxx-xxxx","email":"username@domain.com","format_utterances":true}}}
```

**Timing:** completed in 19.5 s (RTF 0.28), about 11 s slower than without SU.

**Observed (id `c2aff128…`):**
```json
"speech_understanding": {
  "request": { ...echo... },
  "response": {
    "speaker_identification": {"mapping":{"A":"Adjuster","B":"Claimant"},"effort":"low","status":"success"},
    "translation": {"status":"success"},
    "custom_formatting": {"formatted_utterances":[16 items],"status":"success","mapping":{"415-555-0137":"(415)555-0137"},"formatted_text":"…My cell is (415)555-0137.…"}}}
"translated_texts": {"es": "Harbor Point Claims. Habla Daniel Reyes. ¿Su nombre y número de póliza, por favor? Hola, soy Priya Shah. …"}
"utterances[1]": {"speaker":"Claimant","text":"Hi, it's Priya Shah. Policy number HP7740391.","translated_texts":{"es":"Hola, soy Priya Shah. Número de póliza HP7740391."}, ...}
```

- `utterances[].speaker` and `words[].speaker` are replaced with the roles. Role accuracy is 100%.
- **Top-level `text` and `utterances[].text` are *not* formatted.** They still read `415-555-0137`. Formatting appears only in `speech_understanding.response.custom_formatting.formatted_text` and `.formatted_utterances`. The docs say `text` is also updated.
- The date "Tuesday, September 15th" was **not** formatted: with `mm/dd/yyyy` the year is unknown, which is the documented conservative behavior. Use `"mm/dd/yyyy,mm/dd"` to catch dates without a year.
- The translation mixes formal and informal register ("Su nombre" vs "Tu deducible"). Set `formal:true` for customer-facing text.
- Translation is not deterministic: two runs gave different Spanish wording.

### A4b. Golden request: redaction + unredacted + inline SU: PASS

This is the product request exactly (see §4).

**First attempt:** included `custom_formatting` of `phone_number`/`date` together with redaction of `phone_number`/`date`. Result: `400 {"error":"redact pii phone_number not compatible with formatting phone_number; redact pii date not compatible with formatting date"}`.

**Retry:** without `custom_formatting`. Result: PASS (id `5e4b49bc…`), completed in 11.4 s.

**Observed:**
- `speech_model_used: universal-3-5-pro`. `speech_models` was `["universal-3-5-pro","universal-2"]`, so the fallback list is accepted with a pinned language.
- Speaker ID `{A: Adjuster, B: Claimant}` succeeded, and so did translation.
- `utterances`/`words` speakers are roles, but **`unredacted_utterances`/`unredacted_words` still say `A`/`B`**. Apply `mapping` yourself.
- `translated_texts.es` is translated from the **redacted** text: `"Habla [PERSON_NAME] [PERSON_NAME]. … Número de póliza [ACCOUNT_NUMBER]."`. No raw PII appears in the translation, so it is safe to share.
- `entities` (22) are still unredacted, as documented.

### A5. Speech Understanding post-hoc (`POST https://llm-gateway.assemblyai.com/v1/understanding`): PASS (C29 resolved)

**Base transcript:** `5d0563f8…`. Plain request, U3.5 Pro, `speaker_labels`, `speakers_expected:2`. Completed in 7.8 s, speaker accuracy 100%.

**Request shape:**
```json
{"transcript_id":"<id>","speech_understanding":{"request":{ "<task>": { ... } }}}
```
The header is `Authorization: <key>` (raw). **This works even though the account has no Gateway model access.**

| Task | ms | Result |
|---|---|---|
| `speaker_identification` role + `speakers:[{role,description}]` (C29 A) | 2,309 | `{"mapping":{"A":"Adjuster","B":"Claimant"},"effort":"low","status":"success"}`, accuracy 100% |
| `speaker_identification` role + `known_values:["Adjuster","Claimant"]` (C29 B) | 2,189 | Same mapping, accuracy 100% |
| `speaker_identification` name + `speakers:[{name:"Daniel Reyes",…},{name:"Priya Shah",…}]` | ≈2,200 after a rate-limit wait | `{"A":"Daniel Reyes","B":"Priya Shah"}`, accuracy 100% |
| `translation` es + `match_original_utterance` | 2,927 | `translated_texts.es` and per-utterance `translated_texts` |
| `custom_formatting` | ≈2,200 after a rate-limit wait | `formatted_text`, `formatted_utterances`, `mapping:{"415-555-0137":"(415)555-0137"}` |
| All three in one request | 6,611 | All `success` |
| Speaker ID on the **multichannel** transcript (`known_values`) | 2,485 | `{"1":"Adjuster","2":"Claimant"}`, accuracy 98.5% |

**Response shape** (not a transcript; there is no `id`, `text` or top-level `words`):
```json
// speaker_identification:  {"speech_understanding":{"request":{...},"response":{"speaker_identification":{...}}},"utterances":[16, relabelled, with words],"request_id":"<uuid>"}
// translation:             {"speech_understanding":{...},"translated_texts":{"es":"..."},"utterances":[16 with translated_texts],"request_id":"..."}
// custom_formatting:       {"speech_understanding":{"response":{"custom_formatting":{"formatted_text","formatted_utterances","mapping","status"}}},"request_id":"..."}   <- no top-level utterances
// all three:               {"translated_texts","request_id","speech_understanding","utterances"}
```

**Rate limit** (headers seen on every response):
```
x-ratelimit-feature: understanding     x-ratelimit-service: speech-understanding
x-ratelimit-limit: 2                   x-ratelimit-remaining: 1 -> 0 -> -1 ...   x-ratelimit-reset: 60
429 body: {"request_id":"…","message":"too many requests for this action","code":429}   + retry-after: 56
```
The third through sixth back-to-back calls got 429. With `retry-after` handling, the six tasks took 138 s in total.

**Persistence:** `GET /v2/transcript/{id}` afterwards shows `speech_understanding:null` and speakers still `A`/`B`. **Post-hoc results are not stored**, so persist them yourself.

**Conclusion:**
- C29: both request shapes are valid and give identical results. The JS SDK types only know `known_values`, so use `known_values` for simple role lists and `speakers[]` when you need descriptions.
- Prefer inline SU, which has no 2 req/min limit on the submit path.

### A6. `/sentences` and `/paragraphs`: PASS

**Request:** `GET /v2/transcript/{id}/sentences` and `GET /v2/transcript/{id}/paragraphs`.

**Envelope:**
```json
{"sentences":[28],"id","confidence","audio_duration","speech_model_used"}
{"paragraphs":[7],"id","confidence","audio_duration","speech_model_used"}
```

**Items:**
- A sentence is `{"text","start","end","words","confidence","speaker"}`, for example `{"speaker":"A","start":16,"end":1290,"text":"Harbor Point Claims."}`. Sentence speaker accuracy is **100%**, unlike sentiment.
- A paragraph is `{"text","start","end","confidence","words"}` with **no `speaker`**. Paragraphs span speakers: paragraph 1 is `"Harbor Point Claims. Daniel Reyes speaking. Your name and policy number, please? Hi, it's Priya Shah. Policy number HP7740391."`

On the redacted transcript, sentences and paragraphs are **redacted** (`[ORGANIZATION] …`).

### A7. Multichannel (`dialog_stereo_16k.wav`): PASS

**Request:**
```json
{"audio_url":"<stereo upload>","speech_models":["universal-3-5-pro"],"language_detection":false,"language_code":"en","multichannel":true,"keyterms_prompt":[...]}
```

**Timing (id `e70da52d…`):** completed in 6.4 s. That is **not** 40% slower than mono (7.8 s); only one sample was taken.

**Observed:**
- `audio_channels: 2`, `audio_duration: 70`. The duration is not doubled, so apply the ×2 billing yourself (`billableSeconds()` gives 140).
- `speaker_labels` is false in the response.
- Utterances look like `{"channel":"1","speaker":"1","text":"Harbor Point Claims, Daniel Reyes speaking. …","start":240,"end":4640,…}`. There are 8 utterances per channel, and the transcript reads cleanly by channel:
  ```
  [00:00] Adjuster(L): Harbor Point Claims, Daniel Reyes speaking. Your name and policy number, please?
  [00:05] Claimant(R): Hi, it's Priya Shah, policy number HP7740391.
  ```
- Words look like `{"text":"Harbor","start":240,"end":320,"confidence":0.9988,"speaker":"1","channel":"1"}`. Both `speaker` and `channel` are strings.
- Channel-to-truth accuracy is 98.5%, with a few boundary words. Fact recall is 19/19.
- **Word timing is coarse.** Aligning to the mono transcript of the same audio:

  | Measure | Multichannel | Mono |
  |---|---|---|
  | Words that are exactly 80 ms long | 90/137 | — |
  | Median word duration | 80 ms | 242 ms |
  | Mean word-start error | 126 ms | — |
  | Mean word-end error | 154 ms | — |

**Billing:** per the docs, duration × channels × rate, so 140 s here. The API gives no per-job cost field.

### A8. `speech_models` fallback list + language detection (Hinglish): PASS

**Request:**
```json
{"audio_url":"<codeswitch upload>","speech_models":["universal-3-5-pro","universal-2"],"language_detection":true}
```

**Observed (id `a90b2feb…`, 5.0 s, `audio_duration:13`):**
- `speech_model_used:"universal-3-5-pro"`, `language_code:"hi"`, `language_confidence:0.8817`.
- `language_detection_results: null`: no `code_switching_languages` block, although research 04 §7 shows one.
- Text:
  > मेरा ओर्डर अभी तक नहीं आया. Can you please check the status? ओर्डर नंबर है 481529. और हाँ, डिलिवरी कल तक हो जाएगी क्या?

  The order number `481529` is exact. The Hindi is in Devanagari, not romanized, and the English stays Latin.

**Conclusion:**
- U3.5 Pro handles Hindi–English code-switching natively. Universal-2 was not needed.
- Expect native script. Transliterate if the UI needs romanized Hinglish.

### G1. Model catalog (`GET https://llm-gateway.assemblyai.com/v1/models`): PASS (C26, C27)

**Request:** no auth. Adding auth returns the identical list.

**Result:** `200` in 1.7 s. Full body is in `spikes/out/gateway_models.json`.

**C27:** 45 models at 00:39 UTC, and 45 again at 01:09 UTC; five back-to-back fetches were also stable. A concurrent agent's fetch of the same URL at 00:55 UTC returned **47**, including `gpt-6-luna` and `gpt-6-sol`. So models **appear and disappear within minutes**, likely a rollout in progress: openai-node 7.22.0 added "GPT-6 Sol and Luna" identifiers on 2026-09-22. Never hardcode the catalog, and tolerate a model vanishing between the catalog read and the call.

**Model keys:**
- Documented: `id`, `name`, `description`, `creator`, `context_length`, `supported_parameters`, `default_parameters`, `top_provider`, `pricing`, `retirement_date`, `available_regions`.
- New and undocumented: **`providers:[{id,name}]`** and **`default_provider:{id,name}`**. Provider IDs seen: `bedrock`, `bedrock_mantle`, `vertex`, `open_ai`, `fireworks`, `digital_ocean`, `assemblyai`.

**`available_regions` (C26):**

| Regions | Models |
|---|---|
| `us+eu+global` | 10 |
| `us+global` | 12 |
| `us` | 19 |
| `us+eu` | 4 |

- `global` is listed for most Claude models, most Gemini models, **and OpenAI `gpt-5.5`, `gpt-5.6-luna`/`sol`/`terra`**. That contradicts the docs table ("OpenAI Global: No") and "Global live for Claude only".
- `GET https://llm-gateway.eu.assemblyai.com/v1/models` lists only **13** models: Claude haiku-4.5/sonnet-4.5/sonnet-4.6/opus-5.5, Gemini 2.5-flash/flash-lite/pro/3.6/3.7/3.8, Nemotron ×3. It **omits `qwen3.5-4b-32k-fast`**, which the US catalog lists with `eu`.

**Structured-output support per the catalog:** `response_format` is **missing** for `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5`, `gpt-4.1`, `gpt-oss-20b`, `gpt-6-astra` and `qwen3.5-4b-32k-fast`. That confirms synthesis §2.9 and adds `claude-opus-5-5`, `gpt-4.1` and `gpt-6-astra` to the list.

**Streaming per the catalog:** `stream` is listed for every model except `gpt-oss-*`.

### G2. Access matrix (C10 / T7): FAIL for paid models (C10 confirmed)

`gateway/access.ts` sent one request per model: `{"model":<id>,"messages":[{"role":"user","content":"Say hi."}],"max_tokens":16}`.

- **1/45 accessible: `qwen3.5-4b-32k-fast`** (the AssemblyAI-hosted model).
- **44/45 returned:**
  ```json
  400 {"metadata":{"errors":["Your account does not have access to this LLM Gateway model"]},"request_id":"…","message":"invalid request body","code":400}
  ```
  These denials carry no rate-limit headers and return in about 275 ms.
- **The qwen rate limit on this account is 2 requests/min** per model, with headers `x-ratelimit-limit: 2`, `x-ratelimit-model: qwen3.5-4b-32k-fast` and `x-ratelimit-service: llmgw`. The docs say 30/min for paid accounts. The budget is shared per key, and other agents' Gateway probes consumed it during this run.

**Conclusion:**
- C10 confirmed: the $50 credit does not unlock Gateway models. An upgrade is needed.
- The docs' "Free: not available" is only partly right: the self-hosted qwen *is* available at 2 rpm.

### G3. Auth: PASS

| Variant | Result |
|---|---|
| `Authorization: <key>` (raw) | `200` |
| `Authorization: Bearer <key>` (raw fetch, and the OpenAI SDK) | `200`. Research 03's `[UNVERIFIED]` note is resolved: **both forms work**. |
| No `Authorization` header | `401 {"error":"Your account does not have access to LLM Gateway. Please upgrade or contact us at support@assemblyai.com for more information.","status":"error","request_id":"…"}`. The message is misleading: it is a missing-key error, not a plan error. |
| Bad key | `401 {"error":"Authentication error, API token missing/invalid","status":"error","request_id":"…"}` |

Error bodies come in **two envelopes**:
- `{"error","status","request_id"}` for auth errors;
- `{"code","message","request_id","metadata":{"errors":[…]}}` for validation, access and rate-limit errors.

### G4. Chat completions (a) cheap OpenAI, (b) claude-sonnet-4-6, (c) fast small model: PARTIAL

| Model | Result |
|---|---|
| (a) `gpt-5-nano` | `400 … "Your account does not have access to this LLM Gateway model"` (276 ms) |
| (b) `claude-sonnet-4-6` | Same 400 (278 ms) |
| (c) `qwen3.5-4b-32k-fast` via the OpenAI SDK | **200 in 1,121 ms.** Content: "The capital of France is Paris." |

The qwen response (c):
```json
{"request":{"model":"qwen3.5-4b-32k-fast","max_tokens":60},"request_id":"93f7…","model":"qwen3.5-4b-32k-fast",
 "choices":[{"message":{"role":"assistant","content":"The capital of France is Paris."},"finish_reason":"stop"}],
 "usage":{"input_tokens":24,"prompt_tokens":24,"output_tokens":8,"completion_tokens":8,"total_tokens":32,
          "prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},
          "completion_tokens_details":{"reasoning_tokens":0,…}},
 "http_status_code":200,"response_time":53194779,"llm_status_code":200}
```

- `usage` carries **both** naming schemes (`input_/output_tokens` **and** `prompt_/completion_tokens`).
- `http_status_code` is **absent on some 200 responses**; the system+user call lacked it. Don't rely on it.
- `response_time` is about 50 ms (in ns) against about 1.1 s wall time from this client. Round trip from India to the US endpoint plus Gateway overhead is about 0.8–1.1 s.
- `system` + `user` works: "Paris is the capital."
- The documented `prompt` shortcut works: `{"prompt":"Say hello in Spanish, one word."}` returned "Hola".
- `max_tokens:3` returns `finish_reason:"length"` with content "The capital of".
- **qwen latency** over 13 successful non-stream calls: min 353 ms, **median 1,143 ms**, p90 1,589 ms.

### G5. Structured outputs (`response_format: json_schema`): FAIL (blocked by C10)

- `claude-sonnet-4-6` and `gpt-5-nano` with `json_schema` both returned the access 400.
- qwen with `response_format` returned:
  ```json
  400 {"metadata":{"errors":["model qwen3.5-4b-32k-fast does not support response_format"]},"message":"invalid request body","code":400}
  ```

**Finding:** the Gateway **enforces `supported_parameters` strictly**. It rejects unsupported parameters instead of ignoring them, so gate each request parameter on `GET /v1/models`.

The free-tier substitute (prompted JSON + `post_processing_steps: json-repair`) is covered in G10. Structured outputs on Claude/OpenAI remain **untested live**. The client code for them is covered offline (G11).

### G6. Tool calling: FAIL (blocked by C10)

- `claude-sonnet-4-6` and `gpt-5-nano` with `tools` returned the access 400.
- qwen with tools returned:
  ```json
  400 {"metadata":{"errors":["model qwen3.5-4b-32k-fast does not support tools","model qwen3.5-4b-32k-fast does not support tool_choice"]}, ...}
  ```

The `finish_reason` split (`tool_calls` vs `tool_use`, synthesis §2.9) **could not be verified live**. `runToolLoop()` handles both families and is exercised offline (G11).

### G7. Streaming (`stream:true`): PARTIAL (C9: partly contradicted)

- `gpt-5-nano` and `claude-sonnet-4-6` returned the access 400 as `application/json` before any SSE.
- **qwen streamed real SSE.** Request body: `{"model":"qwen3.5-4b-32k-fast","messages":[…],"max_tokens":120,"stream":true,"stream_options":{"include_usage":true}}`.
  - Response `content-type: text/event-stream; charset=utf-8`.
  - 11 events, TTFB = first token 1,368 ms, total 1,626 ms.
  - Events:
  ```
  data: {"id":"chatcmpl-a79c…","object":"chat.completion.chunk","created":1790211793,"model":"qwen3.5-4b-32k","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":26,"total_tokens":26,"completion_tokens":0},"prompt_token_ids":null,"prompt_text":null}
  data: {… "choices":[{"index":0,"delta":{"content":"one"},…}],"usage":{"prompt_tokens":26,"total_tokens":27,"completion_tokens":1}}
  …
  data: {… "choices":[{"index":0,"delta":{"content":"ven, twelve"},"finish_reason":"stop","stop_reason":null,…}],"usage":{…"completion_tokens":25}}
  data: {… "choices":[],"usage":{"prompt_tokens":26,"total_tokens":51,"completion_tokens":25},"system_fingerprint":"vllm-0.23.0-f3184967"}
  data: [DONE]
  ```
  - Chunk `model` is `qwen3.5-4b-32k`, **not** the requested `-fast` ID. The backend is vLLM, `usage` appears on every chunk, and there is a final usage-only chunk.
- The OpenAI SDK helper `gatewayStream()` on qwen gave 10 chunks, TTFT 1,360 ms, total 1,433 ms, and `finishReason:"stop"`.

**Conclusion (C9):**
- "Streaming works on OpenAI models only" is **contradicted for the AssemblyAI-hosted qwen**, and the catalog lists `stream` on Claude and Gemini too.
- Whether Claude streams, which is what Voice Agent BYO-LLM through the Gateway needs, is **untestable until the account is upgraded**.

### G8. `transcript_id` + `{{ transcript }}` injection: PASS (on qwen)

**Request:**
```json
{"model":"qwen3.5-4b-32k-fast","transcript_id":"5d0563f8-…","messages":[{"role":"user","content":"From the call transcript below, list every time of day the caller gave for when the accident happened, and the policy number. One line each.\n\n{{ transcript }}"}],"max_tokens":120,"temperature":0}
```

| Case | Result |
|---|---|
| Exact tag `{{ transcript }}` | `200` in 929 ms. **`input_tokens: 280`**, so the transcript was substituted. Content: `"7 PM\nHP7740391"`. The 4B model **missed the "5 PM" statement**, so it can't be trusted to find contradictions on its own. |
| No-space tag `{{transcript}}` | `200`, `input_tokens: 46`, **not substituted**. The model replied "…you did not provide the transcript text…". Confirms 03 §9.1. |
| PII-redacted transcript (`68453b7e…`), prompt "repeat exactly" | Injected text is the **redacted** `text`: `"[ORGANIZATION] [ORGANIZATION] [ORGANIZATION]. [PERSON_NAME] [PERSON_NAME] speaking. …"`. No raw PII appears, so `unredacted_text` is never exposed to the LLM through injection. |
| Unknown id | `404 {"request_id":"…","message":"transcript not found","code":404}` |
| `transcript_id` with no tag in the prompt | `200`, `input_tokens: 19`. The id is silently ignored. |
| `claude-sonnet-4-6` + `transcript_id` | The access 400 (C10) |

**Conclusion:**
- Injection works, and it is privacy-preserving for redacted transcripts.
- It injects plain `text` only, with no speakers. For speaker-aware prompts, send `formatUtterances()` output instead.
- Contradiction detection needs a stronger model than qwen-4B: Claude/GPT after upgrade, or OpenAI direct now.

### G9. Regions (`model_region`, EU endpoint): PARTIAL (C26)

| Request | Result |
|---|---|
| `claude-sonnet-4-6` + `"model_region":"global"` | The access 400, so this is untestable |
| `qwen3.5-4b-32k-fast` + `"model_region":"global"` (catalog regions `us,eu`, no `global`) | **`200`** in 353 ms. Accepted even though the catalog doesn't list `global`, so the value is either silently ignored or honored without checking the catalog. |
| qwen + `"model_region":"us"` | `400 {"metadata":{"errors":["model_region can only be set to global"]},…}` |
| EU endpoint `llm-gateway.eu.assemblyai.com` + qwen | `400 {"metadata":{"errors":["model qwen3.5-4b-32k-fast is not supported"]},…}`. This matches the EU catalog (13 models) and **contradicts the US catalog's `available_regions:["us","eu"]`** for qwen. |
| EU endpoint + `claude-haiku-4-5-20251001` | The access 400. The EU host accepts this (US-project) key for auth and fails only at model access. |

**Conclusion (C26):**
- Trust the region-specific `/v1/models` over `available_regions` in the US catalog.
- `model_region` only accepts `"global"`.
- Live global routing for Claude/OpenAI remains unverified (C10).

### G10. Fallbacks + `post_processing_steps: json-repair`: PARTIAL

| Request | Result |
|---|---|
| `{"model":"no-such-model-xyz","fallbacks":[{"model":"qwen3.5-4b-32k-fast"}]}` | `400 {"metadata":{"errors":["model no-such-model-xyz is not supported"]}}`. **Fallbacks do not rescue a request-validation error.** |
| `{"model":"claude-sonnet-4-6","fallbacks":[{"model":"qwen3.5-4b-32k-fast"}]}` | The access 400. **Fallbacks do not rescue an access error either.** Validation happens up front, and fallbacks presumably apply only to provider/runtime failures (5xx), which could not be provoked safely. |
| qwen, prompt "Output this JS object exactly…: `{name: 'Priya', amounts: [3450, 125, 500,],}`" + `"post_processing_steps":[{"type":"json-repair"}]` | `200` in 1,445 ms. Content `{"name": "Priya", "amounts": [3450, 125, 500]}`, **valid JSON**. |
| Same prompt without `json-repair` | `200` in 904 ms. Content `{name: 'Priya', amounts: [3450, 125, 500,],}`, **invalid JSON**. |

The `request` echo omits `post_processing_steps`. JSON repair adds about 0.5 s here (n=1).

**Conclusion:**
- `json-repair` works on the free model and is the practical stand-in for `response_format` on qwen.
- Every model and fallback ID must be valid **and accessible**, or the whole request fails.

**qwen fast latency** (13 successful non-stream calls from this machine in India to the US endpoint): min 353 ms, **median 1,143 ms**, p90 1,589 ms, max 1,594 ms. Streaming TTFT is about 1.36 s. Most of that is network and Gateway overhead: the server-side `response_time` is about 50 ms.

### G11. Offline client self-test (`gateway/selftest.ts`): PASS (16/16)

Three checks run against **saved live responses**:
- `unsupportedParams()` on the live catalog flags `tools` and `response_format` for qwen, and nothing for `claude-sonnet-4-6`.
- `reattributeSentiment()` on the live `full` transcript goes from 38.5% to 96.6%.
- `applySpeakerMapping()` relabels the live `golden` transcript's `unredacted_utterances` to match `utterances`.

These checks use a mock fetch, with no network and no keys.

**Gateway client:**
- It sends `Authorization: Bearer <AAI key>` to `https://llm-gateway.assemblyai.com/v1/chat/completions`.
- It sends **no** `OpenAI-Organization`/`OpenAI-Project` headers, even with `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` set.
- Gateway extras (`transcript_id`, `model_region`, `post_processing_steps`) pass through the SDK body.
- `runToolLoop` completes both the OpenAI-style (`tool_calls`→`stop`) and Claude-style (`tool_use`→`end_turn`) flows. It produces the correct assistant `tool_calls` and `tool` messages.
- `gatewayStream` assembles deltas, TTFT, `finish_reason` and usage.
- `parseJsonContent` strips code fences, and `normalizeFinishReason` covers both families.

**Async client:**
- It sends the raw key and polls until `completed`.
- `status:error` throws `TranscriptFailedError`, and a 400 throws `AssemblyAIHttpError` with no POST retry.
- `understanding()` retries a 429 after `retry-after` and posts to the Gateway host.
- The webhook helpers and `formatUtterances`/`billableSeconds` are covered.

---

## 3. Reusable modules

### `spikes/async/client.ts`

This module is dependency-free and suits Node or a Vercel function.

**Client and endpoints**
- `new AssemblyAIAsyncClient({ apiKey, region?: "us"|"eu", fetch?, timeoutMs?, getRetries?, rateLimitRetries?, onRateLimit? })`.
- `upload(bytes) → upload_url`
- `submit(params)`, `get(id)`, and `waitForCompletion(id, {initialIntervalMs, maxIntervalMs, timeoutMs, onPoll})`. Polling backs off from 1 s to 5 s.
- `transcribe(params)`
- `sentences(id)`, `paragraphs(id)`
- `redactedAudio(id)` and `waitForRedactedAudio(id)`
- `wordSearch(id, words)`, `subtitles(id, "srt"|"vtt")`
- `delete(id)`
- `understanding(transcriptId, request)`, which posts to the Gateway host.

**Retries:** 429 is retried on any method, honoring `retry-after` up to 65 s. 5xx and network errors are retried on GET only.

**Webhooks:**
- `webhookParams(url, {headerName, headerValue})`
- `verifyWebhookHeader(headers, name, expected)`, a constant-time compare.
- `parseWebhook(rawBody)`, which returns either a transcript payload or a redacted-audio payload.

**Types:** `TranscriptParams` (all documented request fields, typed), `Transcript`, `Word`, `Utterance`, `Entity`, `SentimentResult`, `SpeechUnderstandingFeatureRequests` (with both `speakers` and `known_values`), `UnderstandingResult` (the slim post-hoc shape), `SentencesResponse`, `ParagraphsResponse`, `RedactedAudioResponse`, and `PII_POLICIES` (51).

**Helpers:**
- `formatUtterances()`: use it because `{{ transcript }}` injects plain text with no speakers.
- `billableSeconds()`.
- `reattributeSentiment()`: 38.5% → 96.6% speaker accuracy.
- `stripSpeakerTags()`.
- `applySpeakerMapping()`: Speaker ID does not relabel `unredacted_*`.

**Errors:** `AssemblyAIHttpError {status, body}` and `TranscriptFailedError {transcript}`.

### `spikes/gateway/client.ts`

**Client:** `createGatewayClient({ apiKey, region?, fetch?, maxRetries?, timeoutMs? })` returns an `OpenAI` instance.
- `baseURL` is `https://llm-gateway.assemblyai.com/v1` or the EU equivalent.
- `organization`, `project` and `adminAPIKey` are forced to `null`.
- `apiKey` is mandatory, so the client never falls back to `OPENAI_API_KEY`.

**Catalog:** `listGatewayModels()` (no auth), `modelSupports(model, param)` and `unsupportedParams(model, params)`.
- **Always gate `response_format`/`tools`/`temperature` on `supported_parameters`.** The Gateway returns 400 otherwise.
- `unsupportedParams` is the pre-flight check for exactly that.

**Calls:**
- `gatewayChat(client, params & {transcript_id?, model_region?, fallbacks?, fallback_config?, post_processing_steps?})` returns `{completion, ms, headers}`, where `headers` holds the rate-limit headers.
- `gatewayStream(client, params, onDelta)` returns `{text, chunks, ttftMs, totalMs, finishReason, usage}`.
- `runToolLoop(client, params, handlers, {maxIterations})`.

**Helpers:**
- `normalizeFinishReason()`, which maps `end_turn`/`tool_use`/`max_tokens` onto the OpenAI names.
- `parseJsonContent()`, `extractToolCalls()`, `usageTokens()`, `jsonSchemaFormat()`.
- `TRANSCRIPT_TAG = "{{ transcript }}"`.

### Supporting modules

- `spikes/async/http-log.ts`: `loggingFetch(log)` to pass as `fetch` for any spike.
- `spikes/async/compare.ts`: scoring against the fixture ground truth.

---

## 4. Golden config (use these exact settings in the product)

### 4.1 Claim-call transcript: one async request

```jsonc
POST https://api.assemblyai.com/v2/transcript        // Authorization: <key>  (no Bearer)
{
  "audio_url": "<upload_url or a fresh pre-signed URL>",
  "speech_models": ["universal-3-5-pro", "universal-2"],   // U3.5 Pro used; fallback accepted
  "language_detection": false, "language_code": "en",      // echoes as "en_us"; for unknown-language calls use language_detection:true instead
  "speaker_labels": true, "speakers_expected": 2,          // mono recordings; for stereo use multichannel:true (see 4.3)
  "keyterms_prompt": ["<insurer>", "<adjuster name>", "<claimant name>", "<street names>", "<product/ID words>"],
  "entity_detection": true,                                 // NOTE: entities are NOT redacted
  "redact_pii": true,
  "redact_pii_policies": ["person_name","phone_number","location","location_address","location_address_street","location_city",
                          "account_number","number_sequence","date","email_address","us_social_security_number",
                          "credit_card_number","date_of_birth"],   // add "money_amount"/"organization"/"time" per policy
  "redact_pii_sub": "entity_name",
  "redact_pii_return_unredacted": true,                     // unredacted_* for internal analysis; redacted text/words/utterances for sharing
  "redact_pii_audio": true,                                 // then GET /redacted-audio; URL valid 30 min, re-request for a fresh one
  "speech_understanding": { "request": {
    "speaker_identification": { "speaker_type": "role", "known_values": ["Adjuster", "Claimant"] },
    "translation": { "target_languages": ["es"], "match_original_utterance": true, "formal": true }   // "formal" was not in the tested golden run (A4b)
    // NO custom_formatting of fields you also redact (400). Format client-side, or post-hoc on an unredacted transcript.
  }},
  "webhook_url": "https://<app>/api/aai/webhook?claim=<id>",                                        // NOT exercised live (no public endpoint in the spike);
  "webhook_auth_header_name": "X-AAI-Webhook-Secret", "webhook_auth_header_value": "<random secret>"  // client helpers are unit-tested (G11)
}
```
Everything except `formal` and the webhook fields was run exactly as shown in A4b (id `5e4b49bc…`): PASS in 11.4 s.

**Read the result like this:**
- **Display:** use `utterances[].speaker`, which already holds the role. `words[].start/end` give the evidence clips.
- **Internal analysis:** use `unredacted_utterances`, and relabel `A`/`B` with `speech_understanding.response.speaker_identification.mapping`.
- **Spanish:** use `translated_texts.es` and `utterances[].translated_texts.es`. They are already redacted.
- **Avoid:**
  - `sentiment_analysis`, unless you strip `[Speaker:…]` tags, re-attribute speakers by time, and treat the text as PII;
  - `paragraphs`, which have no speaker, for anything that needs speakers.

**Expected latency:** 7–20 s for a 70 s call. The webhook returns only `{transcript_id, status}`. Respond 2xx within 10 s, then `GET` the transcript.

### 4.2 Post-hoc Speech Understanding (fallback only)

```jsonc
POST https://llm-gateway.assemblyai.com/v1/understanding       // Authorization: <key>; 2 requests / 60 s per key
{ "transcript_id": "<id>", "speech_understanding": { "request": {
  "speaker_identification": { "speaker_type": "role", "known_values": ["Adjuster","Claimant"] } } } }
```
- Tasks can be combined in one request.
- Persist the result yourself; it is not written back to the transcript.
- Honor `retry-after` on 429. `AssemblyAIAsyncClient` does this.

### 4.3 Voice Agent recording (stereo) → async

```json
{"audio_url":"<fresh pre-signed OGG>","speech_models":["universal-3-5-pro"],"language_code":"en","language_detection":false,
 "multichannel":true,"keyterms_prompt":[...],
 "speech_understanding":{"request":{"speaker_identification":{"speaker_type":"role","known_values":["Agent","Caller"]}}}}
```
- Channels come back as `"1"`/`"2"`, and Speaker ID maps them to roles.
- Billing is duration × 2.
- **Word times are about 80 ms-quantized.** Pad evidence clips by ±300 ms, or prefer a mono downmix with `speaker_labels` when you need precise word timing.

### 4.4 LLM Gateway

- **Client:** `createGatewayClient({ apiKey: ASSEMBLYAI_API_KEY })`. It is the OpenAI SDK with `baseURL=https://llm-gateway.assemblyai.com/v1`, and both Bearer and raw auth work.
- **Account today:** only `qwen3.5-4b-32k-fast`, at 2 requests/min. It supports `max_tokens`, `temperature` and `stream`. It has no `response_format` and no tools.
  - Use it for short summaries or labels over a transcript: `transcript_id` + `{{ transcript }}` + `stream:true`.
  - For JSON, prompt for JSON and add `post_processing_steps:[{"type":"json-repair"}]` (see G10).
- **For structured extraction and tool-calling agents now:** call OpenAI directly with the existing `OPENAI_API_KEY`.
- **After upgrading the AssemblyAI plan:** switch the `model` to `claude-sonnet-4-6` or `gpt-5-mini` with `response_format:{type:"json_schema",json_schema:{name,strict:true,schema}}`.
  - Before sending a parameter, check that the model's `supported_parameters` includes it.
  - Normalize `finish_reason` with `normalizeFinishReason()`.
  - Budget for 30 requests/min per model (docs; unverified here).
- **Rate-limit headers to watch:** `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-ratelimit-model`, `x-ratelimit-service` (`llmgw` | `speech-understanding`), and `retry-after` on 429.

---

## 5. Doc discrepancies

| # | Docs / research claim | Observed live (2026-09-24) |
|---|---|---|
| 1 | `universal-3-pro` is rejected (synthesis §2.9, [05 §11], [07 §5.2]) | Async `speech_models:["universal-3-pro"]` is **accepted** and used (`speech_model_used:"universal-3-pro"`) |
| 2 | `language_detection:false` requires `language_code` (04 §3) | Accepted; it defaults to `en_us` |
| 3 | PII policy list is validated (implied); `gender` is not a valid policy (04 §8 correction) | Unknown policies are **accepted silently** |
| 4 | `redact_pii` + `custom_formatting` not mentioned as conflicting | 400: `redact pii phone_number not compatible with formatting phone_number; redact pii date not compatible with formatting date` |
| 5 | Custom formatting: "`text` at top level is ALSO updated" (04 §13) | `text` and `utterances` are **unchanged**. Formatting appears only in `speech_understanding.response.custom_formatting.formatted_text` / `formatted_utterances` |
| 6 | Redacted audio "available for 24 hours" (04 §8) | The pre-signed URL **expires 30 min after issue**. Re-GET `/redacted-audio` for a new one. HEAD on the URL returns 403. |
| 7 | Sentiment `speaker` is populated with `speaker_labels` (04 §10) | Populated but **wrong 61.5% of the time**, with 3 nulls. Row text contains raw `[Speaker:1]` / `[Speaker:Priya Shah]` tags, is **not PII-redacted**, and is segmented differently from `/sentences` |
| 8 | Entities `{entity_type,text,start,end}` (04 §9) | They also carry `speaker` |
| 9 | Code switching on U3.5 Pro returns `language_detection_results.code_switching_languages` (04 §7) | `language_detection_results: null` for Hinglish, which was detected as `hi` (0.88) |
| 10 | Multichannel increases transcription time by about 40% (04 §11c) | 6.4 s vs 7.8 s mono, so not slower (n=1). Word timestamps are coarse (80 ms quantized). |
| 11 | `audio_duration` in seconds (float implied) | An integer, rounded up (7.3→8, 69.13→70) |
| 12 | Speaker ID requires `speaker_labels` (04 §11b) | Error text says `speaker_labels or multichannel required`. It **works on multichannel** (`{"1":"Adjuster","2":"Claimant"}`) |
| 13 | C29: `speakers:[{name|role}]` vs `known_values` | **Both accepted**, with identical results |
| 14 | `/v1/understanding` returns the transcript with the task applied (04 §11b) | It returns a slim `{speech_understanding, utterances?, translated_texts?, request_id}`, not persisted. The custom-formatting-only response has no `utterances`. |
| 15 | Gateway rate limit 30/min per model; free accounts have no access (03 §12) | Free/credit account: **qwen fast accessible at 2/min**, and 44 other models give a 400 "no access". `/v1/understanding` is limited to 2/min (`x-ratelimit-service: speech-understanding`). |
| 16 | Streaming "OpenAI models only" (03 §6, C9 B) | `qwen3.5-4b-32k-fast` streams SSE, and the catalog lists `stream` for Claude, Gemini and others. Only `gpt-oss-*` lack it. |
| 17 | Global routing "live for Anthropic Claude only"; OpenAI Global "No" (03 §13, C26) | The catalog lists `global` for Claude, Gemini **and** `gpt-5.5`/`gpt-5.6-*`. `model_region:"global"` is accepted (200) even on qwen, whose catalog entry has no `global`. `model_region:"us"` gives 400 `model_region can only be set to global`. |
| 17b | `fallbacks` try the next model when the primary fails (03 §11) | They do **not** apply to validation or access failures: an unknown primary gives 400 `model … is not supported`, and a no-access primary gives the access 400, even with an accessible fallback |
| 17c | `/v1/models` `available_regions` tells you where a model runs | qwen lists `["us","eu"]`, but the EU endpoint returns 400 `model qwen3.5-4b-32k-fast is not supported` and the EU catalog omits it |
| 18 | `/v1/models` fields (03 §4.2) | Adds undocumented `providers[]` and `default_provider`. EU `/v1/models` lists 13 models and omits qwen fast, although the US catalog lists qwen with `eu`. |
| 19 | Gateway response `usage` is `{input_tokens, output_tokens, total_tokens}` (03 §3.1) | Both naming schemes appear, plus `prompt_tokens_details` / `completion_tokens_details`. `http_status_code` is sometimes absent. |
| 20 | Gateway ignores or passes through unsupported parameters (implied) | **Rejected with 400** (`model X does not support response_format` / `tools` / `tool_choice`) |
| 21 | Missing auth → 401 auth error | 401 with the text `"Your account does not have access to LLM Gateway. Please upgrade…"`, which is misleading. A bad key gives `"Authentication error, API token missing/invalid"`. |
| 22 | Stream chunk `model` = requested ID | Chunks report `qwen3.5-4b-32k` (without `-fast`), `system_fingerprint: vllm-0.23.0-…` |
| 23 | Upload URL `https://cdn.assemblyai.com/upload/<uuid>` (04 §4) | `…/upload/<32-hex>/<uuid>` |
| 24 | Paragraphs are "segments with metadata" | Paragraphs have **no `speaker`** and span speaker changes; sentences do have `speaker` (correct) |

---

## 6. Contradiction / test ledger updates

| ID | Status after this run |
|---|---|
| **T7 / C10** | **Confirmed.** Gateway models need an upgraded account. The exact error is `400 {"metadata":{"errors":["Your account does not have access to this LLM Gateway model"]},"message":"invalid request body","code":400}`. Only `qwen3.5-4b-32k-fast` works, at 2 rpm. |
| **C9** | **Partially contradicted.** Non-OpenAI streaming works for qwen. Claude streaming is unverifiable until upgrade, so T6 (Voice Agent BYO-LLM) is also blocked for Gateway-hosted Claude/GPT. |
| **C26** | **Partially resolved.** The catalog shows `global` on 22 models, including OpenAI 5.5/5.6, contradicting the docs. `model_region` accepts only `"global"`, and it was accepted even for qwen. Claude global routing is unverifiable (C10). The EU host serves 13 models. |
| **C27** | **Confirmed volatile.** 45 models at 00:39Z and 01:09Z, but 47 at 00:55Z (`gpt-6-luna`/`gpt-6-sol` appeared, then vanished). Always call `/v1/models`, and handle a "model … is not supported" 400. |
| **C28** | Related finding: the per-model Gateway limit on this account is **2/min** (`x-ratelimit-service: llmgw`), and Speech Understanding has its own 2/min. |
| **C29** | **Resolved:** both `speakers[]` and `known_values[]` work. |
| **C25/T10** | Not tested here: it needs a Voice Agent session artifact. `audio_url` from `/v2/upload` works. |

---

## 7. Artifacts

**Transcripts.** These are not deleted. Delete them with `new AssemblyAIAsyncClient(...).delete(id)` if needed; deletion is permanent.

| Test | Transcript ID |
|---|---|
| full (redaction + entities + sentiment) | `68453b7e-f8b4-40bd-9fd7-744b2dba0fb6` |
| su-inline | `c2aff128-80d9-4e66-9b90-82561447eac9` |
| golden | `5e4b49bc-5f09-41ab-a2ac-4a97728792e3` |
| base (post-hoc SU, sentences) | `5d0563f8-e2cb-4360-90c3-4cf901f28449` |
| multichannel | `e70da52d-72d5-47f5-bb41-9e604825356b` |
| fallback / Hinglish | `a90b2feb-95be-4c81-9d84-409432688f69` |
| negative cases (7.3 s clip) | `ed770631-7396-4ece-81d1-58c4fe492c49`, `ec1f5545-3263-4a2f-a8d6-6a90fb6d5b65`, `d835032b-cae7-4a97-a650-b91b8b81281c`, `71c17df6-b8e8-4552-92ab-09418d6c458d` |

**Output files:**
- `spikes/out/gateway_models.json`: the full catalog, plus the EU list.
- `spikes/out/gateway-access.json`: the per-model access matrix.
- `spikes/out/async-*.jsonl` and `spikes/out/gateway-*.jsonl`: raw HTTP logs with the key masked.
- `spikes/out/async-full.report.json`: fact, speaker, alignment, redaction and sentiment scoring.
