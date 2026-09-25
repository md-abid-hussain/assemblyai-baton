# WP5b notes: Voice Agent client, HUD, Day-1 VA tests

Owner: WP5b. Branch `wp/wp5b`. Round 1 (gate G1). All times IST, 2026-09-24. Client in India (as in 10a).

## 1. Day-1 Voice Agent test results (read this first: other WPs depend on it)

Every live session went through `scripts/lib/aai-open.ts` (file guard, ledger, heartbeat, always `session.end`).
Raw logs: `scripts/day1/out/*.jsonl` and `*.result.json` (git-ignored; audio logged as byte counts, no keys or
tokens). Scripts: `scripts/day1/va-*.ts`. Fixtures: `scripts/day1/fixtures/first-update-{confirm,disclose}.json`.

### Chosen fallbacks and flags (the answers other WPs need)

| Question | Answer | Setting |
|---|---|---|
| `VA_KEYTERMS` | Keyterms in the FIRST update are accepted and echoed (T-D1-0 runs 3–4), and mutable mid-session (T-D1-4) | **`VA_KEYTERMS=1` is safe** (≤100 items, ≤50 chars; whitelist stays as in §5.9.1) |
| `PAY_TOOL_MODE` | `hold` sent mid-session is ACCEPTED and holds silently, and the held `tool.result` fires the next reply. **But a `reply.create` during the hold produces NO audio** (0 `reply.audio` chunks; the text arrives only in `transcript.agent`, 4 s after `reply.done`; timeline confirms the turn has `agent_text` but no audio). Reproduced twice. So the §5.8 step-2 status line and the step-5 reassurances would be silent: the customer hears nothing after "yes, text me the link" | **`PAY_TOOL_MODE=push`** (the §5.8 fallback). See "What push mode needs from WP1/WP6" below |
| WS pre-open (T-D1-3) | Part A PASS: 12 s idle socket, no events, not closed; `session.ready` 672 ms after the late first update; the idle time is **not billed** (`session_duration_seconds` 2.26 s for a 14.7 s socket). Part B (a 5 s TOKEN expiring during an 8 s idle) NOT RUN: `aai-open` can only open with the API-key header and the boundaries test forbids minting elsewhere (request filed) | **Keep the WS pre-open at ARMED** for the header/idle part. Until part B runs, WP2 should mint the VA token with `expires_in_seconds` ≥ the worst-case pre-open idle (≈10 s on auto-baton) + margin, e.g. **20–30 s**, rather than 10 s. 10a §1 showed auth is evaluated when the socket opens (the `unauthorized` error is already queued at open), which predicts part B passes |
| Input-mode mutability (T-D1-4) | `session.update{input:{transcription_mode}}` → `session.updated`, no error, 4/4. A partial `input` MERGES: `format` and earlier `keyterms` are preserved in the echo | **Mutable**: switch per next step (§5.9.1) mid-session; no fixed-mode fallback needed |
| Stage-change ordering (T-D1-2) | `session.update{system_prompt, tools}` immediately followed by `tool.result` on the same socket: the auto-fired reply called the newly added tool (disclose: `get_disclosure` 880 ms after the result; close: `send_confirmation` 650 ms after) | **No wait for `session.updated`** needed (fallback not used) |
| Inline HTTP tools (T-D1-5) | Rejected, all three shapes: `invalid_value` "HTTP tools are not allowed on session.update; define them on a stored agent via POST /v1/agents" (non-fatal mid-session) | **Function tools** (MVP default). Per-case HTTP tools only via stored agents (WP10 Promote) |

### T-D1-0: first-update acceptance: **PASS 4/4** ($0.064)

Hand-written fixtures from DESIGN §5.6 (greeting sentences, phrase table), §5.7 (PROMPT_V3 template + stage
instructions + caseStateJson), §5.8 (tool JSON verbatim, stage lists) and §5.9.1 (message shape), built by
`scripts/day1/va-build-fixtures.ts`. `confirm` = s02 at the hand-off (`effective_date` PENDING), `disclose` = s01
(all VERIFIED). Prompt 3453 / 3520 chars; greeting 65 / 69 words.

