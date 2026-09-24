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
OpenAI TTS for 7 short clips: < $0.01.

## 2. What push mode needs from WP1 / WP6 (requests filed)

- **WP1** (`tool-schemas.ts`, `prompt.ts`): with `PAY_TOOL_MODE=push`, `send_esign_and_pay_link` is
  `execution_mode:"interactive"`, `timeout_seconds:10`, description "…Returns right after the text is sent; the
  system tells you when the payment finishes." and the `pay` stage instruction becomes: "…Call
  send_esign_and_pay_link now with their words. When it returns, tell the customer in one short sentence that you
  texted the link and will wait while they sign and pay. Then stay quiet unless asked; the system gives status
  updates." (`docs/notes/requests/wp5b-to-wp1.md`).
- **WP6** (route #14): in push mode the immediate `result` is `{status:"link_sent"}` (+ `ui.sms/link/paymentId`),
  which the contract already allows. Nothing else changes: the controller polls #15 and uses `PaymentView.toolResult`.
