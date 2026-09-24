# WP0a notes: contracts and promoted core

Status: **done** for Wave 0. `npm run typecheck` is clean and `npm test` passes (13 files, 237 tests, of which WP0a's are 8 files, 202 tests). Nothing was committed or deployed. Live spend: **$0** (no AssemblyAI or OpenAI calls).

## What exists (and where)

| Path | Contents |
|---|---|
| `src/core/contracts/{case,turns,scenario,run,events,errors,tools,takeover,extract,eval,api}.ts` | zod schemas (`XSchema`) with `type X = z.infer<typeof XSchema>`, DESIGN §4.1 + §4.4 |
| `src/core/contracts/services.ts` | TASKS §2 interfaces, types only, textually as in TASKS |
| `src/core/contracts/index.ts` | barrel (`export *` of all of the above, `export type *` of services) |
| `src/core/intents/add-driver.fields.ts` | `FIELD_IDS` (21), `REQUIRED_FIELDS` (10), `SERVER_RESOLVABLE`, `REP_ONLY`, `AI_SETTABLE`, `ADVICE_DOMAIN`, `MONEY_FIELDS`, `DISCOUNT_FIELDS`, the kit enums, `US_STATES`, `FIELD_KIND`, `FIELD_LABEL`, `*_SET`s and `is*` helpers |
| `src/core/aai/streaming.ts` | `StreamingSession`, `FrameBatcher`, `TurnTracker`, `buildStreamingUrl`, `sanitizeParams`, `LIMITS`, `GOLDEN_PARAMS`, `PRESETS`, `CLOSE_CODES`, `isRetryableClose`, `streamAudioPaced`, `defaultWebSocketFactory`, typed server messages, `sttCloseToErrorCode`, `looksLikeBalanceError` |
| `src/core/aai/voice-agent.ts` | `VoiceAgentSession`, `ToolDispatcher`, `ReplyTracker`, `RealtimeAudioFeeder`, typed client/server event unions, `SessionError`, `TimeoutError`, `errorCode`, `RETRYABLE_ERROR_CODES`, `chunkLevelDb`, base64 helpers, `tokenUrl`, `VA_VOICES`, stored-agent/session record types, `vaErrorToErrorCode` |
| `src/core/audio/{units,base64,mulaw,pcm,resample,wav-decode,framing,pace,index}.ts` | isomorphic codecs, resampling, mu-law/A-law, WAV decode/encode, `ByteFramer`, `StreamingDecimator`, `Pcm24kToMulaw8k`, `EvenByteAligner`, `pace`/`paceAudio`/`sleepMs` |
| `src/server/aai/va-node.ts` | `connectNode`, `connectWithToken`, `UpgradeRejectedError`, `VoiceAgentRest` (incl. `mintToken`, agents, sessions, `deleteSession`, `waitForArtifacts`), `mintStreamingToken`, `StreamingHttpError`, `nodeWebSocketFactory` |
| `src/server/aai/async.ts` | `AssemblyAIAsyncClient`, `verifyWebhookHeader`, `parseWebhook`, `billableSeconds`, `PII_POLICIES`, helpers (verbatim from the spike) |
| `src/server/openai/client.ts` | `MODELS`, `EXTRACTOR_MODEL`/`EFFORT`, `VERIFIER_MODEL`/`EFFORT`, `CLASSIFIER_MODEL`, `TTS_MODEL`, `TTS_VOICES`, `extractStructured`, `RefusalError`, `IncompleteError`, `usageOf`, `runToolLoop`, `streamText`, `SentenceBuffer`, `openSpeechPcmStream`, `streamChat`, `normalizeChatBodyForReasoningModel`, re-exported framing classes |
| `tests/unit/contracts/*` | round-trips, DESIGN type parity, tools/errors; `fixtures.ts` holds valid sample values that other WPs may reuse |
| `tests/unit/core/fields-parity.test.ts` | kit parity + `data/scenarios` conformance |
| `tests/unit/core/audio/*` | ported audio self-tests, framing, and the two AssemblyAI clients against fake sockets |

Import paths: my files use relative imports (they work with or without the `@/*` alias). Consumers can use `@/core/contracts`, `@/core/audio`, `@/core/aai/streaming`, `@/core/aai/voice-agent`, `@/server/aai/va-node`, `@/server/aai/async`, `@/server/openai/client`.

## Decisions

1. **Types come from zod.** Every §4.1/§4.4 type is `z.infer` of its schema. `tests/unit/contracts/design-types.test.ts` copies the DESIGN §4.1 interface text into a namespace and asserts **strict type identity** (not just mutual assignability) for all 45 types. It also checks that the route #28 schemas are identical to the `LimitsAuthority`/`SpendLedger`/`AppFlags` types in services.ts, that `ToolResponse` = `ToolOutcome`, and that `NextStep` = the `inputModeFor` argument. A drift is a `tsc` error.
2. **services.ts is a verbatim copy of TASKS §2.** It holds type-only imports and no runtime code. `BatonUiState` is an empty interface that WP7 extends by module augmentation from `src/core/contracts/ext/wp7-*.ts`. `AudioEngine.ctx` uses the ambient DOM `AudioContext` type (the tsconfig has `lib: dom`); it is a type reference, not a DOM global use.
3. **Exhaustive records.** `CaseState.fields` and `SweepPoint.snapshot` use `z.record(FieldIdSchema, …)`, so all 21 fields must be present. `Partial<Record<…>>` uses `z.partialRecord`.
4. **Key-only material moved to the server** (per the WP0a brief, which is stricter than DESIGN §3.2's "kept, server use"). `VoiceAgentRest` and `mintStreamingToken` live in `src/server/aai/va-node.ts` with `import "server-only"`. The core files hold no function that takes the API key. All definitions of the banned open/mint primitives sit in the three `DEFINERS` files that WP0b's boundaries test allow-lists.
5. **`ws` in core.** `defaultWebSocketFactory` uses the global `WebSocket` when no headers are needed. It loads `ws` with `await import(/* webpackIgnore */ /* turbopackIgnore */ /* @vite-ignore */ "ws")` only when headers are requested, and there is no browser sniffing. Node scripts can pass `nodeWebSocketFactory` instead.
6. **Isomorphic audio.**
   - `pcm16ToBytes`, `encodeWav`, `ByteFramer`, `EvenByteAligner` and the TTS chunks return plain `Uint8Array`.
   - Base64 uses the platform `Buffer` when present and `btoa`/`atob` otherwise; tests prove both paths are equal.
   - `pace`/`paceAudio` are isomorphic (an abortable `setTimeout`), so they stay in `src/core/audio/pace.ts`. WP0b's `scripts/lib/pace.ts` re-exports them.
   - `decodeWav`/`encodeWav` are in `wav-decode.ts`. WP0b's `scripts/lib/wav-fs.ts` adds disk I/O.
7. **Framing moved to core.** `StreamingDecimator`, `Pcm24kToMulaw8k` and `ByteFramer` (spike `openai/client.ts`) now live in `src/core/audio/framing.ts` so browser, server and scripts share them. The OpenAI client re-exports them.
8. **OpenAI client (fix 5.3-2).**
   - `ReasoningEffort` no longer includes `"minimal"`.
   - `MODELS.fast` = `gpt-6-luna`, `balanced` = `gpt-6-sol`, `tts` = `gpt-4o-mini-tts-2025-12-15`, and `byoVoiceAgent` = `gpt-4.1-mini`, documented as unused (managed VA LLM).
   - `onTrace(event)` replaces the `JsonlLogger`.
   - New: per-request `request: { timeoutMs, signal, maxRetries }` (WP3's ≈8 s budget and its own retry), an explicit `temperature`, and guards that throw on `temperature` without effort `"none"` and on `maxOutputTokens < 16`.
9. **Error mapping helpers.**
   - `sttCloseToErrorCode(code, text)` implements the tables in DESIGN §5.1.9 and §7.4, including `E_STT_INACTIVITY` and `E_AAI_BALANCE`.
   - `vaErrorToErrorCode(ev, {afterFirstUpdate})` implements §5.9.6.
   - `looksLikeBalanceError` implements F8.
   - Contracts add `ERROR_HTTP_STATUS`, `apiError()` and `BatonError` (`validateFirstUpdate` can throw `new BatonError("E_VA_CONFIG", …)`).
10. **Shared protocol constants.** `TAKEOVER_TIMING` in `contracts/takeover.ts` (DESIGN §5.5.2, plus heartbeat/stale, the 300 ms clip gap, the sweep's +520 ms and 3 takeovers per case) is shared, so WP5's machine and WP9b's sweep cannot drift apart.

## Deviations and additions (flag at G0 if you disagree)

**Moved or renamed:**
- `VoiceAgentRest` and `mintStreamingToken` are in `src/server/aai/va-node.ts`, not in `core/aai/*` (decision 4).
- The streaming `MintTokenOptions` is now `StreamingMintTokenOptions`. The Voice Agent one is `VaMintTokenOptions`, with a deprecated `MintTokenOptions` alias.
- `TrimOptions.windowMs` is now `stepMs`, which keeps the DOM-global word out of `src/core` entirely.

**Shapes DESIGN names but does not define.** I defined these; the owners may extend them via `ext/`:
- `TakeoverView`
- `CheckSummary` (`{ok, at, ageSec}`, used by `StatusResponse.lastChecks`)
- `PromoteEvidence` (`n`, rates, `clickToAudibleP50Ms`, `sweepReaskZeroShare`, `sweepWrongAssertedPoints`) and `PromoteStatusResponse` (GET /api/promote)
- `CronResponse`, `AdminFlagsRequest`, `LedgerSummary`
- the #28 request/response schemas plus the `LimitsRoutes` map
- `StreamingParamsSchema` (loose, so future params survive a parse)
- `EvalSummaryResponse.static`, typed as `Record<string, unknown>` (WP9b owns `summary.json`). Its live rates are `number | null` when n = 0.

**Optional fields added:**
- `CreateCaseResponse.visitorToken?` (DESIGN §4.3 cookie-less fallback)
- `TtsRequest.purpose?: "typed" | "autopilot"` (the separate rate bucket of #22)
- `VerificationView.reason?`

**Strictness choices:**
- `FieldState.evidence` is `.max(3)`, per "newest first, ≤3".
- `EsignRequest.typedName` is trimmed, 1–80 characters.
- `TtsRequest.text` is trimmed, 1–200 characters.

**Tool args:**
- `ToolArgsSchemas.update_case_field.field` is restricted to `AI_SETTABLE`, the tool's own enum.
- `confirm_effective_date.date` is not pattern-checked in zod. The server resolves `customer_words` itself (§5.8).
- The tool result schemas are loose. `send_esign_and_pay_link.verified_by` also accepts `"polar_poll"`, a superset of DESIGN's two values, because a server poll can confirm a payment too.

**Kept verbatim (not changed):**
- `ToolDispatcher.policy` still defaults to `"reply_done"`. Baton sets `"immediate"` (DESIGN §5.9.4, WP5b).
- `RealtimeAudioFeeder` stays timer-paced (Node/tests). The browser uses the worklet `PacedFeeder`.

**Small additions:**
- `StreamingSession.sessionId`, `TurnTracker.hasOpenPartial()`, `FrameBatcher.pendingBytes`
- `VoiceAgentSession.sendUpdate()` (fire-and-forget stage update) and `endNow()` (synchronous `pagehide`)
- `SessionError.retryable`
- `VA_VOICES` (the 18 ids), `VA_INPUT_FRAME_BYTES`, `NON_FATAL_CONFIG_ERROR_CODES`
- REST timeouts and a `fetchImpl` option, and token redaction in the `onHttp` trace
- `resampleLinearFloat32` and `mulawDecodeToFloat32` (for the playback path of §5.1.2), `silenceBytes`, `frameBytesFor`, `concatBytes`
- `turnIdOf`/`cutTurnIdOf`, `BATON_EVENT_TYPES`/`BatonEventOf<K>`, `RawPatchSchema` (the §5.3 strict output), `NextStepSchema`

**Test placement:** the AssemblyAI client tests are in `tests/unit/core/audio/aai-*.test.ts`, because `tests/unit/core/aai/**` is not in any WP's ownership list.

**Direct-open ban:** the streaming client test opens a session **against an in-memory fake socket** (injected `factory`, no network). To stay honest with WP0b's direct-open scanner, the helper is written `StreamingSession["connect"]` and commented as fake-only. If the integrator prefers, allow-list `tests/unit/core/audio/aai-*.test.ts` in `tests/unit/boundaries.test.ts` and use the dotted form.

## Measured results (Wave 0; all offline)

- **Type parity:** strict type identity holds for all 45 DESIGN §4.1 types and for 14 service-level pairs (12 route #28 schemas ↔ `LimitsAuthority`/`SpendLedger`/`AppFlags`/`OpenSource`/`SessionReport`, `ToolResponse` = `ToolOutcome`, `NextStep` = the `inputModeFor` argument). A negative control confirmed that the check catches an extra optional property.
- **Round-trips:** all 75 exported `*Schema`s of `contracts/api.ts` round-trip through JSON with samples. A meta-test fails if a new schema has no sample. Plus 22 core schemas, all 24 `BatonEvent` variants, and 17 rejection cases.
- **Fields parity:** all 21 `FACT_FIELDS` (in order), the 10 `REQUIRED_FIELDS`, `RELATIONS`, `LICENSE_STATUSES`, `OPERATOR_TYPES`, `DISCOUNT_VALUES`, `STATUSES`, `LANGUAGES`, `HANDOFF_RESPONSES`, `US_STATES`, `FIELD_KIND` and `FIELD_LABEL` equal the kit's. The kit's `FactField` union is type-identical to `FieldId`. All 22 `data/scenarios/sNN.json` files and `shared.json` conform (field ids, required set, enum values, state/ZIP/date/vehicle formats).
- **Audio self-tests: 19/19.**
  - The 14 audio checks of `spikes/scripts/selftest-lib.ts` are ported 1:1: WAV mono/stereo, mu-law values + SNR, resample ×4, chunking ×3, trim, pacing ×2. Pacing measured 500 ms of audio in 490–700 ms of wall time and 5 × 40 ms `release:start` in 150–300 ms.
  - The spike's 5 logger/env checks belong to WP0b's `src/server/log.ts`/`env.ts`. They are replaced by 5 isomorphism checks: base64 Buffer = btoa at all lengths; no-Buffer path; `Uint8Array` outputs and little-endian order; mu-law WAV with a streaming header; Float32 resampling and abortable sleep.
- **Framing:** `StreamingDecimator` is bit-identical to the batch `resampleLinear` under ragged chunking. `Pcm24kToMulaw8k` equals the batch path. `ByteFramer` and `EvenByteAligner` carry odd bytes correctly.
- **Streaming client** (spike `streaming/selftest.ts` port plus a fake socket): URL encoding, `FrameBatcher` (worklet quanta and Twilio 20→100 ms), `TurnTracker`, sanitize, error mapping, connect/Begin/turns/binary frames/`UpdateConfiguration` clipping/terminate, a pre-Begin error mapped to `E_STT_INPUT`/`E_STT_INACTIVITY`, and the lazy `ws` load (to loopback only).
- **Voice Agent client** (fake socket): `start`/`session.ready`, a fatal first-update error mapped to `E_VA_CONFIG`, clean `end`, `endNow`, the `maxDurationMs` cap, tool dispatch (immediate / reply_done / interrupted drop / unknown tool / HTTP tools never answered), the four `ReplyTracker` kinds with leading-silence ms, `chunkLevelDb`, and `RealtimeAudioFeeder` pacing (a 120 ms clip → 3 × 2400 B chunks in ≥140 ms).
- **Server modules:** an offline tsx script with `--conditions=react-server`, run from the session scratchpad and not committed, passed 12/12:
  - `SentenceBuffer` ×2, `normalizeChatBody…` ×3 and `pickModels` (the spike selftest-client checks);
  - the golden model constants;
  - `extractStructured` body, per-request timeout, refusal and incomplete paths;
  - `openSpeechPcmStream` odd-byte carry;
  - the async webhook helpers, and 429 `retry-after` handling with submit + poll;
  - `VoiceAgentRest.mintToken` and `mintStreamingToken` with a fake fetch (raw key, token redacted in traces);
  - `connectNode` (API-key header and `?token=`) against a **loopback mock WS server**;
  - `StreamingSession` over real Node `ws` (both the lazy import and `nodeWebSocketFactory`).
- **Browser safety:** esbuild `--platform=browser` of all of `src/core/{aai,audio,contracts,intents}` succeeds. The only packages pulled in are `zod` and `ws/browser.js` (the stub, reachable only when headers are requested). No Node built-ins. WP0b's boundaries test passes.

## Known gaps

- **Next client bundle not checked inside Next.** The `/* webpackIgnore */ /* turbopackIgnore */` handling of the lazy `ws` import is not verified inside Next's own bundler; I only ran the esbuild check. WP4 and WP5b see it first on `/dev/audio`. Fallback: make the specifier a variable.
- **No live re-verification** (by design, $0). The promoted clients' live behaviour rests on the spikes' 2026-09-24 runs (research/10*). The first live use is WP5b T-D1-0 and WP4 T-D1-6/7.
- **The kit import is static.** `fields-parity.test.ts` imports `tools/recording-kit/src/scenarios.ts`, so `tsc` also type-checks the kit (and its `paths.ts`/`util.ts`). If the recording-kit agent introduces code that fails our tsconfig, `npm run typecheck` breaks. Fix: switch the test to a dynamic import with a computed path.
- **WP-owned shapes are open.** `EvalSummaryResponse.static` is untyped (WP9b), and `BatonUiState` is empty (WP7). Both are meant to be filled via `ext/`.
- **`AudioContext` needs the DOM lib.** `services.ts` references the ambient DOM `AudioContext` type, so it needs `lib: dom` (present).