| # | Stage | Keyterms | Mode | `session.ready` | Echo (mode, keyterms, voice, greeting, tool names, `execution_mode`, `timeout_seconds`) | Greeting |
|---|---|---|---|---|---|---|
| 1 | confirm | off | min_latency | 611 ms | all equal | spoken verbatim; first audible chunk 292 ms after ready; 22.0 s of audio |
| 2 | disclose | off | balanced | 639 ms | all equal | not listened |
| 3 | confirm | on (11) | max_accuracy | 619 ms | all equal (keyterms echoed exactly) | not listened |
| 4 | disclose | on (11) | min_latency | 616 ms | all equal | spoken verbatim; first audible 341 ms after ready; 23.7 s |

- `session.updated` arrives before `session.ready` on every first update (as in 10a).
- Tool schemas with `pattern` + `examples` (confirm_effective_date) and empty `properties` (send_confirmation) are
  accepted.
- **The §5.6 greeting is long: 65–69 words = 22–24 s of audio.** The 70-word cap lets a greeting run ~24 s before the
  customer can answer. Worth a planner look (e.g. a 45-word cap) — not changed here (WP1 owns the compiler).
- s02 greeting: DESIGN §5.6's s02 example omits the premium clause, but the §5.6 rule says the premium clause
  appears when `premium_new_monthly_usd` is VERIFIED from the rep (s02: $171, rep-quoted). The fixture follows the
  rule ("…on the 2014 Toyota Corolla, at $171 a month."). WP1 should confirm which is intended.

### T-D1-2 (stage change) and T-D1-1 (`hold` mid-session): one realistic s02 flow, 2 runs ($0.238 + $0.139)

`scripts/day1/va-t12-stage-hold.ts`: greeting → TTS "Yes, that's right. Tomorrow, Saturday." → `confirm_effective_date`
→ [disclose] → premium read → "Go ahead." → `get_disclosure(esign_consent)` → [pay, adds the `hold` tool] → esign read
→ "Yes, please text me the link." → `send_esign_and_pay_link` HELD → `reply.create` status → 12 s watched → [close]
update + held `tool.result {paid}` → `send_confirmation` → number read → goodbye. No nudges were needed.

| Check | Run 2 result |
|---|---|
| T-D1-2 #1 confirm → disclose: update then result; does the auto-fired reply call `get_disclosure`? | **Yes**, 880 ms after the result |
| T-D1-2 #2 disclose → pay (adds the `hold` tool) | `session.updated` echo `send_esign_and_pay_link:hold`; the agent called it after the customer's yes |
| T-D1-2 #3 pay → close (with the held result) | **Yes**, `send_confirmation` 650 ms after the result |
| T-D1-1 a: `reply.create` status line mid-hold is spoken | **NO.** `reply.started` → `reply.done` in 1.1 s with **0 audio chunks**; `transcript.agent` text arrives 4 s later ("I have sent that link to your phone, and I will wait here…"). Same in run 1. `ReplyTracker.kind` = `silent_no_output` |
| T-D1-1 b: silence while held | Yes: no reply in 12 s |
| T-D1-1 c: held `tool.result` fires the next reply | Yes: `reply.started` 220 ms after the result |
| The carrying pre-amble of the hold tool | Silent, `reply.done` 0.2 s after `tool.call` (no 2.3 s pre-amble hold) |

**Consequences implemented in the controller:** `PAY_TOOL_MODE=push` by default; in `hold` mode (kept for
completeness) a `silent_no_output` reply while paying is not counted as `E_VA_SILENT` (it would otherwise trigger
the "Please continue." recovery and a retry).

Other observations from the flow:
- The disclosure texts were read **verbatim** (premium: 21 s of audio; esign: 16 s).
- The timeline artifact (fetched with `scripts/day1/va-session-timeline.ts`, $0) labels the tool-call turn after
  the first user answer as `trigger:"greeting"` (the 10a oddity), and `time_to_first_audio_ms` is null for
  `tool_result` turns.

### T-D1-3: idle WS before the first update: part A **PASS**, part B **not run** ($0.003)

See the table above. Part B needs `openVoiceAgentNode({ auth: "token", tokenTtlSec: 5, … })`
(request: `docs/notes/requests/wp5b-to-integrator.md`). Script ready: `scripts/day1/va-t3-idle.ts`.

### T-D1-4: input-mode mutability and ZIP/DOB capture: **PASS** ($0.126)

s01 variant with `driver_dob` and `garaging_zip` MISSING; TTS (OpenAI `marin`) clips "Her date of birth is March
fourteenth, two thousand nine." and "Sure, it's four four one oh seven."

