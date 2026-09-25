# WP7 notes: call console → RelayConsole

Before WP7·1 (Day 1, commits `f69885f`, `6e255f5`, `3fa14da`): the UI store (`BatonUiState` ext, reducer, phase
derivation, selectors/copy), the s01 fixture logs for every S2 state, the console components (transcript lanes, case
card, controls, HUD, timeline, phone dock, QA card), `/dev/ui`, `/call` and an orchestrator skeleton behind a null
controller seam. The Day-1 attempt's unit tests (store, orchestrator, evidence, render, UI boundaries) were left
uncommitted by the interruption; WP7·1 committed them first (`69a47fa`).

## WP7·1 (D1 AM): Baton console on the real controllers

### Done

- **`git merge main`** (G1 `a914341` + the v2.1 addendum), clean.
- **`git merge wp/wp5`** (`d407cfc`). WP5's TakeoverController is **not on main** (it merges at G2), but it is round-1
  complete, idle and already merged with the current main (`8aa319a`), so `/call` is wired to the real controller
  instead of a stand-in. No WP5 file was edited. See "What the integrator must do" (merge order).
- **`src/client/session/wiring.ts`** (new; replaces the null `controllers.ts` seam): `createBrowserControllers()` =
  - WP4: `getAudioEngine()`, `createPageLifecycle()`, and `createHumanHalf()` = `HttpCaseSync` → `CachedReplay` →
    `LiveSttChannelManager` (`takeover` = the WP5 controller's `armInfo()`, late-bound), per `wp4-to-wp7.md`;
  - WP5: `wireTakeover()` = `createTakeoverController` with `HttpTakeoverApi`, `autoBaton` in Watch mode, WP1's
    `compileTakeover` as the client-compile fallback, `recorded: null` (WP11 not built), per `wp5.md` §6.2;
  - WP5b: `createVoiceAgentController` per attempt (WP1 `validateFirstUpdate`; `stageSource` = WP1
    `compilePrompt`/`toolsForStage` on the page's latest case state; #12 `postEvents` with the takeover token) and one
    `LatencyHud` with `hudMetricReporter` (→ `hud` BatonEvents + #12), per `wp5b.md` §5;
  - routes #14/#15 through `src/client/session/tool-ports.ts`, a contract-exact stand-in for WP6's client (same retry
    policy), replaceable through the `toolPorts` option.
- **Orchestrator** (`src/client/session/orchestrator.ts`, rewritten around the real seams):
  - **Express is the default.** `prepare()` fetches the cached turns (`/data/cached-turns/<callId>.json`) and peaks,
    runs WP4's `expressStart()` (decision point − 25 s snapped back to a clean cut), creates the case with
    `prefillUntilMs = the cut`, and starts the run with `express:true`. Start plays from the same cut and seeds the
    customer session's `agent_context` with the last cached rep final. "Full call" re-creates the case without the
    prefill (releases the Express run first).
  - Start: `unlockSync()` + lifecycle attach synchronously in the click; a context not running after 300 ms →
    "Tap to enable sound". `queued` STT: playback waits until both channels are live (or cached, or the judge chose
    "Watch the cached replay now"). A `denied` open is left to WP4's own cached fallback (no double activation).
  - The page sink tees every `stt.final` into `TakeoverController.noteFinal` (the cut-turn marker).
  - Pass: `unlockSync()` again in the click, then `arm("manual")` only when `manualPassAllowed`. "Ask for {rep}" →
    the VA's `say()` with hand-back instructions; "End call" → `endCall("user_end")`.
  - QA: when WP5's view gets `verificationJobId` (after `/end`), poll #20 every 1.5 s for ≤ 150 s with the takeover
    token (captured by wrapping `TakeoverApi.arm`, since the controller keeps it private). 404 → "no recording to
    verify", keeping the provisional numbers.
  - Run hold: WP5's controller releases it (rule 8 at the recording end, keepalive on pagehide). The page releases it
    itself only before the controller exists, or on an in-app unmount without a pass. On pagehide the page does
    **not** dispose the controller (our listener runs first; disposing would remove WP5's pagehide listener
    mid-dispatch and skip its `session.end` + keepalive `/end`).
- **Store** (`reduce.ts`): WP5 emits one `takeover.phase` per dispatch (a quiet click goes idle → draining without an
  `armed` event) and stamps `atMs` on the AudioContext clock. The reducer now starts a pass on the first in-pass phase
  after idle/done/failed/fallback and takes the call-clock arm time from `detail.tArmMs` (fixture logs, which stamp
  call ms in `atMs` and emit `armed`, render unchanged).
- `/call` index is per-request (it was prerendered as a build-time redirect to `/dev/ui`); an empty or missing call
  manifest is no longer cached by `call-entry.ts`.
- `LiveConsole` uses the real wiring, passes the visitor token back to the page API, and disposes with
  `pagehide` vs `unmount` semantics.

### Decisions

- Merged `wp/wp5` into `wp/wp7` rather than stubbing the TakeoverController (WP5 is complete; G2 merges both).
- Client constants `PAY_TOOL_MODE=push`, `VA_KEYTERMS=1` in `wiring.ts` mirror the server env defaults. The server
  compile (#11) stays authoritative; the constants only shape the local-compile fallback and the paid → close stage
  source. `deployId` for the local compile comes from `/api/status` (`"client"` if status is down).
- Kept intent-agnostic where it was free: the wiring passes compile/stage sources as functions (the D2 relay console
  swaps them for the relay engine's), and the store's pass detection no longer depends on Baton-specific phase order.
- Not wired yet (by scope): AI-half evidence clips (#21 is a 302 to a signed OGG; needs a browser check),
  provisional QA before verification, WP11 recorded AI half and the rep's "I'm back" line (`playRepBack`), WP5 `info`
  notices in the UI (the `error` ones already arrive as `error` events).

### Tests

- `npm run typecheck` clean. `npm test`: **77 files, 978/978 passed** (worktree, local Postgres).
- `next build --webpack` passes in the worktree (Turbopack cannot build inside a junctioned worktree, known G1 note).
- `tests/unit/ui/orchestrator.test.ts` (15 tests, fakes at the new seams): the Express cut (snapped 79.9 s with a
  seed; unsnapped 81.5 s without cached turns); click-synchronous unlock and start order; `stt.final` → store +
  `noteFinal`; full-call re-creation; cached plan vs denied open; queued wait and "watch cached now"; audio-locked;
  pass/ask/end; verification poll with the token (once) and the 404 path; hold-release ownership on recording end,
  unmount and pagehide; no-Web-Audio copy.
- `tests/unit/ui/baton-wiring.test.ts` (**real WP4 + WP5 + WP5b + WP1 code**, fake transports, $0, ≈0.3 s):
  Express prepare → Start (WP4 grant, both channels open, session ids to the store and HUD) → a live rep final
  reaches the store and `/api/extract` → Pass (arm → seal → drain → compile → VA token → token-URL socket → a
  WP1-validated first update; STT terminated; playback stopped; handoff clip) → greeting audible → store in an `ai-*`
  phase with the call-clock arm time → Ask for the rep (`reply.create`) → End call (`session.end` → `/end` with the
  takeover token) → verification poll → QA "verified". Stable over repeated runs.

### Live spend

**$0.** No AssemblyAI, OpenAI or Polar call; no deploy. (WP7 budget: $0.30 AAI / $0.02 OpenAI, unused.)

### What the integrator must do (G2)

1. **Merge order:** `wp/wp7` already contains `wp/wp5` at `bd2e3c6`/`8aa319a`. Merge `wp/wp5` first (as planned), then
   `wp/wp7`; or `wp/wp7` alone brings WP5. If WP5 gets new commits, merge its tip first. No conflicts expected.
2. **WP6 tools client:** after `wp/wp6` merges, swap the stand-in in `src/components/call/live-console.tsx`:
   `createBrowserControllers({ toolPorts: ({ takeoverToken }) => ({ callTool: createCallTool({ token: takeoverToken }),
   pollPayment: (id) => createPaymentsClient({ token: takeoverToken }).get(id) }) })` (WP7·2 does this together with
   the MockPhone mount; the stand-in already speaks the same contract).
3. **Calls:** `/call/<s01>` needs WP9's manifest (`src/generated/calls.json`, cached turns, peaks) and the server call
   lookup (`[WIRE-CALLS]`); without them `/api/cases` cannot find the call and the page shows the error card.
4. **Env on Zerops:** keep `PAY_TOOL_MODE=push` and `VA_KEYTERMS=1` (the client constants match those defaults).
5. The G2 browser check (Express → Pass → greeting audible → pay → close → "✓ Verified from recording") has not run:
   it needs a browser, the secrets and WP6's MockPhone.

### Where WP7·2 starts

- Mount WP6's MockPhone (`MockPhoneProps.onState` → the VA's `setPayingState`) and swap the tool ports (item 2).
- `/call/[id]?express=1`: the 3 s countdown, "Full call instead", the provenance banner, and the `AudioContext`
  created in the landing click handler (`getAudioEngine()` is a page singleton, so the orchestrator reuses it).
- Provisional QA (`computeQa` over the AI transcript/tool rail) before the verified card; WP5 `info` notices;
  AI-half evidence clips via #21 (check the 302 → signed OGG in a browser); the rep's "I'm back" line.
- A browser smoke of `/call` with `next dev --webpack -p 3108` once WP9's s01 manifest is in the tree.

## WP7·2 (D1 PM): the G2 slice UI

Resumed after a usage-limit interruption: the uncommitted provisional-QA work was sound (typecheck and tests green)
and was committed first (`459254b`), then `git merge main` (C2 contracts v2, clean). Commits: `e09690e`, `30df252`,
`933a25c` (before the interruption), `459254b`, `86af305`, `e533e66`, `a908065`.

### Done

- **MockPhone mounted** (`8dcd72f` merges `wp/wp6`; no WP6 file edited). `ConsoleEnv.renderPhone` mounts WP6's
  `MockPhone` with `store.phoneEvents()` (a never-trimmed phone-only event list), `paymentId` + takeover token from the
  session (`phoneAuth()`), `visitorToken`, and `onState` → store + the VA's `setPayingState`. It floats bottom-right
  from `phone.sms` on screens < 1600 px (zoomed to fit 768/700 px heights; "Your turn: tap the text" pill; minimise to a
  pill; steps aside 5 s after paid and at once when the QA card opens), docks in the right column at ≥ 1600 px, and is
  the "Phone" tab on mobile (opens on the SMS; back to "Call" 3 s after paid and at the end of the pass, where the QA
  card lives). Fixture logs and recorded runs use a read-only preview of the same events. `/dev/ui?phone=wp6` drives
  the real component with a fixture payments client (no network).
- **WP6 tool clients** are the default ports (`createCallTool` / `createPaymentsClient`), with a tap that captures
  route #14's `ui.paymentId` for the phone.
- **Express default; `?express=1`**: a 3 s countdown card over the blurred console ("Start now", "Full call instead",
  "Wait, let me choose"). `primeCallAudio()` / `callHref()` (`src/client/session/prime.ts`) are for WP7b's landing CTA
  (request `docs/notes/requests/wp7-to-wp7b.md`). A full page load falls back to "Tap to enable sound".
- **Provenance banner** under the narrator strip (human half / transcription / AI half / customer in the AI half, each
  with a tooltip); WP7·3's provenance strip replaces it.
- **Narrator strip** basics per phase; "Your turn" is in the AI accent (it was the error red).
- **QA card**: **provisional numbers the moment the pass ends** (`src/client/session/provisional-qa.ts`: WP1's
  `computeQa` over the agent's own captions, tool rail and the case snapshot taken at compile; disclosure windows
  anchored on each `get_disclosure` result; critical tokens read back from WP1's templates), then WP8's
  `/api/verifications` result replaces them ("Verified from recording"); 404/failed keep the provisional numbers with a
  plain reason.
- **WP5 info notices** (`view().notice` at level `info`) become the top bar's soft line (new `ui.notice` UiAction and
  `notice` in `Wp7UiState`, additive); error notices already arrive as `error` events.
- **AI-half evidence clips** (`src/client/session/ai-clip.ts`): route #21 needs the Bearer header, so the page fetches
  the recording once per VA session (the browser drops the header on the cross-origin 302), keeps a blob URL and plays
  each clip window; 404 + Retry-After is retried 4×; failures leave the chip silent with a warning.
- **Load errors**: "The call could not load" (5xx) or "This call isn't available" + an "All calls" link (unknown call,
  no context), one-line narrator, no stale "choose Express" hint.
- **AI-half customer without WP11**: the judge answers with the mic (`LIVE_INPUTS`); the phone's own autopilot still
  simulates an untouched payment.

### Browser pass (acceptance 1 and 4)

`tests/unit/ui/browser/console-shots.ts` against `next dev --webpack -p 3108` (fixture pages, $0): 7 states
(countdown, preflight, shadowing, protocol, AI speaking, paying, completed + QA) at **1440×900, 1366×768, 1024×768 and
390×844** in light, plus 1366×768 and 390 in dark: **44 states, a11y min 98** (38 at 100; the 98s are the open QA
dialog, where the inert console hides `<main>`), no horizontal scroll, the phone fully in the viewport at 1366×768 and
390, and the MockPhone flow SMS → e-sign → Sign → Simulate → **Paid** at both sizes. `a11y-audit.ts` is a
Lighthouse-weighted axe-rule proxy (the `lighthouse` package is not a dependency); confirm with the DevTools Lighthouse
panel on the deploy. PNGs + `report.json` land in `test-results/wp7-shots` (git-ignored).

### Tests

- `npm run typecheck` clean; `npm test` **88 files, 1120/1120** (worktree, local Postgres); `next build --webpack` OK.
- New: `provisional-qa.test.ts` (s01 scoring, window anchoring, hand-back, template read-back), `ai-clip.test.ts`,
  orchestrator tests for provisional QA at pass end (+ 404 keeps it) and info notices, and the real-controller
  wiring test now asserts the provisional QA computed from real WP5b captions.

### Open / for the integrator

- The live G2 browser check (Express → Pass → greeting → pay → close → verified) needs secrets, WP9's s01 take and a
  deploy: `docs/notes/requests/wp7-to-integrator.md` item 5. Nothing live ran here (**$0 spend**).
- AI-half evidence clips depend on the signed OGG being fetchable cross-origin (bucket CORS). If it is not, WP8 could
  add a JSON variant of #21 that returns the signed URL, and the page would set `<audio src>` directly.
- The rep's "I'm back" line (`playRepBack`) and the autopilot/typed customer inputs wait for WP11.
