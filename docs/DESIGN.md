# Baton: technical design (MVP + ordered stretch)

**Status:** buildable spec, **v1.1**, 2026-09-24 (IST), for coding agents working in parallel. Work packages are in `docs/TASKS.md`. v1.1 applies three adversarial reviews (API correctness, demo reliability, scope/schedule). Every accepted or rejected finding is listed in **Appendix D (Review log)**. The submission package (video, deck, cover, README, licence, lablab copy) is specified in **§11**.
**Product:** *Baton: reps diagnose, AI finishes the call.* A licensed rep handles the diagnosis/advice half of a US personal-auto "add a driver" servicing call. At any moment the rep passes the baton, and an AssemblyAI Voice Agent that already holds the verified case state finishes the administrative tail: confirmations, verbatim disclosure, e-sign and pay link, and confirmation. It never asks for anything twice.
**Deadline:** submit on lablab by **2026-09-30 12:00 IST** (hard close 20:30 IST).

**Source-of-truth order when documents disagree:**
1. This file.
2. `research/10-smoke-test-results.md` and `10a`–`10d` (live-verified API behaviour).
3. `research/11-ideation-verdict.md` §2.1 and §5.
4. `research/12`–`16`.
5. The older research files.

**Every hosting mention in the research is superseded by §10 of this file:** Zerops runs a Node service and a managed PostgreSQL service. The code stays portable enough to stand up a Vercel mirror in under an hour.

**Tags:**
- `[DAY-1 TEST]`: an API behaviour that must be verified before anyone builds on it. Each one has a named fallback.
- `[HYPOTHESIS]`: an estimate.
- `[STRETCH]`: not in the MVP.

---

## 0. Key decisions (one screen)

| # | Decision | Why |
|---|---|---|
| D1 | **One Next.js 16 app at the repo root.** Strict folders: `src/core` (pure, isomorphic), `src/server` (server-only), `src/client` (browser-only). Node CLIs live in `scripts/`. No monorepo | One deploy unit on Zerops, and the Vercel mirror is trivial. `src/core` is shared by the app and the eval CLI with no workspace linking. Parallel agents own disjoint directories |
| D2 | **Realtime audio goes browser ↔ AssemblyAI directly** for both Streaming STT and the Voice Agent. The server only mints tokens | Lowest latency (India → US edge, not India → Prague → US). No server audio load. Verified architecture [10 §0] |
| D3 | **Watch mode, per-channel replay.** Each channel of a real recorded call (rep and customer) streams to its own U3.5 Pro session at 1× real time. The pacing clock is an AudioWorklet, so what the judge hears is exactly what STT receives | Verified: 27/27 attribution, 21/21 entities [10b ST-6]. Worklet clocks survive tab throttling |
| D4 | **The LLM proposes observations; code decides status.** `gpt-6-luna` (effort `none`) emits per-turn *fact events* with a strict schema. A pure function computes VERIFIED/PENDING/MISSING. `gpt-6-sol` (effort `low`) runs in the background and can only **downgrade** | Status is deterministic and replayable in the sweep. The LLM can never mark something verified |
| D5 | **The server is authoritative for the case and for money.** The greeting and prompt are compiled on the server from DB state. Tool calls are client function tools that call server routes with a per-case JWT. The case is "paid" only when Polar says so (webhook or a server-side GET). `send_confirmation` refuses otherwise | Fail-closed. A tampered browser can fake a `tool.result` but can never obtain a confirmation number |
| D6 | **Free-tier guardrails are first-class, and there is exactly ONE limits authority per AssemblyAI account** (§2.3):<br>• the Zerops Postgres `db` holds the **stream-slot broker** (4 new STT sessions per rolling 60 s, FIFO queue, cached replay starts at once if the ETA is over 15 s), the **Voice Agent slot registry** (3 concurrent, heartbeats) and the **spend ledger** (reservations, an epoch-based judging budget, a dynamic daily cap);<br>• every other opener (local dev, eval scripts, integration tests, the Vercel mirror) reaches that authority over HTTPS (`LIMITS_AUTHORITY_URL`), never a database of its own;<br>• a **mode flag** (`live`, `replay_only`, `maintenance`) degrades to labelled replays | The AssemblyAI free-tier limits (≈$49 credit, 5 new streaming sessions/min, VA concurrency) are **account-wide**, not per database. Temporary tokens are reusable and the Voice Agent cap is not enforced [10 §0.2], so our mint routes plus a frequent session audit are the only spend control |
| D7 | **Evals are cached once, then swept offline.**<br>• Each call × variant goes through live STT exactly once (`data/cache/stt`).<br>• Each cached final goes through luna once (`data/cache/extract`).<br>• The 2 s sweep emulates the takeover protocol against those caches, for $0 extra.<br>• A small set of **live spot-checks** runs the real Voice Agent.<br>• The UI labels every number as `LIVE`, `CACHED-STT SWEEP` or `PROJECTED` | Reproducible within the free-tier budget, and honest about which numbers are measured |
| D8 | **Plain OpenAI Responses API** (`openai@7.23.0`), not `@openai/agents` | These are single strict-schema calls on a latency budget. The Agents SDK adds a default model (`gpt-5.6-luna`), tracing and dependencies for no gain |
| D9 | **Polar sandbox for the pay step, called directly through `@polar-sh/sdk@0.49.0`.** We verify webhooks with our own dual-scheme function (Standard Webhooks as-is, then legacy base64), built on `standardwebhooks@1.1.1`. We do **not** use `@polar-sh/nextjs` | Verified in the 0.49.0 tarball: `validateEvent` only base64-encodes the secret (the legacy "Polar HMAC" scheme). Secrets minted after 2026-09-08 are Standard-Webhooks-as-is [12 §9], so the SDK helper would reject our webhooks. `@polar-sh/nextjs@0.9.6` also pins `@polar-sh/sdk@^0.47`, which would install a duplicate SDK |
| D10 | **TypeScript 6.0.3 for the app** (spikes stay on 7.0.2). Next's build-time type check is off. `npm run typecheck` (`tsc --noEmit`) runs separately | TS 7 is the native port, and Next 16's programmatic TypeScript integration is not guaranteed to work with it. TS 6.0 is the last JS-API release. Spike code is plain TS and compiles under both |
| D11 | **Progressive tools use four stages:**<br>1. `confirm`<br>2. `disclose`<br>3. `pay`<br>4. `close`<br>`update_case_field` and `hand_back_to_rep` are always available. Every stage change sends `session.update{system_prompt, tools}` with the **full** list. The **first** `session.update` contains only live-verified keys and values (`validateFirstUpdate()`, §5.9.1, test T-D1-0): no `hold` tool, no JSON-schema `format`, `input.keyterms` only behind a flag | The list is replaced, not merged [10 §3.5]. Gating makes skipping the disclosure impossible. A validation error on the first update is fatal (close 1008), so it must never carry an untested field |
| D14 | **The AI half of a run is decided at Start** (`POST /api/runs`, §4.4): `live` (VA budget and a VA slot are held for the run) or `recorded` (the labelled recorded AI session plays at its own handoff point, and the manual pass is disabled). A run is never half-live in a way that contradicts the case card | A judge who passes at 00:40 must never hear a recorded greeting built at 01:35 [review B6] |
| D15 | **The pay step never dead-ends.** Every pay sheet offers **Pay with Polar sandbox** and a labelled **Skip: simulate payment** (server-side `mock`). The embed's `success` event is `preventDefault()`-ed so it never navigates. The hold is progress-aware, and a late payment still confirms | The default Watch path is passive; Polar's embed navigates the page on success unless prevented (verified in `@polar-sh/checkout@0.4.1`) [review B1, B2] |
| D12 | **All live UI is driven by one event log (`BatonEvent[]`).** A replay is the same UI fed a stored log plus audio | The labelled fallbacks (cached-turn replay, recorded AI session) reuse every component, and e2e tests run without spending money |
| D13 | **The case schema is the recording kit's schema:**<br>• `FieldId` = kit `FACT_FIELDS` (21);<br>• required = kit `REQUIRED_FIELDS` (10);<br>• value formats = kit formats.<br>A parity unit test imports `tools/recording-kit/src/scenarios.ts`. `callId` = the kit take `base`. The Watch-mode handoff line is the rep's real line cut from the same recording, and auto-baton fires there | Ground truth compares with no mapping layer. No extra recordings are needed for the handoff clip. The default Watch path always completes |

---

## 1. Product

### 1.1 Summary

**The problem.** The routine tail of a servicing call is compliance-heavy, and reps rush or skip parts of it:
- effective date;
- read-backs;
- the required disclosure, read verbatim;
- e-sign and payment;
- confirmation.

After-call work then eats more minutes. Every existing handoff runs AI → human, and customers repeat themselves.

**How Baton works:**
1. Baton rides along silently on the human↔human call. Two Streaming STT sessions, one per channel, build an **evidence-linked case record**. Every fact carries a status (VERIFIED/PENDING/MISSING) and a clickable audio clip.
2. When the rep passes the baton, a Voice Agent opens with the customer's own facts. It asks only for what is missing, reads the disclosure word for word, texts an e-sign and pay link (Polar sandbox), and confirms.
3. After the call, AssemblyAI async transcribes the agent's own recording. A deterministic QA card proves:
   - **Re-asked: 0**;
   - **Disclosure verbatim ✓**;
   - audible latency.

**Autonomy ladder:**

| Rung | What happens |
|---|---|
| Shadow | Case records only |
| Baton | The AI finishes the tail |
| Promote | A stored full-call agent for proven intents (`POST /v1/agents`) |

**MVP intent:** `add_driver` (US personal auto; independent agencies, MGAs and regional carriers).

### 1.2 Personas

| Persona | Role in the demo | Needs |
|---|---|---|
| **Judge** (primary user of the deployed app) | Opens the link with no signup. Has 1–3 minutes. The mic may be blocked. Could be on Chrome, Safari, Firefox or a phone, anywhere in the world | A default path that needs no mic and works on first click. Every number labelled live or cached. Visible proof that both AssemblyAI APIs are necessary |
| **Director of Service Operations** (buyer, story only) | Appears in the video and slides | ROI slider, re-ask/hand-back/completion KPIs, governance (evidence, fail-closed money, disclosure proof) |
| **CSR "Daniel"** (daily user, persona of the rep channel) | His recorded voice in Watch mode. The "Pass the baton" button is his | One click to hand off. The AI never contradicts his VERIFIED facts |
| **Policyholder "Priya"** (customer channel) | The volunteer's recorded voice in the human half. In the AI half, the judge's mic, typed text or suggested-reply chips | Not repeating herself. A clear AI disclosure. A way back to Daniel |
| **Operator** (the user, i.e. you) | Admin flags, budget, eval scripts, deploys | A kill switch, a spend view, reproducible evals |

### 1.3 Judge paths

All paths start at `/`. Clicking a primary button is the audio-unlock gesture: the `AudioContext` is created and resumed inside the click handler.

#### P1. "Watch a real call" (default, no mic needed; MVP)