| Session | Capture | Mode | Value | Voiced end → `speech.stopped` | Voiced end → `tool.call` |
|---|---|---|---|---|---|
| A | DOB | min_latency | 2009-03-14 ✓ | 1305 ms | 2868 ms |
| A | ZIP | balanced (switched mid-session) | 44107 ✓ | 1947 ms | 2741 ms |
| B | DOB | balanced | 2009-03-14 ✓ | 1935 ms | 3499 ms |
| B | ZIP | min_latency (switched) | 44107 ✓ | 1335 ms | 2166 ms |

- Mode updates: 4/4 `session.updated`; keyterms update: `session.updated`, echoed; `format` preserved.
- 4/4 values correct in both modes on clean TTS; `min_latency` endpoints ≈0.6 s sooner. With clean audio there is
  no accuracy reason to prefer `balanced` for ZIP/DOB; keep §5.9.1's rule (balanced for entity asks) for real
  voices, but it is a candidate for tuning.
- **Prompt findings for WP1** (not WP5b's files): (1) a tool pre-amble carried UNSPOKEN text "I'm sorry, I didn't
  quite catch that…" while calling `update_case_field` with the right ZIP (harmless: never captioned); (2) in session
  B the agent re-asked the VERIFIED `effective_date` ("Is that Friday, October 2nd?") after the last MISSING field
  was filled: a rule-1 violation in the confirm stage when nothing is left and no stage change arrives. With the
  real tool route the stage moves to `disclose`, which should prevent it; worth a QA check.

### T-D1-5: inline HTTP tools: **FAIL → function tools** ($0.032)

All three shapes (`{…, http}` without `type`, `type:"http"`, `type:"function"` + `http`) →
`session.error invalid_value` "HTTP tools are not allowed on session.update; define them on a stored agent via
POST /v1/agents", param `tools[3].http`. Non-fatal (the session stayed open).

### Day-1 spend

$0.635 on the guard ledger (10 sessions, wall-clock billing, rounded up); $0.600 by `session_duration_seconds`.
OpenAI TTS for 7 short clips: < $0.01. With the live integration test (§4): **$0.683 total for round 1** (guard ledger; budget $2.00).

## 2. What push mode needs from WP1 / WP6 (requests filed)

- **WP1** (`tool-schemas.ts`, `prompt.ts`): with `PAY_TOOL_MODE=push`, `send_esign_and_pay_link` is
  `execution_mode:"interactive"`, `timeout_seconds:10`, description "…Returns right after the text is sent; the
  system tells you when the payment finishes." and the `pay` stage instruction becomes: "…Call
  send_esign_and_pay_link now with their words. When it returns, tell the customer in one short sentence that you
  texted the link and will wait while they sign and pay. Then stay quiet unless asked; the system gives status
  updates." (`docs/notes/requests/wp5b-to-wp1.md`).
- **WP6** (route #14): in push mode the immediate `result` is `{status:"link_sent"}` (+ `ui.sms/link/paymentId`),
  which the contract already allows. Nothing else changes: the controller polls #15 and uses `PaymentView.toolResult`.

## 3. What was built (product code)

All browser code imports `client-only`; nothing in `src/client/**` imports `src/server/**` (boundaries test green).

| File | What |
|---|---|
| `src/client/va/controller.ts` | `VoiceAgentControllerImpl` (`createVoiceAgentController(deps)`): implements `VoiceAgentController` + `VoiceAgentControllerExt`. `connect(token)` (browser `new WebSocket(tokenUrl(token))`, 3 s open timeout) or `attach(session)` (Node/tests); `start(compiled, {holdAudioUntilCtxMs})`; `applyStage`; `say`; `setPayingState`; `playCustomerClip`; `setMicSource`; `end`; `endNow` (pagehide) |
| `src/client/va/first-update.ts` | `buildFirstUpdate(compiled, {keytermsEnabled})` = exactly the T-D1-0 shape (a unit test checks it is byte-equal to the fixtures that passed live); `basicFirstUpdateGuard` = a conservative local whitelist, used only until WP1's `validateFirstUpdate` is injected |
| `src/client/va/payment-watch.ts` | §5.8 steps 3–8 for both pay modes: 1.5 s polling of #15, 60 s deadline from the SMS, 30 s extensions up to 180 s while the phone is active, reassurance every 45 s (not in `checkout-open`/`processing`), the client timeout result, late success |
| `src/client/va/cap.ts` | §5.9.5 dynamic cap: wrap-up at cap − 20 s, the clock paused while paying, never in paying/closing; `cap` ends the session; the 600 s ceiling ends any stage |
| `src/client/va/captions.ts` | §5.10 caption rules 1–4 → `va.caption` / `va.user` BatonEvents |
| `src/client/va/retry.ts` | `startVoiceAgentWithRetry`: the GREETING-phase RETRYING rule (once, attempt 1, same compiled config, failure reported, old socket ended first; `VaStartFailed` → recorded-AI fallback) |
| `src/client/hud/latency.ts` | `LatencyHudImpl` (`LatencyHud` + ext): marks on the AudioContext clock → `click_to_first_audible`, `dead_air_after_rep`, `turn_audible_latency`, `tool_turn_latency` (last/p50/p90/n); session ids; underruns; slow network. `hudMetricReporter` → `hud` BatonEvents + POST #12 |
| `src/client/hud/view-model.ts`, `use-hud.ts` | Display data (dead air first, the "includes {rep}'s ≈3.5 s handoff line" note, the §5.10 tooltip verbatim, session ids, badges) and a `useHud(hud, repFirst)` hook for WP7's component |
| `src/core/contracts/ext/wp5b-va.ts` | Additive types: `VoiceAgentControllerExt`, `VaControllerEvent`, `VaControllerPhase`, `PayToolMode`, `VaToolCaller`, `VaPaymentPoller`, `VaStageSource`, `VaEventsPoster`, `LatencyHudExt`, `HudSnapshot` |

### Controller behaviour (decisions)

- **First update**: built from `CompiledTakeover` and validated (WP1's validator if injected, else the local guard)
  before a byte is sent. A failure → `error{code:"E_VA_CONFIG", retryable:false}` and a thrown `BatonError`.
- **Audio in**: the feeder starts on `session.ready`, never before. Customer clips (`playCustomerClip`) mark the HUD
  `eos` at the clip's end; with no clip and no mic, the receipt of `input.speech.stopped` is the `eos` fallback.
- **Audio out**: leading silence (≤ −50 dBFS; digital silence is −Infinity, compared but never serialized) is
  dropped until the reply's first audible chunk; `player.holdUntil(repLineEnd)`; the player's first-audible-PLAYED
  callback drives the HUD, the captions, the `first_audible` event and the ACTIVE phase.
- **Barge-in** on the first of `input.speech.started` / `reply.done{interrupted}` / `transcript.agent{interrupted}`,
  only if agent audio is playing or buffered: `player.flush()` runs synchronously in the event handler, the captions
  are cut at the flush time with "—", later chunks of that reply are dropped, and one `va.reply{interrupted:true}` is
  emitted. A speech start in the last 400 ms of a reply that finished streaming lets the tail play. Mic mode: a local
  VAD onset ducks to 30 % and restores after 2.5 s without a server barge-in.
- **Tools**: all six are registered; `ToolDispatcher.policy="immediate"`. For a response with `stage` /
  `systemPrompt` / `tools` / `transcriptionMode`, `session.update{system_prompt, tools[, input:{transcription_mode}]}`
  is sent inside the handler, so the dispatcher's `tool.result` always follows it (T-D1-2). An invented tool name →
  an `error` event with `E_VA_CONFIG` (G0 rule 17) plus the dispatcher's is_error answer.
- **Pay** (`send_esign_and_pay_link`): route #14 → a `phone.sms` event; `not_sent` is a plain answer.
  - Push (default): answer `{status:"link_sent"}` at once → PAYING (cap paused) → PaymentWatch → on success
    `stageSource("close")` + `session.update` → `reply.create "Payment is confirmed. Call send_confirmation now."`.
  - Failed/expired → the server's instruction. Timeout → the timeout line and a `payment{status:"timeout"}` event (the
    phone closes the overlay). A late success → close + "The payment just came through. Call send_confirmation now."
  - Hold (flag only): the result is withheld and resolved with the server-built `PaymentView.toolResult` after the
    close update; silent replies during a hold are not counted as `E_VA_SILENT`.
- **hand_back_to_rep**: the result is sent; the `hand_back` event fires after the agent's next spoken reply has
  played (≤4 s after it finished streaming; 10 s safety).
- **close_ready**: after a successful `send_confirmation`, a spoken reply that does not end in "?" plus 2.5 s of quiet
  (a question waits 12 s for an answer); any speech or new reply cancels the timer.
- **Errors** (§5.9.6): first-update failures are classified in `start()` (`E_VA_CONFIG`: no retry; `E_VA_AUTH`,
  capacity, transient and `E_VA_TIMEOUT`: retryable). Mid-session `immutable_field`/`invalid_*` are only logged.
  `silent_no_output` → "Please continue." once; twice → `E_VA_SILENT` (retryable). An unexpected close after ready →
  a retryable error, then `ended`. Errors that race in between `session.ready` and `start()` resuming are deferred.
- **Heartbeat**: `POST #12 {heartbeat:true, vaSessionId}` every 10 s while open; `{vaSessionId}` once at ready.
- **iOS**: `PageLifecycle.onPause("ios_background")` → `session.end` after 10 s unless the page resumes.
- **Ending**: `end()` = `session.end` → `session.ended` (≤2 s) → close → `ended{sessionSeconds}`; idempotent.

## 4. Tests and measured numbers

- `npm run typecheck` clean; `npm test` green (16 files, 319 tests; WP5b's 48 are in `tests/unit/client/{va,hud}/**`).
- `tests/integration/va-retry.test.ts` ($0, fake server): 5/5.
  - A retry after `server_error` post-compile, in this order: end the old socket → report the failure → mint
    attempt 1 → send the same first update, byte for byte.
  - A pre-ready `internal_error` retries; no audible greeting within 5 s → `E_VA_TIMEOUT` → retry.
  - `E_VA_CONFIG` never retries; two failures → `VaStartFailed` after exactly one retry.
- `tests/integration/va-core.test.ts` (LIVE, `RUN_LIVE=1`): **PASS**, session `sess_ce94…`, 36.0 s, $0.045. The real
  controller on a Node socket:
  - the s02 greeting was spoken verbatim;
  - the TTS "Yes, that's right. Tomorrow, Saturday." → `confirm_effective_date {date:"2026-09-26"}`;
  - on the wire, `session.update{disclose prompt + tools}` immediately before its `tool.result` → `session.updated`,
    no `session.error`;
  - the auto-fired reply called `get_disclosure`; the disclosure was read; one `session.end` → `session.ended`.

| Measurement (India → US) | Value |
|---|---|
| First update → `session.ready` | 611–672 ms (5 sessions) |
| `session.ready` → first audible greeting chunk received | 292–341 ms (leading silence 180–240 ms) |
| Greeting length (65–69 words) | 22.0–23.7 s of audio |
| Stage-change `tool.result` → the new tool's `tool.call` | 650–880 ms |
| Voiced end → `input.speech.stopped` | min_latency 1.3 s, balanced 1.9 s |
| Voiced end → `update_case_field` `tool.call` (DOB / ZIP) | min_latency 2.9 / 2.2 s, balanced 3.5 / 2.7 s |
| The hold tool's carrying pre-amble | silent; `reply.done` 0.2 s after `tool.call` |
| 12 s idle socket before the first update | not closed, not billed, ready in 672 ms |

## 5. What the integrator must wire (G1 / G2)

1. **WP5 (TakeoverController, D2 10:00):**
   - At ARMED: `POST /api/va/token {attempt:0}` → `controller.connect(token)` (the pre-open; token TTL per the WP2
     request). At tSend: `controller.start(compiled, {holdAudioUntilCtxMs: repLineEnd})`, or use
     `startVoiceAgentWithRetry({ preopened, mintToken, makeController, reportFailure, … })` for the GREETING retry.
   - Listen to `onEvent`:
     - `first_audible{greeting:true}` → GREETING → ACTIVE; `paying` → PAYING;
     - `hand_back` → play the rep's "I'm back" line, then `end("hand_back")`;
     - `close_ready` → CLOSING → `end("completed")`;
     - `ended` → `POST /end` with `vaSessionId`;
     - `error{retryable}` after the greeting → the owner's call (FAILED or fallback).
   - `pagehide` → `controller.endNow("pagehide")` (plus the keepalive `/end`, G0 rule 10).
   - Pass `hud`: one `LatencyHudImpl` per page with `onMetric: hudMetricReporter({sink, postEvents, eventTime})`. Mark
     `arm`, `repLineStart` and `repLineEnd` on it; call `setSessionIds({rep, customer})` from WP4.
2. **WP4 (AudioEngine):** `createVaOutput()`, `createFeeder()` and `nowMs()` as in services.ts. What the controller
   relies on:
   - it pushes only chunks from the first audible one on (leading silence is already trimmed), with
     `audible = level > −50 dBFS`;
   - the player fires `onFirstAudiblePlayed(replyId, ctxMs)` for the first `audible` chunk of each reply when it is
     actually PLAYED (never before `holdUntil`);
   - `flush()` is synchronous and idempotent; `enqueueClip` resolves with the clip end on the AudioContext clock.
3. **WP6 (D3 11:00):** `callTool` = the route #14 body (`VaToolCaller`); `pollPayment` = #15; **`stageSource`** for
   the paid → close transition (request `wp5b-to-wp6.md`); push-mode `{status:"link_sent"}`; and
   `MockPhoneProps.onState → controller.setPayingState`.
4. **WP1 (G1):** inject `validateFirstUpdate`; the push-mode pay tool and pay-stage text (request `wp5b-to-wp1.md`);
   re-run T-D1-0 on the compiler output (`va-t0-first-update.ts --fixture-dir`).
5. **WP7 (G2):** render `useHud(hud, repFirst)` in `src/components/hud/**`; consume the `va.caption` (replace by
   `replyId`), `va.user`, `va.reply`, `va.tool`, `stage`, `payment`, `phone.sms`, `hud` and `error` BatonEvents.
6. **WP11:** chips/typed/autopilot audio → `controller.playCustomerClip(pcm24k)`; autopilot waits for
   `va.reply{phase:"done"}` (it never barges in).
7. **Env → config:** `PAY_TOOL_MODE` (default `push`), `VA_KEYTERMS` (default `1`), `VA_SESSION_CAP_MAX_MS`
   (default 420000) → `createVoiceAgentController({ config: { payToolMode, vaKeyterms, vaSessionCapMaxMs } })`.
8. **Integrator:** the token-auth option in `aai-open.ts`, then T-D1-3 part B (`wp5b-to-integrator.md`).

## 6. Acceptance status (TASKS WP5b)

| # | Item | Status |
|---|---|---|
| 1 | T-D1-0 … T-D1-5 executed and recorded | **Done**, except T-D1-3 part B (needs the integrator's token-auth open) |
| 2 | Live Node integration (s02 greeting verbatim, the PENDING date via `confirm_effective_date`, the stage change to disclose with §5.9.4 ordering, `session.end`) and the VA-retry test | **PASS** (`va-core` live; `va-retry` on a fake server) |
| 3 | K2: 10 manual takeovers of s01 from India, plus one early pass with a real Polar payment | **Pending**: needs WP4 (browser engine), WP5 (takeover), WP6 (tools, Polar) and WP7 (`/call`) on D3, and the user's browser |
| 4 | Barge-in flushes within one frame; interrupted captions truncated; the wrap-up never fires in paying/closing | **PASS in unit tests** (the flush is synchronous in the event handler; caption truncation; cap and controller tests for paying and closing). Browser-side timing needs WP4's player (K2) |

## 7. Known gaps

- **T-D1-3 part B** (a token expiring during the idle) has not run. Until it does, WP2 is asked to mint VA tokens with
  a 20–30 s window.
- **The browser path is untested end to end** (a real `WebSocket`, WP4's worklet player and feeder, the iOS
  lifecycle). The Node test covers the protocol; K2 covers the browser.
- **`stageSource` is required for the paid → close step.** Without it the controller logs `E_CASE_STATE`, and the
  agent cannot call `send_confirmation` (it is not in the pay stage's tool list).
- **`hold` mode is kept behind the flag**, but its status line and reassurances are silent (T-D1-1). Do not ship it.
- **The `close_ready` heuristic** is "a spoken reply not ending in '?' plus 2.5 s of quiet". If the agent's goodbye
  ends with a question, the 12 s fallback applies.
- **The HUD `eos` in mic mode** uses a simple RMS VAD (P2 is cut; untested live).
- **Prompt compliance** (WP1): a VERIFIED `effective_date` was re-asked once in T-D1-4, when the stub result left the
  stage at `confirm`.
- `basicFirstUpdateGuard` duplicates part of WP1's validator on purpose, as a stop-gap. WP1's validator is
  authoritative once injected.