1. `/` → **Watch a real call** → `/call/[callId]?mode=watch`. The default `callId` is the entry marked `featured: true` in `src/generated/calls.json` (derived at build time from the kit's chosen `s01` take; a unit test asserts it exists, is publishable and has assets). An unknown `callId` redirects to the default with a toast. The default call's assets are prefetched while the landing page is idle.
   - **Call picker (curated):** only published calls with an accepted handoff and a positive amount due (s01 featured, then e.g. s02, s05, s10). Declined calls (s03/s14/s17) appear under "More calls" with the label "customer declines the AI: Baton respects it". s04 (premium goes down), s09 (no change) and s07 (December start) are not in the picker.
2. The page calls `POST /api/runs` (the run plan, D14) and shows a pre-flight card:
   - Live day: "This is a real role-play phone call recorded by volunteers (consented). It will stream through two live AssemblyAI Universal-3.5 Pro sessions, one per speaker. Call date: Fri 25 Sep 2026; the AI half runs as of that date."
   - Replay day (`aiHalf=recorded` or STT unavailable): "Live budget for today is used up (or live AI is busy). You'll watch a recorded run: real audio, AssemblyAI transcripts cached on 2026-09-2x, and the recorded AI session at Daniel's handoff line."
   - Two buttons with honest durations: **Express · about 3 min** (primary; starts 25 s before the decision point, §5.1.6) and **Full call · about 5 min**.
   - The headphones hint appears only when the mic is turned on. On iOS: "No sound? Turn off silent mode."
3. **Shadowing.**
   - The recording plays.
   - Per-channel transcripts appear live.
   - The case card fills with fact rows. Each row shows a status chip and ▶ evidence chips.
   - The readiness gauge moves.
   - A conflict card appears if the parties disagree.
4. **Pass the baton**, at any second:
   - The protocol stepper shows *Arming → Sealing → Draining → Compiling → Connecting*.
   - Daniel's handoff line plays: "OK if my assistant finishes the paperwork? I'll stay on the line." This is **his real line, cut from the same recording** (`labels.handoff`, §6.1), **followed by the customer's real acceptance** ("Sure, go ahead", `acceptStartMs..acceptEndMs` from the customer channel). If the take has no clean acceptance, a labelled synthetic "Sure." plays. If the take has no clean rep line, a labelled TTS line plays.
   - The AI greeting starts about 0.5 s after the acceptance ends.
   - When the run's AI half is `recorded` (D14), the manual Pass button is disabled with the tooltip "Live AI is unavailable right now: the recorded AI session starts at Daniel's handoff line (01:35)". The Explorer is offered as the any-second proof.
   - **Auto-baton:** if the judge hasn't clicked by the time the recording reaches Daniel's own handoff line (the scenario's `handoff` beat), the protocol arms at that line's start. The line and the customer's "Sure, go ahead" play from the recording, and playback stops after the acceptance. The default path therefore always completes.
   - For scenarios where the customer declines (e.g. `s03`), auto-baton is off. The judge can still pass the baton earlier.
5. **AI half.** The customer is driven by one of these inputs:
   - **Autopilot customer** (default ON in Watch mode). The top suggested reply auto-plays 600 ms after each agent request, with a 4 s stall timer and a loop breaker (§5.15). Where the customer volunteer recorded a "tail pack" (§11.6), autopilot uses **their own recorded voice**; otherwise a synthetic voice. The customer lane labels each clip "Customer (recorded)" or "Customer (synthetic stand-in)".
   - **Suggested-reply chips**, clicked by the judge, plus one "Try this" chip that triggers a live conflict ("Actually, she'll mainly drive the Highlander").
   - **Type a reply**, voiced by OpenAI TTS into the agent.
   - **Use my mic**, optional. Turning it on shows the headphones hint and a notice that the judge's voice is recorded by AssemblyAI (stored in eu-west-1; deletion requested after 7 days), plus "Bluetooth headsets switch to call quality when the mic opens".
6. **Pay.** When the SMS arrives, the MockPhone **floats as an overlay** anchored bottom-right with a pulsing "Your turn: tap the text" (on mobile the Phone tab opens by itself). Tapping it shows:
   - an e-sign sheet (checkbox + typed name prefilled + Sign);
   - a **pay sheet with two first-class choices**:
     - **Pay with Polar sandbox (test card, about 20 s):** the tap copies `4242424242424242` to the clipboard and the sheet shows "Card 4242 4242 4242 4242 · 12/34 · 123: copied" *before* the Polar overlay opens. Name and email are prefilled and locked (a sandbox demo customer), the amount is fixed and tax-inclusive. A visible "Open checkout in a new tab" link is shown from the start (never a timer popup).
     - **Skip: simulate payment:** the server switches that payment to `mock` (`status_source=mock`) and the QA card says "simulated". The fail-closed rule still holds, because the server sets the status.
   - With Autopilot on, if the phone is untouched 15 s after the SMS, a visible 10 s countdown ("Autopilot will simulate the payment, or pay with the test card") runs and then simulates.
   - The Voice Agent hold is progress-aware (§5.8): it extends while the judge is signing or paying, and a payment that lands after a timeout still confirms.
7. **Confirmation.** The agent confirms. The session ends.
8. **QA card.**
   - Immediately: **Provisional** figures from `transcript.agent`.
   - About 15–25 s later: **✓ Verified from recording**, after async multichannel ch2 analysis.
   - Figures shown: re-asked 0 · newly asked N · pending confirmed M · disclosure verbatim ✓ (similarity %) · click → first audible (ms) · dead air after the rep line (ms) · payment verified by Polar webhook.
9. Links to **Takeover Explorer** (this call) and **/evals**. After a hand-back, the card shows what Daniel sees (the summary, AI-confirmed rows, the reason) and **Pass the baton again** (takeovers allow 3 per case).

**Express path (about 3 min in total):**
- The page loads the cached case state up to the decision point (labelled "fast-forwarded with cached transcription").
- About 25 s of live STT plays, starting at the nearest turn start.
- Then the baton pass and the AI half (2–3 min including payment).

#### P2. "Be the customer" (mic; flag `FEATURE_BE_CUSTOMER`; **CUT from the hackathon schedule in v1.1**, kept as roadmap)

> v1.1: P2 is not scheduled (TASKS cut list). The judge can already use their mic in the AI half of P1. The spec below stays for after the deadline; nothing in the MVP depends on it.

1. `/live` → role card: "You're Priya. You want to add your 17-year-old daughter Maya to the policy, on the 2021 Civic, starting Friday…".
2. Headphones prompt, then mic permission.
3. Daniel's recorded rep lines play in sequence. They are fed to the rep STT channel, so rep turns are transcribed live too.
4. The judge answers into their own mic, which goes to the customer STT session.
5. **Half-duplex:** while a rep line plays, the customer session receives **silence** instead of mic audio.
6. The next rep line plays when the judge's turn finalizes (customer final, plus 400 ms).
7. Pass the baton at any time, or answer "yes" to Daniel's consent line (a keyword on the customer final: `/\b(yes|sure|ok(ay)?|go ahead|fine)\b/`).
8. After the pass, the mic feeds **only** the Voice Agent. Both STT sessions are terminated first.

**Gate (end of D4):** 10 dev runs across Chrome and Safari, with:
- ≥90% of role-card facts captured;
- 0 echo leaks (rep audio transcribed on the customer channel);
- barge-in working.

If the gate fails, hide the button.

#### P3. Takeover Explorer (`/explorer/[callId]`; MVP)

- **Top:** the waveform of a real recorded call with both channels and turn markers, plus a draggable **baton** handle that snaps to 2 s points.
- **Panel:** for the selected point:
  - the greeting the AI *would* speak (compiled, deterministic);
  - the case snapshot (statuses and values);
  - metrics: entity accuracy, pending, missing, projected re-ask, wrong-fact asserted;
  - a "mid-utterance" badge;
  - estimated drain time.
- **Toggles:** pipeline version (v1/v2/v3), STT variant (per-channel + `agent_context` / per-channel / mono-diarized).
- **Label:** "EVAL DATA: sweep over cached STT turns of a real call (recorded 2026-09-25). No live API calls on this page."
- A **Play from here** button plays the recording audio around the point (local audio only).
- Links to `/evals`.

#### Secondary pages

| Page | Contents |
|---|---|
| `/evals` | Curves and tables, see §6.6 |
| `/status` | Public health: last synthetic checks, mode, today's budget use as a % (no $ amounts) |
| `/about` | One-page architecture (the diagram in §2.1), "why both APIs", honest limits. This is the video's architecture beat |

### 1.4 Screens, layouts, components, states

**Design system:**
- Tailwind 4 plus shadcn/ui (Radix), lucide icons, recharts for curves.
- Tone: calm "operations console", light and dark.
- Colors are tokens:
  - `--verified` green;
  - `--pending` amber;
  - `--missing` slate;
  - `--conflict` red;
  - `--ai` violet;
  - `--rep` blue;
  - `--customer` teal.
- Every status chip has an icon and text, never color alone.

#### S1. Landing `/`

- **Hero:** "Reps diagnose. AI finishes the call." Sub-line: "The AI inherits the conversation, not just the call."
- **Primary CTA** "Watch a real call (no mic needed)". **Secondary** "Be the customer" (shown only when the flag is on, badge "beta").
- Links: "Takeover Explorer", "Evals", "How it works".
- Strip: "Built on AssemblyAI Universal-3.5 Pro Streaming + Voice Agent API + async multichannel".
- **Status pill** from `GET /api/status`:
  - `Live`;
  - `Replay mode (live budget reached today)`;
  - `Maintenance`.
- **States:**
  - `loading`: skeleton.
  - `status-unavailable`: pill hidden; buttons still work.

#### S2. Call console `/call/[callId]`

- **Desktop (≥1280 px), three columns plus a bottom timeline:**
  - **Top bar:**
    - call title ("Add a driver · Priya ↔ Daniel · phone audio 8 kHz, Twilio dual-channel") and "Call date: Fri 25 Sep 2026";
    - mode badge: `LIVE STT` (green) / `CACHED REPLAY` (amber, with a tooltip giving the reason) / `RECORDED AI SESSION` (amber);
    - queue/budget notice, in plain words (e.g. "Several people on your network ran live demos this hour: showing the labelled replay; live again in 12 min");
    - **Latency HUD** (§5.10), which also shows the live AssemblyAI session ids (`Begin.id` per channel, VA session id) as liveness proof.
  - **Narrator strip** ("Now: …", one line under the top bar, changes by phase): "Human half: Baton is listening silently; watch facts turn green" → "AI half: you are Priya; let Autopilot answer or type anything" → "Your turn: tap the text on the phone to sign and pay" → "Done: this QA card is computed from the AI's own recording".
  - **Left: Transcript** (`TranscriptLanes`, about 38%):
    - Human half: two lanes (Rep, Customer). Partials are grey italic and replaced per `turn_order`; finals are solid. Each final has a hover ▶ and a turn id.
    - AI half: an AI lane (violet captions scheduled per §5.10) and a customer lane (agent-side `transcript.user` text).
    - A separator row: "Baton passed at 01:42.3 · protocol 2.9 s".
  - **Center: Case card** (`CaseCard`, about 36%):
    - Header: intent "Add a driver", policy number, customer name (from the policy record, labelled "policy record").
    - `ReadinessGauge`: a ring with VERIFIED/PENDING/MISSING counts out of the required total.
    - `FieldRow` × 10: label, value, `StatusChip`, reason tooltip ("acknowledged by customer at 01:12"), `EvidenceChip` × ≤3 (▶ plays a padded clip, see §5.11), and a verifier badge ("sol agrees" ✓, or ⚠ "verifier disagrees → PENDING").
    - `ConflictCard`: "Customer said 2021 Civic, rep read back 2020 Civic" with both clips, plus the resolution when resolved.
    - After takeover, rows updated by the AI show a violet "AI-confirmed" tag.
  - **Right: Control panel** (`ControlPanel`, about 26%):
    - Before takeover: a big **Pass the baton** button, a hint ("Pass any time: Baton waits ≤1.5 s for the turn to end"), an estimate that updates live ("Pass now: the AI will need to collect 4 facts, about 2 min"), and a "stop playback" link.
    - During the protocol: `ProtocolStepper` with live ms per step.
    - During the AI half:
      - `StageTracker`: Confirm → Disclose → Pay → Close;
      - `ToolRail`: each tool call with name, args and result, a spinner while pending, and a "hold" badge;
      - `ReplyControls`: Autopilot toggle, 3 suggested chips, text box with Send, mic toggle, **Ask for Daniel** (forces `hand_back_to_rep` through `reply.create` instructions);
      - `MockPhone`: docked in the right column, and **floating as an overlay** (bottom-right, above the fold) from `phone.sms` onwards on any screen narrower than 1600 px, so it is never below the fold on a 1366×768 laptop.
    - While a recorded AI session plays, `ReplyControls` and `MockPhone` are read-only with a "recorded" badge, and the case card switches to the bundle's `case.state` events (the judge's own shadow transcript is greyed).
  - **Bottom: `CallTimeline`:** a waveform for both channels from precomputed peaks, the playhead, turn blocks, fact markers (diamonds colored by status), the takeover marker, and the AI-half segment.
- **Mobile (<768 px):** tabs "Call | Case | Phone", a sticky bottom bar with Pass the baton, and the HUD collapsed into the top bar.
- **Page states (store `ui.phase`):**

| State | UI |
|---|---|
| `preflight` | Pre-flight card with Start / Express |
| `queued` | Only while the ETA is ≤15 s: "Live transcription is limited to 5 new sessions per minute on our plan. You're #2, starting in ~10 s", a countdown, and the button "Watch the cached replay now". A longer ETA skips this state and starts the labelled cached replay |
| `connecting` | Spinner "Opening 2 live transcription sessions…" with per-channel dots |
| `shadowing` | Normal. The Pass button is enabled once ≥1 final exists |
| `arming` … `connecting-agent` | `ProtocolStepper`; everything else frozen |
| `ai-listening` | Pulsing customer-lane indicator |
| `ai-thinking` | "…" bubble in the AI lane, shown from the end of customer speech (`eos`) until first audible. If the reply turns out to be a tool pre-amble, the bubble reads "checking…" |
| `ai-speaking` | Captions animating; HUD shows the last latency |
| `paying` | Tool rail shows "hold · waiting for payment (Polar sandbox)" with a progress-aware countdown (§5.8); the phone floats and pulses |
| `paused` | iOS only: the tab was backgrounded or the screen locked. "Paused: tap to resume" (§7.6) |
| `completed` | QA card opens as a sheet (S3) |
| `handed-back` | Hand-back card "Daniel has the call back · reason: advice requested"; QA card still computed |
| `fallback` | Amber banner stating what is replayed and why (`FallbackBanner`). The page remains interactive |
| `error` | Red banner, plain-English cause, **Try again** / **Watch replay** buttons. Never a blank page |

#### S3. QA card (`QaCard`)

- **Title:** "Call QA", with a badge that is `Provisional` (from live `transcript.agent`) or `✓ Verified from recording` (from async ch2).
- **Metrics grid:**
  - **Re-asked: 0** (large);
  - newly asked N;
  - pending confirmed M;
  - verified reconfirmed K (shown only if >0);
  - disclosure verbatim ✓/✗ with similarity (e.g. 0.97) and a "View diff" popover;
  - click → first audible;
  - dead air after the rep line;
  - p50 audible turn latency;
  - payment `verified by Polar webhook` / `simulated (mock mode)`;
  - hand-back yes/no;
  - AI minutes.
  - Each count expands to its `details[]` sentences with classification and time (so a judge who heard "Just to confirm, the change should start Saturday…" sees it counted as `pending_confirm`, not a re-ask).
- **Footer:** "Computed deterministically from the AssemblyAI async multichannel transcript of the agent's own recording (channel 2). How →" links to `/about#qa`.
- **States:**
  - `waiting-for-recording`: spinner with an elapsed timer; if >60 s, "Verification delayed; provisional numbers shown".
  - `verified`.
  - `failed`: "Couldn't verify from recording (reason). Provisional numbers shown."

#### S4. Takeover Explorer

Described in §1.3 P3. Components:
- `WaveformScrubber` (2 s snap, keyboard ← →);
- `PointPanel` (greeting in a quote block, `CaseSnapshotTable`, `MetricBadges`);
- `VariantToggles`;
- `EvalLabel`.

**States:**
- `loading`: fetching `public/data/explorer/<callId>/v3.pc_ctx.json` (other versions and variants lazy-load).
- `no-data`: "This call isn't in the eval set".

#### S5. Evals

See §6.6. Components:
- `CurveChart` (x: takeover point as % of human half; y: metric; one series per variant);
- `VariantComparisonTable`;
- `IterationLog` (v1 → v3 config diff, headline metrics, date, git sha);
- `LiveSpotCheckTable`;
- `JudgeRunsTable` (live DB aggregates, labelled `LIVE`);
- `PromoteCard` (§5.14);
- `MethodologyNote`.

#### S6. MockPhone (`MockPhone`, owned by the payments package)

Screens:
1. **Lock-screen SMS notification.**
2. **SMS thread.** Messages:
   - "Harborview: Review & sign your change to policy HP-…: [link]";
   - later: "Payment received. Confirmation END-48213".
3. **E-sign sheet.**
   - Summary of the change: driver, relationship, vehicle, effective date, new monthly premium, due today.
   - Checkbox "I agree to sign electronically. I can request a paper copy."
   - Typed-name field, prefilled with the policyholder's name and editable.
   - **Sign** button.
4. **Pay sheet.** The amount (Polar's own `total_amount` once the checkout exists), then two buttons of equal weight:
   - **Pay with Polar sandbox (test card, about 20 s).** The tap (a user gesture) runs `navigator.clipboard.writeText("4242424242424242")` and shows "Card 4242 4242 4242 4242 · 12/34 · 123: copied" on the sheet, then opens the embedded checkout via `PolarEmbedCheckout.create(url)`. Nothing of ours is drawn under Polar's full-screen iframe (z-index 2147483647), so the card details are shown before it opens.
   - **Skip: simulate payment.** Always available, in every `PAYMENTS_MODE` (route #17, §4.4).
   - A visible link **Open checkout in a new tab** (`<a target="_blank" rel="noopener">`) is shown from `checkout-loading` onwards. It is never opened by a timer (popup blockers).
   - In `PAYMENTS_MODE=mock` only the simulate button is shown.
5. **Done** screen: a ✓ plus "Verified by Polar webhook", or "Simulated".

**Overlay control:** MockPhone owns the embed instance and calls `checkout.close()` itself when the server reports `succeeded`/`failed`/`expired`, when the hold times out, on simulate, and on hand-back, so the judge is never trapped behind a full-screen iframe while the agent talks.

**States:**
- `idle`;
- `sms-received`;
- `esign`;
- `signed`;
- `checkout-loading`;
- `checkout-open`;
- `processing` ("Waiting for Polar to confirm… we only trust the webhook");
- `simulating`;
- `autopilot-countdown` (10 s visible countdown before autopilot simulates);
- `paid`;
- `failed`;
- `expired`;
- `timeout`.

### 1.5 Demo narrative beats → what must exist

| Video time | Beat | Screen / feature that must support it | Fallback if it breaks during recording |
|---|---|---|---|
| 0:00–0:10 | Cold open. The AI greeting plays: "Hi Priya, this is Harborview Insurance Agency's AI assistant…". The case card shows evidence chips and **Re-asked: 0** | S2 AI half plus S3 (record a real run) | Record again. The recorded-session replay (§7.5) can re-render the same run for B-roll |
| 0:10–0:30 | The problem, the buyer, before/after. Both APIs named on screen | `/about` diagram | Slides |
| 0:30–2:10 | Live demo on the deployed URL:<br>• chips fill with clickable clips;<br>• pass the baton at an arbitrary second (the stepper shows the ms);<br>• AI opening, disclosure verbatim, pay link on the mock phone, Polar sandbox payment;<br>• confirmation, QA card, the Verified-from-recording badge, the HUD | S2, S3, S6 | Every step has a labelled fallback. **Record with the mode badge visible** |
| 2:10–2:45 | Evidence:<br>• sweep curves;<br>• mid-utterance curve;<br>• stereo vs mono;<br>• ±`agent_context`;<br>• v1 → v3;<br>• Takeover Explorer drag | S5, S4 | Static PNG export of the charts |
| 2:45–3:35 | Business:<br>• ROI slider (on `/about#roi`: the break-even formula `seat_price / (freed_min_per_day × working_days × loaded_cost_per_min)`);<br>• autonomy ladder;<br>• **Promote** live click (a real `POST /v1/agents`) with its evidence card;<br>• competition line: "not found in the pool or our market scan" | S5 `PromoteCard`, `/about#roi` | One agent is promoted **before** recording (T-D1-11), so an upsert returns the existing agent ("already promoted") and still shows the evidence card |
| 3:35–4:15 | Architecture:<br>• one pipeline;<br>• why both APIs;<br>• spike-verified numbers;<br>• roadmap (CCaaS connectors, a live phone-leg bridge as a Zerops sibling service, DTMF) | `/about` | Slides |
| 4:15–4:30 | Tagline and URL | — | — |


---

## 2. System architecture

### 2.1 Diagram

```
 JUDGE BROWSER (Next.js client; one AudioContext; AudioWorklets drive every realtime clock)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ CallPlayer worklet ──ticks──► SttChannelManager ──binary frames (8k µ-law 100ms | 16k PCM 50ms)──┐ │
 │   ▲ call assets (public/calls/*)                    │ rep final → UpdateConfiguration{agent_context}│
 │   │                                                 ▼   on the CUSTOMER session                   │
 │ CaseSync (ordered turn queue) ◄── finals ── [STT rep session] [STT customer session] ◄────────────┘ │
 │   │ POST /api/extract (caseJWT)                                ║ wss://streaming.assemblyai.com/v3/ws│
 │   ▼                                                            ║   ?speech_model=universal-3-5-pro&token=…
 │ TakeoverController (state machine §5.5) ──► VoiceAgentController ══ wss://agents.assemblyai.com/v1/ws?token=…
 │   │ POST /api/takeovers, /compile, /events, /end               ║  (PCM16 24k base64 JSON, both ways)
 │   │                                  function tools ──► POST /api/tools/:name (caseJWT) ──┐        │
 │ VaOutputPlayer worklet (jitter 120 ms, flush on barge-in)   MockPhone ─► Polar embed iframe│        │
 │ Customer input: Autopilot/chips (cached TTS PCM) | typed→/api/tts | mic worklet → 24k PCM │        │
 └──────────────┬──────────────────────────────────────────────────────────────────────────┼────────┘
                │ HTTPS (India↔Prague ~150 ms RTT; only control traffic, never audio)        │
 ZEROPS PROJECT "baton" (Prague)                                                              │
 ┌──────────────▼──────────────────────────────────────────────────────────────────────────▼────────┐
 │ service `app` nodejs@22 · Next.js standalone server · port 3000 httpSupport · *.zerops.app HTTPS │
 │  min/max containers 1 (always on)                                                               │
 │  Route handlers:                                                                                │
 │   /api/runs      ── run plan at Start: aiHalf live|recorded; holds VA budget + a VA slot (D14)
 │   /api/stt/token ── StreamSlotBroker (4 opens / rolling 60 s, FIFO queue) + SpendLedger ──► AAI /v3/token
 │   /api/va/token  ── RateLimiter + SpendLedger + VA slot registry (3, heartbeats) ────────► AAI /v1/token
 │   /api/internal/limits/* ── THE account-wide limits authority for every other opener (dev, scripts, mirror)
 │   /api/cases, /api/extract ── Extractor (gpt-6-luna) → deterministic status rules → Postgres
 │        └─ after(): Verifier (gpt-6-sol, every ≥15 s, can only downgrade)
 │   /api/takeovers/* ── compile greeting + prompt + stage tools from DB case state
 │   /api/tools/:name ── ToolService (dates, disclosures, mock rating, case updates, hand-back)
 │   /api/payments/*, /api/webhooks/polar ── PaymentProvider(polar sandbox | mock) ◄── Polar webhooks
 │   /api/verifications/*, /api/webhooks/assemblyai ── JobRunner: GET /v1/sessions/{id} → POST /v2/transcript
 │   /api/promote ── POST/DELETE https://agents.assemblyai.com/v1/agents (HTTP tools → /api/agent-tools/*)
 │   /api/tts ── OpenAI gpt-4o-mini-tts (typed fallback)      /api/health, /api/status, /api/internal/cron
 │  instrumentation.ts: in-process job ticker (ENABLE_INPROC_WORKER=1; jobs are also poll-advanced)
 │  crontab: synthetic light hourly · full every 6 h · purge daily (all via /api/internal/cron)
 ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ service `db` postgresql:single@17 — DATABASE_URL=${db_connectionString}                          │
 │  cases, turns, fact_events, takeovers, tool_calls, payments, jobs, verifications, spend_ledger,  │
 │  rate_events, stream_queue, live_sessions, webhook_events, app_flags, promoted_agents, health_checks
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
 External: AssemblyAI (US endpoints; VA recordings stored in S3 eu-west-1) · OpenAI (luna/sol/TTS) ·
           Polar sandbox (sandbox-api.polar.sh; embed from sandbox.polar.sh) · Twilio (OFFLINE only: recording kit)
 Offline (developer machine): scripts/eval/*, scripts/day1/*, integration tests and local dev use the same
           src/core + src/server code and acquire STT/VA slots and ledger reservations from the Zerops app over HTTPS
           (LIMITS_AUTHORITY_URL + LIMITS_AUTHORITY_KEY), so nothing anywhere can exceed the account-wide free-tier limits.
```

### 2.2 Why both AssemblyAI APIs, as one data path

1. **Streaming STT** (the human half) produces attributed finals with word times. luna turns them into fact events, and the status rules turn those into `CaseState`.
2. `CaseState` feeds the Voice Agent directly:
   - VERIFIED facts become the **greeting** (spoken verbatim);
   - the full state becomes the **system prompt** CASE STATE block;
   - entity values become **`input.keyterms`**;
   - PENDING/MISSING fields become the first question.
3. The **Voice Agent** (the AI half) produces a stereo recording. That recording goes to **async** `/v2/transcript` (multichannel), and ch2 gives the deterministic QA numbers.
4. Take out Streaming and the agent opens blind (re-asks everything). Take out the Voice Agent and nobody finishes the call.

### 2.3 Free-tier constraints and how the architecture respects them

**The limits are account-wide.** 5 opens/min, VA concurrency and the credit balance belong to the AssemblyAI *account*, not to a deployment or a database. So there is **one limits authority**: the Zerops `app` service and its `db`.
- Inside the Zerops app, `LimitsAuthority` is the DB implementation (`src/server/limits/db-authority.ts`).
- Every other process that opens an AssemblyAI session or spends credit uses the HTTP implementation (`src/server/limits/remote-authority.ts`) against `POST {LIMITS_AUTHORITY_URL}/api/internal/limits/*` with `x-limits-key: LIMITS_AUTHORITY_KEY`. That covers local `next dev`, `scripts/eval/*`, `scripts/day1/*`, `tests/integration/*`, synthetic checks and the Vercel mirror.
- Everything goes through **one helper per resource**: `acquireStreamSlots()`, `acquireVaSlot()`, `ledger.reserve()`. `tests/unit/boundaries.test.ts` fails if `StreamingSession.connect`, `connectNode` or `mintStreamingToken` / `VoiceAgentRest.mintToken` is called anywhere else.
- **Before the Zerops app is up** (D1 morning), `scripts/lib/local-open-guard.ts` (a file lock in the repo, shared by every agent on the user's laptop) is the authority. Nothing else may open sessions then.
- **If the authority is unreachable,** a remote opener falls back to a split budget: 2 opens/min and 1 VA session, locally guarded, and logs a warning.

| Constraint (verified or documented) | Mechanism |
|---|---|
| **5 new streaming sessions/min** (free, account-wide), each replay opens 2 | `StreamSlotBroker` (in the authority):<br>• Postgres table of opens, limit `STT_OPENS_PER_MIN=4` (1 spare for health checks and the reconnect path).<br>• Atomic reserve of `n` slots under `pg_advisory_xact_lock`.<br>• FIFO `stream_queue` with tickets. The client polls every 2 s. A ticket not polled for 3 intervals expires. At most 2 open tickets per `ipKey`.<br>• If the ETA exceeds `STT_QUEUE_MAX_WAIT_S=15`, the labelled cached replay **starts at once** (no waiting screen). A hot upgrade to live STT when a slot frees is a D4 polish item (§5.1.10).<br>• The ETA counts pending reconnect opens |
| Tokens reusable within their window; Voice Agent `max_session_duration_seconds` not enforced [10 §0.2] | Short windows:<br>• STT token `expires_in_seconds=10` (connect happens right after the grant);<br>• VA token `expires_in_seconds=10`, minted only for a takeover in `armed`/`ai_active` state with a retry budget (§4.4 #10).<br>Per-visitor **and** per-ipKey limits on both mints. A global **VA slot registry of 3** with 10 s heartbeats (a slot goes stale after 30 s without one). A dynamic client cap (§5.9.5) with `session.end`. A **VA audit every 3 min** during judging (F6, marker-based), which flips to `replay_only` on any anomaly. Residual risk (a scripted client reusing one 10 s token for several sessions until the next audit) is documented in the runbook and bounded by keeping the ledger budget well under the real balance |
| ≈$49 credit, no card; LLM Gateway locked | `SpendLedger` (in the authority):<br>• reserve before mint, settle on report;<br>• dev and eval spend is recorded but only spend since `LEDGER_EPOCH` (the judging-window start) counts against `AAI_JUDGING_BUDGET_USD`;<br>• a **dynamic daily cap** = remaining judging budget ÷ remaining judging days, clamped by `AAI_DAILY_CAP_MAX_USD`;<br>• an operator-entered **real balance** guard (`aai_balance_usd` flag) and mapping of any "balance/credit" mint error to `replay_only`;<br>• exceeding any of these sets `mode=replay_only` (§7.2).<br>Gateway is not used |
| Async concurrent jobs: 5 (free) [00 §1.1] | JobRunner caps in-flight `/v2/transcript` jobs at 3 |
| Streaming billed open → `Termination`; VA billed until `session.end` (+30 s on bare close) | Always `Terminate` / `session.end`, on `pagehide` too. `inactivity_timeout=30` on STT. Registry settles the worst case (`inactivity_timeout` + terminate for STT; the dynamic cap for VA) if no report arrives |
| Unknown free-tier VA concurrency (`at_capacity`, `concurrency_exceeded` exist) | The run plan holds a VA slot from Start (D14). 1 retry with a fresh takeover-keyed token, then a labelled recorded AI session. K4 measures 3 concurrent VA sessions on D4 |

### 2.4 Component responsibilities

**Browser, `src/client`:**
- `AudioEngine`: one `AudioContext` at the device rate. It owns the call-player worklet, the VA output worklet, the mic capture worklet and the paced feeder.
- `SttChannelManager`: two `StreamingSession`s, `agent_context` carryover, silence feeding, ForceEndpoint gating, terminate/report.
- `CaseSync`: ordered turn queue → `/api/extract`, drain with timeout, mirror of `CaseState`.
- `TakeoverController`: the protocol state machine (§5.5); orchestrates the other components.
- `VoiceAgentController`: `VoiceAgentSession`, `ToolDispatcher`, `ReplyTracker`, stage updates, captions, barge-in, HUD marks.
- `CustomerInput`: autopilot, chips, typed TTS, mic. All customer audio for the agent goes through one paced 24 kHz feeder.
- `store` (zustand): an event-sourced UI state from `BatonEvent`s; an optional recorder for replay bundles.

**Server, `src/server`:**
- `env`, `db`, `auth` (visitor cookie, case JWT, admin, cron);
- `limits` (RateLimiter, StreamSlotBroker, SpendLedger, flags);
- `aai` (token mint, async client, VA REST);
- `openai` (client, extractor, verifier, TTS);
- `cases` (repository and apply pipeline);
- `takeovers` (arm, compile, events, end);
- `tools` (ToolService);
- `rating` (mock rating engine);
- `payments` (+ `polar`);
- `jobs` (runner + verify-takeover);
- `promote`;
- `health`.

**Pure, `src/core`:**
- contracts (zod + types);
- the `add_driver` intent registry;
- normalizers and status rules;
- greeting/prompt/stage compilers;
- the takeover state machine;
- the sweep simulator;
- QA (re-ask, verbatim);
- evidence clip math;
- spoken formats;
- audio codecs;
- promoted AssemblyAI clients (browser-safe).

---

## 3. Repository layout, promoted spike code, libraries, env

### 3.1 Layout (single Next.js app at the repo root)

```
/                              ← Next.js app root (package.json, next.config.mjs, tsconfig.json)
  src/
    app/                       ← App Router pages + route handlers (thin: parse → call service → respond)
      page.tsx                 (S1)            about/page.tsx      status/page.tsx
      call/[callId]/page.tsx   (S2/S3/S6)      live/page.tsx       [STRETCH P2]
      explorer/[callId]/page.tsx (S4)          evals/page.tsx      (S5)
      api/…                    (see §4.2 route table; one folder per route)
    core/                      ← PURE: no `node:*`, no DOM, no fetch side effects; runs in browser, server, scripts, vitest
      contracts/               api.ts case.ts turns.ts events.ts tools.ts takeover.ts extract.ts scenario.ts eval.ts errors.ts
                               services.ts (service interfaces; docs/TASKS.md §2)   ext/ (additive, per WP)
      intents/                 add-driver.fields.ts (WP0: ids, types, required sets)  add-driver.ts (WP1: normalizers, lexicon, phrases)
      case/                    status-rules.ts derive.ts apply.ts compat.ts
      compiler/                greeting.ts prompt.ts stages.ts tool-schemas.ts spoken.ts disclosures.ts suggest.ts
      scenario/                normalize.ts (kit Scenario + Sidecar overrides → Scenario, PolicyRecord)   (WP9)
      protocol/                takeover-machine.ts (WP5)  simulate.ts (WP9)
      qa/                      reask.ts verbatim.ts text-normalize.ts compute.ts
      evidence/                clip.ts
      eval/                    metrics.ts score.ts (WER/entity scoring ported from spikes/streaming/harness.ts)
      audio/                   pcm.ts mulaw.ts resample.ts wav-decode.ts   (from spikes/lib/audio.ts, wav.ts)
      aai/                     streaming.ts (from spikes/streaming/client.ts) voice-agent.ts (from spikes/voice-agent/client.ts, minus Node connect)
                               stt-params.ts (buildSttParams, keytermsFromPolicy, STT_PROMPT, TUNING_8K; WP4)
    server/                    ← `import "server-only"` at the top of every module
      env.ts  log.ts  db/{schema.ts,client.ts}  auth/  limits/  flags.ts
      aai/{tokens.ts,async.ts,va-rest.ts,va-node.ts}  openai/{client.ts,extractor.ts,verifier.ts,tts.ts}
      cases/  takeovers/  tools/  rating/  payments/  polar/  jobs/  registry/  runs/  qa/  promote/  health/  data/
    client/                    ← `import "client-only"`
      audio/{engine.ts,worklets/*.ts,call-player.ts,va-output.ts,mic-capture.ts,paced-feeder.ts}
      stt/  case/  platform/ (iOS audio session, visibility)  takeover/  va/  tools/  customer/  replay/  store/  hud/  session/ (page orchestrator)  fixtures/  live/ (P2, cut)
    components/                ui/ (shadcn) call/ case/ qa/ hud/ phone/ explorer/ evals/ promote/ common/ layout/
    generated/                 scenarios.json calls.json (built by scripts/calls/build-assets.ts; imported, never fs-read)
    instrumentation.ts         (in-process job ticker when ENABLE_INPROC_WORKER=1)
    proxy.ts                   (Next 16 name for middleware: visitor cookie + security headers; rename to middleware.ts if the installed Next still expects it)
  scripts/                     ← Node CLIs (tsx); may import src/core + src/server
    calls/ eval/ tts/ polar/ day1/ lib/ migrate.ts cron.ts assemble-bundle.mjs gen-secrets.ts loadtest.ts
  drizzle/                     ← generated SQL migrations (drizzle-kit generate)
  data/
    scenarios/                 ← OWNED BY THE RECORDING-KIT AGENT (read-only for us): kit Scenario JSON
    calls/                     ← OWNED BY THE RECORDING KIT (read-only; git-ignored audio): raw/<base>.{wav,json sidecar},
                                 split/<base>_{rep,customer}.wav (PCM16 8 kHz), manifest.json (`kit report`)
    golden/                    ← optional 16 kHz two-recorder calls: <callId>/{rep,customer}.wav + sidecar-like meta.json (WP9)
    labels/<callId>.json       ground-truth mentions + handoff line times (WP9; reviewed)
    cache/stt/<callId>/<variant>.jsonl   cache/extract/<callId>/<pipelineVersion>.<variant>.json   cache/verify/…
    evals/                     iterations.json, spotchecks.json (committed)
  public/
    calls/<callId>/{rep.ulaw|rep.pcm16, customer.*, peaks.json}  (only calls with sidecar.consent.publishable)
    data/cached-turns/<callId>.json   (published calls; for cached replay)
    tts/<sha16>.pcm            (cached 24 kHz chip/autopilot clips)   replays/<bundleId>/{events.json,audio.wav}
    data/explorer/<callId>/<version>.<variant>.json   data/evals/summary.json   data/evals/iterations.json   data/evals/spotchecks.json
  tests/ unit/** integration/** e2e/**      tools/recording-kit/ (other agent)   spikes/ (frozen)   research/  docs/
  docs/pitch/                  numbers.md video-script.md shot-list.md slides.md (→ slides.pdf) descriptions.md cover.html (WP13)
  .github/workflows/monitor.yml   hourly external check of /api/status (§7.7)
  zerops.yml  zerops-project-import.yml  vercel.json  drizzle.config.ts  vitest.config.ts  playwright.config.ts
  .env.example  .deployignore  components.json (shadcn)  README.md  LICENSE (MIT)
```

**Public-repo hygiene.** The GitHub repo is public (a lablab requirement). `research/` is git-ignored except the live-verified API results (`research/10*.md`), because `00`, `07` and `11` profile named judges and contain win estimates. `data/calls/` audio stays git-ignored (§8.5). `.env` is never committed.

**Boundary enforcement:**
- `server-only` and `client-only` package imports.
- `tests/unit/boundaries.test.ts` greps `src/core/**` for `node:`, `fs`, `window`, `document` and `process.env`, and fails if it finds any. It also fails if `StreamingSession.connect`, `connectNode(`, `mintStreamingToken(` or `.mintToken(` appears outside the allow-listed limits helpers (`src/server/limits/**`, `src/server/aai/tokens.ts`, `src/client/stt/**`, `src/client/va/**`, `scripts/lib/aai-open.ts`).
- `tsconfig.json` `exclude: ["spikes", "tools", "research"]`.

### 3.2 Promotion of spike modules (with the 10 §5.3 fixes)

| Spike module | Destination | Changes |
|---|---|---|
| `spikes/voice-agent/client.ts` | `src/core/aai/voice-agent.ts` (browser-safe) + `src/server/aai/va-node.ts` | **Fix 5.3-1:** move `connectNode`/`connectWithToken` and the top-level `ws` import to `va-node.ts`. Keep everything else verbatim: types, `VoiceAgentRest` (server use), `VoiceAgentSession`, `ToolDispatcher`, `ReplyTracker`, `RealtimeAudioFeeder`, `errorCode`, `RETRYABLE_ERROR_CODES`, `chunkLevelDb`, base64 helpers. `VoiceAgentRest` is only imported by server code |
| `spikes/voice-agent/core-loop-config.ts` | Reference only | Its anti-fabrication rule wording seeds `compiler/prompt.ts` |
| `spikes/streaming/client.ts` | `src/core/aai/streaming.ts` | The lazy `ws` import must not be bundled for the browser. Wrap it as `await import(/* webpackIgnore: true */ "ws")` inside `defaultWebSocketFactory`, and only when `headers` are passed. Keep `StreamingSession`, `FrameBatcher`, `TurnTracker`, `sanitizeParams`, `buildStreamingUrl`, `LIMITS`, `GOLDEN_PARAMS`, `PRESETS`, `CLOSE_CODES`, `isRetryableClose`, `mintStreamingToken` (server use) |
| `spikes/streaming/browser-capture.ts` | `src/client/audio/mic-capture.ts` | Verbatim. Add `targetRate: 24000` usage for the Voice Agent feed. **First real-browser test on D1** |
| `spikes/async/client.ts` | `src/server/aai/async.ts` | **Fix 5.3-3:** it now lives inside the root `tsconfig`. Keep `AssemblyAIAsyncClient`, `verifyWebhookHeader`, `parseWebhook`, `billableSeconds`, `PII_POLICIES` |
| `spikes/openai/client.ts` | `src/server/openai/client.ts` | **Fix 5.3-2:**<br>• remove `"minimal"` from `ReasoningEffort`;<br>• fix the `MODELS.fast` comment (luna is **not** a BYO Voice Agent LLM; BYO = `gpt-4.1-mini`, unused);<br>• replace the `JsonlLogger` parameter with an optional `onTrace(event)` hook.<br>Keep `extractStructured`, `RefusalError`, `IncompleteError`, `usageOf`, `openSpeechPcmStream`, `StreamingDecimator` |
| `spikes/lib/audio.ts` | `src/core/audio/*.ts` | Make it isomorphic: `pcm16ToBytes` returns `Uint8Array`, not `Buffer`; base64 goes through `btoa`/`atob` when `Buffer` is absent. Keep `resampleLinear` (anti-aliased), `mulawEncode/Decode`, `silence*`, `chunk*`, `rmsDbfs`, `trimSilence`. **Node-only** `pace`/`paceAudio` go to `scripts/lib/pace.ts` |
| `spikes/lib/wav.ts` | `src/core/audio/wav-decode.ts` (`decodeWav`) + `scripts/lib/wav-fs.ts` (`readWav`/`writeWav`) | — |
| `spikes/lib/log.ts` | `src/server/log.ts` | Keep `redact()`, `registerSecrets()` and the base64/token masking. Replace the JSONL file writer with structured `console` JSON lines (Zerops log collection) |
| `spikes/lib/env.ts` | **not promoted** (**fix 5.3-5**) | New `src/server/env.ts` (zod-validated `process.env`, lazy, never prints values) |
| `spikes/lib/tts.ts` | `scripts/tts/tts-cache.ts` | Disk cache for chip clips → `public/tts/` |
| `spikes/streaming/harness.ts` (scoring fns) | `src/core/eval/score.ts` | Port `normalizedWer`, entity hit scoring |
| `spikes/gateway/*` | not promoted | LLM Gateway unused (qwen only at 2 rpm) |

### 3.3 Libraries (exact versions, verified on the npm registry 2026-09-24)

**Runtime dependencies:**

| Package | Version | Notes |
|---|---|---|
| `next` | 16.3.6 | `output: "standalone"`, App Router, `after()` from `next/server` |
| `react`, `react-dom` | 19.3.0 | |
| `zod` | 4.6.5 | Every API contract; `z.toJSONSchema` is **not** used for tool schemas, which are hand-written (§5.8) |
| `drizzle-orm` | 0.45.3 | node-postgres driver. Stay off the 1.0 beta/RC |
| `pg` | 8.23.0 | Pool `max: 15`, `connectionTimeoutMillis: 3000`, `idleTimeoutMillis: 30000`; every connection sets `statement_timeout = 5000` |
| `openai` | 7.23.0 | Responses API + audio speech |
| `@polar-sh/sdk` | 0.49.0 | Stable class API: `new Polar({ accessToken, server: "sandbox" })` |
| `@polar-sh/checkout` | 0.4.1 | `PolarEmbedCheckout` (client) |
| `standardwebhooks` | 1.1.1 | Dual-scheme Polar verification (§5.12) |
| `jose` | 6.2.12 | HS256 case tokens |
| `zustand` | 5.0.15 | UI store |
| `recharts` | 3.10.1 | Eval curves |
| `lucide-react` | 1.47.0 | |
| `radix-ui` | 1.6.7 | Via shadcn |
| `class-variance-authority` | 0.7.1 | |
| `tailwind-merge` | 3.7.0 | |
| `sonner` | 2.0.8 | Toasts |
| `server-only`, `client-only` | 0.0.1 | |
| `nanoid` | 6.0.1 | |

**Dev dependencies:**

| Package | Version | Notes |
|---|---|---|
| `typescript` | **6.0.3** | D10 |
| `@types/node` | 22.20.4 | |
| `@types/react`, `@types/react-dom` | 19.3.0 | |
| `@types/pg` | 8.23.1 | |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.3 | |
| `tw-animate-css` | 1.4.0 | |
| `shadcn` | 4.21.0 | CLI only |
| `drizzle-kit` | 0.31.11 | |
| `vitest` | 5.0.1 | |
| `@playwright/test` | 1.63.0 | |
| `tsx` | 4.23.15 | |
| `esbuild` | 0.28.2 | Bundles `scripts/migrate.ts` and `scripts/cron.ts` for production |
| `ws` | 8.21.3 | Node scripts only |
| `@types/ws` | 8.18.1 | |

**Not used, and why:**

| Package | Reason |
|---|---|
| `@openai/agents` | D8 |
| `@polar-sh/nextjs` | D9 |
| `assemblyai` SDK | The spikes' own clients are verified |
| LLM Gateway | Locked |
| Prisma | Drizzle is lighter, and SQL migrations are portable |

**`package.json` scripts:**

```jsonc
"dev": "next dev",
"build": "next build && npm run bundle:scripts && node scripts/assemble-bundle.mjs",
"build:vercel": "next build",
"bundle:scripts": "esbuild scripts/migrate.ts scripts/cron.ts --bundle --platform=node --format=esm --target=node22 --outdir=dist --out-extension:.js=.mjs --packages=bundle",
"start": "node bundle/server.js",
"typecheck": "tsc --noEmit",
"test": "vitest run tests/unit",
"test:int": "RUN_LIVE=1 vitest run tests/integration",   // costs money; see §9
"e2e": "playwright test",
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx scripts/migrate.ts",
"eval:cache-stt": "tsx scripts/eval/cache-stt.ts", "eval:extract": "tsx scripts/eval/extract.ts",
"eval:sweep": "tsx scripts/eval/sweep.ts", "eval:spot": "tsx scripts/eval/live-spotcheck.ts",
"calls:build": "tsx scripts/calls/build-assets.ts", "tts:chips": "tsx scripts/tts/generate-chips.ts"
```

**`next.config.mjs`:**

```js
export default {
  output: "standalone",
  typescript: { ignoreBuildErrors: true },           // D10: `npm run typecheck` is the gate
  serverExternalPackages: ["pg", "ws"],
  poweredByHeader: false,
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; } // §8.4
};
```

### 3.4 Environment variables

The table below is the complete list. `S` means secret (Zerops secret env var; never `NEXT_PUBLIC_`).

| Name | S | Example / default | Used by |
|---|---|---|---|
| `DATABASE_URL` | – | Zerops: `${db_connectionString}` | server, scripts |
| `APP_URL` | – | `https://app-xxxx.prg1.zerops.app` | Polar success/embed origin, AAI webhook URLs, promote tool URLs |
| `ASSEMBLYAI_API_KEY` | S | — | token mint, async, VA REST, promote |
| `OPENAI_API_KEY` | S | — | extractor, verifier, TTS |
| `POLAR_SERVER` | – | `sandbox` | payments |
| `POLAR_ACCESS_TOKEN` | S | sandbox OAT (`checkouts:read/write`, `products:read/write`) | payments |
| `POLAR_PRODUCT_ID` | – | uuid of the one-time product that carries the ad-hoc per-checkout price (§5.12) | payments |
| `POLAR_WEBHOOK_SECRET` | S | `whsec_…` | webhook verify |
| `POLAR_DEMO_CUSTOMER_EMAIL` | – | an org-member alias, e.g. `baton.demo+judge@…` | fallback prefill only (never the judge's data) |
| `POLAR_DEMO_CUSTOMERS` | – | JSON `{"s01":"<customer uuid>",…}`, created by `scripts/polar/setup.ts` (fictional name, the alias email, the scenario's US address) | `customerId` on create: prefills and locks name and email |
| `EMBED_ORIGINS` | – | comma list: the Zerops subdomain, an optional custom domain, the Vercel mirror | `embedOrigin` allowlist (§5.12) |
| `PAYMENTS_MODE` | – | `polar` \| `mock` | payments (Simulate is available in both) |
| `CASE_TOKEN_SECRET` | S | 32+ random bytes, base64 | case JWT |
| `VISITOR_SECRET` | S | 32+ random bytes | visitor cookie HMAC, IP hashing |
| `ADMIN_KEY` | S | random | `/api/admin/*` |
| `CRON_SECRET` | S | random | `/api/internal/cron` |
| `AAI_WEBHOOK_SECRET` | S | random | async transcript webhook header |
| `AGENT_TOOL_SECRET` | S | random | promoted-agent HTTP tools header |
| `LIMITS_ROLE` | – | `authority` on Zerops; `remote` everywhere else (local dev, scripts, tests, Vercel) | limits (§2.3) |
| `LIMITS_AUTHORITY_URL` | – | the Zerops `APP_URL` (unset only before the first deploy; then the local file guard applies) | remote limits |
| `LIMITS_AUTHORITY_KEY` | S | random; the same value on the authority and every remote | `/api/internal/limits/*` |
| `BATON_DEPLOY_ID` | – | `zp-prod`, `vercel-mirror`, `dev-<name>` | deploy marker in the compiled VA prompt (F6) and ledger `env` |
| `LEDGER_EPOCH` | – | ISO timestamp set at the D6 deploy freeze, e.g. `2026-09-30T02:30:00Z` | ledger: spend since the epoch counts against the judging budget |
| `AAI_JUDGING_BUDGET_USD` | – | `28.00` (dashboard balance at the epoch − `AAI_RESERVE_USD`) | ledger |
| `AAI_RESERVE_USD` | – | `5.00` | ledger, balance guard |
| `AAI_DAILY_CAP_MAX_USD` | – | `3.00` | ledger (upper clamp of the dynamic daily cap) |
| `JUDGING_END_DATE` | – | `2026-10-21` | ledger (divides the remaining budget) |
| `OPENAI_DAILY_CAP_USD` | – | `3.00` | ledger |
| `STT_OPENS_PER_MIN` | – | `4` (authority); remotes never read it | broker |
| `STT_QUEUE_MAX_WAIT_S` | – | `15` | broker |
| `VA_MAX_CONCURRENT` | – | `3` | registry |
| `VA_SESSION_CAP_BASE_MS` / `VA_SESSION_CAP_PER_FIELD_MS` / `VA_SESSION_CAP_MAX_MS` | – | `150000` / `15000` / `420000` | dynamic cap (§5.9.5), ledger reservation |
| `VA_KEYTERMS` | – | `0` until T-D1-0 passes, then `1` | first `session.update` (§5.9.1) |
| `VA_VOICE` | – | `alba` (one of the 18 verified ids) | compiler |
| `PAY_TOOL_MODE` | – | `hold` \| `push` | §5.8 fallback |
| `FEATURE_BE_CUSTOMER` | – | `0` (P2 is cut) | P2 gate |
| `ENABLE_INPROC_WORKER` | – | `1` on Zerops, `0` on Vercel | instrumentation |
| `PORT`, `HOSTNAME`, `NODE_ENV` | – | `3000`, `0.0.0.0`, `production` | Zerops runtime |
| `TWILIO_*` | S | (recording kit only; **not deployed**) | tools/recording-kit |

`src/server/env.ts` parses these with zod on first use and throws a named error listing the **missing names only**. There is **no** `NEXT_PUBLIC_*` variable: the default call comes from `calls.json` (`featured`), and flags come from `/api/status` at runtime.


---

## 4. Contracts, data model, API routes, async flows

### 4.1 Core contracts (`src/core/contracts/*`, written by WP0; everyone imports them)

The interface names below are the ones `docs/TASKS.md` refers to. Zod schemas carry the same name with a `Schema` suffix (`TurnInputSchema` → `type TurnInput = z.infer<…>`).

```ts
// ── contracts/case.ts ───────────────────────────────────────────────────────────────────────────
export type Channel = "rep" | "customer";
export type Party = Channel | "ai" | "policy" | "verifier";
export type FieldStatus = "VERIFIED" | "PENDING" | "MISSING";
// FieldId === the recording kit's FactField (tools/recording-kit/src/scenarios.ts FACT_FIELDS), copied into
// intents/add-driver.fields.ts; tests/unit/core/fields-parity.test.ts imports the kit module and asserts equality
// of FACT_FIELDS, REQUIRED_FIELDS, RELATIONS, LICENSE_STATUSES, OPERATOR_TYPES, DISCOUNT_VALUES, STATUSES.
export type FieldId =
  | "driver_full_name" | "driver_dob" | "driver_age" | "driver_relation"
  | "license_state" | "license_status" | "license_number" | "incidents_3y"
  | "vehicle_assignment" | "operator_type" | "garaging_zip" | "effective_date"
  | "good_student_discount" | "driver_training_discount" | "distant_student_discount" | "mature_driver_discount"
  | "coverage_change" | "underwriting_review"
  | "premium_new_monthly_usd" | "premium_change_monthly_usd" | "amount_due_today_usd";
// REQUIRED (kit REQUIRED_FIELDS, 10): driver_full_name, driver_dob, driver_relation, license_state, license_status,
//   vehicle_assignment, operator_type, garaging_zip, effective_date, premium_new_monthly_usd
// SERVER_RESOLVABLE: premium_new_monthly_usd (if not VERIFIED from the rep, get_disclosure supplies it from the rating tool)
// REP_ONLY (only a REP statement can make these VERIFIED): premium_new_monthly_usd, premium_change_monthly_usd,
//   amount_due_today_usd, underwriting_review
// AI_SETTABLE (update_case_field enum): driver_full_name, driver_dob, driver_relation, license_state, license_status,
//   license_number, incidents_3y, vehicle_assignment, operator_type, garaging_zip
// ADVICE_DOMAIN (the AI never raises or changes these; rep only): coverage_change, *_discount, underwriting_review
export type StatusReason =
  | "acknowledged" | "read_back" | "both_stated" | "policy_record" | "ai_confirmed"   // → VERIFIED
  | "stated_once" | "late_turn" | "conflict" | "denied" | "verifier_disagrees"
  | "verifier_only" | "rep_only_violation"                                            // → PENDING
  | "absent";                                                                          // → MISSING
export interface Evidence {
  channel: Channel | "ai" | "customer_ai";   // customer_ai = customer speech in the AI half (VA ch1)
  turnId: string; startMs: number; endMs: number;   // call clock (human half) or VA session clock (AI half)
  quote: string; source: "stt_live" | "stt_cache" | "va_transcript" | "async_ch2" | "async_ch1";
}
export type FactKind = "stated" | "readback" | "ack" | "corrected" | "denied" | "question" | "tool_update" | "policy";
export interface FactEvent {
  id: string; caseId: string; field: FieldId; kind: FactKind; party: Party;
  valueRaw: string | null; valueNorm: string | null;       // valueNorm from normalizeField(); null if unparseable
  acknowledgesTurnId: string | null; confidence: "high" | "medium" | "low";
  turnId: string | null; turnEndMs: number; late: boolean; cut: boolean;  // late/cut per §5.4
  evidence: Evidence | null; extractor: "luna" | "sol" | "tool" | "policy"; seq: number;
}
export interface FieldState {
  field: FieldId; status: FieldStatus; reason: StatusReason;
  value: string | null; display: string | null; source: Party | null;
  evidence: Evidence[];                                   // newest first, ≤3
  conflict: { values: string[]; evidence: Evidence[] } | null;
  flags: ("late_turn" | "cut_turn" | "verifier_disagrees" | "customer_corrected_verified")[];
  updatedAtMs: number;
}
export interface Readiness { verified: number; pending: number; missing: number; requiredTotal: number; ready: boolean }
export interface ConflictCard { field: FieldId; values: { value: string; party: Party; evidence: Evidence | null }[]; resolved: boolean; resolution?: string }
export type Stage = "confirm" | "disclose" | "pay" | "close";
export type PaymentStatus = "none" | "created" | "open" | "confirmed" | "succeeded" | "failed" | "expired" | "timeout";
export interface PolicyVehicle { id: string; year: number; make: string; model: string; label: string } // id "veh1", label "2021 Honda Civic"
export interface PolicyRecord {                  // mapped from kit Scenario.rep/customer (fictional data)
  policyNumber: string; carrier: string; agencyName: string; repFirstName: string;   // "Harborview Insurance Agency", "Daniel"
  policyholder: { firstName: string; lastName: string };
  phoneOnFileLast4: string;                      // not in the kit: derived deterministically from the policy number digits
  address: { street: string; city: string; state: string; zip: string };
  existingDrivers: { name: string; relation: string }[]; vehicles: PolicyVehicle[];
  currentMonthlyPremiumUsd: number; callDate: string;                              // ISO date (kit call_date)
}
export interface CaseState {
  caseId: string; intent: "add_driver"; version: number; callClockMs: number;
  fields: Record<FieldId, FieldState>; readiness: Readiness; conflicts: ConflictCard[];
  stage: Stage | null; disclosuresGiven: ("premium_change" | "esign_consent")[];
  payment: { id: string; status: PaymentStatus; amountCents: number; totalAmountCents: number | null;       // Polar amounts are cents;
             provider: "polar" | "mock"; simulated: boolean } | null;                                       // total = Polar's total_amount
  confirmationNumber: string | null;
}

// ── contracts/turns.ts ──────────────────────────────────────────────────────────────────────────
export interface WordTiming { text: string; startMs: number; endMs: number; confidence: number }
export interface TurnInput {                     // client → /api/extract
  caseId: string; turnId: string;                // `${channel}-${turn_order}` or `${channel}-cut-${n}`
  channel: Channel; text: string; startMs: number; endMs: number; words: WordTiming[];
  source: "stt_live" | "stt_cache" | "typed" | "mic";
  recvMs: number;                                // call clock when the final arrived
  cut: boolean; late: boolean;                   // set by the takeover protocol
}

// ── contracts/scenario.ts ───────────────────────────────────────────────────────────────────────
// Inputs owned by the recording-kit agent (READ-ONLY for Baton code):
//   data/scenarios/sNN.json (kit `Scenario`, schema_version 1), data/calls/raw/<base>.{wav,json} (kit `Sidecar`:
//   channel_map, consent.publishable, review.fact_overrides/status_overrides, audio stats),
//   data/calls/split/<base>_{rep,customer}.wav (PCM16 mono 8 kHz), data/calls/manifest.json (`kit report`).
// callId = the sidecar `base` (one take). Baton-derived files live OUTSIDE data/calls (see §3.1).
export type CallAudioFormat = { encoding: "pcm_mulaw"; sampleRate: 8000 } | { encoding: "pcm_s16le"; sampleRate: 16000 };
export interface CallManifestEntry {             // src/generated/calls.json (built by scripts/calls/build-assets.ts)
  callId: string; scenarioId: string; title: string; source: "golden16k" | "twilio8k";
  language: "en" | "hinglish"; durationMs: number; format: CallAudioFormat;
  publishAudio: boolean;                         // = sidecar.consent.publishable
  inEval: boolean;                               // review.status !== "discard" && labels.reviewed && twilio.recording_channels === 2
  featured: boolean;                             // exactly one entry: the landing default (the kit's chosen s01 take)
  picker: "main" | "more" | "hidden";            // curated call picker (§1.3 P1)
  decisionPointMs: number | null;                // Express start (§5.1.6); from labels
  handoff: { lineStartMs: number; lineEndMs: number; acceptStartMs: number | null; acceptEndMs: number | null;
             declined: boolean } | null;         // from labels
  recordedAiBundle: string | null;               // public/replays/<bundleId>/ for this call, if recorded (§7.5)
  customerTailPack: string | null;               // public/tts/voice/<scenarioId>/manifest.json, if recorded (§11.6)
}
export interface Scenario {                      // normalizeScenario(kitScenario, sidecar?) — overrides applied
  id: string; intent: "add_driver"; title: string; language: "en" | "hinglish"; callDate: string;
  policy: PolicyRecord;
  truth: Partial<Record<FieldId, string>>;       // normalized values (valueNorm format) after sidecar.review.fact_overrides
  expectedAtHandoff: Partial<Record<FieldId, FieldStatus>>;   // status_at_handoff after status_overrides
  plannedHandoffS: number; handoffResponse: "accepts" | "accepts_after_question" | "declines";
  rating: { newMonthlyUsd: number; changeMonthlyUsd: number | null; dueTodayUsd: number };  // from facts; dueToday computed if absent
  traps: string[];
}
export interface CallLabels {                    // data/labels/<callId>.json (auto + human-reviewed; owned by WP9)
  callId: string; reviewed: boolean;
  mentions: { field: FieldId; valueNorm: string; channel: Channel; statedAtMs: number; ackedAtMs: number | null; quote: string }[];
  handoff: { lineStartMs: number; lineEndMs: number; acceptStartMs: number | null; acceptEndMs: number | null } | null;
  diagnosisEndsMs: number | null; tailStartsMs: number | null;
}

// ── contracts/run.ts (the run plan, D14) ─────────────────────────────────────────────────────────
export interface RunPlan {                       // POST /api/runs → decided once, at Start
  runId: string; caseId: string;
  sttHalf: "live" | "cached";                    // "cached" when mode/budget/queue ETA > 15 s says so (it may later upgrade, §5.1.10)
  aiHalf: "live" | "recorded";                   // "recorded" = the call's recordedAiBundle at its own handoff point; manual pass disabled
  vaHoldId: string | null;                       // live_sessions row in status "held" (VA budget + slot); consumed by /api/va/token
  holdExpiresAt: string | null;
  reason: string | null;                         // plain-English, shown on the pre-flight card
  recordedHandoffMs: number | null;              // where the recorded AI session starts (aiHalf = recorded)
}

// ── contracts/events.ts (UI + replay bundles; every event has t = ms since page session start) ────
export type BatonEvent =
  | { t: number; type: "call.loaded"; callId: string; durationMs: number }
  | { t: number; type: "run.plan"; plan: RunPlan }
  | { t: number; type: "paused"; reason: "ios_background" | "audio_interrupted"; resumed: boolean }
  | { t: number; type: "phone.state"; state: string }            // MockPhone state (S6), for replays and the narrator strip
  | { t: number; type: "mode"; mode: "live" | "cached_replay" | "recorded_ai"; reason?: string }
  | { t: number; type: "stt.status"; channel: Channel; status: "queued" | "connecting" | "open" | "reconnecting" | "terminated" | "error"; detail?: string }
  | { t: number; type: "stt.partial"; channel: Channel; turnOrder: number; text: string }
  | { t: number; type: "stt.final"; turn: TurnInput }
  | { t: number; type: "case.state"; state: CaseState }
  | { t: number; type: "case.facts"; events: FactEvent[] }
  | { t: number; type: "verifier"; agrees: boolean; disagreements: FieldId[] }
  | { t: number; type: "takeover.phase"; phase: TakeoverPhase; atMs: number; detail?: Record<string, number | string> }
  | { t: number; type: "va.status"; status: "connecting" | "ready" | "ended" | "error"; sessionId?: string; code?: string }
  | { t: number; type: "va.reply"; replyId: string; phase: "started" | "first_audible" | "done"; kind?: ReplyKind; interrupted?: boolean }
  | { t: number; type: "va.caption"; replyId: string; words: { text: string; atMs: number }[] }
  | { t: number; type: "va.user"; text: string; final: boolean }
  | { t: number; type: "va.tool"; callId: string; name: ToolName; phase: "call" | "result"; args?: unknown; result?: unknown }
  | { t: number; type: "stage"; stage: Stage }
  | { t: number; type: "payment"; status: PaymentStatus; source?: "webhook" | "server_poll" | "mock" }
  | { t: number; type: "phone.sms"; text: string; link?: string }
  | { t: number; type: "qa"; qa: QaResult }
  | { t: number; type: "hud"; metric: HudMetric; ms: number }
  | { t: number; type: "fallback"; kind: FallbackKind; label: string }
  | { t: number; type: "error"; code: ErrorCode; message: string };
export type ReplyKind = "speech" | "tool_preamble" | "unspoken_text" | "silent_no_output";
export type TakeoverPhase = "idle" | "armed" | "sealing" | "draining" | "compiling" | "connecting" | "greeting"
  | "active" | "paying" | "closing" | "done" | "retrying" | "fallback" | "failed";
export type HudMetric = "click_to_first_audible" | "dead_air_after_rep" | "turn_audible_latency" | "tool_turn_latency";
export type FallbackKind = "cached_turn_replay" | "recorded_ai_session" | "typed_tts" | "mock_payment" | "hosted_checkout";
export interface QaResult {
  provisional: boolean; reAsked: number; newlyAsked: number; pendingConfirmed: number; verifiedReconfirmed: number;
  disclosures: { kind: "premium_change" | "esign_consent"; similarity: number; ok: boolean; missingCritical: string[] }[];
  clickToFirstAudibleMs: number | null; deadAirAfterRepMs: number | null; turnLatencyP50Ms: number | null;
  payment: "verified_webhook" | "verified_poll" | "simulated" | "unpaid"; handedBack: boolean; aiSeconds: number;
  adviceFlags: number;                           // agent sentences matching the advice lexicon outside disclosures (target 0)
  details: { sentence: string; atMs: number; field: FieldId | null; classification: "reask" | "new" | "pending_confirm" | "verified_reconfirm" | "advice" | "other" }[];
}

// ── contracts/errors.ts ────────────────────────────────────────────────────────────────────────
export type ErrorCode =
  | "E_BUDGET" | "E_RATE_LIMITED" | "E_QUEUE_TIMEOUT" | "E_MODE_REPLAY_ONLY" | "E_MAINTENANCE"
  | "E_STT_AUTH" | "E_STT_RATE" | "E_STT_INPUT" | "E_STT_TRANSIENT" | "E_STT_INACTIVITY" | "E_AAI_BALANCE"
  | "E_VA_AUTH" | "E_VA_CONFIG" | "E_VA_CAPACITY" | "E_VA_SILENT" | "E_VA_TIMEOUT" | "E_VA_TRANSIENT"
  | "E_OPENAI_TIMEOUT" | "E_OPENAI_REFUSAL" | "E_OPENAI_RATE" | "E_POLAR_API" | "E_POLAR_SIG"
  | "E_MIC_DENIED" | "E_AUDIO_LOCKED" | "E_CASE_TOKEN" | "E_CASE_STATE" | "E_DB" | "E_INTERNAL";
export interface ApiError { error: { code: ErrorCode; message: string; retryAfterMs?: number; fallback?: FallbackKind } }

// ── contracts/tools.ts ─────────────────────────────────────────────────────────────────────────
export type ToolName = "confirm_effective_date" | "get_disclosure" | "send_esign_and_pay_link" | "send_confirmation"
  | "update_case_field" | "hand_back_to_rep";
export interface VaFunctionTool { type: "function"; name: ToolName; description: string; parameters: Record<string, unknown>;
  execution_mode: "interactive" | "hold"; timeout_seconds: number }
export interface ToolArgs {
  confirm_effective_date: { date: string; customer_words: string };
  get_disclosure: { kind: "premium_change" | "esign_consent" };
  send_esign_and_pay_link: { customer_agreed_to_text: boolean; paper_copy_requested: boolean; customer_words: string };
  send_confirmation: Record<string, never>;
  update_case_field: { field: FieldId; value: string; reason: "customer_confirmed" | "customer_corrected" | "newly_provided" };
  hand_back_to_rep: { reason: "advice_requested" | "customer_request" | "conflict" | "customer_declined" | "out_of_scope" | "payment_problem" | "other"; summary: string };
}

// ── contracts/takeover.ts ──────────────────────────────────────────────────────────────────────
export interface DrainReport { tArmMs: number; tCutMs: number; capHit: boolean; midUtterance: boolean;
  completedTurnIds: string[]; pendingTurnIds: string[]; cutTurnIds: string[]; waitedMs: number;
  timings: Partial<Record<"armed" | "sealed" | "finals" | "drained", number>> }            // ms since arm
export type TranscriptionMode = "min_latency" | "balanced" | "max_accuracy";
export interface CompiledTakeover { greeting: string; systemPrompt: string; keyterms: string[];   // [] unless VA_KEYTERMS=1
  tools: VaFunctionTool[]; stage: Stage; snapshot: CaseState; voice: string;
  transcriptionMode: TranscriptionMode;          // chosen per next step (§5.9.1)
  vaSessionCapMs: number;                        // dynamic cap from the snapshot (§5.9.5)
  promptVersion: string; deployMarker: string;   // deployMarker is embedded in systemPrompt (F6)
  compiledBy: "server" | "client" }
export interface InputModePlan { mode: TranscriptionMode; reason: "asks_entity" | "yes_no" | "disclosure" | "id_capture" }

// ── contracts/extract.ts ───────────────────────────────────────────────────────────────────────
export interface ExtractTurnInput { caseId: string; policy: PolicyRecord; callDate: string; state: CaseState;
  recent: TurnInput[]; newTurns: TurnInput[] }
export interface ExtractTurnOutput { events: FactEvent[]; ms: number; usage: { input: number; output: number }; model: string;
  extractorVersion: string; cached: boolean }
export interface VerifierResult { uptoRecvMs: number; fields: { field: FieldId; value: string | null;
  support: "stated_and_confirmed" | "stated_once" | "conflicting" | "absent"; turnIds: string[]; quote: string }[] }

// ── contracts/eval.ts ──────────────────────────────────────────────────────────────────────────
export type PipelineVersion = "v1" | "v2" | "v3";
export type SttVariant = "pc_ctx" | "pc_noctx" | "mono_diar" | "pc_ctx_8k";
export interface SttCacheRecord { callId: string; variant: SttVariant; channel: Channel | "mono"; recvMs: number;
  message: Record<string, unknown> }                                  // raw server message (Turn/Begin/Termination…)
export interface SweepMetrics { entityAcc: number | null; verifiedPrecision: number | null; wrongAsserted: number;
  wrongPending: number; reaskProjected: number; pendingN: number; missingN: number; ready: boolean;
  statusAgreementAtPlanned: number | null }
export interface SweepPoint { callId: string; version: PipelineVersion; variant: SttVariant; tMs: number; midUtterance: boolean;
  tCutMs: number; capHit: boolean; protocolMs: number;
  snapshot: Record<FieldId, { status: FieldStatus; value: string | null; display: string | null }>;
  greeting: string; metrics: SweepMetrics }
```

### 4.2 Data model (Drizzle, `src/server/db/schema.ts`; one initial migration by WP0; later changes are additive only)

**Conventions for every table:**
- Timestamps are `timestamptz` and default to `now()`.
- Ids are `text` holding nanoid (21 chars) unless noted otherwise.
- JSON columns are `jsonb`.

#### Case tables

| Table | Columns (type, notes) | Indexes |
|---|---|---|
| `cases` | • `id` pk<br>• `mode` (`watch` \| `live` \| `spot` \| `synthetic`)<br>• `call_id` text null<br>• `scenario_id` text<br>• `intent` (`add_driver`)<br>• `policy` jsonb `PolicyRecord`<br>• `state` jsonb `CaseState` (the latest derived state; a denormalized cache)<br>• `status` (`shadowing` \| `armed` \| `ai_active` \| `completed` \| `handed_back` \| `abandoned` \| `failed`)<br>• `visitor_id` text<br>• `ip_key` text<br>• `t_arm_ms` int null<br>• `run_plan` jsonb `RunPlan` null (D14)<br>• `created_at`, `updated_at` | `(visitor_id, created_at)`, `(created_at)` |
| `turns` | • `id` pk (= `TurnInput.turnId` scoped by case: `${caseId}:${turnId}`)<br>• `case_id` fk<br>• `channel`<br>• `source`<br>• `text`<br>• `start_ms`, `end_ms`, `recv_ms` int<br>• `words` jsonb<br>• `cut`, `late` bool<br>• `extract_status` (`pending` \| `done` \| `failed` \| `skipped`)<br>• `extract_ms` int null<br>• `created_at` | `(case_id, recv_ms)` |
| `fact_events` | • `id` pk<br>• `case_id`<br>• `turn_id` null<br>• `seq` int (per case, monotonic)<br>• `field`, `kind`, `party`<br>• `value_raw`, `value_norm`<br>• `acknowledges_turn_id`<br>• `confidence`<br>• `late`, `cut`<br>• `evidence` jsonb<br>• `extractor`<br>• `created_at` | `(case_id, seq)` unique |
| `verifier_runs` | • `id`<br>• `case_id`<br>• `upto_turn_recv_ms` int<br>• `result` jsonb `VerifierResult`<br>• `disagreements` jsonb<br>• `ms` int<br>• `usd` numeric(10,5)<br>• `created_at` | `(case_id, created_at)` |

#### Takeover and payment tables

| Table | Columns (type, notes) | Indexes |
|---|---|---|
| `takeovers` | • `id` pk<br>• `case_id`<br>• `armed_at`<br>• `t_arm_ms`<br>• `mid_utterance` bool<br>• `phase` (`TakeoverPhase`)<br>• `protocol` jsonb (per-phase timings)<br>• `snapshot` jsonb `CaseState`<br>• `greeting` text<br>• `system_prompt_hash`<br>• `prompt_version`<br>• `stage`<br>• `va_session_id` text null<br>• `retries` int (0 or 1; the VA mint checks it, §4.4 #10)<br>• `last_failure_at` null<br>• `va_session_cap_ms` int<br>• `outcome` (`completed` \| `handed_back` \| `abandoned` \| `failed`) null<br>• `metrics` jsonb (HUD numbers, provisional QA)<br>• `ended_at` | `(case_id)`, `(va_session_id)` |
| `tool_calls` | • `id` pk<br>• `takeover_id`<br>• `call_id` text (VA `call_id`)<br>• `name`<br>• `args` jsonb<br>• `result` jsonb<br>• `status` (`ok` \| `error` \| `rejected`)<br>• `started_at`, `finished_at` | `(takeover_id)`, `(takeover_id, call_id)` unique |
| `payments` | • `id` pk<br>• `case_id`<br>• `takeover_id`<br>• `provider` (`polar` \| `mock`)<br>• `checkout_id` text null<br>• `checkout_url` text null<br>• `amount_cents` int (what the disclosure said)<br>• `total_amount_cents` int null, `tax_amount_cents` int null (Polar's own figures)<br>• `simulated` bool<br>• `status` `PaymentStatus`<br>• `status_source` (`webhook` \| `server_poll` \| `mock`) null<br>• `failure_reason` (`amount_mismatch` \| `polar_failed` \| …) null<br>• `esign_consent_at`, `esign_name` null<br>• `created_at`, `updated_at` | `(checkout_id)` unique |
| `webhook_events` | • `id` pk (`polar:<webhook-id>` or `aai:<transcript_id>:<status>`)<br>• `provider`<br>• `type`<br>• `payload` jsonb (redacted)<br>• `received_at`, `processed_at`<br>• `error` | — |
| `verifications` | • `takeover_id` pk<br>• `aai_transcript_id`<br>• `status` (`pending` \| `completed` \| `failed`)<br>• `qa` jsonb `QaResult` (non-provisional)<br>• `completed_at` | — |

#### Background and platform tables

| Table | Columns (type, notes) | Indexes |
|---|---|---|
| `jobs` | • `id` pk<br>• `kind` (`verify_takeover` \| `purge` \| `va_audit`)<br>• `ref_id`<br>• `state` jsonb (step machine)<br>• `status` (`pending` \| `running` \| `done` \| `failed`)<br>• `run_after`<br>• `lease_until`<br>• `attempts` int<br>• `last_error`<br>• `created_at`, `updated_at` | `(status, run_after)` |
| `spend_ledger` | • `id` pk<br>• `day` date (UTC)<br>• `provider` (`aai_stt` \| `aai_va` \| `aai_async` \| `openai` \| `polar`)<br>• `action`<br>• `ref_id`<br>• `env` text (`BATON_DEPLOY_ID` of the spender)<br>• `est_usd` numeric(10,5)<br>• `actual_usd` numeric(10,5) null<br>• `status` (`reserved` \| `settled` \| `released`)<br>• `created_at`, `settled_at` | `(day, provider)`, `(ref_id)` |
| `rate_events` | • `id` bigserial<br>• `bucket` text<br>• `key` text<br>• `cost` int<br>• `ts` | `(bucket, key, ts)` |
| `stream_queue` | • `ticket` pk<br>• `visitor_id`<br>• `n` int<br>• `status` (`queued` \| `granted` \| `expired` \| `cancelled`)<br>• `created_at`, `granted_at`<br>• `last_poll_at` | `(status, created_at)` |
| `live_sessions` | • `id` pk<br>• `kind` (`stt` \| `va`)<br>• `case_id`<br>• `visitor_id`<br>• `ledger_id`<br>• `provider_session_id` null<br>• `opened_at`, `closed_at` null<br>• `billed_seconds` int null<br>• `cap_ms` int<br>• `run_id` null, `deploy_id` text<br>• `hold_expires_at` null<br>• `last_heartbeat_at` null<br>• `status` (`held` \| `open` \| `closed` \| `stale` \| `released`) | `(kind, status)` |
| `app_flags` | • `key` pk (`mode` \| `notice` \| `payments_mode_override` \| `aai_balance_usd`)<br>• `value` jsonb<br>• `reason` text<br>• `updated_at` | — |
| `promoted_agents` | • `id` pk (AssemblyAI `agent_…`)<br>• `intent`<br>• `config_hash`<br>• `config` jsonb (headers stripped)<br>• `evidence` jsonb<br>• `created_at`, `deleted_at` | `(intent, deleted_at)` |
| `health_checks` | • `id`<br>• `kind` (`light` \| `full`)<br>• `ok` bool<br>• `details` jsonb (per-probe `{ok, ms, code}`)<br>• `created_at` | `(created_at)` |

**Retention:** a daily purge job deletes judge `cases` and their cascading rows older than 14 days, `rate_events` older than 2 days, and `health_checks` older than 30 days. `mode='spot'` cases (eval evidence) are kept.

### 4.3 Auth primitives

| Primitive | Mechanics |
|---|---|
| **Visitor cookie** | • `bvid`, set by `src/proxy.ts` on the first request.<br>• Value: `<id>.<hmac>` (HMAC-SHA256 with `VISITOR_SECRET`); `httpOnly`, `secure`, `sameSite=Lax`, 30 days.<br>• `visitorId` = the id.<br>• `ipKey = hmac(VISITOR_SECRET, dayUTC + ":" + firstHop(x-forwarded-for))`. The raw IP is never stored.<br>• **Cookies blocked** (Brave, Safari "Block all cookies"): `/api/cases` returns a signed visitor token in the body, which the client sends as `x-baton-visitor`. Limits then key on that token **and** the ipKey. Never a 401 just because cookies are off |
| **Case token** | • JWT HS256 (`jose`) with `CASE_TOKEN_SECRET`.<br>• Claims: `{ sub: caseId, vid: visitorId, scp: ["case","tools"], tko?: takeoverId, exp: now + 45 min }`.<br>• Sent as `Authorization: Bearer <jwt>`.<br>• Every case/takeover/tool/payment route checks `sub` = path case, `vid` = cookie visitor, and the scope.<br>• A takeover-scoped token (with `tko`) is re-issued by `POST /api/takeovers` |
| **Admin** | `x-admin-key` = `ADMIN_KEY` (constant-time compare) |
| **Cron** | `x-cron-secret` = `CRON_SECRET`, or `Authorization: Bearer <CRON_SECRET>` (the Vercel Cron style) |
| **Limits authority** | `x-limits-key` = `LIMITS_AUTHORITY_KEY` (constant-time compare). Only accepted when `LIMITS_ROLE=authority` |
| **AssemblyAI async webhook** | Header `X-Baton-Webhook: <AAI_WEBHOOK_SECRET>` (set through `webhook_auth_header_name` / `webhook_auth_header_value`), plus the `?job=<jobId>` query |
| **Polar webhook** | Signature (§5.12) |
| **Promoted-agent HTTP tools** | Header `X-Baton-Agent-Key: <AGENT_TOOL_SECRET>` |

### 4.4 API routes

**Conventions for every route:**
- All routes: `export const runtime = "nodejs"; export const dynamic = "force-dynamic"`.
- Bodies are validated with the zod schemas in `contracts/api.ts`.
- Errors return `ApiError` with an HTTP status: 400 validation, 401 auth, 403 scope, 404, 409 state, 429 rate limit / queue, 503 mode/budget, 502 upstream.
- Rate-limit headers: `Retry-After` (seconds).

**Cases, streaming and extraction:**

| # | Method + path | Auth | Rate limit | Request → Response (zod names in `contracts/api.ts`) | Owner |
|---|---|---|---|---|---|
| 1 | `GET /api/health` | none | — | → `{ok:boolean, db:boolean, version:string}`. No external calls | WP0 |
| 2 | `GET /api/status` | none | 60/min/IP | → `StatusResponse {mode, reason, notice, budgetPctToday, sttQueueDepth, aiHalfAvailable:boolean, lastChecks:{light,full}, limits:{sttOpensPerMin, vaMaxConcurrent}, features:{beCustomer, payments}, deployId}` | WP2 |
| 3 | `POST /api/cases` | visitor | 10/h/visitor, 30/h/ipKey | `CreateCaseRequest {mode:"watch"\|"live", callId?:string, prefillUntilMs?:number}` → `CreateCaseResponse {caseId, caseToken, policy:PolicyRecord, call:CallManifestEntry\|null, state:CaseState, assets:{rep:string, customer:string, peaks:string}, cachedTurnsUrl:string\|null}` (the handoff clip is a span of the rep asset, `call.handoff`) | WP3 |
| 4 | `GET /api/cases/[caseId]` | case | 120/min/case | → `CaseView {state, turns:TurnInput[], facts:FactEvent[], takeover:TakeoverView\|null, payment:PaymentView\|null}` | WP3 |
| 5 | `POST /api/stt/token` | case | 6 grants/h/visitor, 15/h/ipKey; ≤2 open queue tickets per ipKey | `SttTokenRequest {caseId, runId, n:1\|2, ticket?:string, reconnect?:boolean}` → `SttTokenResponse = {status:"granted", token (10 s window), expiresAt, params:{rep:StreamingParams, customer:StreamingParams}, sessionIds:string[]}` \| `{status:"queued", ticket, position, etaMs, pollMs:2000}` (only while `etaMs ≤ 15000`) \| `{status:"denied", code:"E_BUDGET"\|"E_MODE_REPLAY_ONLY"\|"E_QUEUE_TIMEOUT"\|"E_RATE_LIMITED"\|"E_AAI_BALANCE", message:string (plain words), fallback:"cached_turn_replay"}`. Any upstream mint failure maps to `denied` plus the fallback, never a bare 502 | WP2 |
| 5a | `POST /api/runs` | case | 10/h/visitor | `StartRunRequest {caseId, callId, express:boolean}` → `RunPlan` (§4.1). Reserves the VA budget (the dynamic-cap maximum, ≈$0.53) and a VA slot in status `held` (expires at the remaining call time + 60 s), or returns `aiHalf:"recorded"` with a plain reason. Also decides `sttHalf` from mode, budget and the broker ETA | WP2 |
| 5b | `POST /api/runs/[runId]/release` | case | — | → `{ok:true}`. Releases an unused VA hold (end of recording without a pass; `pagehide` via `sendBeacon`) | WP2 |
| 6 | `DELETE /api/stt/queue/[ticket]` | case | — | → `{ok:true}` | WP2 |
| 7 | `POST /api/sessions/report` | case | 60/min/case | `SessionReport {sessionId (our live_sessions id), kind:"stt"\|"va", event:"opened"\|"closed", providerSessionId?, billedSeconds?, closeCode?}` → `{ok:true}`. Settles the ledger | WP2 |
| 8 | `POST /api/extract` | case | 5/s burst 10 per case; 250 turns/case | `ExtractRequest {turn:TurnInput}` → `ExtractResponse {state:CaseState, events:FactEvent[], extractMs:number, skipped?:"duplicate"\|"after_takeover"}`. Idempotent on `(caseId, turnId)` | WP3 |

**Takeovers and tools:**

| # | Method + path | Auth | Rate limit | Request → Response | Owner |
|---|---|---|---|---|---|
| 9 | `POST /api/takeovers` | case | 3/case | `ArmRequest {caseId, runId, tArmMs, midUtterance:boolean, source:"manual"\|"auto_handoff"}` → `ArmResponse {takeoverId, takeoverToken, leadMs:number (adaptive update→audible estimate, default 900)}`. Case status → `armed`. Refused (409) for runs with `aiHalf:"recorded"` | WP5 |
| 10 | `POST /api/va/token` | takeover | 4/h, 8/day per visitor; 12/h per ipKey; global slots ≤ `VA_MAX_CONCURRENT` | `VaTokenRequest {takeoverId, attempt:0\|1}` → `{token, expiresInSeconds:10, liveSessionId}` \| `ApiError(E_BUDGET\|E_RATE_LIMITED\|E_VA_CAPACITY\|E_AAI_BALANCE, fallback:"recorded_ai_session")`.<br>**Keyed on the takeover, not only on case status:** allowed when the case is `armed` or `ai_active` and either `attempt=0 ∧ retries=0` within 30 s of `armed_at`, or `attempt=1 ∧ retries=0` within 30 s of `last_failure_at` (the route sets `retries=1` atomically in the same transaction).<br>The run's `held` slot becomes `open`. On a retry, the failed attempt's `live_sessions` row is released first, so the retry is never refused by its own zombie slot | WP2 |
| 11 | `POST /api/takeovers/[id]/compile` | takeover | 3/takeover | `CompileRequest {drain:DrainReport}` → `CompiledTakeover {greeting, systemPrompt, keyterms:string[], tools:VaFunctionTool[], stage:Stage, snapshot:CaseState, voice:string, transcriptionMode:TranscriptionMode, vaSessionCapMs:number, promptVersion, deployMarker}`, checked by `validateFirstUpdate()` on the server before it is returned | WP5 |
| 12 | `POST /api/takeovers/[id]/events` | takeover | 30/min | `TakeoverEventsRequest {phase?:TakeoverPhase, timings?:Record<string,number>, vaSessionId?, hud?:Partial<Record<HudMetric,number>>, provisionalQa?:QaResult, heartbeat?:true, failure?:{code:ErrorCode}}` → `{ok:true}`. The client posts a heartbeat every 10 s while a VA session is open (the registry marks the slot stale after 30 s without one). `failure` sets `takeovers.last_failure_at` | WP5 |
| 13 | `POST /api/takeovers/[id]/end` | takeover | 2/takeover | `EndTakeoverRequest {outcome, vaSessionId:string\|null, reason?:string}` → `{ok:true, verificationJobId:string\|null}`. Enqueues `verify_takeover` via `enqueueVerification()` (WP8) | WP5 |
| 14 | `POST /api/tools/[name]` | takeover | 60/takeover | `ToolRequest {takeoverId, callId (VA call_id), args:unknown}` → `ToolResponse {result:object (sent verbatim as tool.result JSON), stage?:Stage (new stage → client sends session.update first), systemPrompt?:string, tools?:VaFunctionTool[], transcriptionMode?:TranscriptionMode (the next step's input mode, §5.9.1), ui?:{sms?:string, link?:string, paymentId?:string, conflict?:ConflictCard}}`. Idempotent on `(takeoverId, callId)` | WP6 |

**Payments and webhooks:**

| # | Method + path | Auth | Rate limit | Request → Response | Owner |
|---|---|---|---|---|---|
| 15 | `GET /api/payments/[id]` | takeover | 1/s | → `PaymentView {id, status, statusSource, amountCents, totalAmountCents, provider, simulated, checkoutUrl?, embed:{url, origin}\|null, failureReason?, updatedAt}`. When `status ∈ {open, confirmed}` and >8 s since the last server poll, it calls Polar `GET /v1/checkouts/{id}` first (server-authoritative). Clients poll every 1.5–2 s and ignore 429s silently | WP6 |
| 16 | `POST /api/payments/[id]/esign` | takeover | 5 | `EsignRequest {consent:true, typedName:string≤80}` → `{ok:true, signedAt}` | WP6 |
| 17 | `POST /api/payments/[id]/simulate` | takeover | 3 | **Any provider, any `PAYMENTS_MODE`.** Switches the payment to `provider=mock, simulated=true`, sets `succeeded` with source `mock`, and ignores later Polar webhooks for it (logged). → `{ok:true}`. The QA card shows "simulated" | WP6 |
| 18 | `POST /api/webhooks/polar` | Polar signature | — | raw body → 202. Idempotent on `webhook-id` | WP6 |
| 19 | `POST /api/webhooks/assemblyai?job=` | header secret | — | `{transcript_id, status}` → 200, then advances the job | WP8 |
| 20 | `GET /api/verifications/[takeoverId]` | takeover | 1/s | → `VerificationView {status:"pending"\|"completed"\|"failed", qa:QaResult\|null, elapsedMs}`. **Advances the job one step if due** (portable background) | WP8 |
| 21 | `GET /api/va-sessions/[vaSessionId]/audio` | takeover (must own it) | 30/min | → 302 to a fresh pre-signed OGG URL (from `GET /v1/sessions/{id}`; TTL 1 h), plus a `?t=` passthrough | WP8 |

**TTS, evals, promote, admin:**

| # | Method + path | Auth | Rate limit | Request → Response | Owner |
|---|---|---|---|---|---|
| 22 | `POST /api/tts` | case | typed: 20/h/visitor; autopilot: a separate bucket of 60/h/visitor; ≤200 chars | `TtsRequest {caseId, text, voice:"marin"\|"cedar"}` → `audio/pcm` (24 kHz s16le mono, chunked; odd-length carry handled server-side). Cached in an in-memory LRU keyed by `sha256(voice+text)` | WP11 |
| 23 | `GET /api/evals/summary` | none | 30/min/IP | → `EvalSummaryResponse {static: <public/data/evals/summary.json>, live:{judgeRuns:{n, reAskRate, handBackRate, completionRate, disclosureOkRate, clickToAudible:{p50,p90}, deadAir:{p50,p90}}}}` | WP10 |
| 24 | `GET /api/promote` / `POST /api/promote` | none (POST: 1 per 10 min global + 3/day/visitor) | — | `PromoteRequest {intent:"add_driver"}` → `PromoteResponse {agentId, created:boolean, configHash, evidence:PromoteEvidence, gate:{passed:boolean, reasons:string[]}}` | WP10 |
| 25 | `POST /api/agent-tools/[name]` | agent key | 60/min | AssemblyAI HTTP tool body (JSON args) → tool JSON (≤8 KiB) | WP10 |
| 26 | `POST /api/internal/cron?kind=light\|full\|purge\|tick` | cron | — | → `{ok, details}` | WP2 |
| 27 | `POST /api/admin/flags` · `GET /api/admin/ledger` | admin | — | `{mode?, notice?, aaiBalanceUsd?}` → flags (a balance below `AAI_RESERVE_USD` flips `replay_only`, reason `aai_balance`); → spend by provider and env, the since-epoch total and today's dynamic cap | WP2 |
| 28 | `POST /api/internal/limits/{stt-acquire,stt-cancel,va-acquire,va-release,report,reserve,settle,release}` | limits key | — | The `LimitsAuthority` interface (TASKS §2) over HTTP, for remote openers. Same zod schemas as the in-process calls | WP2 |

### 4.5 Background and async flows

**Runner model (portable).** Jobs live in `jobs`. `advanceJob(id)`:
1. Takes a lease: `UPDATE jobs SET lease_until=now()+30s, status='running' WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) AND run_after<=now()`.
2. Runs **one step** of the job's step machine.
3. Persists `state`, then sets `run_after` for the next step, or `done`/`failed`.

Three things call it:
- (a) the in-process ticker (`instrumentation.ts`, every 2 s, only when `ENABLE_INPROC_WORKER=1`);
- (b) status-poll routes (`GET /api/verifications/…`);
- (c) `POST /api/internal/cron?kind=tick` (the Vercel mirror).

**F1 Extraction** (synchronous, per final turn), in `POST /api/extract`. **No transaction or pool connection is held across the LLM call:**
1. Insert the turn (conflict → return the current state, `skipped: "duplicate"`).
2. Read the case state and its `version` (a plain read, no lock).
3. Call `Extractor.extractTurn` **outside any transaction** (budgets in §5.3).
4. Open a short transaction: take `pg_advisory_xact_lock(hashtext(caseId))`, re-read `version`. If newer events landed, re-derive on top of them (events are append-only and derivation is pure, so this is always safe). Insert `fact_events` with the next `seq`, run `deriveCaseState` (pure), save `cases.state` with `version+1`. Commit.
5. Return.
6. `after(() => maybeRunVerifier(caseId))`.

Ordering: turns of one case are sent by `CaseSync` in order, and step 4 orders events by `(turnEndMs, seq)`, so a late-finishing extraction of an earlier turn still lands in the right place.

**F2 Verifier** (background, never awaited by takeover code). `maybeRunVerifier`:
- **Conditions:**
  - case status `shadowing`;
  - ≥15 s since the last run;
  - ≥1 new final;
  - runs < 8;
  - **no verifier run in flight for this case** (sol/low took 25.9 s for one structured extraction in 10d t02, so runs would otherwise overlap);
  - OpenAI daily budget OK.
- **Steps:**
  1. `Verifier.verifyCase(allTurns, policy)` (sol, low).
  2. Store it in `verifier_runs`.
  3. Insert `fact_events` with `extractor:"sol"` for disagreements only.
  4. Re-derive and save.
- **Late results.** If the case is no longer `shadowing` when the result arrives, store the run but don't touch the state. The takeover snapshot is immutable.

**F3 Takeover verification** (`verify_takeover`), started by `/api/takeovers/[id]/end`, `run_after = now()+7s`. Steps:
- **S1 `await_artifacts`:** `GET /v1/sessions/{vaSessionId}`. When `artifacts` includes `audio`, store `audio_url`, `timeline_url` and `duration_seconds`, then settle the VA ledger entry with the actual duration. Otherwise retry in 3 s, for at most 30 tries.
- **S2 `submit`:** `POST /v2/transcript`:

  ```json
  {"audio_url":"<fresh presigned>","speech_models":["universal-3-5-pro"],"multichannel":true,
   "keyterms_prompt":["<snapshot entity values>"],
   "webhook_url":"APP_URL/api/webhooks/assemblyai?job=<id>",
   "webhook_auth_header_name":"X-Baton-Webhook","webhook_auth_header_value":"<AAI_WEBHOOK_SECRET>"}
  ```

  - This waits while more than 3 async jobs are in flight.
  - It reserves an `aai_async` ledger entry: 2 ch × duration × $0.21/h.
  - `keyterms_prompt` + `multichannel` were verified separately (A4b, VA-13) but never together: on a 400, resubmit once without `keyterms_prompt`.
- **S3 `await_transcript`:** triggered by the webhook, or by polling `GET /v2/transcript/{id}` every 3 s for at most 60 s.
- **S4 `compute`:**
  1. Fetch the timeline JSON (`tool_calls` with results; `turns`).
  2. Build ch2/ch1 utterances with words.
  3. Run `computeQa(snapshot, ch2, ch1, toolCalls)` (§5.13).
  4. Upsert `verifications`, update `takeovers.metrics`, and settle the ledger.
- **Failure.** Any step failing 3 times sets `failed` with a reason. The UI keeps the provisional numbers.

**F4 Payment.** Polar webhook `checkout.updated` / `order.paid`:
1. Verify, then insert into `webhook_events` (a duplicate means return 202).
2. Map `metadata.paymentId` → payment → set the status if it is a forward transition (`open → confirmed → succeeded`; `failed`/`expired` are terminal), with `status_source='webhook'`.
3. The client learns the new status by polling route #15.

**F5 Registry sweeper** (the ticker every 15 s, and cron light):
- A `va` row `open` with no heartbeat for 30 s, or any row `open` past `cap_ms + 60 s`, becomes `stale` and frees its slot (a dead browser's WebSocket closes on its own, so this is safe).
- A `held` row past `hold_expires_at` becomes `released` and its reservation is released.
- Stale rows have their ledger entry settled at the worst case (STT: `inactivity_timeout` + terminate; VA: the session's dynamic cap).
- For kind `va`, a `verify_takeover` job is enqueued if one doesn't exist yet.

**F6 VA audit** (the in-process ticker every 3 min while `mode=live`; cron light as a backstop). `GET /v1/sessions?limit=50`, following `has_more` / `next_cursor` and filtering by `created_at` over the last 60 min:
- **Production sessions are recognised by content, not by DB row.** Every compiled system prompt ends with the line `(internal ref: baton-deploy={BATON_DEPLOY_ID}; never mention this)` (`CompiledTakeover.deployMarker`). The audit fetches `GET /v1/sessions/{id}` for new ids and reads the marker from `config.system_prompt`. Sessions with another marker (dev, mirror) or no marker are ignored.
- Anomalies: a marker-bearing session unknown to `live_sessions`, a marker-bearing session still running whose row is `closed`/`stale`, or more concurrently open marker-bearing sessions than `VA_MAX_CONCURRENT`. Any anomaly sets `mode=replay_only`, reason `"va_audit_anomaly"`, and (if T-D1-0b shows that `DELETE /v1/sessions/{id}` ends a live session) deletes the anomalous sessions.
- The audit also settles actual durations.

**F7 Synthetic checks.**

| Kind | Schedule | Probes | Cost |
|---|---|---|---|
| **light** | Hourly | DB write/read; mint STT token (no connect); mint VA token (no connect); OpenAI `luna` 16-token call; Polar `GET /v1/checkouts?limit=1` list; flags readable | ≈$0.00002 |
| **full** | Every 6 h | Opens 1 STT session through the broker and streams a 4 s fixture (`public/fixtures/health_16k.pcm`), expecting a final containing "481529"; opens 1 VA session with a greeting-only config, waits for the first audible chunk, then `session.end` (≈5 s) | ≈$0.0075 |

**Two consecutive full failures** set `mode=replay_only`, reason `"synthetic_failed"`. The next success restores `live`, but only if the reason was `synthetic_failed`. Checks run inside the same container, so an **external monitor** also watches it (§7.7).

**F8 Budget guard** (the ticker every 60 s, and on every reservation):
- Recomputes today's dynamic daily cap (§7.2).
- Any AssemblyAI mint or WebSocket error whose text mentions balance, credit, payment or quota, or 3 consecutive 1008 closes on fresh tokens within 10 min, sets `mode=replay_only`, reason `aai_balance`. Only the operator clears it.


---

## 5. Core algorithms (precise specs)

### 5.1 Per-channel streaming replay of a recorded call (Watch mode)

#### 5.1.1 Assets (built offline by `scripts/calls/build-assets.ts`)

- `public/calls/<callId>/rep.<ext>` and `customer.<ext>`: one mono channel per file, with no header.
  - `twilio8k` calls use `.ulaw`: raw G.711 µ-law, 8 kHz. This is re-encoded from the kit's split WAVs (`data/calls/split/<base>_{rep,customer}.wav`, PCM16 8 kHz decoded from Twilio's µ-law), so it is near-lossless. **This is the verified phone path [10b ST-13].**
  - `golden16k` calls use `.pcm16`: raw s16le, 16 kHz.
  - The channel split was already done by the kit using its sidecar `channel_map`.
- `peaks.json`: `{ ratePerSec: 50, rep: number[], customer: number[] }`. Each value is the 0..1 max-abs over 20 ms.
- **Handoff line:** there is no separate asset. `CallManifestEntry.handoff.lineStartMs`/`lineEndMs` (from labels) point into the rep channel, and `acceptStartMs`/`acceptEndMs` into the customer channel. For an early baton pass, the client plays the rep span, a 300 ms gap, then the customer's acceptance span, so the story is "Daniel asks, Priya agrees, the AI speaks".
  - Nuance: the line then plays twice in the story, early and at the original spot, but the recording is stopped at the pass, so the second play never happens.
  - If `acceptStartMs` is null, a labelled synthetic "Sure." (voice `marin`, cached) plays instead.
  - If `handoff` is null (no labelled line), fall back to cached TTS in voice `cedar`: "OK if my assistant finishes the paperwork? I'll stay on the line.", labelled "synthesized rep line".
- Assets are served with long-lived immutable caching (content-hashed file names in `calls.json`), and the default call is prefetched while the landing page is idle.
- Only calls with `publishAudio` get `public/` assets.
- Size check: a 2-min 8 kHz call is ≈1 MB per channel; a 16 kHz call is ≈3.8 MB per channel.

#### 5.1.2 Load

1. `fetch` both channels as `ArrayBuffer`.
2. Keep the raw bytes (`srcBytes[ch]`) for STT. They are sent **unchanged**.
3. For playback, decode to Float32 at the source rate (µ-law decode, or PCM16 / 32768), then `resampleLinear(…, srcRate, ctx.sampleRate)`.
4. Transfer both Float32Arrays to the **CallPlayer worklet**.
5. Never call `ctx.createBuffer` at 8 kHz; Safari's range is not guaranteed.

#### 5.1.3 Clock

The CallPlayer worklet outputs a stereo mix: rep panned 30% left, customer 30% right, with per-channel gain. It keeps a frame counter. Every 50 ms of output frames it posts `{type:"tick", frame, playing}`.

After `stop(fadeMs=30)` it outputs silence but **keeps ticking**. Its clock never stops until `dispose()`. Ticks come from the audio render thread, so background-tab timer throttling cannot starve STT.

#### 5.1.4 Feeding STT

On each tick, on the main thread:

```ts
srcPos = Math.floor(tick.frame * srcRate / ctx.sampleRate)          // samples of source audio "elapsed"
for ch of ["rep","customer"]:
  bytes = tick.playing && !takeover.stopped
        ? srcBytes[ch].subarray(lastPos*bps, srcPos*bps)           // bps = 1 (µ-law) | 2 (PCM16)
        : silence((srcPos-lastPos), encoding)                       // 0xFF µ-law / 0x00 PCM16
  for frame of batcher[ch].push(bytes): stt[ch].sendAudio(frame)    // FrameBatcher targetMs: 100 (8k) | 50 (16k)
lastPos = srcPos;  callMs = srcPos / srcRate * 1000 + startOffsetMs
```

**Invariant:** session audio ms = call ms − `startOffsetMs`, because both advance by the number of samples sent. Word times from a session are converted with `callMs = word.start + startOffsetMs + reconnectOffsetMs[ch]`.

#### 5.1.5 Session parameters

`buildSttParams(call, policy, channel): StreamingParams` in `src/core/aai/stt-params.ts` (owned by WP4):

```ts
{ speech_model: "universal-3-5-pro", encoding: call.format.encoding, sample_rate: call.format.sampleRate,
  mode: "min_latency", inactivity_timeout: 30,
  keyterms_prompt: keytermsFromPolicy(policy),        // ≤100 items, ≤50 chars each (sanitizeParams clips)
  prompt: STT_PROMPT,                                  // ≤1750 chars (below)
  ...(hinglishChannel(call, channel) ? { language_codes: ["en","hi"], language_detection: true } : {}),  // en FIRST [10b ST-12]
  // hinglishChannel: per CHANNEL, from the scenario's speaker languages (s19: customer only; s20: both). ST-12 was n=1 at 16 kHz
  // with no prompt, so T-D1-6 adds one Hinglish × 8 kHz µ-law × prompt/keyterms run.
  ...(call.format.sampleRate === 8000 ? TUNING_8K : {}) }   // TUNING_8K = {min_turn_silence, max_turn_silence} — DAY-1 TEST
```

- **No** `speaker_labels`, **no** `redact_pii`, and **no** `llm_gateway` [10 §0].
- `STT_PROMPT` = "Recorded phone call at a US insurance agency. A customer service representative and a policyholder discuss adding a driver to a personal auto policy: people's names, relationship, age or date of birth, learner's permit or driver's license, vehicle year make and model, ZIP codes, effective dates, and monthly premiums in dollars."
- `keytermsFromPolicy` returns: policyholder first and last name, existing drivers' names, agency name, carrier, rep first name, every vehicle make and model, street and city, plus the fixed set `["learner's permit","probationary license","endorsement","garaging","premium","liability limits","good student discount","driver's ed"]`. **It never uses ground-truth values of the new driver.**

#### 5.1.6 Connect and start

1. Token: `POST /api/stt/token {runId, n:2}` (handle queued/denied, §2.3). One token opens both sessions; its window is 10 s, and both connects start immediately after the grant.
2. `StreamingSession.connect({auth:{token}, params})` for both channels in parallel, with an 8 s timeout each.
3. **Check `Begin.configuration`:** `speech_model` or `model` must equal `universal-3-5-pro` and `mode` must equal `min_latency`. Typos are silently ignored by the server, which is why this check exists. On a mismatch: in dev and CI, `terminate()` both and raise `E_STT_INPUT`; **in production, log a warning and continue** (if AssemblyAI renames the echoed field in October, a hard check would silently force cached mode for the whole judging window). The 6-hourly full synthetic check runs the same code path and alerts.
   - `keyterms_prompt` and `prompt` are not echoed by `Begin` (ST-9), so a unit test snapshots the exact URL query that `buildStreamingUrl` produces (JSON-string arrays, exact parameter names).
4. `POST /api/sessions/report {event:"opened"}` for each channel.
5. Start the worklet at `startOffsetMs`:
   - **Full:** 0.
   - **Express:** `max(0, decisionPointMs − 25000)`, snapped back to the nearest labelled turn start or silence gap, so the first live partial is never half a word. The case was created with `prefillUntilMs = startOffsetMs`, so the server inserted the cached turns and cached fact events up to that point with no LLM calls. They render with a "cached" badge. The customer session is seeded with `agent_context` = the last cached rep final before `startOffsetMs`.

#### 5.1.7 Turn handling

`TurnTracker.apply(t)`:

| Result | Action |
|---|---|
| `partial` | Emit `stt.partial` |
| `final` | Build a `TurnInput`:<br>• `turnId`: `${ch}-${turn_order}` (+ `-r1` after a reconnect)<br>• `text`<br>• `startMs`/`endMs` from the first/last word (call clock)<br>• `words`<br>• `recvMs = callMs now`<br>• `cut=false`<br>• `late = takeover.armed && endMs > tArm`<br>Then `CaseSync.enqueue()`. If `ch === "rep"`, also run §5.2 |
| `empty-final` / `duplicate-final` | Ignore |

#### 5.1.8 End of recording

1. The worklet reports `ended`.
2. Feed 1500 ms of silence. The last turn finalizes about 0.3 s after its last word [10b ST-14].
3. `terminate()` both sessions, waiting ≤3 s each.
4. Report `billedSeconds = Termination.session_duration_seconds`.

A full recording end is not a takeover. The UI shows "Call ended without a baton pass" and offers the Explorer.

#### 5.1.9 Errors while shadowing

| Close / error | Action |
|---|---|
| `isRetryableClose` (1006, 1011, 3005) | **One** reconnect per channel:<br>1. `POST /api/stt/token {n:1}`.<br>2. Reconnect with the same params, plus `agent_context` = the last rep final.<br>3. `reconnectOffsetMs[ch] = callMs` at the first frame sent.<br>4. Show a "reconnected at mm:ss" chip.<br>If the reconnect is denied or fails, that channel switches to **cached turns** for the rest of the call (§5.1.10) and the badge reads "partially cached" |
| 1008/3009 with text matching `/too many\|concurrent/i` | `E_STT_RATE`: treat as queue-denied and go to the cached replay |
| 1008 otherwise | `E_STT_AUTH`: no retry; cached replay. Counts toward the F8 balance guard |
| 3006 with text matching `/inactivity/i` (no `Termination` frame) | `E_STT_INACTIVITY`: transient, not a bug. Typically an iOS tab whose `AudioContext` was suspended. Settle the ledger from wall time; show "Paused" and resume through the reconnect path (§7.6) |
| 3006 otherwise / 3007 | `E_STT_INPUT`: a bug. Log, and fall back to the cached replay |
| Token mint fails upstream (`/v3/token` 4xx/5xx, free credit exhausted) | The route returns `denied` + `fallback`; the page shows the labelled cached replay, never a generic 502 |

#### 5.1.10 Cached-turn replay (labelled fallback)

**When:**
- STT is denied (budget, replay-only mode, or a queue ETA over 15 s: the replay **starts immediately**, with no waiting screen);
- STT fails;
- the judge clicks "Watch the cached replay now".

**Hot upgrade (D4 polish; cut first if late):** if the run started cached because of the queue, the client keeps polling its ticket. When granted, it opens live sessions through the reconnect path of §5.1.9 (`reconnectOffsetMs[ch] = callMs`, `agent_context` = the last rep final), and the badge changes to "CACHED → LIVE from 00:52".

**How:**
- The audio plays identically.
- Cached `Turn` messages from `public/data/cached-turns/<callId>.json` (per-channel + `agent_context` variant; partials and finals with `recvMs`) are emitted on the call clock at their `recvMs`.
- Finals go to `/api/extract` with `source:"stt_cache"`. The server serves **cached fact events** for `(callId, turnId, pipelineVersion)` when present (deterministic, $0), and otherwise calls luna.
- Badge: `CACHED REPLAY`. Tooltip: the exact reason, plus "transcribed live by AssemblyAI on 2026-09-2x; replayed now".
- The AI half follows the run plan (D14): the **live** Voice Agent when `aiHalf=live`, else the recorded session at its own handoff point.

### 5.2 `agent_context` carryover, rep → customer

- **Trigger:** on every **rep** final while shadowing, `sttCustomer.updateConfiguration({ agent_context: repTurn.text })`. `sanitizeParams` clips to the **last** 1750 chars, which is fatal to exceed [10b C15].
- **No ack comes back.** It applies to audio processed afterwards. The customer's answer usually starts more than 300 ms after the rep's final arrives (≈420 ms after the last rep word), so the timing works.
- **Variant knob** for the sweep: `CtxCarry = "none" | "last_rep_turn"` (the default in v3). Nothing flows from the customer to the rep channel.
- **Never** send `agent_context` to the Voice Agent. Context there goes through the prompt and greeting only [10 §5 corrections].

### 5.3 The `gpt-6-luna` JSON-patch extractor

`src/server/openai/extractor.ts`, implementing `Extractor.extractTurn(input: ExtractTurnInput): Promise<ExtractTurnOutput>`.

#### Call parameters

- `extractStructured` with `model: "gpt-6-luna"`, `reasoningEffort: "none"`, `temperature: 0` (allowed only with `none`), `maxOutputTokens: 1000`, `store: false`.
- **Budgets from measured throughput** (10d: luna/none structured output ≈166 tokens/s, TTFT ≈1.17 s): `timeoutMs = 1500 + maxOutputTokens / 150 × 1000` ≈ **8 s**. A typical single-turn patch is 60–250 output tokens, so p50 should be ≈1.5–2.5 s. **WP3 measures p50/p95 `extractMs` from the Zerops (Prague) host on D1** and records them in `docs/notes/wp3.md`; the sweep uses the measured distribution, and `DRAIN_MAX_MS` is re-checked against it.
- **Retry:** once, with **only the newest turn** and the same timeout (never a shorter timeout than the first attempt). `status:"incomplete"` (`IncompleteError`) is treated the same way: retry with fewer turns.
- On final failure, `turns.extract_status='failed'` (the verifier may fill the gap later). A fact whose extraction misses the drain deadline is simply not in the snapshot, so it is never asserted (safe by construction).
- **Batching:** when more than 2 turns are queued for the case, send **at most 3** together as `NEW TURNS` (ordered) in one call. Events carry `turn_id`.

#### Instructions (verbatim; `EXTRACTOR_PROMPT_V3`)

```
You extract facts for an insurance policy-change case from a phone call between an agency REP and a policyholder CUSTOMER.
Intent: add a driver to a personal auto policy. You see the current case, recent turns, and one or more NEW TURNS.
Emit events ONLY for what the NEW TURNS say. Never repeat facts from earlier turns unless a NEW TURN restates, reads back,
confirms, corrects or denies them. Never invent values. If nothing relevant is said, return {"events": [], "no_facts": true}.

Fields (value formats):
- driver_full_name: the new driver's name as spoken ("Maya", "Maya Raman").
- driver_dob: YYYY-MM-DD.            - driver_age: integer years ("17").
- driver_relation: one of spouse, domestic_partner, child, stepchild, parent, sibling, other_relative,
  non_relative_resident, non_relative_nonresident.
- license_state: 2-letter US state code ("OH").   - license_number: as spoken, digits/letters only.
- license_status: one of learner_permit, provisional (probationary), full.
- incidents_3y: "none", or a short description of tickets/accidents/claims in the last 3 years.
- vehicle_assignment: the policy vehicle the new driver will mainly drive, as its id from POLICY VEHICLES ("veh1").
- operator_type: primary or occasional (for that vehicle).
- garaging_zip: 5-digit ZIP where that vehicle is kept overnight.
- effective_date: YYYY-MM-DD. Resolve relative dates ("tomorrow", "next Friday") against CALL DATE.
- good_student_discount, driver_training_discount, distant_student_discount, mature_driver_discount:
  eligible, not_eligible or pending_proof.
- coverage_change: short text of what the customer decided about coverage ("keep current limits").
- underwriting_review: "true" or "false".
- premium_new_monthly_usd, premium_change_monthly_usd, amount_due_today_usd: dollars with cents ("142.00", "-12.50").
  Only the REP can state these.
Event kinds:
- stated: the speaker gives a value, or proposes one in a question ("Is that the Civic?").
- readback: the speaker repeats a value the OTHER party gave, to check it.
- ack: the speaker affirms the other party's latest statement/readback ("yes", "that's right", "correct"). Set
  acknowledges_turn_id to that turn; value = the value being affirmed (or null if unclear).
- corrected: the speaker replaces an earlier value with a new one.
- denied: the speaker says an earlier value is wrong without giving a new one (value null).
- question: the speaker asks for a field without proposing a value (value null).
quote: the shortest exact span of the NEW TURN (verbatim, same casing) that carries the event.
turn_id: the id of the NEW TURN the event comes from.
```

#### User input (JSON string)

```json
{"call_date":"2026-09-25","call_weekday":"Friday",
 "policy":{"policyholder":"Priya Raman","vehicles":[{"id":"veh1","label":"2021 Honda Civic"},{"id":"veh2","label":"2018 Toyota Highlander"}],
           "address_zip":"44107","existing_drivers":["Priya Raman","Arun Raman"]},
 "case":{"driver_full_name":{"value":"Maya Raman","status":"PENDING"},"effective_date":{"value":null,"status":"MISSING"}, "...": "..."},
 "recent_turns":[{"turn_id":"rep-11","speaker":"REP","text":"And what's Maya's date of birth?"},
                 {"turn_id":"customer-12","speaker":"CUSTOMER","text":"March 14th, 2009. She's seventeen."}],
 "new_turns":[{"turn_id":"rep-13","speaker":"REP","text":"March 14th, 2009, got it. Will she mainly drive the Civic?"}]}
```

Expected output for this example (`value` for `vehicle_assignment` is the policy vehicle id):

```json
{"no_facts":false,"events":[
 {"turn_id":"rep-13","field":"driver_dob","kind":"readback","value":"2009-03-14","quote":"March 14th, 2009, got it","acknowledges_turn_id":null,"confidence":"high"},
 {"turn_id":"rep-13","field":"vehicle_assignment","kind":"stated","value":"veh1","quote":"Will she mainly drive the Civic?","acknowledges_turn_id":null,"confidence":"high"},
 {"turn_id":"rep-13","field":"operator_type","kind":"stated","value":"primary","quote":"mainly drive the Civic","acknowledges_turn_id":null,"confidence":"medium"}]}
```

- `recent_turns` holds the last 6 finals before the new ones, across both channels.
- `case` holds only fields that are not MISSING, plus required MISSING fields as `null`.

#### Strict output schema (`ADD_DRIVER_PATCH_FORMAT`, name `add_driver_patch`)

```json
{"type":"object","additionalProperties":false,"required":["events","no_facts"],
 "properties":{
  "no_facts":{"type":"boolean"},
  "events":{"type":"array","items":{"type":"object","additionalProperties":false,
    "required":["turn_id","field","kind","value","quote","acknowledges_turn_id","confidence"],
    "properties":{
      "turn_id":{"type":"string"},
      "field":{"type":"string","enum":["driver_full_name","driver_dob","driver_age","driver_relation","license_state",
        "license_status","license_number","incidents_3y","vehicle_assignment","operator_type","garaging_zip","effective_date",
        "good_student_discount","driver_training_discount","distant_student_discount","mature_driver_discount",
        "coverage_change","underwriting_review","premium_new_monthly_usd","premium_change_monthly_usd","amount_due_today_usd"]},
      "kind":{"type":"string","enum":["stated","readback","ack","corrected","denied","question"]},
      "value":{"type":["string","null"]},
      "quote":{"type":"string"},
      "acknowledges_turn_id":{"type":["string","null"]},
      "confidence":{"type":"string","enum":["high","medium","low"]}}}}}}
```

#### Post-processing (deterministic, `src/core/case/apply.ts`)

1. Drop events whose `turn_id` is not a new turn.
2. Drop events with `kind != question` and `value == null`, except `ack`/`denied`.
3. `party` = the channel of `turn_id`.
4. `valueNorm = normalizeField(field, value, ctx)` (§5.4.1). An unparseable value gives `valueNorm=null` and the event is kept for audit only (it has no status effect).
5. **Evidence alignment:**
   1. Find the `quote` in the turn text: case-insensitive, whitespace-collapsed, exact.
   2. If that fails, use the best token-LCS window with a ratio ≥ 0.8.
   3. If that fails, use the whole turn, with the quote truncated to 200 chars.
   4. Map characters to word indices with the cumulative word text.
   5. `evidence = {channel, turnId, startMs: words[i].startMs, endMs: words[j].endMs, quote, source}`.
6. `late`/`cut` are copied from the turn.
7. `seq` = the next per-case sequence number.

#### Version pinning

Pipeline caches key on `extractorVersion = sha256(EXTRACTOR_PROMPT + schema + model + effort).slice(0,12)`.

### 5.4 Deterministic status rules (`src/core/case/status-rules.ts`, `derive.ts`)

#### 5.4.1 Normalizers (`src/core/intents/add-driver.ts`)

`normalizeField(field, raw, ctx:{policy, callDate}) → {norm, display} | null`. The **norm formats equal the kit's value formats**, so `Scenario.truth` compares directly:

| Field | Norm (= kit value format) | Display | Rules |
|---|---|---|---|
| `driver_full_name` | lowercase letters, spaces, `-`, `'`; collapsed | Title Case | — |
| `driver_dob` | `YYYY-MM-DD` | "March 14th, 2009" | Year in 1920..callDate−14y |
| `driver_age` | integer 14–99 | "17" | Also derived: a VERIFIED `driver_dob` implies an age. If both exist and are inconsistent, both become PENDING (`conflict`) |
| `driver_relation` | kit `RELATIONS` enum via a synonym map | "child (daughter)" | Synonyms:<br>• daughter/son/kid → `child`;<br>• wife/husband → `spouse`;<br>• partner → `domestic_partner`;<br>• stepdaughter/stepson → `stepchild`;<br>• mom/dad → `parent`;<br>• brother/sister → `sibling`;<br>• niece/nephew/cousin/grandchild → `other_relative`;<br>• roommate/boyfriend/girlfriend "who lives with us" → `non_relative_resident` |
| `license_state` | 2-letter code | "Ohio (OH)" | State names, codes and "out of state" (null) |
| `license_status` | `learner_permit` \| `provisional` \| `full` | "probationary license" | "probationary", "provisional", "junior", "intermediate" → `provisional`; "permit", "learner's" → `learner_permit` |
| `license_number` | uppercase alphanumerics | the value spaced | — |
| `incidents_3y` | `none` or lowercase text | as spoken | "no tickets", "nothing", "clean" → `none` |
| `vehicle_assignment` | the policy vehicle id (`veh1`) | the vehicle label | The id directly, or `{year, make, model}` tokens matching one vehicle uniquely (a model alone is OK if unique). "all" → `all`. Otherwise null |
| `operator_type` | `primary` \| `occasional` | — | "every day", "mainly" → `primary`; "sometimes", "weekends" → `occasional` |
| `garaging_zip` | 5 digits | the digits | Non-digits stripped; exactly 5 digits required |
| `effective_date` | `YYYY-MM-DD` | "Friday, October 2nd" | Must parse. Must satisfy `callDate ≤ d ≤ callDate + 60`; outside that range, flag `out_of_range` and stay PENDING |
| `*_discount` | `eligible` \| `not_eligible` \| `pending_proof` | — | — |
| `coverage_change` | lowercase text | as spoken | Informational. Advice domain: never asserted by the AI |
| `underwriting_review` | `"true"` \| `"false"` | — | — |
| `premium_new_monthly_usd`, `premium_change_monthly_usd`, `amount_due_today_usd` | dollars with 2 decimals (`"142.00"`, `"-12.50"`) | "$142 a month" | Kit truth numbers (142, 34.1) are formatted the same way before comparing |

`compatible(field, a, b)`:
- Normalized equality.
- **Exception, `driver_full_name`:** the token set of one is a subset of the other ("maya" ⊂ "maya raman"). The merged value is the longer one.

#### 5.4.2 `deriveField` (pure; applied per field over the case's events sorted by `(turnEndMs, seq)`)

```ts
function deriveField(field: FieldId, evs: FactEvent[], ctx: DeriveCtx): FieldState {
  // evs excludes kind=question; includes policy/tool_update/verifier events
  let cur: {value; party; supports: FactEvent[]} | null = null;
  let confirmedBy: FactEvent | null = null;          // cross-party confirmation of cur
  let conflict: FactEvent[] = [], denied = false, aiConfirmed = false;
  for (const e of evs) {
    if (e.valueNorm === null && e.kind !== "ack" && e.kind !== "denied") continue;
    switch (e.kind) {
      case "policy": cur = {value: e.valueNorm, party: "policy", supports: [e]}; confirmedBy = e; break;
      case "tool_update":                              // accepted update_case_field in the AI half (§5.8)
        cur = {value: e.valueNorm, party: "ai", supports: [e]}; confirmedBy = e; aiConfirmed = true; conflict = []; denied = false; break;
      case "stated": case "readback": case "corrected":
        if (!cur || !compatible(field, cur.value, e.valueNorm)) {
          if (cur && e.kind !== "corrected" && e.party !== cur.party && !confirmedBy) conflict = [...cur.supports, e];
          if (e.kind === "corrected" || !cur || confirmedBy === null || e.party === cur.party) {
            cur = {value: e.valueNorm, party: e.party, supports: [e]}; confirmedBy = null; denied = false;
            if (e.kind === "corrected") conflict = [];
          } // else: a new value contradicting a CONFIRMED value by the other party → conflict only (keep cur)
        } else {
          cur.supports.push(e); cur.value = merge(field, cur.value, e.valueNorm);
          if (e.party !== cur.party && !confirmedBy) confirmedBy = e;                  // read_back / both_stated
        }
        break;
      case "ack":
        if (cur && e.party !== cur.party && (e.valueNorm === null || compatible(field, cur.value, e.valueNorm))
            && (e.acknowledgesTurnId === null || cur.supports.some(s => s.turnId === e.acknowledgesTurnId)))
          confirmedBy ??= e;
        break;
      case "denied": if (cur && e.party !== cur.party) { denied = true; confirmedBy = null; } break;
      case "verifier": /* handled below */ break;
    }
  }
  // ---- status ----
  if (!cur) return verifierOnly(field, evs) ?? missing(field);                           // MISSING (absent) or PENDING (verifier_only)
  if (REP_ONLY.has(field) && !cur.supports.some(s => s.party === "rep" || s.party === "ai"))
                                                return pending(cur, "rep_only_violation");
  if (conflict.length && !aiConfirmed)          return pending(cur, "conflict", conflict);
  if (denied)                                   return pending(cur, "denied");
  if (!confirmedBy)                             return pending(cur, "stated_once");
  const involved = [confirmedBy, ...cur.supports];
  if (!aiConfirmed && involved.some(x => x.late || x.cut)) return pending(cur, "late_turn");      // §5.5 late/cut rule
  if (verifierDisagrees(field, cur.value, ctx.verifier) && !aiConfirmed) return pending(cur, "verifier_disagrees");
  return verified(cur, reasonOf(confirmedBy));  // acknowledged | read_back | both_stated | policy_record | ai_confirmed
}
```

#### 5.4.3 Readiness and the verifier overlay

**Readiness:**
- `requiredTotal = REQUIRED.length` = 10. This is the kit's `REQUIRED_FIELDS`.
- `ready` = every required field is VERIFIED, **except** `premium_new_monthly_usd`, which is SERVER_RESOLVABLE and may be MISSING. The premium in the disclosure comes from a VERIFIED rep quote when present, otherwise from the server's rating tool (§5.8). The AI never asks for it.
- The readiness gauge shows `verified/10`. The premium chip reads "rep quote" or "rating tool".

**Verifier overlay:**
- `ctx.verifier` = the latest `VerifierResult` applied while shadowing.
- `verifierDisagrees(field, v, r)` is true when sol reports a non-`absent` support with a value that is not compatible with `v`.
- If sol reports a value for a field that luna left MISSING, `verifierOnly` returns PENDING with the verifier's value and the reason `verifier_only`.
- Sol **never** upgrades a field to VERIFIED.

**Snapshot.** `CaseState` is fully recomputed from events every time (≤ a few hundred events). `deriveCaseState(policy, events, ctx)` is pure and exported for the sweep.

### 5.5 Takeover protocol state machine

#### 5.5.1 Pure reducer

`src/core/protocol/takeover-machine.ts` exports `reduce(state: TakeoverMachineState, ev: TakeoverInput): { state, effects: TakeoverEffect[] }`. `src/client/takeover/controller.ts` executes the effects. That split makes it unit-testable.

#### 5.5.2 Constants

| Constant | Value | Constant | Value |
|---|---|---|---|
| `ARM_TURN_END_MAX_MS` | 1500 | `COMPILE_TIMEOUT_MS` | 1500 |
| `QUIET_REQUIRED_MS` | 400 (both channels < −45 dBFS) | `VA_TOKEN_TIMEOUT_MS` | 3000 |
| `SEAL_TAIL_MS` | 250 | `VA_WS_OPEN_TIMEOUT_MS` | 3000 |
| `FINALS_WAIT_MAX_MS` | 900 | `SESSION_READY_TIMEOUT_MS` | 3000 |
| `DRAIN_MAX_MS` | 2000 | `FIRST_AUDIBLE_TIMEOUT_MS` | 5000 (measured from `session.ready`) |
| `LEAD_MS` | from `ArmResponse.leadMs` (the server's running median of update → first audible over the last 20 takeovers; default 900) | `vaSessionCapMs` | dynamic, from `CompiledTakeover` (§5.9.5); 150–420 s |
| `CLOSE_GRACE_MS` | 2500 | | |

#### 5.5.3 Timeline

`t0` = the click; `tArm` = `callMs` at the click.

```
IDLE(shadowing) --arm--> ARMED                                   [effects: HUD mark t0; UI freeze; fire&forget in parallel:
                                                                   POST /api/takeovers → takeoverToken → POST /api/va/token → new WebSocket(tokenUrl)]
  midUtterance := speaking(rep,200ms) || speaking(customer,200ms) || hasOpenPartial(any)
ARMED --(quiet ≥400 ms on both) | (t0+1500)--> SEALING           [tCut := callMs; playback.stop(30ms fade); play handoff clip (duration R);
                                                                   repLineEnd := now + R; STT channels keep receiving silence]
  capHit := (t0+1500 reached while speaking) → the in-progress turn on the speaking channel will be marked cut
SEALING --(tCut+250)--> for ch: if hasOpenPartial(ch) → stt[ch].forceEndpoint()     // safe: 250 ms of fed silence already
SEALING --(no open partials) | (tCut+900)--> DRAINING            [finals arriving now: late = endMs > tArm; cut = capHit && ch===speakingCh;
                                                                   background: terminate both STT (≤3 s) → /api/sessions/report]
DRAINING --(CaseSync queue empty) | (+2000)--> COMPILING         [DrainReport {completed:[…], pending:[…], waitedMs}]
COMPILING --POST /compile ok | (+1500 → local compile)--> CONNECTING
CONNECTING --(ws open ∧ compiled)--> at tSend = max(now, repLineEnd − LEAD_MS): session.start(config)   // the first session.update
         --(ws not open by +3000 | token error)--> RETRYING
GREETING: session.ready (≤3000) → start customer feeder; player.holdUntil(repLineEnd)
          first audible PLAYED → HUD: click_to_first_audible = tAudible − t0; dead_air_after_rep = max(0, tAudible − repLineEnd)
          (no audible by +5000 after ready | session.error retryable | close) → RETRYING
ACTIVE ⇄ PAYING (hold tool in flight) → CLOSING (send_confirmation result + closing reply.done + 2.5 s quiet | hand_back | cap | user "End call")
CLOSING → session.end → wait session.ended (≤2 s) → close → POST /end → DONE
RETRYING (once): abort old WS (session.end if ready) → POST /events {failure} (sets last_failure_at) →
          /api/va/token {attempt:1} (takeover-keyed; releases the failed slot first) → new WS → same compiled config → GREETING
RETRYING fails → FALLBACK (if a recorded AI session bundle exists for this callId: play it, labelled) else FAILED (error card)
While a VA session is open: POST /events {heartbeat:true} every 10 s
Any state --pagehide--> session.end (sync send) + stt Terminate + navigator.sendBeacon(/end)
```

#### 5.5.4 Rules

1. **ForceEndpoint only in silence.** `forceEndpoint` is only ever called after ≥250 ms of fed silence. It is never called mid-speech: mid-entity it cut 5 entities and raised WER to 13.8% [10b §2].
2. **What the server does at compile time.**
   - It sets `cases.t_arm_ms = tArm`.
   - It marks turns with `endMs > tArm` as `late`, and cut turns as `cut` (from the `DrainReport`).
   - It re-derives the state and **freezes** `takeovers.snapshot`.
   - It flips the case status to `ai_active`.
   - `/api/extract` calls arriving afterwards return `skipped:"after_takeover"`, unless the turn is in `DrainReport.pending` and arrives within 3 s. Those are stored and shown but never alter the snapshot.
3. **Watch vs live.**
   - In Watch mode, `speaking(ch)` is computed from the source samples (RMS over the last 200 ms).
   - In live mode, the rep channel uses the playing rep clip and the customer channel uses the mic worklet RMS.
4. **Pre-update idle `[DAY-1 TEST]`.** The WS opens about 1.5–3.5 s before the first `session.update` (up to 6–10 s on auto-baton, which waits for the rep line and the acceptance). T-D1-3 verifies that the server tolerates ≥10 s of idle before `session.update`, **with a token that expires during the idle** (a 5 s token and an 8 s idle), to prove auth is checked on open only. **Fallback:** open the WS at `COMPILING` instead. That costs about 0.5 s, which the rep line still masks.
5. **Adaptive lead.** The server computes `leadMs` from the `takeovers.protocol` timings of the last 20 successful takeovers: median of `firstAudiblePlayed − sessionUpdateSent`, clamped to 500–1500.
6. **Auto-baton at the recorded handoff line (Watch mode).** If `call.handoff` exists, the takeover isn't `declined`, and the judge hasn't armed by `callMs = handoff.lineStartMs`, the controller arms automatically with `tArm = lineStartMs`. Differences from a manual pass:
   - ARMED → SEALING waits for `acceptEndMs ?? lineEndMs + 1500`. Playback continues through the rep's real line and the customer's real acceptance.
   - No separate handoff clip plays, and `repLineEnd := acceptEndMs`.
   - Everything else is identical.
   - For a **manual** pass, the handoff clip is `rep[lineStartMs..lineEndMs]` + 300 ms + `customer[acceptStartMs..acceptEndMs]`, cut from the same recording (§5.1.1), and `repLineEnd := end of the clip`.
   - `midUtterance` is always false for auto-baton. The sweep's "planned handoff" point uses the same timing.
7. **Recorded AI half (D14).** When the run plan says `aiHalf=recorded`, the manual Pass is disabled. At `handoff.lineStartMs` the controller does not arm; the recording plays through the acceptance, then `ReplayPlayer` plays the call's recorded AI session bundle (its `case.state` events replace the live case card; the judge's shadow lanes are greyed; controls are read-only). A run with no bundle ends with "Call ended: live AI unavailable; see the Explorer".
8. **Releasing the hold.** At the end of the recording without a pass, or on `pagehide`, the client calls `/api/runs/[runId]/release` (beacon), so held VA slots are never wasted.

### 5.6 Deterministic greeting compiler (`src/core/compiler/greeting.ts`)

`compileGreeting(snapshot: CaseState, policy: PolicyRecord): {text, wordCount, asserted: FieldId[], asks: FieldId | null}`. No LLM is involved.

**Sentences, in order:**

1. **Disclosure (mandatory; unit-tested regex `/AI assistant/` ∧ `/not a person/` ∧ `/recorded/`):**
   `Hi {customerFirst}, this is {agencyName}'s AI assistant. I'm an automated assistant, not a person, and this call is still being recorded.`
2. **Handoff summary (VERIFIED only; each clause only if its field is VERIFIED):**
   `{repFirst} passed me your request to add {driverFirst ?? "a new driver"}{ as a driver on the {vehicleLabel}}{, starting {effectiveDateSpoken}}{, at {premiumSpoken}}.`
   - `driverFirst` = the first token of the VERIFIED `driver_full_name`, Title Case.
   - The premium clause appears only if `premium_new_monthly_usd` is VERIFIED from the rep. Otherwise the premium is first spoken in the disclosure.
3. **Opt-out:** `You can ask for {repFirst} at any time.`
4. **Next step (exactly one):**
   - If any PENDING field (priority order below): `Just to confirm, {confirmPhrase(field, value)}. Is that right?`
   - Else if any required MISSING field: `To finish up, I just need {askPhrase(field)}.`
   - Else: `I have everything I need, so next I'll read you the updated premium. Ready?`

**Priority order** (never includes the premium, discounts, `coverage_change` or `underwriting_review`): `driver_full_name, driver_relation, driver_dob, license_state, license_status, incidents_3y, vehicle_assignment, operator_type, garaging_zip, effective_date`.

**Phrase table** (in `intents/add-driver.ts`; `{d}` = driver first name or "the new driver"):

| Field | `confirmPhrase` | `askPhrase` |
|---|---|---|
| driver_full_name | `the new driver's name is {v}` | `the new driver's full name` |
| driver_relation | `{d} is your {relWord}` | `how {d} is related to you` |
| driver_dob | `{d}'s date of birth is {spoken}` | `{d}'s date of birth` |
| license_state | `{d}'s license is from {StateName}` | `which state issued {d}'s license` |
| license_status | `{d} has a {licenseWords}` | `whether {d} has a learner's permit, a probationary license or a full license` |
| incidents_3y | `{d} has had no tickets or accidents in the last three years` (or `…: {text}`) | `whether {d} has had any tickets or accidents in the last three years` |
| vehicle_assignment | `{d} will mainly drive the {label}` | `which car {d} will mainly drive` |
| operator_type | `{d} will be the {primary\|occasional} driver of the {label}` | `whether {d} will drive the {label} every day or just occasionally` |
| garaging_zip | `the car is kept at ZIP code {digits spaced}` | `the ZIP code where the car is kept overnight` |
| effective_date | `the change should start {spoken}` | `the date you'd like this change to start` |

**Spoken formats** (`compiler/spoken.ts`):
- Date: `Friday, October 2nd`.
- Money: `$142 a month`.
- ZIP: `4 4 1 0 7`.
- Age: `17`.
- Vehicle: the label.

**Length cap.** If the word count is over 70, drop the date clause, then the vehicle clause.

**Invariant (asserted, and tested with property tests):** every value in the text belongs to a VERIFIED field, except the one confirm clause, which carries a PENDING value.

**Examples.**

`s01` at the planned handoff (everything VERIFIED, premium quoted by the rep):

> "Hi Priya, this is Harborview Insurance Agency's AI assistant. I'm an automated assistant, not a person, and this call is still being recorded. Daniel passed me your request to add Maya as a driver on the 2021 Honda Civic, starting Friday, October 2nd, at $142 a month. You can ask for Daniel at any time. I have everything I need, so next I'll read you the updated premium. Ready?"

`s02` (`effective_date` PENDING, "tomorrow" = Saturday, September 26th):

> "…Daniel passed me your request to add Lucas as a driver on the {vehicle}. You can ask for Daniel at any time. Just to confirm, the change should start Saturday, September 26th. Is that right?"

### 5.7 Voice Agent system prompt template (`src/core/compiler/prompt.ts`, `PROMPT_V3`)

```
IDENTITY
You are {agencyName}'s automated AI assistant finishing a policy change that a licensed representative, {repFirst},
started with the customer, {customerFirst} {customerLast}. You already said the greeting. You are not a person; if asked, say so.
TODAY is {callDateSpoken} (the date of this call, e.g. "Friday, September 25, 2026"). Resolve relative dates against TODAY.
You handle ADMINISTRATIVE steps only. You never give insurance advice, never recommend coverages, limits or deductibles,
and never explain what is or isn't covered. If the customer asks for advice or anything outside this change, call
hand_back_to_rep with reason "advice_requested" (or "out_of_scope").

CASE STATE (authoritative; VERIFIED = already confirmed with the customer)
{caseStateJson}

RULES
1. Never ask for a VERIFIED field, and never ask the customer to repeat it.
2. Confirm PENDING fields one at a time by reading the value back. If the customer confirms or corrects it, call update_case_field.
3. Ask for MISSING fields one at a time; when answered, call update_case_field.
4. If the customer disputes a VERIFIED value, call update_case_field with their value and reason "customer_corrected";
   if the result is "conflict", read back the recorded value, ask which is right, and call update_case_field again with
   reason "customer_corrected" only if they insist. Never silently change a VERIFIED value.
5. State a premium, amount or date ONLY if it comes from CASE STATE or a tool result. Never estimate or compute money.
6. When a tool returns disclosure text, read it EXACTLY as written, word for word, then stop and wait for the answer.
7. Never ask for, repeat, or accept card numbers, bank details or passwords. Payment happens only through the secure link.
   If the customer starts reading a card number, stop them politely and explain the link.
8. One question per turn. Short sentences. Natural US English. Say ZIP codes digit by digit.
9. If the customer asks for {repFirst}, or is upset or confused twice, call hand_back_to_rep.
10. Discounts, coverage limits, deductibles and underwriting are {repFirst}'s decisions. Never offer, re-offer or
    change them; if the customer brings them up, say {repFirst} will follow up, or call hand_back_to_rep.

CURRENT STAGE: {stage}
{stageInstructions}

(internal ref: baton-deploy={BATON_DEPLOY_ID}; never mention this)
```

The last line is the **deploy marker** read by the F6 audit. It is excluded from `promptVersion`.

**`caseStateJson`** is compact JSON, capped at 1800 chars:

```json
{"intent":"add_driver","policy":"NBM-4418207","vehicles":{"veh1":"2021 Honda Civic","veh2":"2018 Toyota Highlander"},
 "fields":{"driver_full_name":{"status":"VERIFIED","value":"Maya Raman"},
           "vehicle_assignment":{"status":"VERIFIED","value":"2021 Honda Civic"},
           "effective_date":{"status":"PENDING","value":"Friday, October 2nd"},
           "license_state":{"status":"MISSING"}, "...": "..."},
 "decided_by_rep":{"good_student_discount":"eligible","coverage_change":"keep current limits"}}
```

It lists the 10 required fields plus any non-MISSING optional ones. Advice-domain fields go under `decided_by_rep` (read-only context). It never contains the premium unless the rep quoted it.

**Stage instructions:**

| Stage | Instructions |
|---|---|
| `confirm` | "Resolve every PENDING and MISSING required field, using confirm_effective_date for the date and update_case_field for everything else. When all required fields are VERIFIED, the system gives you the next step." |
| `disclose` | "Call get_disclosure with kind "premium_change" and read it exactly. If the customer agrees, call get_disclosure with kind "esign_consent" and read it exactly. If they decline the premium, call hand_back_to_rep with reason "customer_declined"." |
| `pay` | "The customer agreed to the e-signature and text. Call send_esign_and_pay_link now with their words. While it runs, stay quiet unless asked; the system gives status updates." |
| `close` | "Payment is confirmed. Call send_confirmation, read the confirmation number digit by digit, ask if there is anything else about this change, then say goodbye." |

**Size and versioning.** Keep the template under 3500 chars. `promptVersion = sha256(template).slice(0,8)` is stored on the takeover.

### 5.8 Tools: exact JSON schemas, stages, handler semantics

`src/core/compiler/tool-schemas.ts` exports `TOOL_SCHEMAS: Record<ToolName, VaFunctionTool>` and `toolsForStage(stage): VaFunctionTool[]`. All tools are `type:"function"` client tools. The browser handler calls `POST /api/tools/[name]` and returns the `result` object.

```jsonc
[{"type":"function","name":"confirm_effective_date","execution_mode":"interactive","timeout_seconds":10,
  "description":"Record the date the customer confirmed or chose for this change to take effect. Call only after the customer says the date or clearly confirms it.",
  "parameters":{"type":"object","required":["date","customer_words"],"properties":{
    "date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD","examples":["2026-10-02"]},
    "customer_words":{"type":"string","description":"The customer's exact words"}}}},
 {"type":"function","name":"get_disclosure","execution_mode":"interactive","timeout_seconds":10,
  "description":"Get disclosure text that you must read to the customer word for word.",
  "parameters":{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","enum":["premium_change","esign_consent"]}}}},
 {"type":"function","name":"send_esign_and_pay_link","execution_mode":"hold","timeout_seconds":120,
  "description":"Text the customer a secure link to e-sign the change and pay the amount due today. Only after the customer agreed to the premium and to receiving the text. Returns when payment finishes, fails or times out.",
  "parameters":{"type":"object","required":["customer_agreed_to_text","paper_copy_requested","customer_words"],"properties":{
    "customer_agreed_to_text":{"type":"boolean"},"paper_copy_requested":{"type":"boolean"},
    "customer_words":{"type":"string","description":"The customer's exact words agreeing"}}}},
 {"type":"function","name":"send_confirmation","execution_mode":"interactive","timeout_seconds":10,
  "description":"Finalize the change and text a confirmation. Only after payment is confirmed.",
  "parameters":{"type":"object","required":[],"properties":{}}},
 {"type":"function","name":"update_case_field","execution_mode":"interactive","timeout_seconds":10,
  "description":"Record a field value the customer just confirmed, corrected or newly provided.",
  "parameters":{"type":"object","required":["field","value","reason"],"properties":{
    "field":{"type":"string","enum":["driver_full_name","driver_dob","driver_relation","license_state","license_status",
                                     "license_number","incidents_3y","vehicle_assignment","operator_type","garaging_zip"]},
    "value":{"type":"string","description":"As spoken; date of birth as YYYY-MM-DD; state as 2 letters; ZIP as 5 digits; vehicle as year make model"},
    "reason":{"type":"string","enum":["customer_confirmed","customer_corrected","newly_provided"]}}}},
 {"type":"function","name":"hand_back_to_rep","execution_mode":"interactive","timeout_seconds":10,
  "description":"Return the call to the human representative. After calling it, say one short sentence that the rep is coming back.",
  "parameters":{"type":"object","required":["reason","summary"],"properties":{
    "reason":{"type":"string","enum":["advice_requested","customer_request","conflict","customer_declined","out_of_scope","payment_problem","other"]},
    "summary":{"type":"string","description":"One sentence for the rep"}}}}]
```

**Stage lists** (always the full list; `update_case_field` and `hand_back_to_rep` are in every stage):

| Stage | Tools |
|---|---|
| `confirm` | `confirm_effective_date`, `update_case_field`, `hand_back_to_rep` |
| `disclose` | `get_disclosure`, `confirm_effective_date`, `update_case_field`, `hand_back_to_rep` |
| `pay` | `send_esign_and_pay_link`, `get_disclosure`, `update_case_field`, `hand_back_to_rep` |
| `close` | `send_confirmation`, `update_case_field`, `hand_back_to_rep` |

**Initial stage.** `disclose` if `readiness.ready`, else `confirm`. Neither initial stage contains a `hold` tool: `send_esign_and_pay_link` (the only `hold` tool) first appears in `pay`, through a mid-session `session.update`, where a validation error is non-fatal (`E_VA_CONFIG`, then `PAY_TOOL_MODE=push`).

**Schema rules** (from the verified `lookup_policy` schema [10 §3.5]): `type`, `required`, `properties`, `enum`, `description`, `pattern`, `examples` only. No `format`, no `oneOf`/`anyOf`, no `$ref`.

**Handler semantics** (`src/server/tools/*`; each handler is idempotent on `(takeoverId, callId)` and appends a `tool_calls` row):

| Tool | Server behaviour | `result` (JSON string sent as `tool.result`) |
|---|---|---|
| `confirm_effective_date` | Resolves `customer_words` **server-side** with the same normalizer as the extractor ("this Friday" → 2026-10-02, against `callDate`). If that parses and disagrees with the LLM's `date`, the server's value wins (logged). Validates that the date is between `callDate` and `callDate + 30` days (a carrier-style guardrail). On OK, appends a `tool_update` fact event (effective_date, party `ai`) and re-derives. If ready, `stage → disclose` | `{"accepted":true,"effective_date":"2026-10-02","spoken":"Friday, October 2nd","next":"disclose"}` or `{"accepted":false,"reason":"out_of_range","allowed":"today to October 25th"}` |
| `update_case_field` | Normalizes the value. **Rules:**<br>• if the field is VERIFIED and the value is incompatible, and this is the first attempt → `conflict`;<br>• if the same field is updated again within this takeover with reason `customer_corrected` → accepted, flagged `customer_corrected_verified` (a conflict card for rep review);<br>• if PENDING or MISSING → accepted (`tool_update`, VERIFIED via `ai_confirmed`);<br>• an unparseable value → `rejected`.<br>May advance the stage | `{"result":"accepted","field":"license_state","status":"VERIFIED","value":"WI"}` · `{"result":"conflict","field":"vehicle_assignment","recorded_value":"2021 Honda Civic","instruction":"Read back the recorded value and ask which is right."}` · `{"result":"rejected","reason":"unparseable"}` |
| `get_disclosure` | Requires `stage ∈ {disclose, pay}` and `readiness.ready`; otherwise `{ok:false, missing:[…]}`. **Premium source:** a VERIFIED rep-quoted `premium_new_monthly_usd`, else `mockRating(scenario)` = `scenario.rating.newMonthlyUsd`. This is the kit's `premium_new_monthly_usd` truth, standing in for the carrier rating engine; it is labelled "rating tool" in the UI. **Due today** is `amount_due_today_usd` when the rep quoted it or the scenario defines it. Otherwise it is the prorated difference to the end of the calendar month: `(new − current) × daysLeft/daysInMonth`, min $0.50, rounded to cents. The text is recorded in `takeovers.metrics.disclosures[kind]` for the verbatim check. After `esign_consent` is retrieved → `stage = pay` | `{"ok":true,"disclosure_id":"dsc_…","text":"<exact text>","instruction":"Read this exactly, then wait for the answer."}` |
| `send_esign_and_pay_link` | Requires `customer_agreed_to_text === true`, otherwise `{status:"not_sent", reason:"consent_required"}`. Creates a payment (§5.12). Returns **immediately to the browser handler** with `ui.sms`, `ui.link` and `ui.paymentId`. The browser handler then **holds** (does not send `tool.result`) until the payment resolves (see the hold protocol below). The amount in the result is **Polar's `total_amount`**, never a local number | Final: `{"status":"paid","amount":"$23.40","receipt":"PAY-…","verified_by":"polar_webhook"\|"simulated"}` / `{"status":"failed"\|"expired"\|"timeout","instruction":"Tell the customer the link stays valid for 24 hours and offer to hand back to the rep."}` |
| `send_confirmation` | **Server-authoritative:** requires `payments.status='succeeded'` with a source of `webhook`, `server_poll` or `mock`. Otherwise `{ok:false, reason:"payment_not_confirmed"}`. Issues `confirmationNumber = "END-" + 5 digits` (stored), SMS `ui.sms`, case `completed` | `{"ok":true,"confirmation_number":"END-48213","spoken":"E N D 4 8 2 1 3","sms_sent":true}` |
| `hand_back_to_rep` (`interactive`) | Case `handed_back`. Returns immediately. The browser sends the `tool.result`, lets the agent finish its one-sentence reply (≤4 s after `reply.done`), then plays Daniel's recorded "I'm back" line (from the tail pack, §11.6; else TTS `cedar`, labelled), ends the Voice Agent session and shows the hand-back card with **Pass the baton again** | `{"status":"transferring","message":"Tell the customer {repFirst} is coming back on the line now."}` |

**Disclosure texts** (`compiler/disclosures.ts`; SAMPLE, not legal advice, per 13 §3.6):
- **`premium_change`:** "Here's the change. We're adding {d} as a {licenseWords} driver on the {vehicleLabel}, starting {dateSpoken}. Your new premium is {monthly} a month, and {dueToday} is due today, prorated for the rest of this billing period. The change is subject to the terms of your policy. Would you like me to go ahead?"
- **`esign_consent`:** "I'll text a secure link to the number on file ending in {last4 spaced}, so you can review and sign this change electronically and pay the {dueToday}. You can ask for a paper copy instead, and you can withdraw consent to electronic documents at any time. Is it OK if I text you that link now?"
- **Critical tokens for the verbatim check:**
  - premium: `{monthly}`, `{dueToday}`, the date, `{d}`;
  - esign: the last 4 digits, "electronically", "paper copy".
- **Tax.** The checkout is created tax-inclusive (§5.12), so `{dueToday}` equals Polar's `total_amount`. If T-D1-9 shows the totals cannot be made equal, `premium_change` gains "plus any applicable tax" after `{dueToday}` (and that phrase joins the critical tokens) through the flag `DISCLOSURE_TAX_SUFFIX=1`.

**Hold protocol for `send_esign_and_pay_link`** (`PAY_TOOL_MODE=hold`, default; `[DAY-1 TEST]` T-D1-1 [01 §8.4]). **Progress-aware**: the client knows the MockPhone state, so the hold follows what the judge is doing.
1. When `tool.call` arrives, the handler POSTs the tool route and gets `ui.*`. The UI shows the SMS on the floating MockPhone.
2. Immediately: `reply.create{instructions: "Tell the customer in one short sentence that you've texted the secure link and you'll wait while they sign and pay."}`. This is a mid-hold status update.
3. The handler polls `GET /api/payments/[id]` every 1.5 s:
   - at `status='succeeded'` → `tool.result {status:"paid"…}`, then the server stage becomes `close`. The client sends `session.update{system_prompt, tools}` **first**, then the `tool.result` (§5.9.4).
   - `failed`/`expired` → the corresponding result.
4. **Deadline:** 60 s from the SMS while the phone is `sms-received`. While the phone is in `esign`, `signed`, `checkout-loading`, `checkout-open`, `processing` or `simulating`, the deadline extends in 30 s steps up to **180 s** in total.
5. **Reassurance** at +45 s and then every 45 s: `reply.create{instructions:"Briefly reassure the customer you're still here and the link is on their phone."}`, **suppressed while the Polar overlay is open or processing**.
6. **Autopilot countdown** (Autopilot on, phone untouched 15 s after the SMS): a visible 10 s countdown, then `POST /simulate` (§1.3 P1 step 6).
7. At the deadline: `tool.result {status:"timeout"}` and the phone closes the Polar overlay.
8. **Late success.** If the payment succeeds after `timeout` and the session is still open: `session.update{stage close}` then `reply.create{instructions:"The payment just came through. Call send_confirmation now."}` (the same path as push mode).

**Fallback `PAY_TOOL_MODE=push`** (used if the hold test fails):
- The tool is `interactive`. It returns `{status:"link_sent"}` immediately, and the prompt tells the agent to wait.
- On payment: `session.update{stage close}`, then `reply.create{instructions:"Payment is confirmed. Call send_confirmation now."}`.

### 5.9 Voice Agent session mechanics (`src/client/va/controller.ts`)

#### 5.9.1 First message

`VoiceAgentSession.start(config)` sends:

```json
{"type":"session.update","session":{
  "system_prompt":"<compiled>","greeting":"<compiled; never null, never omitted in Baton>",
  "input":{"format":{"encoding":"audio/pcm","sample_rate":24000},"transcription_mode":"<compiled.transcriptionMode>"
           /* ,"keyterms":["<≤100 items, ≤50 chars>"]  only when VA_KEYTERMS=1 (after T-D1-0 passes) */},
  "output":{"voice":"alba","format":{"encoding":"audio/pcm","sample_rate":24000}},
  "tools":[/* toolsForStage(initial): interactive tools only */]}}
```

- **`validateFirstUpdate(msg)`** (`src/core/compiler/first-update.ts`, pure, run on the server at compile **and** on the client before sending). A whitelist of live-verified keys and values; anything else throws `E_VA_CONFIG` before a byte is sent:
  - top-level `session` keys ⊆ {`system_prompt`, `greeting`, `input`, `output`, `tools`};
  - `input` keys ⊆ {`format`, `transcription_mode`, `keyterms`}; `keyterms` only if `VA_KEYTERMS=1`, ≤100 items, each ≤50 chars;
  - `transcription_mode` ∈ {`min_latency`, `balanced`, `max_accuracy`};
  - `output.voice` ∈ the 18 verified ids (§A.4); both formats exactly as above;
  - every tool: `type:"function"`, `execution_mode:"interactive"`, `timeout_seconds` ≤ 30, and a parameters schema that uses only the keywords allowed in §5.8;
  - `greeting` is a non-empty string; `system_prompt` ≤ the verified size.
- A bad first update is fatal (close 1008) [10 §3.5]. **T-D1-0** (D1, before WP5b builds) sends the exact compiled first update for both initial stages (`confirm`, `disclose`), asserts `session.ready`, and diffs `session.ready.config` against what was sent (`input.transcription_mode`, `input.keyterms` when on, `tools[].execution_mode`).
- `input.keyterms` (when on) = snapshot values (driver name, vehicle label tokens, relationship word), plus the policyholder name, agency and rep name.
- **Input mode per next step** (`inputModeFor(nextStep)` in `src/core/compiler/stages.ts`), following the golden config [10 §3.5 rule 9]:
  - `balanced` when the next step asks for a MISSING entity (`driver_dob`, `garaging_zip`, `license_state`, `driver_full_name`, `vehicle_assignment`);
  - `max_accuracy` only while asking for `license_number` (+1.3 s, rare);
  - `min_latency` for yes/no confirmations and the disclosure answers.
  The first update carries the mode for the greeting's next step. Later changes are sent as `session.update{input:{transcription_mode}}` together with stage updates or after an `update_case_field` result that carries `transcriptionMode`. If T-D1-4 shows the mode is immutable mid-session, the first update uses `balanced` whenever the snapshot has any MISSING entity field, else `min_latency`.

#### 5.9.2 Audio in

- A 24 kHz PCM16 `PacedFeeder`, running on the **customer-feeder worklet** clock. It emits 50 ms = 2400 B frames. Silence is sent when no clip or mic audio is queued.
- It starts on `session.ready`; nothing is sent before that.
- Sources, in priority order: mic frames (mic mode), queued clips (chips/typed/autopilot), silence.
- Every frame becomes `input.audio` (base64).

#### 5.9.3 Audio out

`VaOutputPlayer` is a worklet ring buffer:
- It receives `reply.audio` base64 → Int16 24 kHz, plus the `replyId`.
- **Leading-silence trim:** while `ReplyTracker.current.firstAudibleAtMs` is undefined, chunks with `chunkLevelDb ≤ −50` are dropped [10a §15].
- It starts output once ≥120 ms is buffered, or 200 ms after the first kept chunk. **Adaptive:** after an underrun it raises the start threshold by 80 ms (up to 400 ms) for the rest of the session. Underruns are counted in the HUD.
- If the WebSocket's `bufferedAmount` holds more than ~1 s of outgoing audio (slow uplink), the page shows a "slow network" badge.
- `holdUntil(t)`: output does not start before `t` (the end of the rep line). The backlog is kept, never dropped.
- `flush()` empties the buffer, is idempotent, and posts `flushed`.
- It resamples 24 kHz → `ctx.sampleRate` inside the worklet (linear, stateful).
- It reports `playedFirstAudible(replyId, ctxTime)` back to the main thread for the HUD. This is the moment the judge **hears** it, not when the bytes arrived.

#### 5.9.4 Tools

- `ToolDispatcher.policy = "immediate"`: `tool.result` is sent as soon as the handler resolves, which is accepted and about 1 s faster [10a §7]. Results for interrupted replies are dropped (built in).
- **Stage change ordering:** when a tool response contains `stage`, the controller sends, in this order on the same socket:
  1. `session.update{system_prompt: resp.systemPrompt, tools: resp.tools}` (the full list);
  2. `tool.result`.
- **`[DAY-1 TEST]`** Check that the reply fired by `tool.result` sees the new tools. **Fallback:** wait for `session.updated` (≤400 ms) before sending `tool.result`.

#### 5.9.5 Mid-session context, cap and ending

- Mid-session context uses `session.update{system_prompt}` (durable) or `reply.create{instructions}` (one turn). **Never** `conversation.message` [10 §0.4].
- **Dynamic, stage-aware cap.** The server computes `vaSessionCapMs = min(VA_SESSION_CAP_MAX_MS, VA_SESSION_CAP_BASE_MS + VA_SESSION_CAP_PER_FIELD_MS × (pending + missing required fields at the snapshot))`, i.e. 150 s + 15 s per open field, at most 420 s. The client adds the time spent in `paying` (the wrap-up clock is **paused** while the hold is in flight). At effective cap − 20 s, and **never** in `paying` or `closing`: `reply.create{instructions:"Tell the customer you need to wrap up and that {repFirst} will follow up on anything left."}`. The absolute ceiling (`VA_SESSION_CAP_MAX_MS` + 180 s of hold) ends the session in any stage. The ledger reserves the maximum (≈$0.53) and settles the actual duration.
- End: `s.end()` (`session.end` → `session.ended` → close). This also runs on `pagehide` (a synchronous `ws.send` of `session.end`, then `sendBeacon` to `/end`).

#### 5.9.6 Errors

| Error | Action |
|---|---|
| `errorCode(ev)` ∈ `RETRYABLE_ERROR_CODES` | RETRYING (once) |
| `unauthorized` | `E_VA_AUTH` → RETRYING with a new takeover-keyed token (`attempt:1`, once) |
| Close 1008 right after the **first** update | `E_VA_CONFIG`: a bug (T-D1-0 and `validateFirstUpdate` should prevent it). No retry with the same config; recorded AI session |
| `invalid_value` / `invalid_format` / `immutable_field` mid-session | Log `E_VA_CONFIG`. The session stays open; continue without that update |
| `ReplyTracker.kind === "silent_no_output"` | `E_VA_SILENT`. Once: `reply.create{instructions:"Please continue."}`. Twice → RETRYING |

### 5.10 Audible-latency HUD, captions, barge-in

#### HUD marks (`src/client/hud/latency.ts`)

`mark(name, ctxTime)`. The marks are:
- `arm`;
- `repLineStart` / `repLineEnd`;
- `updateSent`;
- `sessionReady`;
- per reply: `eos` (end of customer speech), `replyStarted`, `firstAudiblePlayed`.

**Metric definitions:**

| Metric | Definition |
|---|---|
| `click_to_first_audible` | `firstAudiblePlayed(greeting) − arm` |
| `dead_air_after_rep` | `max(0, firstAudiblePlayed(greeting) − repLineEnd)` |
| `turn_audible_latency` | `firstAudiblePlayed(reply) − eos` |
| `tool_turn_latency` | The same, for a reply whose predecessor was a `tool_preamble` |

Sources for `eos`:
- **Chips, typed, autopilot:** `eos` = the exact end time of the clip in the feeder.
- **Mic:** the local VAD end (RMS < −45 dBFS for 300 ms). If unavailable, the receipt time of `input.speech.stopped`.

**Display:**
- The last value, plus p50/p90 over the session.
- A tooltip: "Measured in your browser: from the end of the customer's speech to the first audible AI audio, including your network. Leading silence is trimmed."
- Values are posted to `/api/takeovers/[id]/events`.

**Reference numbers (India → US) [10 §3.5, 10a §4.2, §7]:**

| Turn type | End of speech → first audible |
|---|---|
| Plain turn, `min_latency` | 2.1–2.6 s |
| Plain turn, `balanced` | ≈ +0.7 s |
| Speech-triggered tool turn, `min_latency`, immediate `tool.result` | ≈3.5–5 s (the 2.8–2.9 s figures were `reply.create`-triggered with no endpointing, so they are not used in claims) |

The HUD leads with **dead air after Daniel's line** and shows click → first audible with the note "includes Daniel's ≈3.5 s handoff line", so a 4,100 ms figure doesn't read as slow. The video and the tooltip use the ranges above.

#### Caption rules

1. `transcript.agent.delta` words arrive in a burst. Each is shown at `playStart(reply) + (start_ms − leadingSilenceMs)`. If `start_ms` is null, all words show at `playStart`.
2. Never caption replies with `kind ∈ {tool_preamble, unspoken_text}`. The kind is only known at `reply.done`, so buffer the captions of a reply until its first audible chunk has **played**. A reply with no audible chunk never shows captions. If `transcript.agent` arrives for such a reply, render nothing.
3. For an interrupted reply, stop at the last word whose scheduled time is ≤ the flush time, and append "—".
4. Customer lane (AI half): replace with `transcript.user.delta.text` for the same `item_id`; finalize on `transcript.user`.

#### Barge-in

- On the **first** of `input.speech.started`, `reply.done{status:"interrupted"}` or `transcript.agent{interrupted:true}`: `player.flush()`, cancel pending captions and mark the reply interrupted. These events arrive together, 1.1–2.2 s after the customer starts speaking.
- **Mic mode only:** a local VAD onset ducks agent playback to 30% within 50 ms (a perceived-responsiveness aid). If no server barge-in follows within 2.5 s, restore the volume.
- Autopilot never barges in: it waits for `reply.done`.

### 5.11 Evidence chips and clip padding (`src/core/evidence/clip.ts`)

`clipWindow(ev: Evidence, turn: {words, startMs, endMs}, kind: "stream" | "async", durationMs) → {fromMs, toMs}`.

**Streaming words** (the human half) [10b ST-6: the first word of a turn starts ≈990 ms early; the last word ends 0.24–1.3 s late]:
- `from = ev.startMs − (quote starts at the turn's first word ? 0 : 400)`.
- `to = ev.endMs + (quote ends at the turn's last word ? 0 : 300)`.

**Async words** (the AI half, 80 ms quantized) [10 A7]:
- `from = ev.startMs − 300`, `to = ev.endMs + 300`.

**Clamps:**
- Clamp to `[0, durationMs]`.
- Enforce a minimum length of 1500 ms by extending both sides equally.
- Cap at 8000 ms, keeping the start.

**Playback:**
- **Human half, Watch mode:** a one-shot source from the loaded call buffers. Only the speaking channel plays, center-panned, with a 20 ms fade in and out. While a clip plays during live playback, the call is ducked to 20% (the STT feed is unaffected: it reads source bytes, not the mix).
- **Live mic mode:** clips come from a local ring buffer of the session's customer PCM (kept in memory, never uploaded).
- **AI half:** `GET /api/va-sessions/[id]/audio` gives a 302 to a fresh pre-signed OGG URL (TTL 1 h; eu-west-1 S3), which plays in an `<audio>` element with a media fragment `#t=from,to`.
  - Safari can't play Ogg Opus reliably. On `error`, show "clip unavailable in this browser" with a transcript popover instead.
  - Chips for AI-half facts appear only after verification.

### 5.12 Polar checkout flow (fail-closed)

#### Setup (`scripts/polar/setup.ts`, run once by the user)

In the **sandbox** org it creates:
1. A one-time product "Baton demo: policy change payment (sandbox)" with a nominal fixed catalog price. Every checkout overrides it with an **ad-hoc** price (below).
2. One sandbox **demo customer per published scenario** (fictional name such as "Priya Raman", the org-member alias email, the scenario's fictional US address). It prints `POLAR_DEMO_CUSTOMERS` as JSON.

It prints the product id, which is not a secret. The webhook endpoint is registered manually in the dashboard (§10.2).

SDK 0.49.0 uses camelCase in TypeScript: `amountType`, `priceAmount`, `priceCurrency`, `taxBehavior`, `recurringInterval: null`, `customerId`, `allowDiscountCodes`, `embedOrigin`, `customerBillingAddress{country, line1, city, state, postalCode}`. WP6 writes these exactly and lets `tsc` confirm them.

#### Create (`PaymentProvider.createCheckout`, provider `polar`)

```ts
const polar = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: "sandbox" });
const co = await polar.checkouts.create({
  products: [env.POLAR_PRODUCT_ID],
  prices: { [env.POLAR_PRODUCT_ID]: [{ amountType: "fixed", priceAmount: dueTodayCents, priceCurrency: "usd",
                                       taxBehavior: "inclusive" }] },  // ad-hoc price: fixed, not editable, tax-inclusive [12 §5, §12]
  customerId: demoCustomers[scenarioId],                   // prefills AND locks name + email (a fictional sandbox customer)
  customerBillingAddress: { country: "US", line1: policy.address.street, city: policy.address.city,
                            state: `US-${policy.address.state}`, postalCode: policy.address.zip },   // fictional scenario address
  allowDiscountCodes: false,
  embedOrigin: validatedOrigin,                            // the request's Origin, if it is in EMBED_ORIGINS; else APP_URL
  // successUrl only for the hosted new-tab variant: `${origin}/pay/done?checkout_id={CHECKOUT_ID}`; never for the embed
  metadata: { paymentId, caseId, takeoverId },
});
```

- Store `checkout_id`, `url`, status `open`, and Polar's `total_amount` / `tax_amount`.
- **Amount check (fail-closed):** on create, on every webhook and on every server poll, require `total_amount === amount_cents`. A mismatch sets `failed` with `failure_reason='amount_mismatch'`, and the judge is offered Simulate.
- Do not persist `client_secret`. Return it once only if the embed needs it.
- `@polar-sh/checkout` works from `url`.
- **`[DAY-1 TEST]` T-D1-9** checks: SDK 0.49.0 accepts the ad-hoc `prices` map with `taxBehavior`; the checkout shows no editable amount field; `totalAmount === amountCents` and `taxAmount` is 0 or included; name and email are prefilled and locked; the US address prefill skips the address form; discount codes are hidden. **Fallbacks, in order:** a catalog price with `taxBehavior:"inclusive"` + `amount`; the "plus any applicable tax" disclosure (§5.8); mock.
- Errors: 1 retry after 1 s. Then **mock fallback**: provider `mock`, and the UI label "Simulated payment (Polar unavailable)".

#### Client

- **E-sign sheet:** `POST /esign` records consent with a timestamp.
- **Pay:** on the Pay tap, copy the test card to the clipboard and show it on the sheet (S6), then `const co = await PolarEmbedCheckout.create(url, {theme})`.
- **Embed events: never navigate.** Register the listeners at create:
  ```ts
  co.addEventListener("success", (e) => { e.preventDefault(); reconcile(); });   // prevents window.location = successURL
  co.addEventListener("confirmed", () => reconcile());
  co.addEventListener("close", () => phone.onOverlayClosed());
  ```
  `@polar-sh/checkout@0.4.1` dispatches the event and only runs `handleSuccess` (`window.location.href = successURL` when `redirect` is true) if it was not default-prevented, so `preventDefault()` is mandatory. `reconcile()` = `GET /api/payments/[id]?reconcile=1`, which makes the server call `polar.checkouts.get`. Events never set a status themselves.
- **Closing the overlay** is ours (S6): `co.close()` on server `succeeded`/`failed`/`expired`, on hold timeout, on Simulate and on hand-back.
- **Hosted fallback:** a visible `<a href={url} target="_blank" rel="noopener">Open checkout in a new tab</a>` from `checkout-loading` onwards; never a timer-driven `window.open`. `/pay/done` says "Payment received: return to the Baton tab" and calls reconcile.
- **Simulate:** always offered next to Pay (route #17).

#### Webhook verification (`src/server/polar/webhook.ts`)

```ts
import { Webhook } from "standardwebhooks";
export function verifyPolarWebhook(raw: string, headers: Headers, secret: string): unknown {
  const h = { "webhook-id": headers.get("webhook-id") ?? "", "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
              "webhook-signature": headers.get("webhook-signature") ?? "" };
  const attempts = [secret, Buffer.from(secret, "utf-8").toString("base64")];  // Standard Webhooks as-is, then legacy Polar HMAC
  for (const key of attempts) { try { return new Webhook(key).verify(raw, h); } catch { /* next */ } }
  throw new PolarSignatureError();                                            // → 403
}
```

- **Unit test:** sign a payload with each scheme, and verify that both are accepted and a tampered body is rejected.
- **Route:** `const raw = await req.text()` → verify → idempotency insert → map the event:
  - `checkout.updated` with `data.status` ∈ {`confirmed`, `succeeded`, `failed`, `expired`};
  - `order.paid` → `succeeded`;
  - `checkout.expired` → `expired`.
  - Respond 202 in < 2 s.
- **Unknown events:** 202, ignored.

#### State machine (server; forward-only)

```
created → open → confirmed → succeeded
open|confirmed → failed | expired          (failed includes failure_reason=amount_mismatch)
created|open|confirmed|failed|expired|timeout → succeeded(simulated, source mock)   (only via POST /simulate)
any → timeout        (only by the hold handler at its progress-aware deadline; timeout is a UI state and does NOT block a
                      later webhook from setting succeeded, which then triggers the late-success path of §5.8)
```

**Fail-closed rules:**
- `succeeded` is set **only** by a verified webhook, a server GET to Polar, or mock mode.
- `send_confirmation` checks it server-side.
- A client-reported success means nothing.

#### Polling

- The client polls `GET /api/payments/[id]` every 1.5–2 s during the hold, and ignores 429s silently.
- The server itself GETs Polar when the status is `open` or `confirmed` and the last server check was more than 8 s ago, and on `reconcile=1`.
- Polar's sandbox limit is 100 req/min. With one hold at a time this stays under 10/min.

### 5.13 QA: deterministic re-ask counter and disclosure-verbatim check (`src/core/qa/*`)

`computeQa(input: QaInput): QaResult`. Inputs:
- `snapshot` (`CaseState` at takeover);
- `ch2`/`ch1` utterances with words (async multichannel; ch1 = user, ch2 = agent [10a §11]);
- `toolCalls` (from the timeline);
- `disclosures` (from `takeovers.metrics`);
- `greeting`.

The **provisional** variant uses `transcript.agent` finals with `kind === "speech"` and no timings.

#### Algorithm

1. **Sentences.** Split each ch2 utterance on `(?<=[.?!])\s+`, keeping word timings.
2. **Exclude disclosure spans.** For each disclosure, find its best-matching span (step 6) and drop the sentences inside it. The greeting sentences are **not** excluded, which is how the greeting's own confirm counts as `pendingConfirmed`.
3. **Request detection.** `isRequest(s)`:
   - ends with `?`; or
   - matches `^(can|could|would|will|may|do|does|did|is|are|was|what|what's|which|when|where|how|who)\b` (case-insensitive); or
   - matches `\b(please (tell|confirm|give|provide|spell)|i (just )?need|can i (get|have)|could i (get|have)|let me get)\b`.
4. **Field targeting.** `FIELD_LEXICON[field].ask` is a list of regexes. Examples:

   | Field | Example `ask` patterns |
   |---|---|
   | `driver_full_name` | `\b(name\|spell)\b` |
   | `driver_relation` | `\b(relat\|your (daughter\|son\|wife\|husband\|partner))` |
   | `driver_dob` | `\b(date of birth\|birthday\|born\|how old\|age)\b` |
   | `license_state` | `\b(which state\|state (issued\|is (it\|the license) from)\|issued (it\|her\|his))\b` |
   | `license_status` | `\b(licen[cs]e\|permit\|probationary)\b` |
   | `license_number` | `\blicen[cs]e number\b` |
   | `incidents_3y` | `\b(ticket\|accident\|violation\|claim\|driving record)` |
   | `vehicle_assignment` | `\b(vehicle\|car\|drive (mainly\|mostly\|primarily)\|which (car\|one))\b` |
   | `operator_type` | `\b(every day\|primary\|main driver\|occasional)` |
   | `garaging_zip` | `\b(zip\|postal\|kept overnight\|parked\|garag)` |
   | `effective_date` | `\b(effective\|start\|begin\|what date\|which day\|when would)\b` |
   | *advice* (→ `adviceFlags`) | `\b(recommend\|suggest\|you (should\|might want to)\|limits?\|deductible\|coverage\|discount)\b` (sentences outside disclosure spans; counted, not a re-ask) |

   A sentence may target several fields.
5. **Classification.** For each (request sentence, targeted field):
   - `valueBearing` = the sentence contains a spoken form of the snapshot value (`spokenForms(field, value)`: date as weekday/month-day forms, the vehicle model, the age number, the first name, ZIP digits spaced or unspaced, the relationship words).
   - Then, by the snapshot status of the field:

     | Snapshot status | `valueBearing` | Classification |
     |---|---|---|
     | VERIFIED | false | **`reask`** |
     | VERIFIED | true | `verified_reconfirm` |
     | PENDING | either | `pending_confirm` |
     | MISSING | either | `new` |

   - Metrics: `reAsked` = **number of distinct VERIFIED fields** with ≥1 `reask`. `newlyAsked` and `pendingConfirmed` are distinct-field counts. `details[]` lists every classified sentence with its `atMs`.
6. **Disclosure verbatim.** For each disclosure (`premium_change`, `esign_consent`):
   1. `norm(t)`: lowercase; strip punctuation; `$142.00`/`$142` → `142 dollars`; spelled numbers → digits (a small parser up to 999,999); ordinals `2nd` → `2`; drop fillers (`uh|um|okay so`).
   2. `D = tokens(norm(text))`. `A` = ch2 tokens from 2 s before the matching `get_disclosure` result time to 60 s after it.
   3. For every start `s` and length `L' ∈ [0.8|D|, 1.2|D|]`: `d = levenshtein(D, A[s:s+L'])` at token level. Keep the minimum.
   4. `similarity = 1 − d/|D|`.
   5. `missingCritical` = critical tokens not present in the best window.
   6. `ok = similarity ≥ 0.90 ∧ missingCritical.length === 0`.
7. **Other fields:**
   - `payment` from `payments.status_source`;
   - `handedBack` from the outcome;
   - `aiSeconds` from `GET /v1/sessions/{id}.duration_seconds`;
   - latency metrics from `takeovers.metrics` (browser-measured).

**Unit tests** use fixtures of synthetic ch2 utterances, and cover:
- a re-ask of a VERIFIED ZIP → 1;
- a confirmation question including the value → `verified_reconfirm`;
- disclosure paraphrase → `ok=false`;
- `$142` vs "one hundred forty two dollars" → equal.

### 5.14 Promote (real `POST /v1/agents` with HTTP tools)

`src/server/promote/agent.ts`, `compilePromotedAgent(intent)`: the same template family, minus per-case state.

```json
{"name":"baton-add-driver-<configHash8>",
 "system_prompt":"<PROMPT_V3 with IDENTITY adapted for a full inbound call: first call lookup_policy with the policy number the caller gives; CASE STATE comes from tool results>",
 "greeting":"Hi, you've reached Harborview Insurance Agency. I'm an AI assistant, not a person, and this call is recorded. Are you calling to add a driver to your auto policy?",
 "voice":{"voice_id":"alba"},
 "input":{"keyterms":["Harborview","learner's permit","endorsement"]},   // NO transcription_mode: not in the stored-agent schema (10a §8)
 "tools":[ {"name":"lookup_policy","description":"Look up the caller's policy.","execution_mode":"interactive","timeout_seconds":10,
            "parameters":{"type":"object","required":["policy_number"],"properties":{"policy_number":{"type":"string","pattern":" *([A-Za-z0-9] *-? *){6,14}","examples":["NBM-4418207","N B M 4 4 1 8 2 0 7"]}}},
            "http":{"url":"<APP_URL>/api/agent-tools/lookup_policy","http_method":"POST","headers":[{"name":"X-Baton-Agent-Key","value":"<AGENT_TOOL_SECRET>"}]}},
           "…confirm_effective_date, get_disclosure, send_esign_and_pay_link (interactive; returns link_sent), send_confirmation, update_case_field, hand_back_to_rep (returns a transfer message) — same schemas as §5.8, each with an http block to /api/agent-tools/<name>"]}
```

**Rules:**
- **Probe first (T-D1-11, D2 morning, WP10):** POST the exact body above, `GET /v1/agents/{id}` it back, and diff the echo (`input` keys, `tools[].http.http_method`, schemas). Anything rejected (422) or silently dropped is removed from the compiler. `transcription_mode` can still be set per session with `session.update` after binding `agent_id` (C22). Keep that probe agent as the "already promoted" fallback for the video.
- **Scope cut (v1.1):** `/api/agent-tools` implements `lookup_policy` (read-only, returns the fictional policy) and answers every other tool with `{"status":"handled_by_rep","message":"Tell the caller a representative will finish this step."}`. "Call the promoted agent" is cut. Promote's value in the demo is the real `POST /v1/agents` plus the evidence card.
- **Upsert.** The config hash covers the JSON with header values removed.
  - If a non-deleted `promoted_agents` row with the same hash exists, return it (`created:false`).
  - Otherwise `POST /v1/agents` (201 → `agent_<hex>`), then `DELETE /v1/agents/{oldId}` for the previous row (204), and store the new row.
  - Agents live on `agents.assemblyai.com`, not the US host [10a §8].
- **Evidence card** (`PromoteEvidence`):

  | Figure | Source |
  |---|---|
  | `n` verified takeovers | `verifications` |
  | re-ask rate | mean `reAsked` > 0 |
  | hand-back rate | takeovers |
  | completion rate | takeovers |
  | disclosure OK rate | verifications |
  | click → audible p50 | takeovers |
  | sweep | projected re-ask = 0 at X% of points (labelled PROJECTED) |

- **Gate:** `n ≥ 5` ∧ re-ask rate ≤ 10% ∧ disclosure OK ≥ 90% ∧ 0 wrong-fact assertions in the sweep. The button is disabled with reasons when the gate fails. The operator can override with `x-admin-key`.
- **`/api/agent-tools/[name]`** runs the same `ToolService` against a **promoted-session case**:
  - `lookup_policy` creates a case (`mode:"spot"`) from the scenario whose policy number matches and returns `{case_id, policy, fields (all MISSING)}`.
  - Each later tool takes a `case_id` argument, added to every promoted tool schema.
  - Responses must stay ≤ 8 KiB, with no redirects.
  - **`[DAY-3 TEST]`** POST body arrival; the documented behaviour is a JSON body for POST.
- **`[STRETCH]`** A "Call the promoted agent" button opens a session with `{"type":"session.update","session":{"agent_id":"…"}}`, **alone** in its message.

### 5.15 Customer input in the AI half, and the suggested-reply engine

**`suggestReplies(ctx): Suggestion[]`** (`src/core/compiler/suggest.ts`; pure). `ctx = {lastAgentText, snapshot, scenario.truth, stage, paymentStatus}`:

1. Classify the last agent sentence with §5.13 steps 3–5 (request? which field? value-bearing?).
2. **Confirm question with value v:**
   - v compatible with `truth[field]` → `["Yes, that's right.", …]`;
   - otherwise → `["No, it's {truthSpoken}.", …]`.
3. **Open question for a field:** the truthful answer from `truth` (e.g. "It's 4 4 1 0 7.").
4. **Disclosure premium question** → "Yes, go ahead."
5. **E-sign consent** → "Yes, text me the link. No paper copy, thanks."
6. **During `pay`** → "Okay, I'm paying now."
7. **After confirmation** → "No, that's everything. Thanks, bye!"
8. **Always appended:** "Can I talk to Daniel?" and "Sorry, could you repeat that?".
9. **Unclassified** → "Okay." / "Sure."

10. **Field not classified by the regex lexicon** (the managed LLM phrases freely: "Where does Maya park the car at night?"): one `gpt-6-luna` call (effort `none`, ≤15 output words; input = scenario truth + the last agent sentence) returns `{field|null, answer}`. Cached by `(scenarioId, normalized sentence)`, and served from `/api/tts`'s autopilot bucket.

**Audio:**
- **Recorded customer voice first:** if the call has a customer tail pack (§11.6), phrases it covers play the volunteer's own recorded clip (labelled "Customer (recorded)").
- Otherwise phrases in `public/tts/manifest.json` play from cache. `scripts/tts/generate-chips.ts` pre-generates **every** template of this section for every published scenario and its truth values (voice `marin`), so a normal run makes zero live TTS calls.
- Other phrases go through `POST /api/tts` (autopilot has its own bucket, §4.4 #22), labelled "Customer (synthetic stand-in)".
- A clip is fed to the Voice Agent through the `PacedFeeder` **and** played locally at 70% so the judge hears "their" line.

**Autopilot** (default ON in Watch mode):
- After `reply.done` with `kind === "speech"`, if the last sentence is a request and **600 ms** pass without new agent audio → play suggestion #1.
- **Stall timer:** if there has been no agent audio and no customer input for 4 s after a `reply.done` (outside `paying`), play the best candidate anyway (or "Sorry, could you repeat that?" if there is none).
- **Loop breaker:** if the agent asks about the same field twice, answer with an explicit field-plus-value sentence ("Her date of birth is March 14th, 2009.").
- During `pay` it speaks once ("Okay, I'm paying now") and runs the visible simulate countdown of §5.8 step 6; it never enters card details.
- It is disabled as soon as the judge uses a chip, types, or turns on the mic.

**Typed:**
- The text box (≤200 chars) → `/api/tts` (PCM stream) → feeder.
- **Mic blocked:** typed and chip input are the fallback. The label reads "Your reply will be spoken by a synthetic voice".

**Mic:**
- `startMicCapture({targetRate: 24000, chunkMs: 50})` → feeder. This is the promoted worklet.
- Headphones prompt first. `getUserMedia({echoCancellation:true, noiseSuppression:false, autoGainControl:true})` [00 §2.3].


---

## 6. Evaluation harness

**Goal:** publish honest curves and claim nothing else. Four families of numbers:
- (a) takeover-sweep projections over real recorded calls;
- (b) live Voice Agent spot-checks;
- (c) live judge/dev runs;
- (d) the v1 → v3 iteration log.

Every number shown in the UI carries a **provenance badge**:

| Badge | Meaning |
|---|---|
| `LIVE` | Measured in a real session (judge, dev or spot-check) |
| `CACHED-STT SWEEP` | Computed offline from STT turns and extraction events that were produced live once and cached |
| `PROJECTED` | Inferred behaviour, e.g. projected re-ask in the sweep |

### 6.1 Inputs

| Input | Source | Owner |
|---|---|---|
| Scenarios (policy, truth, expected status at handoff, rating, traps) | `data/scenarios/sNN.json`: the kit's `Scenario` (schema_version 1, 6+ files written 2026-09-24). `normalizeScenario(kitScenario, sidecar)` maps it to our `Scenario`:<br>• facts `value` → `truth` (norm formats equal the kit formats; money → "142.00");<br>• `status_at_handoff` → `expectedAtHandoff`;<br>• `sidecar.review.fact_overrides` / `status_overrides` are applied on top, because the take's actual words win;<br>• `rep` + `customer` → `PolicyRecord`;<br>• `handoff` → `plannedHandoffS` / `handoffResponse`;<br>• `eval.traps` → `traps` | WP9 writes the adapter; it never edits kit files |
| Recordings | The kit's `data/calls/manifest.json` (`kit report`: per scenario, `chosen_take` + `takes[]`) and sidecars `data/calls/raw/<base>.json` (`channel_map`, `consent.publishable`, `review.status`, `audio.duration_s`). Audio: `data/calls/split/<base>_{rep,customer}.wav`, PCM16 8 kHz mono.<br>`scripts/calls/build-assets.ts` reads these (read-only) and:<br>• writes `src/generated/calls.json` (`CallManifestEntry[]`, `callId = base`) and `src/generated/scenarios.json`;<br>• writes `public/calls/<base>/…` assets for publishable takes only.<br>**Eval set:** every take with `review.status !== "discard"` and reviewed labels.<br>**Demo/Watch set:** the `chosen_take` of each publishable scenario.<br>**Golden 16 kHz calls,** if recorded, live in `data/golden/<callId>/` with the same `meta.json` fields | WP9 |
| Ground-truth labels | `scripts/eval/label-ground-truth.ts`:<br>1. Async multichannel U3.5 Pro transcription of the take's split channels (2 files, or a 2-ch WAV rebuilt locally), with keyterms including the truth values (allowed for labelling only). Cost ≈ $0.0035 per channel-minute.<br>2. sol (effort low) locates each truth fact's **first mention** (`statedAtMs`) and **cross-party acknowledgement** (`ackedAtMs`) with quotes; the **rep's handoff line** (`handoff.lineStartMs/lineEndMs`, matched to `scenario.handoff.line`) and the customer's reply end (`acceptEndMs`); and `diagnosisEndsMs` / `tailStartsMs`.<br>3. Writes `data/labels/<callId>.json` with `reviewed:false`.<br>4. The user reviews flagged items (overrides vs mismatches, low confidence) with `scripts/eval/review-labels.ts`, which prints each item's quote and timestamp, and sets `reviewed:true`.<br>`decisionPointMs` = `handoff.lineStartMs`, or the `ackedAtMs` of the last required fact + 2 s when there is no handoff line. Express starts 25 s before it (§5.1.6) | WP9 |

### 6.2 STT cache (live, once per call × variant)

`scripts/eval/cache-stt.ts --calls all --variants pc_ctx,pc_noctx,mono_diar` (Node, API key auth with `Authorization: <raw key>`; never Bearer [10 §3.1]).

| Variant | What | Extra cost |
|---|---|---|
| `pc_ctx` | Two sessions per call (rep, customer), `agent_context` carryover rep → customer, exactly as §5.2. **v3 default** | 2 × duration × $0.45/h + prompt $0.05/h |
| `pc_noctx` | Same, without carryover | same |
| `mono_diar` | Downmix to mono; `speaker_labels=true&max_speakers=2`; one session | duration × ($0.45 + $0.12)/h |
| `pc_ctx_8k` (golden 16k calls only) | Downsampled to 8 kHz µ-law | 2 × duration × $0.45/h |

**Runner mechanics:**
- Audio is paced at 1× with the same `FrameBatcher` framing as the browser.
- The runner **acquires broker slots from the limits authority** (`acquireStreamSlots()` with `LIMITS_ROLE=remote`, §2.3), never from a database of its own. Before the Zerops app exists it uses the laptop's file guard.
- At most 2 calls run concurrently.
- Each server message is logged with `recvMs` = audio ms sent so far, to `data/cache/stt/<callId>/<variant>.jsonl`. The file ends with `Termination.session_duration_seconds` (billing) and the params hash.

**Mono attribution:**
1. Each mono final is attributed by majority word-level `speaker`.
2. Diarization labels map to roles by maximum time-overlap with per-channel energy from the stereo source.
3. Mixing errors are kept. That is the point of the curve.

**Estimated cost** for 22 takes × ≈2 min (scenarios target 75–120 s), variants `pc_ctx` + `pc_noctx` on all takes and `mono_diar` on the 5 pilot takes only (v1.1 cut): ≈ 22 × 2 × 0.0083×2×2 + 5 × 2 × 0.0095 ≈ **$1.6**. It needs ≈95 opens at 4/min, so about 30 min of wall time. **Takes whose sidecar says `twilio.recording_channels !== 2` (a MONO warning) are excluded** from every per-channel variant: a mixed take is never channel-separated ground truth.

**Audio source:** the kit's split WAVs (PCM16 8 kHz), converted to µ-law exactly as in `public/calls`, so eval audio is byte-identical to Watch-mode audio.

### 6.3 Extraction cache

`scripts/eval/extract.ts --version v1|v2|v3 --variant <v>`:
1. Replays cached finals in `recvMs` order through the production `applyTurn` path (Extractor + normalizers), **sequentially**, so each patch sees the same prior state as live.
2. Records the events and the measured `extractMs` per turn.
3. Writes `data/cache/extract/<callId>/<version>.<variant>.json`.
4. Also extracts **cut-turn texts** on demand for the sweep (cached by `sha256(text + contextHash)`).

**Verifier runs** (for the v3 ablation): cached sol runs at 30 s call-time cadence go to `data/cache/verify/<callId>.<variant>.json`.

**OpenAI cost:**
- luna: ≈$0.01 per call per version.
- sol: ≈6 runs × $0.016 per call.
- **Total ≈ $3** for everything.

### 6.4 Pipeline versions (the v1 → v3 iteration log)

| Version | STT variant | Extractor | Status rules | Takeover protocol | Greeting |
|---|---|---|---|---|---|
| **v1** (naive) | `pc_noctx` | `EXTRACTOR_PROMPT_V1` (values only; no ack/readback kinds) | Any stated value = VERIFIED | Immediate cut at arm (ForceEndpoint emulated as truncation at `t`); no drain (only extractions finished by `t`) | Asserts every known value |
| **v2** (+ deterministic status) | `pc_noctx` | `EXTRACTOR_PROMPT_V3` | §5.4 rules, without the late/cut rule | Immediate cut, no drain | §5.6 compiler |
| **v3** (+ protocol + `agent_context` + verifier) | `pc_ctx` | V3 | §5.4 full, plus the verifier overlay | §5.5 (wait ≤1.5 s for quiet, ForceEndpoint in silence, finals wait, 2 s drain, late/cut → PENDING) | §5.6 |

**Ablations at v3:**
- `pc_noctx` (isolates `agent_context`);
- `mono_diar` (isolates channel separation);
- verifier off;
- 16k vs 8k (golden calls).

`data/evals/iterations.json` appends one entry per run: `{version, date, gitSha, configHash, extractorVersion, promptVersion, variants, summary}`. The page shows headline deltas. Hand-written notes explain *why* each change was made.

### 6.5 The takeover sweep (`src/core/protocol/simulate.ts`, `scripts/eval/sweep.ts`)

For every call in the eval set, every version or ablation, and every `t` from 2000 ms to `tailStartsMs ?? durationMs` in 2000 ms steps, compute `simulateTakeover(inputs, version, t): SweepPoint`.

**Step 1: mid-utterance.** `midUtterance` = either channel's energy over `[t−200, t]` is above −45 dBFS (from `peaks.json`), **or** some final spans `t`.

**Step 2: cut time.**
- **v1/v2:** `tCut = t`.
- **v3:** the first `τ ∈ [t, t+1500]` (50 ms grid) where both channels have been quiet over `[τ−400, τ]`. If there is none, `tCut = t+1500` and `capHit = true`.

**Step 3: available turns.**
- Finals with `endMs ≤ tCut` are available if `recvMs ≤ tCut + (v3 ? 900 : 0)`.
- In v3, a final with `endMs ≤ tCut` but a later `recvMs` counts as force-endpointed, available at `tCut + 520`.
- A final spanning `tCut` (only when `capHit` in v3; always possible in v1/v2) becomes a **cut turn**: its words with `startMs < tCut` form the text, with `cut=true`.
- `late = endMs > t`.

**Step 4: extraction timing.**
- `doneAt_i = max(availableAt_i, doneAt_{i−1}) + extractMs_i`. Cut turns use the median `extractMs` and their on-demand cached events.
- Only events with `doneAt ≤ deadline` count:
  - v3: `deadline = tCut + 900 + 2000`;
  - v1/v2: `deadline = t`.

**Step 5: verifier (v3).** Use the latest cached verifier run whose **start + measured latency** ≤ `t` (not its start time), with runs never overlapping (F2).

**Step 6: state and greeting.**
- `state = deriveCaseState(...)`. v1 uses `deriveV1`.
- `greeting = compileGreeting(state)`. v1 uses `compileGreetingV1`.
- `protocolMs = (deadlineUsed − t)`, reported as "estimated protocol time before connect".

**Metrics per point** (truth from labels; "known" = truth facts with `statedAtMs < t`):

| Metric | Definition | Target |
|---|---|---|
| `entityAcc` | Share of known truth facts with a compatible value in state (VERIFIED or PENDING) | ≥ 0.90 (K1/K3 context) |
| `verifiedPrecision` | Correct VERIFIED ÷ all VERIFIED | 1.0 |
| `wrongAsserted` | Greeting-asserted fields (`compileGreeting().asserted`) whose value ≠ truth | **0 at every point (K3)** |
| `wrongPending` | PENDING fields with a wrong value (the agent will confirm them, so less harmful) | report |
| `reaskProjected` | Required fields with `ackedAtMs < t` whose state is MISSING. The agent would ask again **(PROJECTED)** | **0 at ≥ 90% of points (K3)** |
| `pendingN`, `missingN`, `ready` | Counts | report |
| `statusAgreementAtPlanned` (only at the point nearest the recorded handoff line) | Share of scenario facts whose derived status equals `expectedAtHandoff`. This is the kit designer's intended VERIFIED/PENDING/MISSING (e.g. `s02` `effective_date` PENDING, `s05` `license_state` MISSING) | ≥ 0.9; reported per scenario |

**Aggregation:**
- Bin `x = t / (tailStartsMs ?? durationMs)` into deciles.
- Per version/variant, report the mean and the 10th–90th percentile band.
- Keep a separate series for `midUtterance = true` points ("mid-utterance clicks").
- Also report "share of points with `wrongAsserted = 0` and `reaskProjected = 0`" (headline).

**Outputs:**
- `public/data/explorer/<callId>/<version>.<variant>.json`: every point, for published calls, one file per combination (the page lazy-loads everything but the default v3 · `pc_ctx`). It stores the snapshot (field → `{status, value, display}`), the greeting and the metrics. About 90 points × ~1.2 KB per file.
- `public/data/evals/summary.json`: curves, tables, K1/K3 results, provenance.

**K1 from caches:**
- Entity recall in the STT text: each truth mention's spoken forms must appear in the corresponding channel's finals within ±3 s. Target ≥ 90%.
- Final latency: `recvMs − lastWord.endMs`, p50 ≤ 1000 ms.
- Both are reported per variant and per 8k/16k.

### 6.6 `/evals` page content

1. **Headline** (each with its badge):
   - "At X% of takeover points across N real calls, the AI asserted **0 wrong facts** and would re-ask **0** settled questions" (CACHED-STT SWEEP / PROJECTED);
   - "Live: re-asked 0 in M/M verified takeovers" (LIVE).
2. **Curves:**
   - entity accuracy by decile;
   - projected re-ask by decile;
   - pending by decile;
   - wrong-asserted by decile.
   Each shows v1, v2 and v3, plus a mid-utterance series.
3. **Ablation table:** v3 against `pc_noctx` / `mono_diar` / verifier off / 8k. Columns: `entityAcc`, `wrongAsserted` points, `reaskProjected = 0` share.
4. **Latency:**
   - live spot-checks from Node in India (update → first audible, turn latencies);
   - live browser runs from `takeovers.metrics` (click → first audible, dead air, p50/p90, n).
   - Always labelled with where they were measured.
5. **Iteration log** (v1 → v3).
6. **Methodology and cost:**
   - "Each call was transcribed live once per variant; sweeps replay cached turns; no number on this page is simulated except those marked PROJECTED."
   - Spend used.
   - Known limitations: role-play calls; volunteers from India; 8 kHz phone audio; small n.
7. **Promote card** (§5.14).

### 6.7 Live spot-checks (`scripts/eval/live-spotcheck.ts`)

**Sample (v1.1 cut from 15):** 5 points = s01 and s02 at {40%, 90%} of the human half, plus 1 mid-utterance pick. More only if budget remains on D4.

**Per point (all in Node):**
1. Create a `mode:"spot"` case with `prefillUntilMs = t` (cached turns and events).
2. Run the server compile path directly (same functions).
3. Acquire a VA slot and a ledger reservation from the limits authority (`acquireVaSlot()`), then connect the Voice Agent with `connectNode({apiKey})` through `scripts/lib/aai-open.ts`. The compiled prompt carries a `dev-*` deploy marker, so the F6 audit ignores it.
4. Run the **simulated customer**: `suggestReplies` + cached TTS PCM through `RealtimeAudioFeeder`, which is paced at real time with silence between clips, exactly like a mic.
5. Use mock payments.
6. Run to DONE, or the 3-minute cap.
7. Run `verify_takeover` (async ch2) → `QaResult`.

**Records:** `data/evals/spotchecks.json` plus DB rows.

**Cost:** ≈5 × 2.5 min × $0.075 + async ≈ **$1.0**.

**Validation:** these runs check the sweep's projections. The report shows the agreement rate between projected re-ask and actual re-ask.

---

## 7. Spend, limits and reliability

### 7.1 Per-action cost table (list prices [00 §1.1]; `[HYPOTHESIS]` for estimates)

| Action | Unit cost | Typical | Ledger reservation |
|---|---|---|---|
| Watch replay, live STT | 2 sessions × $0.45/h + prompt $0.05/h ≈ $0.0167/call-min. Keyterms price unknown (C3) | 3-min call ≈ **$0.05** | 2 × 6 min ≈ $0.10 |
| Express replay | same | ≈ $0.015 | $0.05 |
| Voice Agent takeover | $4.50/h = $0.075/min | 2–3 min incl. payment hold ≈ **$0.15–0.23** | the dynamic-cap maximum, 7 min ≈ $0.53 (held from Start, D14) |
| Async verification (VA recording, 2 ch) | $0.21/h × 2 = $0.007/min | ≈ **$0.02** | $0.03 |
| luna extraction | $0.10 / $0.50 per 1M tokens | ≈1.8k tokens per turn × 40 turns ≈ $0.01 per call | settle actual |
| sol verifier | $2 / $10 per 1M | ≤8 runs × ≈$0.016 ≈ $0.12 per call | settle actual |
| TTS (typed / dynamic chips) | $0.60 per 1M input + $12 per 1M audio tokens ≈ $0.015/min `[HYPOTHESIS]` | < $0.005 per call | settle actual |
| Polar sandbox, Zerops, Postgres | $0 (sandbox) / ≈$10 for 5 weeks of Zerops (covered by the $15 signup credit [16 §11]) | — | — |
| **Full judge run** | — | **≈ $0.27 AssemblyAI + ≈ $0.14 OpenAI** | — |

### 7.2 Budget plan (AssemblyAI, ≈$48 remaining; confirm on the dashboard, C11)

| Bucket | Cap | Notes |
|---|---|---|
| Development and integration tests (D1–D5) | $7 | Recorded in the same ledger with `env = dev-*`; not counted against the judging budget |
| Eval: STT caches, labels, spot-checks | $4 | §6 (v1.1 cuts: 5 spot-checks, `mono_diar` on 5 takes, smaller T-D1-6 grid) |
| Video recording | $1 | |
| **Judging window** (`LEDGER_EPOCH` = the D6 freeze → `JUDGING_END_DATE` 2026-10-21) | **≈$31** | `AAI_JUDGING_BUDGET_USD` = the dashboard balance at the epoch − `AAI_RESERVE_USD` |
| Reserve | $5 | Never spent. Synthetic "full" checks cost ≈$0.03/day |

**Total-budget semantics (unambiguous):** only reservations and settlements with `created_at ≥ LEDGER_EPOCH` count against `AAI_JUDGING_BUDGET_USD`. Dev and eval spend before the epoch is recorded (for the dashboard reconciliation) but never reduces the judging budget. The operator sets the epoch and the budget at the freeze, from the real dashboard balance.

**Dynamic daily cap** (F8), recomputed every minute:
`dailyCap = clamp(remaining / max(1, daysLeft) × (first 3 judging days ? 2 : 1), 0.75, AAI_DAILY_CAP_MAX_USD)`, where `remaining = AAI_JUDGING_BUDGET_USD − spentSinceEpoch`. With ≈$31 over 21 days this is ≈$3/day on Oct 1–3 (≈10 full live runs per day), then ≈$1.2–1.5/day. The budget can't run out in week 1 and leave weeks 2–3 replay-only.

**Real-balance guard:** each morning of the judging window the operator enters the dashboard balance (`POST /api/admin/flags {aaiBalanceUsd}`, the runbook's daily step). Below `AAI_RESERVE_USD` the mode flips to `replay_only` (`aai_balance`), whatever the ledger says. Unpriced items (keyterms, C3; the +30 s bare-close billing) are why the ledger alone is not trusted.

**OpenAI:** `OPENAI_DAILY_CAP_USD=3`. When it is exceeded, extraction serves cached events for published calls (Watch still works with a "cached extraction" label). Live mode and typed TTS are disabled; cached autopilot clips still play.

**Ledger mechanics:**
- `reserve()` inserts `status='reserved'` and refuses when `sum(today settled + reserved, since epoch) + est > dailyCap`, or when `spentSinceEpoch + reserved + est > AAI_JUDGING_BUDGET_USD`. Before the epoch (development) only a dev guard applies: $3 per day for `env = dev-*`.
- `settle()` writes the actual amount from:
  - `Termination.session_duration_seconds`;
  - the Voice Agent `duration_seconds` (`GET /v1/sessions/{id}`);
  - transcript `audio_duration × channels`;
  - OpenAI `usage`.
- Unsettled reservations older than cap + 5 min are settled at the reserved amount (F5).
- A refusal sets `mode=replay_only` (reason `budget_daily`, auto-cleared at 00:00 UTC; or `budget_total` / `aai_balance`, cleared manually).

### 7.3 Rate limits and caps (consolidated)

| Limit | Value | Where |
|---|---|---|
| New STT sessions, account-wide | 4 per rolling 60 s (free tier 5; 1 spare), enforced by the single limits authority for every opener | `StreamSlotBroker` |
| STT queue | ETA ≤ 15 s → queue; ETA > 15 s → cached replay at once; ≤2 open tickets per ipKey; tickets expire after 3 missed polls | broker + UI |
| STT grants | 6/h per visitor, 15/h per ipKey | RateLimiter `stt:<vid>`, `stt-ip:<ipKey>` |
| STT session caps | `inactivity_timeout=30`; client terminates at end + 1.5 s. The token's `max_session_duration_seconds=600` only appears in `Begin.expires_at`; its enforcement was never observed [10b], so it is **not** relied on | client |
| Voice Agent tokens | 4/h and 8/day per visitor; 12/h per ipKey; window 10 s; keyed on the takeover and its retry budget (§4.4 #10) | RateLimiter + mint route |
| Voice Agent slots, account-wide | 3 (`live_sessions` `held`/`open`, kind `va`); heartbeat every 10 s, stale after 30 s | registry |
| Voice Agent session cap | dynamic, 150–420 s + hold time (§5.9.5); wrap-up never in `paying`/`closing`; ledger reserves the maximum | client + ledger |
| Voice Agent audit | every 3 min in-process while `mode=live` (F6) | ticker |
| Cases per visitor | 10/h; per ipKey 30/h. When a limit is hit, the message says so in plain words ("Several people on your network ran live demos this hour: showing the labelled replay; live again in 12 min") | RateLimiter |
| Extract | 5/s burst 10 per case; 250 turns per case | RateLimiter |
| Verifier runs | ≤8 per case, ≥15 s apart | `maybeRunVerifier` |
| TTS | typed 20/h per visitor; autopilot 60/h per visitor (own bucket); ≤200 chars | RateLimiter |
| Promote | 1 per 10 min global, 3/day per visitor | RateLimiter |
| Async jobs in flight | 3 | JobRunner |

**RateLimiter implementation:**
1. `INSERT INTO rate_events(bucket,key,cost)`.
2. Then `SELECT sum(cost) … WHERE ts > now() − window`, inside one transaction.
3. If over the limit, `DELETE` the inserted row and return `retryAfterSec`.

Cleanup is cron purge.

### 7.4 Error taxonomy, retries, user-facing behaviour

| Code | Detected by | Retry | Fallback / UX |
|---|---|---|---|
| `E_MODE_REPLAY_ONLY`, `E_BUDGET` | `/api/runs`, mint routes | — | The run plan says so **before Start** (pre-flight copy, D14): cached-turn replay + recorded AI session at its own handoff point |
| `E_AAI_BALANCE` | mint/WS error text; operator balance flag | — | As above; mode flips to `replay_only` (F8) |
| `E_RATE_LIMITED` | any route (429) | client waits `Retry-After` once | A plain-words note naming the reason |
| `E_QUEUE_TIMEOUT` | broker ETA > 15 s | — | Cached replay starts at once |
| `E_STT_TRANSIENT` (1006/1011/3005) | `StreamingSession` close | 1 reconnect per channel (new slot) | Channel → cached turns |
| `E_STT_RATE` (1008/3009 "too many") | close text | — | Cached replay |
| `E_STT_INACTIVITY` (3006 "inactivity") | close text | resume via the reconnect path | "Paused: tap to resume" (iOS) |
| `E_STT_AUTH` (1008) / `E_STT_INPUT` (other 3006/3007) | close | none | Cached replay; log |
| `E_VA_TRANSIENT` / `E_VA_CAPACITY` / `E_VA_AUTH` / `E_VA_TIMEOUT` | controller | 1 retry, fresh token | Recorded AI session (labelled), else an error card with "Try again" |
| `E_VA_CONFIG` (first update) | close 1008 | none (a bug) | Recorded AI session; log |
| `E_VA_SILENT` | `ReplyTracker.kind` | nudge once with `reply.create` | Then retry |
| `E_OPENAI_TIMEOUT` / `E_OPENAI_RATE` | extractor | 1 retry (2.5 s) | Turn `extract_status=failed`; verifier or cached events may fill it; the case card shows "1 turn not analysed" |
| `E_OPENAI_REFUSAL` | extractor | none | Skip the turn |
| `E_POLAR_API` | create checkout | 1 retry after 1 s | Mock payment, labelled |
| Amount mismatch | Polar `total_amount ≠ amount_cents` | — | `failed(amount_mismatch)`; Simulate offered |
| `E_POLAR_SIG` | webhook | — | 403 (Polar retries; log) |
| `E_MIC_DENIED` | `getUserMedia` | — | Chips, typed and autopilot (default in Watch anyway) |
| `E_AUDIO_LOCKED` | `ctx.state !== "running"` after the click | resume on the next gesture | "Tap to enable sound" overlay |
| `E_DB` | any route | 1 retry | `/api/health` fails → Zerops restarts; the UI shows maintenance if persistent |

### 7.5 Fallback ladder (always labelled; never pretend)

| Failure | Fallback | Label |
|---|---|---|
| Mic blocked | Autopilot + chips + typed (OpenAI TTS → `input.audio`) | "Customer replies are synthesized" |
| STT refused (budget, queue, mode) or failing | Cached-turn replay: real audio + cached finals at their original `recvMs`; extraction live, or cached if OpenAI is out | "CACHED REPLAY: transcribed live by AssemblyAI on <date>; replayed now because <reason>" |
| VA budget or slot unavailable **at Start** (D14) | The run is planned as `aiHalf=recorded`: manual pass disabled, the **recorded AI session bundle** plays at its own handoff point, and the case card switches to the bundle's `case.state` events | Pre-flight: "Live AI is busy / today's budget is used: you'll watch the recorded AI session at Daniel's handoff line" |
| Voice Agent failure after 1 retry (mid-run) | The same bundle, **only if** the pass point is within 10 s of the bundle's point; otherwise an error card with "Replay the recorded AI session from Daniel's handoff line" and "Try again" | "RECORDED AI SESSION from <date>: live AI failed (<reason>)" |
| Polar failure | Mock provider (same state machine, `status_source=mock`) | "Simulated payment" |
| Judge doesn't want to pay | **Skip: simulate payment** (always offered) | "Simulated payment" |
| OpenAI TTS failure | Chips from the pre-generated cache only; typed input disabled | tooltip |
| Everything down | `/` shows the video embed and `/evals` (static) | "Maintenance" |

**Recorded bundles:** `public/replays/<bundleId>/` = `events.json` (the `BatonEvent` log with relative `t`) + `ai.wav` (24 kHz stereo: L = customer feed, R = agent output, captured client-side in a dev run with `?record=1`). `ReplayPlayer` plays the audio and dispatches the events; the QA card shows that run's verified numbers. WP11 records, on D4, one bundle per picker-"main" call **from the same take the call uses**, at the planned handoff, plus one extra s01 bundle from a mid-call pass (so replay days can still show a PENDING-confirm greeting).

### 7.6 Browser matrix concerns

| Concern | Rule |
|---|---|
| **Autoplay / unlock** | Create **one** `AudioContext` inside the first click handler (Watch on `/`, and pre-flight Start/Express on `/call`, so deep links behave the same) and call `ctx.resume()` **synchronously, before any `await`**. Never create contexts elsewhere. If `ctx.state !== "running"` after 300 ms, show the "Tap to enable sound" overlay |
| **iOS silent switch** | Web Audio follows the ring/silent switch on iOS unless the session is `playback`. In the same unlock gesture, synchronously: `if (navigator.audioSession) navigator.audioSession.type = "playback"`. Switch to `"play-and-record"` only while the mic is on, and back afterwards. For iOS versions without `audioSession`, also start a looping silent `<audio>` element in the gesture (the known unmute trick). The pre-flight card on iOS says "No sound? Turn off silent mode." A muted-by-switch context still reports `running`, so the overlay can't detect it |
| **iOS backgrounding** | Listen to `ctx.onstatechange`, `visibilitychange` and `freeze`. On iOS only (desktop Chrome keeps running): in the human half, on `interrupted`/hidden, stop feeding and terminate STT cleanly; on return show "Paused: tap to resume" and reconnect through the reconnect-offset path (or continue from cached turns). In the AI half, after 10 s hidden during an open VA session, send `session.end`; on return show "The AI call ended while this tab was in the background: replay it / try again". Prefer Simulate or the embed over the new-tab checkout on iOS |
| **Sample rate** | Never pass `sampleRate` to `new AudioContext()`. It breaks Firefox AEC and garbles Safari [00 §2.3]. Resample in JS/worklets: µ-law 8k and PCM 16k to the device rate for playback; mic device rate → 16k/24k in the capture worklet; VA output 24k → device rate in the output worklet |
| **Safari AudioBuffer rates** | Don't `createBuffer` at 8 kHz; resample first (§5.1.2) |
| **Safari AudioWorklet** | Supported (14.1+). Load worklets from Blob URLs (as `browser-capture.ts` does). `AudioWorkletNode` `processorOptions` are fine |
| **iOS layout** | The mobile layout is tabbed; the Phone tab opens by itself on `phone.sms`. Headphones are recommended only for mic mode |
| **Background tabs** | Every realtime clock (STT feed, VA feed) runs on worklet ticks, never `setTimeout`/`setInterval` |
| **Firefox** | `getUserMedia` constraints: `echoCancellation:true, noiseSuppression:false, autoGainControl:true`. Test the VA output worklet resampler |
| **Ogg Opus** (AI-half clips) | Chrome and Firefox OK. Safari → transcript popover fallback (§5.11) |
| **Polar embed** | May fail in Safari with strict ITP → the visible "Open checkout in a new tab" link (a user click, so popup blockers allow it) and Simulate |
| **WebSocket** | Direct `wss://` to AssemblyAI from the browser. The CSP must allow it (§8.4) |
| **Test matrix (D4 and D5, on the Zerops URL)** | Browsers: Chrome (Win/Mac/Android), Safari (Mac/iOS), Firefox (Win), Edge (Win). Watch path × {mic allowed, mic blocked} × {autopilot, chips}. **Plus the adversarial conditions** (WP12, `docs/notes/browser-matrix.md`): iPhone with the silent switch on; iOS tab switch and screen lock mid-shadow and mid-AI; DevTools "Slow 3G" and "Fast 3G" through the whole path; mic blocked at the OS level and a muted hardware mic; a forced `replay_only` run; 3 browsers starting at the same second including 3 concurrent VA sessions; embed success without navigation; the hold timeout followed by a late payment; Simulate; a popup blocker on the new-tab link; Safari with "Prevent cross-site tracking"; an early pass at t≈20 s that completes payment; a hand-back via "Ask for Daniel" then "Pass the baton again"; cookies blocked |

### 7.7 Health and monitoring

- `/api/health` is liveness only: a DB `select 1` and required env present. It is used by the Zerops `healthCheck` and `readinessCheck`.
- `/status` shows mode, notice, last light/full check (ok, age), today's budget % and the queue depth.
- Synthetic checks run light hourly and full every 6 h (F7), stored in `health_checks`.
- Logs are JSON lines (`src/server/log.ts`, with secrets and tokens redacted), read with `zcli service log app --follow`.
- **External monitoring** (the checks above run in the same container, so they can't report their own death):
  - `.github/workflows/monitor.yml`: an hourly GitHub Actions cron that fetches `$APP_URL/api/status` and **fails** (GitHub emails the owner) when the request fails, `mode != "live"`, or `lastChecks.full` is older than 7 h;
  - optionally a free uptime pinger on `/api/health` (the user sets it up; no code).
- **Zerops credit runway:** ≈$10 estimated (§7.1) against the $15 signup credit, with autoscaling up to 2 CPU / 2 GB. Recommended: the $10 account verification for +$50 before Sep 30 [16 §11], so October hosting can't run dry.
- **Operator runbook** (in `docs/RUNBOOK.md`, WP12):
  - kill switch: `curl -X POST $APP_URL/api/admin/flags -H "x-admin-key: …" -d '{"mode":"replay_only"}'`;
  - **daily during judging:** read the AssemblyAI dashboard balance and post it (`{"aaiBalanceUsd": 27.4}`); glance at `/status` and the monitor workflow;
  - residual risk: a scripted client can reuse one 10 s token for several sessions until the next 3-min audit; keep `AAI_JUDGING_BUDGET_USD` at least `AAI_RESERVE_USD` below the real balance;
  - rotate keys.

---

## 8. Security and privacy

### 8.1 Secrets

- All secrets live **only** in Zerops secret env vars (and Vercel env on the mirror).
- `.env` stays local. `.env.example` lists names only.
- No `NEXT_PUBLIC_*` secret, ever.
- `src/server/env.ts` is `server-only`.
- The logger registers every secret value and masks it wherever it appears (from `spikes/lib/log.ts`). Tokens (`?token=`, JWTs) are masked by pattern.
- Temporary AssemblyAI tokens go only to the case's browser, in a JSON response with `Cache-Control: no-store`.
- The Polar OAT is server-only. It is auto-revoked by Polar if leaked.
- Keys are never embedded in stored-agent configs, except `AGENT_TOOL_SECRET`, which AssemblyAI stores encrypted and omits on read [10a §9].

### 8.2 Per-case signed tokens and route authorization

Per §4.3:
- Every mutating route checks the case JWT `sub` and `vid`, and the takeover `tko` for tool and payment routes.
- **State guards:**
  - tools only in `ai_active`;
  - `/compile` only in `armed`;
  - `/api/va/token` only for the takeover's first attempt (≤30 s after arm) or its single retry (≤30 s after the recorded failure);
  - `/api/internal/limits/*` only with the limits key, and only on the authority;
  - payment routes only for the case's own payment.
- Tool calls are idempotent by `(takeoverId, callId)`.
- **Money is fail-closed (§5.12):** the client can't mark anything paid, and `send_confirmation` checks the server state.

### 8.3 PII and data handling

- **Everything in cases is fictional role-play data** from scenarios. Judges are told on the role card and on the page: "Don't share real personal information."
- **Judge audio:**
  - In the AI half, it goes browser → AssemblyAI Voice Agent, which **records** the session. Recordings are stored by AssemblyAI in S3 eu-west-1 [10a §11], and we fetch pre-signed URLs only on demand.
  - In "Be the customer", it goes to Streaming STT, which is not stored by us.
  - We store **transcripts and metrics only**, never raw judge audio, except local in-memory clip buffers.
- **Purge:** judge cases older than 14 days are deleted (F-purge). The purge job also calls `DELETE /v1/sessions/{id}` for judge Voice Agent sessions older than 7 days, which **requests deletion** of the recording. T-D1-0b checks once what it actually does (GET the artifact URL afterwards); the privacy copy only claims what that test shows. It keeps `mode:"spot"` evaluation sessions.
- No PII in URLs: ids only. Logs never include turn text (only lengths and ids).
- Async QA of judge sessions never displays entity or sentiment rows. Those leak PII [10 §0.6].

### 8.4 Security headers (`next.config.mjs` `headers()`, and `src/proxy.ts`)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; worker-src 'self' blob:;
  connect-src 'self' wss://streaming.assemblyai.com wss://agents.assemblyai.com https://sandbox-api.polar.sh;
  frame-src https://sandbox.polar.sh https://*.polar.sh https://js.stripe.com https://*.stripe.com;
  media-src 'self' blob: https://*.amazonaws.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'
Permissions-Policy: microphone=(self), camera=()
Referrer-Policy: strict-origin-when-cross-origin      X-Content-Type-Options: nosniff
```

(AudioWorklet modules load from `blob:` URLs, which need `worker-src blob:` and possibly `script-src blob:`. Verify on D1.)

### 8.5 Consent for voices

- **Volunteer consent is captured by the recording kit.** It lives in `tools/recording-kit/participants.json` (consent scope per participant; git-ignored) and is summarized per take in `sidecar.consent`: `all_recording_consent`, and `publishable` (true only when every participant's scope is "public").
- **Baton honours these flags:**
  - `publishable` → audio in `public/calls/`, the Watch set and Explorer audio.
  - `all_recording_consent` without publishable → eval use only: cached transcripts and metrics in git; audio never leaves `data/calls/` (git-ignored).
  - Takes with no recording consent are excluded entirely.
- **Withdrawal:** the user flips the participant's scope in the kit and re-runs `kit report` + `npm run calls:build`. Assets are removed on the next deploy.
- Hinglish volunteers are included on the same terms.
- Recording calls include the spoken notice ("this call is recorded for a hackathon demo") [15 §5].

### 8.6 AI disclosure

- The **greeting** (compiled, verbatim, unit-tested) always discloses that the speaker is an AI assistant, not a person, and that the call is recorded. The compiler refuses to output a greeting that fails the disclosure regex.
- The rep's handoff line precedes the greeting.
- The prompt rule "you are not a person; if asked, say so".
- Promoted agents carry the same disclosure in their stored greeting.

---

## 9. Testing strategy

### 9.1 Unit tests (vitest, `tests/unit/**`, $0, run on every change; each WP owns its folder)

**Core logic:**

| Area | Must-have cases |
|---|---|
| **Normalizers** (`intents/add-driver`) | Date resolution ("this Friday" from Monday 2026-09-28 → 2026-10-02), money ("$142"/"142 dollars"/"14200" cents), ZIP, relationship synonyms, vehicle matching (unique model, ambiguous → null), name subset compatibility |
| **Status rules** | Table-driven cases:<br>• stated once → PENDING;<br>• stated + ack by the other party → VERIFIED;<br>• ack by the same party → PENDING;<br>• readback by the other party (same value) → VERIFIED;<br>• conflict → PENDING + conflict card;<br>• corrected → new value;<br>• denied → PENDING;<br>• late/cut → PENDING;<br>• verifier disagreement downgrades but never upgrades;<br>• rep-only premium stated by the customer → PENDING;<br>• `tool_update` → VERIFIED (`ai_confirmed`);<br>• determinism (same events → same state; event order by `seq`) |
| **Greeting compiler** | • Disclosure regex always passes.<br>• Only VERIFIED values asserted (property test over random states).<br>• One confirm/ask sentence max; priority order; ≤70 words; phrase formats.<br>• Snapshot tests for 6 canonical states |
| **Prompt compiler** | Size ≤ 3500 + state; stage instructions; no premium unless rep-quoted |
| **Stage tools** | Exact tool lists per stage (snapshot); every stage includes `update_case_field` and `hand_back_to_rep` |
| **Takeover machine** | • All transitions and timeouts with a fake clock.<br>• ForceEndpoint never emitted before `SEAL_TAIL_MS`.<br>• Retry-once semantics.<br>• `pagehide` from every state (releases the run hold).<br>• Recorded-AI runs never arm manually |
| **First update** | `validateFirstUpdate` accepts the compiled update for `s01`/`s02`/`s05` snapshots in both initial stages and rejects: a `hold` tool, a `format` keyword, keyterms with the flag off, >100 keyterms, a 51-char keyterm, an unknown voice, an unknown `input` key |
| **Dynamic cap and hold** | `vaSessionCapMs` formula; the wrap-up never fires in `paying`/`closing`; the hold deadline extends only in the listed phone states and stops at 180 s; late success triggers the push path |
| **STT URL** | Snapshot of the exact query string `buildStreamingUrl` produces for an 8 kHz call, a Hinglish customer channel and a 16 kHz call |
| **Input mode** | `inputModeFor` per next step (`balanced` for MISSING entities, `min_latency` for yes/no and disclosures, `max_accuracy` for `license_number`) |

**QA, payments and platform:**

| Area | Must-have cases |
|---|---|
| **Re-ask counter** | • Re-ask of a VERIFIED ZIP = 1.<br>• Confirm with value = `verified_reconfirm`.<br>• Greeting confirm = `pending_confirm`.<br>• Disclosure spans excluded.<br>• Distinct-field counting |
| **Verbatim check** | Exact → 1.0; paraphrase → < 0.9; number words ≡ digits; a missing critical token → `ok=false` |
| **Evidence clip math** | Edge-word rules, min/max lengths, clamps |
| **Simulate (sweep)** | • A synthetic call where the truth is known.<br>• v1 asserts a wrong fact mid-utterance; v3 does not.<br>• `reaskProjected` correct.<br>• `capHit` path |
| **Polar webhook verify** | Both schemes accepted; tampered body rejected; timestamp skew rejected |
| **Payment state machine** | Forward-only; fail-closed `send_confirmation`; `amount_mismatch` → failed; simulate from every non-terminal state; late webhook after `timeout` |
| **Limiter / broker / ledger** | Against a test Postgres (`pg` in Docker, or a throwaway schema on the Zerops DB): concurrency of 10 parallel acquires never exceeds 4 per 60 s; FIFO order; ETA > 15 s → cached; daily cap refusal → mode flip; epoch semantics (pre-epoch spend never counts); the dynamic daily cap formula; the remote authority client against the route handlers (in-process) |
| **Boundaries** | `src/core` has no `node:`/DOM/env imports; no session-opening call outside the allow-listed helpers (§3.1) |

### 9.2 Integration tests (`tests/integration/**`, `RUN_LIVE=1`, real APIs, cost-capped at ≤ $0.50 per full run)

Fixtures are reused from `spikes/fixtures` (`dialog_stereo_16k.wav`, `question_8k.mulaw`, `question_24k.wav`). **Every live test acquires its slots and ledger reservations from the limits authority** (`LIMITS_ROLE=remote`), runs serially (`vitest --no-file-parallelism`), and uses a `dev-*` deploy marker.

| Test | Checks | Cost |
|---|---|---|
| **STT per-channel** | Stream the left/right channels of `dialog_stereo_16k.wav` through `src/core/aai/streaming.ts` with `agent_context` carryover; expect finals on the correct channel and the 21 entities | ≈$0.02 |
| **STT 8k** | `question_8k.mulaw` with `TUNING_8K`; expect `481529` and a final before Terminate with a tail of silence | — |
| **Voice Agent core** | Node `connectNode`, the compiled config for a fixture case (greeting + stage tools); feed `question_24k`-style TTS answers; expect:<br>• `session.ready`;<br>• greeting audio;<br>• `update_case_field` `tool.call` → immediate `tool.result`;<br>• a stage-change `session.update` + `tool.result` ordering accepted;<br>• `session.end` | ≈$0.05 |
| **Hold tool** `[DAY-1]` | `send_esign_and_pay_link` in `hold`; `reply.create` status while holding; `tool.result` after 10 s → next reply | — |
| **Async verify** | Fetch the session → `/v2/transcript` multichannel → `computeQa` on real ch2 | ≈$0.01 |
| **OpenAI extractor** | 12 fixture turns (hand-written add-driver dialog) → events; asserts the kinds and values for 10 labelled events (tolerant: ≥9/10) | — |
| **Polar sandbox** | `checkouts.create` (ad-hoc fixed tax-inclusive price, `customerId`, prefilled address, no discount codes) → `get` → status `open`, `totalAmount === amountCents`; expires naturally | $0 |
| **VA retry** | Force `session.error{code:"server_error"}` after compile (fake server) → a second token is minted with `attempt:1`, the same compiled config is sent, the failed slot was released first | $0 |
| **Webhook e2e** | Via the deployed URL: pay with 4242 in the sandbox → `checkout.updated` → `payments.succeeded` (manual trigger script `scripts/day1/polar-e2e.ts`) | — |

### 9.3 Playwright e2e (`tests/e2e/**`)

**Projects:**
- `chromium`, with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`;
- `webkit` (Safari approximation: layout, audio unlock paths, no fake mic).

**Spec 1: `watch-replay.spec.ts`** ($0, runs in CI and locally)
- Starts the app with `E2E_FAKE_UPSTREAM=1`:
  - the STT and VA factories are replaced by **replay fakes** fed from a committed replay bundle;
  - `PAYMENTS_MODE=mock`.
- Path:
  1. Landing → Watch → Start.
  2. Transcript finals appear; the case card reaches ≥5 VERIFIED.
  3. Click Pass the baton at ≈60%; the stepper completes.
  4. Captions appear; autopilot answers.
  5. The phone SMS arrives and floats → esign → Simulate payment (and, in a second run, the autopilot countdown simulates).
  6. The confirmation shows.
  7. The QA card shows "Re-asked 0" (provisional) and the verified badge (fake verification).
- Also asserts:
  - a forced `replay_only` run: the pre-flight copy, manual Pass disabled, the recorded session at its handoff point with read-only controls;
  - **embed success does not navigate:** dispatch a synthetic `postMessage({type:"POLAR_CHECKOUT", event:"success", redirect:true, successURL:"/pay/done"})` to the page and assert the URL and the VA socket are unchanged;
  - an early pass at t≈20 s completes (the wrap-up never fires during `paying`);
  - the mobile viewport tabs and the floating phone at 1366×768.

**Spec 2: `watch-live.spec.ts`** (manual, `RUN_LIVE=1`, ≈$0.30)
- The same path against the deployed Zerops URL with the real APIs and Polar sandbox (card 4242 entered in the iframe via frame locators).
- Run it once per day from D3.

**Spec 3:** `explorer.spec.ts`, `evals.spec.ts`: static data renders, the drag changes the greeting, badges are present.

**Spec 4: `a11y.spec.ts`:** axe checks on `/` and `/call`, plus keyboard operation of Pass the baton and the Explorer scrubber.

### 9.4 Synthetic health check

This is F7, deployed as cron.

**Acceptance:**
- One light and one full run succeed on Zerops, visible on `/status`.
- A forced failure (a bad key in a staging env) flips `mode` after 2 consecutive full failures.

### 9.5 Load test (K4, free tier) — `scripts/loadtest.ts`

**Script (v1.1: 5 minutes):**
- 3 synthetic visitors start Watch every 20 s for 5 minutes (≈15 replay starts, 30 STT opens).
- Plus **3 simultaneous full runs from 3 real browsers** including 3 concurrent VA sessions (≈$0.25). Record whether `at_capacity` / `concurrency_exceeded` appears.
- Headless browser, or a Node client using the same routes and `StreamingSession`.
- ≈$1.0.

**Pass criteria:**
- 0 `E_STT_RATE`/1008/3009 closes;
- no visitor waits more than 15 s on a queue screen (ETA > 15 s → cached at once);
- every visitor either streams live or gets the labelled cached replay;
- 3 concurrent VA sessions work, or the observed limit is recorded and `VA_MAX_CONCURRENT` set to it;
- the ledger reconciles within ±10% of the `Termination` sums.

---

## 10. Deployment

### 10.1 Zerops (primary)

**`zerops.yml`** (repo root):

```yaml
zerops:
  - setup: app
    build:
      base: nodejs@22
      envVariables:
        NEXT_TELEMETRY_DISABLED: "1"
        NODE_OPTIONS: --max-old-space-size=6144
      buildCommands:
        - npm ci
        - npm run build            # next build → .next/standalone; esbuild migrate/cron → dist/; assemble → bundle/
      deployFiles:
        - bundle                    # lands at /var/www/bundle
      cache:
        - node_modules
        - .next/cache
    deploy:
      readinessCheck:
        httpGet: { port: 3000, path: /api/health }
        failureTimeout: 120
        retryPeriod: 5
    run:
      base: nodejs@22
      ports:
        - port: 3000
          httpSupport: true
      envVariables:
        NODE_ENV: production
        PORT: "3000"
        HOSTNAME: 0.0.0.0
        DATABASE_URL: ${db_connectionString}
        ENABLE_INPROC_WORKER: "1"
        LIMITS_ROLE: authority
        BATON_DEPLOY_ID: zp-prod
      initCommands:
        - node bundle/migrate.mjs   # idempotent drizzle migrator (advisory-locked); runs on every container start
      start: node bundle/server.js  # standalone server.js chdir()s to its own dir
      healthCheck:
        httpGet: { port: 3000, path: /api/health }
      crontab:
        - { timing: "7 * * * *",    command: "node bundle/cron.mjs light" }
        - { timing: "17 */6 * * *", command: "node bundle/cron.mjs full" }
        - { timing: "37 3 * * *",   command: "node bundle/cron.mjs purge" }
```

**`scripts/assemble-bundle.mjs`:**
1. `rm -rf bundle`.
2. Copy `.next/standalone/.` → `bundle/`.
3. Copy `.next/static` → `bundle/.next/static`.
4. Copy `public` → `bundle/public`.
5. Copy `drizzle` → `bundle/drizzle`.
6. Copy `dist/migrate.mjs` and `dist/cron.mjs` → `bundle/`.
7. Assert `bundle/server.js` exists.

This avoids depending on the `~` path-flattening syntax [16 §2.2]. **`[DAY-1 TEST]`** Deploy the scaffold and confirm `server.js` binds `0.0.0.0:3000`.

**`scripts/migrate.ts`:**
- `pg_advisory_lock(778899)`.
- `migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, "drizzle") })`.
- Unlock; exit 0.
- It never seeds destructive data.
- Seed (flags defaults) is an idempotent upsert.

**`scripts/cron.ts`** is a tiny `fetch("http://127.0.0.1:3000/api/internal/cron?kind=" + argv[2], { method:"POST", headers:{ "x-cron-secret": process.env.CRON_SECRET }})`. It uses no curl, because the Alpine base may lack it.

**`zerops-project-import.yml`:**

```yaml
project:
  name: baton
  description: "Baton: reps diagnose, AI finishes the call (AssemblyAI hackathon)"
  corePackage: LIGHT
  tags: [hackathon, assemblyai]
services:
  - hostname: app
    type: nodejs@22
    enableSubdomainAccess: true
    minContainers: 1          # always on: no cold starts during judging (Zerops runtimes never scale to zero)
    maxContainers: 1          # single container: the in-process ticker is fine; DB leases keep it safe anyway
    verticalAutoscaling: { cpuMode: SHARED, minCpu: 1, maxCpu: 2, minRam: 1, maxRam: 2, minDisk: 2, maxDisk: 6 }
  - hostname: db
    type: postgresql:single@17   # mode is fixed at creation; single is enough for the demo
```

**Steps:**
1. **Account:** sign up at app.zerops.io ($15 credit, no card). Optionally do the $10 verification for +$50 [16 §11]. Set a **daily spend limit** in the GUI (it only emails).
2. **Provision:** `zcli login <token>`, then `zcli project project-import zerops-project-import.yml --org-id <ORG_ID>`. Alternatively, paste the file into the GUI → Import.
3. **Secrets:** GUI → service `app` → Environment variables → **secret** variables:
   - `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`;
   - `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (after step 6);
   - `CASE_TOKEN_SECRET`, `VISITOR_SECRET`, `ADMIN_KEY`, `CRON_SECRET`, `AAI_WEBHOOK_SECRET`, `AGENT_TOOL_SECRET`, `LIMITS_AUTHORITY_KEY`.

   Non-secret variables go in the same panel:
   - `APP_URL` (the subdomain from step 5), `EMBED_ORIGINS`, `POLAR_SERVER=sandbox`, `POLAR_PRODUCT_ID`, `POLAR_DEMO_CUSTOMERS`, `POLAR_DEMO_CUSTOMER_EMAIL`, `PAYMENTS_MODE=polar`;
   - the caps and budget (`AAI_*`, `LEDGER_EPOCH` set at the D6 freeze, `JUDGING_END_DATE`), `VA_VOICE`, `VA_KEYTERMS`, `PAY_TOOL_MODE`, `FEATURE_BE_CUSTOMER=0`.

   There are **no `NEXT_PUBLIC_*` variables** (the default call is `featured` in `calls.json`; flags come from `/api/status`), so nothing is baked in at build time.

   **The same `LIMITS_AUTHORITY_KEY`** goes into the user's local `.env` with `LIMITS_ROLE=remote`, `LIMITS_AUTHORITY_URL=<APP_URL>` and `BATON_DEPLOY_ID=dev-<name>`, so every laptop script and test uses the Zerops authority from then on.
4. **Deploy:** `zcli push app` from the repo root (or from the integration worktree at a gate). Or connect GitHub (push-to-`main` trigger) once the repo is public.
5. **Subdomain:** it is enabled by the import. Copy `https://app-….zerops.app` into `APP_URL` and reload the service. A custom domain is optional (Dedicated IPv4 $3/30d) [16 §6].
6. **Polar webhook** (§10.2), then set `POLAR_WEBHOOK_SECRET` and reload. Secret changes need no rebuild.
7. **Smoke:**
   - `/api/health`;
   - `/status`;
   - `POST /api/internal/cron?kind=full` with the cron secret;
   - one Watch run;
   - one payment.
8. **Logs:** `zcli service log app --follow`.
9. **Balancer:** the default L7 `keepalive_timeout` is fine. Browser WebSockets go directly to AssemblyAI; only the STRETCH phone bridge needs tuning [16 §7].

### 10.2 Polar webhook registration

1. In the **sandbox** dashboard (`sandbox.polar.sh`), open the org settings → Webhooks → **Add Endpoint**.
2. URL: `https://<APP_URL>/api/webhooks/polar`. It must be the final URL with no redirect [12 §9].
3. Format **Raw**.
4. Events: `checkout.created`, `checkout.updated`, `checkout.expired`, `order.paid`.
5. Generate the secret and paste it into Zerops as the `POLAR_WEBHOOK_SECRET` secret.
6. Settings → Preferences → **Embedding**: add every `EMBED_ORIGINS` host (HTTPS). The embed refuses to load on unlisted hosts [12 §8].
7. Add the demo email alias as an org member, so sandbox emails deliver [12 §1].
8. Test: `scripts/day1/polar-e2e.ts` creates a checkout; pay with 4242; `payments.status` becomes `succeeded` with source `webhook` within 5 s.

### 10.3 Environment setup (local dev)

1. `npm ci`.
2. Local Postgres **for app data only**. Either:
   - `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:17`; or
   - `zcli vpn up` and a separate schema on the Zerops DB.
   Limits never come from this database: `LIMITS_ROLE=remote` + `LIMITS_AUTHORITY_URL` (the Zerops app), or the file guard before the first deploy.
3. Next reads `.env` at the root. Add `DATABASE_URL`, `APP_URL=http://localhost:3000`, `LIMITS_*`, `BATON_DEPLOY_ID=dev-<name>` and the secrets.
4. `npm run db:migrate` → `npm run dev`.
5. **Polar webhooks locally:** `polar listen http://localhost:3000/` [12 §9]. It prints its own local secret; put that in `.env.local`.
6. The HTTPS requirement for the mic is satisfied by `localhost`.

### 10.4 Vercel mirror checklist (target < 1 hour; only if lablab's "Demo application platform" field demands Vercel)

**Portability rules the code already follows:**
- standard Next.js + `DATABASE_URL`;
- no Zerops APIs;
- no runtime filesystem writes;
- background work via `after()` plus poll-advanced jobs;
- the in-process ticker is optional;
- static data in `public/`;
- no request bodies > 4.5 MB (audio is never uploaded).

| Step | Action |
|---|---|
| 1 | Vercel → New Project → import the GitHub repo. Framework: Next.js. Build command `npm run build:vercel`. Output: default (`output: "standalone"` is ignored by Vercel) |
| 2 | Postgres **for app data only**: Vercel Marketplace → Neon → it injects `DATABASE_URL` (append `?sslmode=require` if absent). Run `DATABASE_URL=<neon> npm run db:migrate` from a laptop |
| 3 | Env vars: copy the list from §3.4. `APP_URL=https://<project>.vercel.app`, `ENABLE_INPROC_WORKER=0`, **`LIMITS_ROLE=remote`, `LIMITS_AUTHORITY_URL=<Zerops APP_URL>`, `LIMITS_AUTHORITY_KEY`, `BATON_DEPLOY_ID=vercel-mirror`**. The mirror never enforces limits from Neon: every STT open, VA mint and ledger reservation goes to the Zerops authority |
| 4 | `vercel.json`:<br>• `{"functions":{"src/app/api/extract/route.ts":{"maxDuration":30},"src/app/api/internal/cron/route.ts":{"maxDuration":60}}, "crons":[{"path":"/api/internal/cron?kind=tick","schedule":"*/5 * * * *"}, …]}`.<br>• On the Hobby plan, crons run **once per day** at most. Instead, point the Zerops crontab (still running) or a GitHub Actions schedule at the Vercel URL with the `CRON_SECRET` header.<br>• Jobs also advance on `/api/verifications/*` polls, so verification works without cron |
| 5 | Polar: add a **second** sandbox webhook endpoint for the Vercel URL (its own secret goes into the Vercel env), add the Vercel host to the Embedding allowlist and to `EMBED_ORIGINS` on both deployments |
| 6 | AssemblyAI: nothing. Webhook URLs derive from `APP_URL`. The promoted agent's HTTP tool URLs point to whichever `APP_URL` created them, so re-promote on the mirror if you demo Promote there |
| 7 | Smoke: `/api/health`, `/status`, one Watch run, one payment |
| 8 | lablab form: "Demo application platform: Vercel" plus the Application URL (either host; both share the code) |

**Limits caveat (account-wide).** Both deployments share one AssemblyAI account, so they share **5 opens/min, the VA concurrency and the credit**. That is why the mirror is a remote of the Zerops authority (step 3): one broker, one VA registry, one ledger for both. The F6 audit recognises mirror sessions by their `vercel-mirror` marker and counts them through the registry. **If the authority is unreachable** from Vercel, the mirror falls back to the split budget (2 opens/min, 1 VA session, a $1/day local cap) and shows `CACHED REPLAY` sooner rather than risking rate-limit closes for both.

### 10.5 Stretch deployments

**STRETCH 5, live Twilio phone-leg handoff.** Add a sibling Zerops service `voicebridge` (nodejs@22, plain `ws` server, port 8080 `httpSupport`, its own subdomain or Direct Port Access):
- Twilio `<Connect><Stream>` → `voicebridge` receives µ-law 8 kHz in **20 ms** frames.
- During the human half it forwards them to the AssemblyAI Streaming session (header auth), **re-batched to 100 ms** with `FrameBatcher` (Streaming rejects frames under 50 ms with 3007, ST-15).
- On baton pass, it bridges the same Twilio stream to a Voice Agent session with `{"encoding":"audio/pcmu"}`. The VA's `audio/pcmu` output arrives as 37.5 ms / 300 B chunks and is re-framed to Twilio's 160 B (20 ms) frames with `ByteFramer(160)`; silence is `0xFF` [10 §3.4].
- It acquires slots from the same limits authority (it is in the same project, so it can use the DB implementation directly).

Rules:
- Send an app-level ping every 20 s.
- The balancer idle timeout can be raised to 300 s [16 §7].
- `voicebridge` reads `DATABASE_URL` through `${db_connectionString}` and shares the ledger and broker.

**Not in the MVP.**

---

## 11. Submission package (owned by WP13 unless noted; see TASKS §4 for dates)

lablab scores **Presentation, Business value, Application of technology, Originality** [06 §c]. Presentation 4–5 needs market analysis, revenue, future goals and a competitive analysis. A video under 3 minutes scores 2. The repo must be public, MIT and show honest commit history.

### 11.1 Deliverables checklist

| lablab field | Artifact | Owner | Draft → final |
|---|---|---|---|
| Project title (≤50 chars) | `Baton: reps diagnose, AI finishes the call` (42) | WP13 | D1 → D5 |
| Short description (≤255 chars) | `docs/pitch/descriptions.md` (§11.2) | WP13 | D1 → D5 |
| Long description (≥100 words) | `docs/pitch/descriptions.md` | WP13 | D2 → D5 |
| Technology & category tags | `docs/pitch/descriptions.md` | WP13 | D1 |
| Cover image (16:9 PNG/JPG) | `public/cover.png` 1920×1080, rendered from `docs/pitch/cover.html` | WP13 | D3 → D5 |
| Video (MP4, ≤5 min; target 3:50–4:30) | `docs/pitch/video-script.md` + `shot-list.md`; recorded by the user | WP13 script; user records | rough D3 19:00, final D4 19:00, re-record/edit D5 |
| Slide presentation (PDF) | `docs/pitch/slides.md` → `docs/pitch/slides.pdf` (9 slides, §11.4) | WP13 | outline D2, v1 D3, final D5 |
| Public GitHub repository | `README.md` (§11.5), `LICENSE` (MIT), clean history of gated merges | WP13 README; user pushes | README v1 D3, final D5 |
| Demo application platform | "Vercel" only if the field is a strict dropdown without "Other"; then stand up the mirror (§10.4). Otherwise the Zerops URL | WP12 | D5 |
| Application URL | the Zerops `*.zerops.app` URL (or the mirror) | WP12 | D3 |

### 11.2 lablab copy (drafts; WP13 finalises with measured numbers)

- **Title:** `Baton: reps diagnose, AI finishes the call`
- **Short description (249 chars):** "A licensed insurance rep hands a live call to an AI at any second. AssemblyAI Universal-3.5 Pro Streaming builds an evidence-linked case from both speakers; the Voice Agent API finishes the paperwork, reads the disclosure verbatim and never re-asks."
- **Technology tags:** AssemblyAI (Universal-3.5 Pro Streaming, Voice Agent API, async multichannel), OpenAI, Next.js, TypeScript, PostgreSQL, Zerops, Polar, Twilio (offline recording kit).
- **Category tags:** Insurance, Customer service / contact center, Voice AI, Fintech (payments).
- **Long description skeleton (≈250 words):** problem (the compliance-heavy admin tail of servicing calls; customers hate repeating themselves [08 §0]; every existing handoff is AI→human) → solution (the human→AI baton pass with context; the three rungs Shadow, Baton, Promote) → how both AssemblyAI APIs form one data path (§2.2) and why the LLM Gateway isn't used (free tier) → proof (the sweep over N real recorded calls, "re-asked 0", disclosure verbatim, verified from the agent's own recording; provenance labels) → buyer and pricing ($199/rep/month + $0.15/AI-minute) → what's real vs simulated (Polar sandbox payments, fictional policies, role-play calls) → the link and the 60-second judge path.

### 11.3 Video script outline (`docs/pitch/video-script.md`; recorded on the deployed URL, mode badge visible)

| Time | Beat | On screen | Voice-over key line |
|---|---|---|---|
| 0:00–0:12 | Cold open on the wow | The AI greeting playing over the S2 console; case card with evidence chips; **Re-asked: 0** | (the AI's own voice) "Hi Priya… Daniel passed me your request to add Maya…" |
| 0:12–0:35 | Problem, buyer, before/after | `/about` hero, one stat card, both API names on screen | "The last three minutes of a servicing call are paperwork, and every handoff today goes AI to human. Baton is the missing direction." |
| 0:35–2:05 | **Live demo** | Watch s01 (Express): live per-channel transcripts, chips turning green, ▶ evidence clip; **pass the baton at an arbitrary second**; the stepper's ms; Daniel's line + Priya's "Sure"; AI greeting with PENDING confirm; disclosure verbatim; the floating phone → e-sign → **Polar sandbox payment** (real test card); confirmation; QA card flips to **✓ Verified from recording**; HUD dead air | "I'll pass it mid-sentence… Baton waits for the turn to end, seals the case, and the AI starts with only what's verified." |
| 2:05–2:40 | Evidence | `/evals` curves (v1 → v3, mid-utterance series, ±`agent_context`, stereo vs mono), then drag the Explorer baton | "Across N real phone calls, at X% of takeover points the AI asserted zero wrong facts." (exact measured numbers only) |
| 2:40–3:30 | Business | ROI slider at break-even; pricing; autonomy ladder; **Promote** click (real `POST /v1/agents`) with the evidence card; competition line | "Not found in the hackathon pool or our market scan: Vapi, Bland, Five9 all hand off AI→human." |
| 3:30–4:10 | Architecture + roadmap | `/about` diagram; "why both APIs"; spike-verified numbers; roadmap (CCaaS connectors, live phone-leg bridge as a Zerops sibling service, DTMF, more intents) | "Streaming does the listening, the Voice Agent does the finishing, async proves it." |
| 4:10–4:25 | Close | Tagline, URL, repo | "Reps diagnose. AI finishes the call." |

**Recording rules:** 1920×1080, browser zoom 100%, captions burned in, one continuous take for the demo beat (cut only between beats), no real personal data on screen, the mode badge visible. Keep a backup take on a second day (D4) in case the live budget or an API misbehaves. If a beat fails, use its fallback from §1.5 and say so on screen.

### 11.4 Slide deck outline (`docs/pitch/slides.md` → PDF, 9 slides)

1. **Title:** Baton: reps diagnose, AI finishes the call. Tagline, URL, team, "Built on AssemblyAI Universal-3.5 Pro Streaming + Voice Agent API".
2. **Problem:** the admin tail (effective date, read-backs, verbatim disclosure, e-sign/pay, confirmation); customers hate repeating themselves (55% [08 §0]); every handoff runs AI→human.
3. **Solution:** the baton pass (human→AI with context); the autonomy ladder Shadow → Baton → Promote; one screenshot of the console.
4. **Demo:** the 6-step judge path as a filmstrip, with the "Re-asked 0 · Disclosure verbatim ✓ · Verified from recording" QA card.
5. **How it works:** the §2.1 diagram simplified; why both APIs; the deterministic status rules; fail-closed money; the LLM Gateway not used and why.
6. **Evidence:** sweep curves (v1 → v3, mid-utterance), K1/K2/K3 numbers with provenance badges, the measured admin-tail share from the recorded calls ("directional").
7. **Market and business model:** ~37,000 US independent P&C agencies averaging 9.9 staff (Big "I"/Future One 2026 [13 §4]); beachhead = MGAs, regional carriers and agencies with 20–200 servicing CSRs; pricing $199/rep/month + $0.15 per AI-finished minute + $299/promoted intent; unit economics (COGS ≈$0.34 for an 8-min call with a 3-min AI tail [11 §2.1]); ROI break-even formula with its inputs sourced.
8. **Competition:** a table by handoff direction [14 A.6]: Vapi (whisper, AI→AI, AI→human), Bland (AI→human), CCaaS suites (assist + AI→human), insurance AI receptionists such as Sonant (full automation, no human half), the hackathon pool (whisper/interrupt, never take over). Baton = human→AI with verified context. Claim: "not found in the pool or our market scan", never "first".
9. **Roadmap and ask:** CCaaS/AMS connectors (Applied Epic, AMS360, EZLynx), the live phone-leg bridge, more intents (address change, vehicle swap), promoted intents; what we'd do with AssemblyAI credits.

### 11.5 Cover image, README and licence

- **Cover (`public/cover.png`, 1920×1080):** rendered from `docs/pitch/cover.html` (HTML/CSS only; a headless screenshot). Content: the wordmark "Baton", the tagline, a stylised baton passing from a "Rep" lane (blue) to an "AI" lane (violet) over a waveform, three chips "Re-asked 0 · Disclosure verbatim ✓ · Verified from recording", and "AssemblyAI Universal-3.5 Pro Streaming + Voice Agent API". Readable at thumbnail size, no small text.
- **README.md outline:** one-line pitch and the live link → "Judge in 60 seconds" (Watch → Express → pass → pay/simulate) → what is live vs simulated (labelled) → how both AssemblyAI APIs are used, and why the LLM Gateway is not → architecture diagram → evals and provenance badges → free-tier engineering (one limits authority, budget, fallbacks) → run locally → deploy (Zerops; Vercel mirror checklist) → repo map → cost table → licence and credits (volunteers who consented). Mentions `research/10*` as the live-verified API notes.
- **LICENSE:** MIT, "Copyright (c) 2026 Md Abid Hussain" (created D0). Every dependency is MIT/Apache/BSD-compatible (WP0b runs `npx license-checker --summary` once).

### 11.6 Recording-day add-on: the "tail pack" and the s01 consent check (D1, user + volunteers)

The kit's normal procedure has the rep hang up ≈3 s after the customer accepts, so nothing after the handoff is recorded in the participants' voices. Two short extra things fix the "voices change" problem in the AI half.

1. **Before recording s01:** confirm that both s01 participants chose `"scope": "public"` in `participants.json`. s01 is the demo call and must be publishable.
2. **Right after the kept s01 take**, record one extra take with the same two people: `.\kit call --scenario s01 --rep <same> --customer <same>`. When "BOTH CONNECTED" shows, read the lines below in order with a one-second pause between lines, then hang up and mark it `.\kit mark <take> --discard --note "TAILPACK"` (discarded so it never enters the eval). About 3 minutes and $0.25.
   - **Rep (Daniel):** "Hi, it's Daniel again. I'm back on the line. What can I help with?" · "Hi, Daniel here, I've got you back. Let me take care of that." · "Okay, I'm back. Let's sort that out together."
   - **Customer (Priya), generic:** "Yes, that's right." · "Yes, go ahead." · "Yes, text me the link. No paper copy, thanks." · "Okay, I'm paying now." · "Okay, done, I've paid." · "No, that's everything. Thanks, bye!" · "Sure." · "Sorry, could you repeat that?" · "Can I talk to Daniel?" · "Actually, she'll mainly drive the Highlander."
   - **Customer (Priya), s01 answers for early passes:** "Her name is Maya Raman. M-A-Y-A." · "She's my daughter." · "March 14th, 2009. She's seventeen." · "Ohio." · "It's a probationary license. She passed last Tuesday." · "No tickets, nothing." · "She'll mainly drive the Civic." · "Every day, to school." · "It's parked at home, 4 4 1 0 7." · "Next Friday, October 2nd."
3. **Processing (WP11, `scripts/tts/cut-tailpack.ts`):** async-transcribe the take's two split channels (≈$0.01), fuzzy-align each scripted line, cut with 150 ms padding, resample 8 kHz → 24 kHz, write `public/tts/voice/s01/<slug>.pcm` + `manifest.json` (only when the take's `consent.publishable` is true). Autopilot and the hand-back use these clips first and label them "Customer (recorded)" / "Daniel (recorded)".

The same section is mirrored in `docs/recording-day.md` §15 so it is on the page the user follows tomorrow.

---

## Appendix A. API facts you must respect (condensed from 10 / 10a–10d)

### A.1 Endpoints and auth

- **Streaming WS:** `wss://streaming.assemblyai.com/v3/ws?…&token=<tok>` (browser), or the raw-key `Authorization` header in Node.
  - **`Bearer` is rejected** on the WS (1008).
  - Token: `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=10&max_session_duration_seconds=600` with the header `Authorization: <raw key>`. (`max_session_duration_seconds` only shows up in `Begin.expires_at`; its enforcement is unverified.)
  - Array params go into the URL as JSON strings.
- **Voice Agent WS:** `wss://agents.assemblyai.com/v1/ws?token=<tok>`.
  - Token: `GET https://agents.assemblyai.com/v1/token?expires_in_seconds=10&max_session_duration_seconds=<cap s>` (the cap is not enforced).
  - The server sends **nothing until the first `session.update`**.
  - Auth failures arrive as `session.error{code:"unauthorized"}` + close 1008.
- **REST:** `https://agents.assemblyai.com/v1/{agents,sessions,sessions/{id}}` and `https://api.assemblyai.com/v2/transcript`, both with the raw key.
- **Tokens are reusable** within their window and **the Voice Agent session cap is not enforced**.

### A.2 Streaming frames, events and control

- **Frames:** binary, 50–1000 ms (else 3007).
  - 16 kHz PCM16: 50 ms = 1600 B.
  - 8 kHz µ-law: 100 ms = 800 B.
- **Events:** `Begin` → `Turn` (replace per `turn_order`; final = `end_of_turn:true`; ignore empty finals) → `Termination`.
  - The last turn needs trailing audio (silence) or `ForceEndpoint` to finalize.
  - `UpdateConfiguration` has no ack.
  - `agent_context` and `prompt` are capped at 1750 chars (fatal if exceeded, even mid-stream).
  - At most 100 keyterms of ≤50 chars each.
- **ForceEndpoint:** final in ≈270 ms. **Never mid-speech.**
- **Word times:** the first word of a turn is ≈1 s early; the last word is 0.24–1.3 s late.
- **Shutdown:** `Terminate`, then wait for `Termination` (0.6–1.3 s). Billing runs from open to `Termination`.
- **Close codes:** retry on 1006/1011/3005; not on 1008/3006/3007. An `inactivity_timeout` close is **3006 with no `Termination`** and the text "Session terminated due to inactivity" [10b]: treat it as transient (`E_STT_INACTIVITY`).

### A.3 Voice Agent audio, turns and tools

- **Audio in:** `input.audio` base64 PCM16 24 kHz, 50 ms = 2400 B, at real time, only after `session.ready`.
- **Audio out:** `reply.audio` 10 ms = 480 B chunks at real time. Every reply starts with 0.2–2 s of silence; tool pre-ambles are fully silent.
- **Greeting and voice:**
  - The greeting is spoken verbatim.
  - Omit it rather than sending `null` (`invalid_format`).
  - `greeting`, `output.voice` and `output.format` are immutable after the first update.
- **Latency:** `min_latency` plain turns take 2.1–2.6 s end-of-speech → audible; `balanced` ≈ +0.7 s; speech-triggered tool turns ≈3.5–5 s.
- **First `session.update`:** any validation error closes with 1008. Only the keys and values in `validateFirstUpdate` (§5.9.1) are sent. `hold`, non-null `keyterms` and schema `format` were never live-sent before T-D1-0.
- **Tools:**
  - `tool.result` immediately (≈1 s faster); drop it on interruption.
  - The list is **replaced** on update.
  - Stored-agent mid-session prompt and tool updates work.
  - HTTP tools exist only on stored agents; the client still receives an informational `tool.call` (never answer it).
- **Context:** `conversation.message` never reaches the model. Use `reply.create{instructions}` or `session.update{system_prompt}`.
- **Barge-in:** `input.speech.started`, `transcript.agent{interrupted}` and `reply.done{interrupted}` arrive together.
- **Captions:** `transcript.agent` may contain unspoken text.
- **Ending:** always `session.end`, then wait for `session.ended`.
- **Artifacts:** available ≈7 s after the end: stereo OGG (L = user = ch1, R = agent = ch2), timeline and metadata. Pre-signed URLs last 1 h (eu-west-1).

### A.4 Async, OpenAI and TTS

- **Voice Agent voices (18):** `alba, anna, charles, estelle, eve, george, giovanni, iris, jane, jean, juergen, lola, mary, michael, paul, rafael, reid, vera`.
- **Async:** `POST /v2/transcript {audio_url, speech_models:["universal-3-5-pro"], multichannel:true}` completes in about 3.4–12 s.
  - Word times are 80 ms-quantized.
  - `audio_duration` is not doubled (bill × channels).
  - Never display sentiment or entity rows.
- **OpenAI Responses:**
  - Always set `reasoning.effort` explicitly (`none`/`low`; never `minimal`).
  - `temperature` only with `none`.
  - `max_output_tokens` ≥ 16.
  - Handle refusal and `incomplete`.
  - TTFT ≈1.1–1.2 s for luna/sol.
- **OpenAI TTS:** `gpt-4o-mini-tts-2025-12-15`, `response_format:"pcm"` → 24 kHz s16le mono. HTTP chunks are often **odd-length**: carry the odd byte.

## Appendix B. Day-1 tests (each has a named fallback)

Run in this order on D1 (all live tests acquire slots from the file guard or, once deployed, the limits authority). **T-D1-0 runs first**, at 09:30, before WP5b builds on the first-update format.

| # | Test | Owner | Pass criteria | Fallback |
|---|---|---|---|---|
| **T-D1-0** | **First-update acceptance.** Send the exact compiled first `session.update` (from WP1's compiler on the s01 and s02 fixture snapshots) for both initial stages, `confirm` and `disclose`: once with `VA_KEYTERMS=0`, once with keyterms (≤100, ≤50 chars), each `transcription_mode` value once | WP5b | `session.ready` every time; `session.ready.config` echoes `input.transcription_mode`, `input.keyterms` (when sent) and `tools[].execution_mode:"interactive"` as sent | Drop the failing field from the whitelist (keyterms stay off); never ship an untested first-update field |
| T-D1-0b | `DELETE /v1/sessions/{id}`: (a) on a **live** session: does it end it? (b) on an ended one: does the artifact URL stop working? | WP8 | Documented either way | F6 only flips the mode; the privacy copy says "requests deletion" |
| T-D1-1 | `hold` execution mode, sent **mid-session** by a stage `session.update`: silence while held, `reply.create` status mid-hold, `tool.result` fires the next reply | WP5b | All three observed | `PAY_TOOL_MODE=push` (§5.8) |
| T-D1-2 | Stage change: `session.update{tools}` immediately followed by `tool.result`; the next reply can call a newly added tool | WP5b | The new tool is called in the auto-fired reply | Wait for `session.updated` before `tool.result` |
| T-D1-3 | Idle WS for ≥10 s before the first `session.update`, **with a 5 s token that expires during an 8 s idle** | WP5b | `session.ready` after the idle, with the expired token | Open the WS at COMPILING; mint the token later |
| T-D1-4 | `input.transcription_mode` (and `keyterms`, if on) mutable mid-session; ZIP and DOB capture with autopilot TTS clips in `min_latency` vs `balanced` | WP5b | `session.updated`, no error; capture accuracy recorded per mode | Fixed mode at start: `balanced` when any MISSING entity field, else `min_latency` |
| T-D1-5 | Inline `session.update` with `http` tools (per-case HTTP tools) | WP5b | Accepted and invoked | Function tools (MVP default) |
| T-D1-6 | 8 kHz turn tuning on 2 real takes (v1.1 grid, 16 sessions): `min_turn_silence ∈ {160,400}` × `max_turn_silence ∈ {1000,2400}`, plus one Hinglish take × 8 kHz × `prompt`/`keyterms_prompt` | WP4 | Recall ≥ 90%, p50 final ≤ 1 s | Golden 16k for the demo if recorded; 8k as a robustness curve |
| T-D1-7 | Browser worklets: mic capture (spike, first real-browser test), call player, VA output, on Chrome, Safari and Firefox; **iPhone with the silent switch on** (Watch path audible via `audioSession="playback"`) | WP4 | Audio correct; no 3007; no drift after 3 min; iPhone audible | Per-browser fixes; Safari → typed/chips |
| T-D1-8 | Zerops scaffold deploy: standalone bundle, `migrate.mjs`, health, subdomain; `/api/internal/limits/*` reachable from the laptop with the key | WP0b | Green `/api/health` on `*.zerops.app`; a remote `stt-acquire` round trip | Fix the deploy files; worst case, the Vercel mirror (as a remote of a local authority) |
| T-D1-9 | Polar: the ad-hoc fixed `prices` map with `taxBehavior:"inclusive"` is accepted by SDK 0.49.0; no editable amount; `totalAmount === amountCents`; name/email locked via `customerId`; US address prefill skips the form; discount codes hidden; embed loads on the Zerops host; **embed `success` with `preventDefault()` does not navigate**; the webhook verifies with our dual-scheme function; the full funnel is timed 5× (for the deck) | WP6 | All | Catalog price + `taxBehavior` + `amount`; "plus any applicable tax" disclosure; hosted link; Simulate; mock mode |
| T-D1-10 | CSP with `blob:` worklets and `wss:` AssemblyAI | WP0b | No CSP violations in the console | Relax to `script-src 'self' 'unsafe-inline' blob:` |
| T-D1-11 (D2 AM) | Promote probe: POST the exact §5.14 body (HTTP tools with `http_method:"POST"`), GET it back, diff the echo; one POST tool call arrives with a JSON body | WP10 | Created (201) and echoed as sent, minus anything documented | Drop rejected/ignored fields; keep this agent as the "already promoted" fallback |

## Appendix C. Open questions (to the user; defaults are applied if unanswered)

1. **Budget.** What is the AssemblyAI balance on the dashboard today? Default: judging budget = balance at the D6 freeze − $5 reserve (≈$31), dynamic daily cap ≤ $3 (§7.2).
2. **Golden 16 kHz calls.** Default (v1.1): **not recorded**; the default demo call is the best Twilio 8 kHz `s01` take (label "phone audio"). Record them only if the recording day finishes early.
3. **Publishing consent.** Which volunteers consent to public audio? At least 3 calls must be publishable for Watch mode and the Explorer, **and s01 must be one of them** (check before recording s01; if nobody consents to "public", s01 is recorded with a consenting friend or family member; last resort, an all-TTS s01 labelled "synthetic voices").
4. **Handoff lines.** Every take should include the rep's scripted handoff line (the kit's `handoff.line`) spoken clearly. Watch mode reuses it as the baton clip and as the auto-baton point. Takes without a clean line fall back to a labelled TTS line.
5. **Brand.** Agency and carrier names come from the scenarios ("Harborview Insurance Agency", "Northbeam Mutual"; fictional). Also keep "Baton" or pick NextLeg [14 B.3]? Default: keep "Baton" for the hackathon.
6. **OpenAI spend ceiling.** Default: $3/day during judging.
7. **Promote on the public page.** Should judges be able to click Promote (rate-limited upsert), or only the operator? Default: judges can, upsert-only.
8. **Git workflow.** May coding agents make local commits on their own `wp/<n>` branches in separate worktrees (never pushing), with the user or an integrator merging at gates? Default: yes (TASKS §0); the user alone pushes.
9. **Zerops verification.** Pay the $10 verification for +$50 of credit before Sep 30 so October hosting can't run dry? Default: recommended.

## Appendix D. Review log (v1.0 → v1.1)

Three adversarial reviews of v1.0 (API correctness, demo reliability, scope and schedule). ✅ = applied, ◐ = applied in part (the reason is given), ✗ = rejected (the reason is given). The relayed scope/schedule review was cut off after its third blocking item; its verdict and the three blocking items are applied, and nothing beyond them was visible.

### D.1 API correctness

| # | Finding | Decision | Where |
|---|---|---|---|
| A-B1 | The first `session.update` carries never-sent fields (`keyterms` values, `hold`, schema `format`); a validation error is fatal | ✅ T-D1-0 first; `hand_back_to_rep` → `interactive`; `keyterms` behind `VA_KEYTERMS` (off until T-D1-0 passes; ≤100 × ≤50 chars); `format` → `pattern` + `examples`; `validateFirstUpdate()` whitelist on server and client | D11, §5.8, §5.9.1, App. B |
| A-B2 | Free-tier limits are account-wide, but brokers are per database; the mirror, dev, scripts and tests bypass them; F6 would flag them | ✅ One limits authority (Zerops) reached over HTTPS by every other opener, rather than pointing the mirror's `DATABASE_URL` at the Zerops DB (that needs Postgres direct port access on a paid dedicated IPv4, which promo credit can't buy). A file guard before the first deploy; a split-budget fallback; a boundaries test forbidding direct opens; F6 keys on a deploy marker in the prompt; §10.4 caveat rewritten | D6, §2.3, §4.4 #28, F6, §10.4 |
| A-I1 | `min_latency` everywhere contradicts the golden config for entity capture | ✅ `TranscriptionMode` widened; `inputModeFor(nextStep)`; mid-session switch; T-D1-4 measures ZIP/DOB capture per mode | §4.1, §5.9.1 |
| A-I2 | luna timeout and token budgets are below measured throughput; the retry is shorter than the first try | ◐ Budgets from throughput (≈8 s at 1000 tokens), retry with only the newest turn and the same timeout, `incomplete` → fewer turns, ≤3 turns per batch, measured from Prague on D1. **Streaming deltas rejected:** a fact that misses the drain is simply not asserted (safe by construction), so partial results add complexity for no demo gain | §5.3 |
| A-I3 | Polar may add US tax, so the total ≠ the verbatim "due today" | ✅ Ad-hoc fixed, tax-inclusive price per checkout; `total_amount === amount_cents` enforced (else `amount_mismatch`); the tool result and phone show Polar's total; "plus any applicable tax" disclosure as a flagged fallback | §5.8, §5.12, T-D1-9 |
| A-I4 | Promote sends `input.transcription_mode` to a stored agent; `POST` HTTP tools untested | ✅ Field dropped; T-D1-11 probe on D2 (POST, GET, diff); one agent promoted before the video | §5.14, App. B |
| A-I5 | Total-cap semantics ambiguous; the daily cap doesn't fit a 3-week window | ✅ `LEDGER_EPOCH`, `AAI_JUDGING_BUDGET_USD`, dynamic front-loaded daily cap, daily operator balance entry and guard | §3.4, §7.2, F8 |
| A-I6 | Reusable tokens + hourly audit leave an expensive abuse window | ◐ Audit every 3 min with a marker filter and a concurrency check; token windows 30/15 s → 10 s; the DELETE-ends-session test (T-D1-0b) and delete on anomaly if it works; residual risk in the runbook. **Not shortened below 10 s:** India → US mint-to-connect plus one retry needs the margin | §2.3, F6, §7.7 |
| A-n1 | T-D1-3 should use a token that expires during the idle | ✅ | App. B |
| A-n2 | Token `max_session_duration_seconds` is not a proven cap | ✅ labelled unverified; the worst case settles on inactivity + terminate | §7.3, App. A |
| A-n3 | 3006 inactivity isn't a bug | ✅ `E_STT_INACTIVITY` | §5.1.9, §7.4 |
| A-n4 | Tool-turn latency figures mix bases | ✅ 3.5–5 s used in claims | §5.10 |
| A-n5 | Verifier runs overlap; the sweep uses the start time | ✅ no-overlap condition; start + latency | F2, §6.5 |
| A-n6 | "Soft-deletes the recording" was never exercised | ✅ "requests deletion" + T-D1-0b | §8.3 |
| A-n7 | F6 pagination | ✅ | F6 |
| A-n8 | Twilio bridge framing wrong for Streaming | ✅ 100 ms re-batching; `ByteFramer(160)` on VA output | §10.5 |
| A-n9 | Hinglish params per channel; untested 8 kHz Hinglish; script mismatch in K1 | ✅ per-channel `language_codes`; a T-D1-6 Hinglish run; K1 compares normalized values only | §5.1.5, App. B, TASKS WP9 |
| A-n10 | Polar SDK camelCase | ✅ | §5.12 |
| A-n11 | Async `keyterms_prompt` + `multichannel` untested together | ✅ retry without keyterms on 400 | F3 |
| A-n12 | Mint failures should map to labelled fallbacks | ✅ | §4.4 #5, §5.1.9 |
| A-n13 | MONO takes counted as channel-separated | ✅ excluded in WP9 via `twilio.recording_channels`; the kit itself is not edited (owned by the recording-kit agent) | §6.2, §4.1 |
| A-n14 | STT URL typos fail silently | ✅ URL-query snapshot test | §5.1.6, §9.1 |

### D.2 Demo reliability

| # | Finding | Decision | Where |
|---|---|---|---|
| B1 | Polar embed `success` navigates the page and kills the call | ✅ `preventDefault()` on `success`; no `successUrl` for embeds; we close the overlay; a Playwright no-navigation test; added to T-D1-9 | D15, §5.12, S6, §9.3 |
| B2 | The passive Watch path dead-ends at a 90 s pay hold | ✅ Simulate always offered; autopilot countdown; card shown and copied before the overlay; progress-aware hold up to 180 s; reassurance suppressed while paying; late success confirms; the phone floats | §1.3 P1, S6, §5.8 |
| B3 | The VA retry can never mint a token | ✅ takeover-keyed mint with `attempt`, `retries`, `last_failure_at`; zombie slot released first; integration test | §4.4 #10, §5.5.3, §9.2 |
| B4 | The 240 s cap collides with early passes plus payment | ✅ dynamic cap 150 s + 15 s per open field (≤420 s) + hold time; wrap-up paused/never in `paying`/`closing`; a live estimate before the pass; an early-pass acceptance test | §5.9.5, S2, §9.3, TASKS K2 |
| B5 | iPhones on silent play nothing | ✅ `audioSession="playback"` in the gesture, a silent `<audio>` fallback, an iOS hint, a matrix row | §7.6, T-D1-7 |
| B6 | Recorded AI session contradicts the case card on replay days | ◐ The AI half is decided at Start (D14, `POST /api/runs`, VA budget and slot held); recorded runs disable the manual pass, play the bundle at its own point and swap the case card to the bundle's state. **Not made all-or-nothing for STT:** on days when only the VA is short, live STT still runs, and the swap at the handoff removes the contradiction | D14, §1.3, §5.5.4, §7.5 |
| I1 | The third concurrent judge waits 45 s and gets a replay anyway | ✅ ETA > 15 s → cached at once; ticket expiry; a per-ipKey ticket cap. The hot upgrade to live is D4 polish (first to cut) | §2.3, §5.1.10 |
| I2 | VA concurrency never load-tested; dead slots held 5 min | ✅ K4 adds 3 concurrent VA sessions; heartbeats, stale after 30 s | §4.4 #12, F5, §9.5 |
| I3 | Budget can silently run out; no external alerting; Zerops runway | ✅ epoch semantics, a balance guard, error mapping, a GitHub Actions monitor, the $10 Zerops verification recommended | §7.2, §7.7, F8 |
| I4 | Rate-limit gaps both ways | ◐ ipKey buckets on STT grants, a ticket cap, VA ipKey 12/h, plain-words messages. **Rejected:** "only accept a `bvid` set ≥5 s earlier": a judge who clicks Watch within 5 s of landing would be refused; the ipKey buckets already bound cookie rotation | §4.4, §7.3 |
| I5 | Polar friction and trust (editable amount, name, email, popup blocker, embed origin, discounts) | ✅ all six; the funnel timed 5× on D3 for the deck | §5.12, T-D1-9 |
| I6 | iOS interruption and backgrounding | ✅ iOS-scoped pause/resume, VA `session.end` after 10 s hidden, 3006 inactivity mapping | §7.6 |
| I7 | Autopilot stalls or loops | ✅ stall timer, luna classifier fallback, loop breaker, all templates pre-generated with their own bucket, 600 ms delay | §5.15 |
| I8 | The agent doesn't know "today" | ✅ `TODAY` in the prompt; server-side date resolution; the call date shown | §5.7, §5.8, S2 |
| I9 | The handoff sounds fake (no acceptance; voices change) | ✅ the manual pass plays the real acceptance; the recording-day tail pack; clip labels | §1.3, §5.1.1, §11.6 |
| I10 | The default call can 404 or lack audio | ✅ `featured` in `calls.json`, a test, a redirect, the s01 consent check before recording, a synthetic last resort | §1.3, §4.1, App. C |
| I11 | A transaction is held across the LLM call; the pool is too small | ✅ no transaction across the call, a version check, pool 15, timeouts, slower polls | F1, §3.3 |
| I12 | Slow networks | ◐ prefetch, immutable caching, an adaptive jitter buffer, a `bufferedAmount` badge. **Rejected for now:** a streaming-fetch start at 10 s buffered: the default call is 8 kHz µ-law (≈0.8 MB per channel per 100 s); revisit only if a 16 kHz call becomes the default | §5.1.1, §5.9.3 |
| I13 | No orientation; liveness hard to see | ◐ a narrator strip, session ids in the HUD, a "Try this" conflict chip, the floating phone. **Cut:** the 3-step coach mark (the narrator strip covers it; time) | S2, §1.3 |
| I14 | The test plan misses adversarial conditions | ✅ matrix rows added; run on D4 and D5 | §7.6, TASKS WP12 |
| n1 | Honest durations; Express primary | ✅ | §1.3 |
| n2 | Express snaps to a turn start and seeds `agent_context` | ✅ | §5.1.6 |
| n3 | An evidence clip over the live call | ✅ duck to 20% | §5.11 |
| n4 | Curate the picker (decreases, $0, December start, declines) | ✅ picker tiers and labels | §1.3, §4.1 |
| n5 | The HUD leads with dead air | ✅ | §5.10 |
| n6 | Mic recording notice; Bluetooth warning | ✅ | §1.3 |
| n7 | Headphones hint only in mic mode | ✅ | §1.3 |
| n8 | `ai-thinking` from end of speech | ✅ | S2 |
| n9 | QA `details[]` visible | ✅ | S3 |
| n10 | Pre-flight Start is a full unlock (deep links) | ✅ | §7.6 |
| n11 | `Begin` check: warn in production | ✅ | §5.1.6 |
| n12 | Hand-back dead end | ✅ "Pass the baton again" | §1.3 |
| n13 | Cookies blocked | ✅ a signed header fallback | §4.3 |
| n14 | Explorer JSON size | ✅ one file per version × variant, lazy | §6.5 |
| n15 | WSS reachability probe | ✗ deferred: it needs a Day-1 test of the missing-token behaviour, and the 8 s / 3 s timeouts already land on the labelled fallback | — |
| n16 | Custom domain or jsDelivr for assets | ✗ for now: a dedicated IPv4 can't be bought with promo credit, a domain adds cost and DNS time, and the assets are small; revisit if K4 or the D4 matrix shows balancer trouble | — |
| n17 | Bundles from the same take; a second mid-call bundle | ✅ | §7.5 |

### D.3 Scope and schedule

| # | Finding | Decision | Where |
|---|---|---|---|
| S-B1 | No one owns the video, deck, cover, README, descriptions or business numbers; the video lands too late | ✅ WP13 Pitch pack from D1; §11 specifies every asset; rough video D3 19:00, final D4 19:00, D5 buffer | §11, TASKS WP13, §4 |
| S-B2 | Public repo: no commits, no MIT licence, agents can't commit, research profiles judges | ✅ `LICENSE` (MIT) created; `.gitignore` excludes `research/` except `research/10*`; D0 first commit and push by the user; per-WP worktrees with local commits on `wp/<n>`; the integrator merges and the user pushes at 8 gates | §3.1, TASKS §0, §4 |
| S-B3 | The schedule can't be met (serial chains; WP5, WP7, WP9 underestimated) | ✅ Wave 0 starts tonight (split WP0a/WP0b); WP5, WP7 and WP9 split; vertical slice D2 14:00; full path on Zerops D3 16:00; a cut list worth ≈30–35 agent-hours and ≈$4.5; submit D6 by 10:00 | TASKS §1, §4, §6 |
| S-verdict | Never cut: live per-channel STT + `agent_context`, deterministic status and greeting, the baton protocol + auto-baton, VA with progressive tools and the verbatim disclosure, the fail-closed Polar step with mock, the async "verified" QA card, v1/v2/v3 curves with a mid-utterance series, Explorer, `/evals`, cached replay, caps and kill switch | ✅ adopted as TASKS §6 "Never cut" | TASKS §6 |
