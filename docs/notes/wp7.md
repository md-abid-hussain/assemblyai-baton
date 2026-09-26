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
A second resume found a clean tree at `34ebec8` with `main` already merged; typecheck and `npm test` (88 files,
1120/1120) were re-run green and the saved browser pass (`report.json`, 44 states) was spot-checked. No code changed.

A third resume found the tree clean at `c913c63`, which **is** `main`: WP7·2 merged at `8584be5` and `wp/wp7`
fast-forwarded over the later G2 merges, so `git log main..HEAD` is empty and there was nothing to merge or commit.
`main` has since taken WP9, WP18 and WP13 (`git diff 8584be5..c913c63 -- src/` is **purely additive**: `src/content/**`,
`src/core/scenario/**`, three `contracts/ext` files, `src/generated/*.json`, `server/jobs/va-audit.ts`, `server/qa/deps.ts`)
— nothing under `src/components/call/**`, `src/app/call/**` or the global CSS, so the console surface is untouched.
Everything below was **re-verified against that tree**, not merely re-read. No code changed.

- `npm run typecheck` clean; `npm test` **102 files, 1293 passed + 1 skipped**.
- **Browser pass re-run** (not the saved report): `next dev --webpack -p 3108`, 44 states, **min a11y 98** (40 at 100),
  phone clipped in 0, horizontal scroll in 0, and the MockPhone flow SMS → e-sign → Sign → Simulate → **Paid** at both
  1366×768 and 390. The dev log had **zero** errors, warnings or hydration notices across the whole pass. The only
  remaining deduction is still `landmark-one-main` (weight 3) on `completed-qa`: Radix's modal QA dialog `aria-hidden`s
  the console, so the page has no visible `<main>` while it is open. Real Lighthouse reports the same thing, so this is
  left alone rather than nesting a `<main>` inside a `role="dialog"` to chase 100.
- **Unknown-call state checked live** at `/call/s01` (`src/generated/calls.json` is still `[]`, so this is what a judge
  hits if WP9's manifest is not deployed — integrator item 3). It is correct at 1366×768 and 390 and throws no page
  errors: title "Call unavailable", narrator and strip "This call isn't available. It may have been renamed or removed.
  Pick another call from the home page.", an **All calls** button, and "The call did not load, so there is nothing to
  start yet." in the control column — no stale "choose Express" hint.
- Deleted a stale `test-results/wp7-shots/1366x768-live-no-manifest.png` left over from an earlier session: it predated
  `e533e66` and still showed the old generic "Something went wrong · Unknown call" card with the stale start hint, which
  reads like a live regression. `test-results/` is git-ignored, so re-run the harness rather than trusting old PNGs.

**Suite flake worth knowing (not WP7, affects everyone):** the *first* `npm test` on a cold machine failed 13 tests
across 8 `tests/unit/server/**` files (`payments/routes`, `limits/stt-routes`, `jobs/runner`, `cases/routes`,
`runs/runs-va`) — all "real Postgres" files, each sitting at ~17 s against the 20 s `testTimeout`. Every one passes
alone, the immediate re-run was **102/102 files green in 9.3 s**, and `--maxWorkers=1` is green too. So it is
first-connection contention on the one shared local Postgres under `fileParallelism`, not a code regression. If CI
starts flaking here, give those files their own database or run them serially rather than raising the timeout.

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

## WP7·3 (D2 AM): `RelayConsole` from `UiSpec`, the provenance strip, production polish

Resumed after an interrupted attempt that had left three sound commits on the branch (`2d02a3b`, `d1a1cde`,
`5355441`) plus a dirty tree. The dirty change (the flagship fallback's `repOnly` set, narrowed to the four fields the
blueprint actually marks `rep_only`) and the new `ui-spec.test.ts` were correct against
`data/relays/baton-add-driver.json`, so they were committed first (`d8cece7`); then `git merge main` (`0ca99c1`,
clean: it brought only WP12's secret-scan marker and a relay-code test) and `npm run migrate` (no-op, 25 tables).
Commits: `d8cece7`, `af6546c`, `0abd3c1`, `64c2131`, `cd6ae0c`, `48bf49d`, `d6247c0`, `8a7e000`.

### Done

Carried in from the interrupted attempt and re-verified against the merged tree, not merely re-read:

- **`RelayConsole({callId, relayVersionId, mode})`** (`src/components/call/relay-console.tsx`). `live-console.tsx` is
  now its flagship wrapper. Four modes (`flagship` / `test` / `shared` / `published`); it owns its store, session and
  lifecycle, and disposes on unmount and on `pagehide`.
- **The case card, stage strip, QA card and phone render from the run's `UiSpec`** (`src/client/store/ui-spec.ts`:
  `specOf`, `labelsOf`, `requiredOf`, `groupsOf`, `caseTitleOf`, `relayChip`). No spec (a fixture log, a v1 server) →
  `BATON_UI_SPEC`, the flagship's own spec written out by hand.
- **The provenance strip** (`src/components/call/provenance-strip.tsx` + `provenance()` in `selectors.ts`): four
  segments, one strip per run, the "Relay: <title> v<n>" chip, and the sim QA wording (`qaVerifiedCopy`).
- **`api.ts`** parses `CreateCaseResponseV2` (`relay` / `provenance` / `listening` / `account`) with a v1 fallback and
  a widened case state; the orchestrator pins a relay version, dispatches `ui.relay`, and merges
  `src/generated/call-provenance.json` over the server's human half (G2b open item §6.1, client half).
- **`LiveSttChannelManager.open({listening})`**: a relay other than the flagship is transcribed with its own prompt
  and keyterms.
- **The Dental fixture** (`src/client/fixtures/dental.ts`; `dental-deposit` + `dental-shadowing`) and `s01-sim`.

New in this unit:

- **Relay-agnostic copy** (`af6546c`). Three places still spoke Baton on every relay:
  - `agentNameOf(spec)` — **"Baton" is the flagship relay, never the product** (PLATFORM §2 glossary), so only the
    flagship's console says "Baton is listening silently"; every other relay's says "The relay agent is listening
    silently". "Pass the baton" is the universal action and is unchanged everywhere.
  - `paySteps(spec)` from `UiSpec.phone` — the paying copy no longer promises an e-sign a relay does not have
    ("Pay with the Polar sandbox test card, or skip with a simulated payment." on Dental).
  - `passEstimate` counts required fields that are **not `repOnly`** instead of Baton's `SERVER_RESOLVABLE_SET`. On
    Baton that is the same single field (`premium_new_monthly_usd`), so the flagship's number does not move.
  - Deleted the now-dead `modeBadge` (the stacked RECORDED AI SESSION / CACHED REPLAY badge the strip replaced) and
    `fieldLabel`. No component had used either since `2d02a3b`.
- **One a11y regression found and fixed** (`48bf49d`, see the browser pass). Each strip segment was a `<span>` with
  `aria-label`, which ARIA prohibits on a generic element: axe/Lighthouse failed `aria-prohibited-attr` (weight 7) on
  **every** console state, taking the page from 100 to 96. The segment is now `role="group"`.
- **`docs/notes/requests/wp7-to-wp15.md`**: the Test-tab embedding contract (props, what `mode` already guarantees,
  what WP7·4 still brings, and the Dental-blueprint coupling).

### Decisions

- **"No spec" is not a different relay.** `BATON_UI_SPEC` is pinned against `compileRelay(baton-add-driver.json).ui`
  (`ui-spec.test.ts`), and the console renders **byte-identically** with it and without it in every s01 state
  (acceptance 2 below). That is the whole safety claim of making the console spec-driven, so it is tested as an
  equality over rendered markup rather than as a snapshot file nobody re-reads.
- **`repOnly` is the generic "the AI never asks for this"**, replacing Baton's `SERVER_RESOLVABLE`. It is the same
  field on Baton, and it is the only signal a `UiSpec` carries for it.
- Left alone deliberately: the **fallback banner labels** ("CACHED REPLAY: transcribed live by AssemblyAI on …") that
  WP4's `cached-replay.ts` and WP5 put in `fallback.label`. They are event data in the labelled-fallback notice, not a
  stacked badge in the chrome, and TASKS-v2 §4 gives WP7 that file "changed only for relay listening pass-through".
- The Dental `smsSender` is honoured by the phone **dock** (`UiSpec.phone.smsSender`); the "Harborview Insurance"
  string inside WP6's `MockPhone.tsx` is WP6/WP16's file and was not touched.

### [VERIFY] results

**None of SAAS §16's `[VERIFY]` items is owned by WP7** (checked in the first hour against `docs/SAAS.md` §16: every
row is WP19·2/·3, WP21·1, WP22·1, WP23·1/·2, WP15·1 or WP12). Nothing to record, and no fallback of ours is in play.
The two live-API behaviours this unit leans on are settled facts, not `[VERIFY]`s: the `keyterms_prompt` limits
(DESIGN §5.1.5, 100 × 50 chars, enforced in `withListening`) and `CreateCaseResponseV2`'s shape (frozen at C2).

### Tests

- `npm run typecheck` clean. `npm test`: **167 files, 2409 passed** (worktree, local Postgres).
- `next build --webpack` passes in the worktree (Turbopack still cannot build inside a junctioned worktree, G1 note).
- **`tests/unit/ui/relay-console.test.tsx` (new, 84 tests)** — the WP7 acceptance list:
  - **2.** For every s01 fixture × every state it reaches, the console's markup with `BATON_UI_SPEC` is
    **byte-identical** to its markup with no spec. Two guards keep that from being vacuous: a renamed, non-flagship
    spec must change the render, and each render must exceed 2 kB.
  - **3.** `dental-deposit` renders its own labels and groups and **no** Baton field; its own stage labels ("Deposit
    terms", never "Disclose"); a deposit phone with no e-sign, "Cedar Hollow Dental" and not "Harborview"; "The relay
    agent", never "Baton", while "Pass the baton" stays; and a pass estimate that ignores the rep-only deposit.
  - **4.** Every fixture, in every state it reaches, carries **exactly one** strip with exactly one of each of the
    four `data-provenance` segments; the tags are pinned for recorded, simulated (+ the detail line), text dry run,
    cached replay and a recorded AI half; each segment is a named `role="group"`; and no console source file renders
    a retired badge string any more.
  - **5.** unchanged in `boundaries-ui.test.ts` (no console file imports `src/server/**`).
  - plus the per-mode inputs: `shared` and `published` never offer the mic (PLATFORM §8.3).
- `tests/unit/client/stt/channel-manager.test.ts` (+2): the relay's listening laid over route #5's params — its
  prompt, its keyterms first, the server's after, deduped case-insensitively, capped at 100 × 50 chars, with the
  audio contract (encoding, sample rate) still the server's; and **no** listening leaves the params byte-equal.
- `tests/unit/ui/orchestrator.test.ts` (+3): `listening` is forwarded **only** for a non-flagship relay (not for the
  flagship, not for a v1 server that sends no v2 fields); and `call-provenance.json` overriding the server's human
  half flips the strip to SIMULATED, the customer to synthetic and the QA badge to "customer audio simulated", while
  a recorded take keeps "Verified from recording".
- `ui-spec.test.ts` pins both `BATON_UI_SPEC` and `DENTAL_UI_SPEC` against the compiled blueprints on disk.

### Browser pass (acceptance 1 and 4, $0)

`tests/unit/ui/browser/console-shots.ts` against `next dev --webpack -p 3108`, extended in this unit with a `FIXTURE`
switch, a **second relay pass** (Dental at 1366×768 and 390: shadowing, paying, completed) and a per-shot read of the
strip's four rendered tags (a missing or wrong strip now fails the run).

**50 states, minimum a11y 98**, phone clipped in 0, horizontal scroll in 0, provenance strip wrong in 0, and the
MockPhone flow SMS → e-sign → Sign → Simulate → **Paid** at both sizes. The dev log had **zero** errors, warnings or
hydration notices across the whole pass. Every state is 100 except the six with the QA dialog open, which stay at 98
for `landmark-one-main` — Radix `aria-hidden`s the console, so there is no visible `<main>` while the modal is up;
real Lighthouse says the same and WP7·2 already decided not to chase it.

The first run of this pass is what caught the `aria-prohibited-attr` regression (96 everywhere). After the fix the
Baton states match WP7·2's numbers exactly, and the Dental states match them too — the same components, a different
relay. PNGs + `report.json` land in `test-results/wp7-shots` (git-ignored); re-run the harness rather than trusting
old PNGs.

**Suite note:** the first `npm test` of this session reproduced the WP7·2 cold-machine flake exactly — 3 files timing
out at 20 s (`core/relay-code/roundtrip`, `server/relays/registry`) under `fileParallelism`. Each passed alone in
3–19 s and the warm full run was 167/167 green in 23 s. Still contention, still not a code regression.

### Live spend

**$0.** Nothing live ran: fixture logs and fake transports only. No AssemblyAI, OpenAI or Polar call was made.

### What the integrator must do

1. Nothing new for the merge itself: `wp/wp7` still carries `wp/wp5` and `wp/wp6` (see
   `docs/notes/requests/wp7-to-integrator.md` items 1–2), and this unit added no dependency and no migration.
2. **G2b open item §6.1 is closed on the client** (`src/generated/call-provenance.json` → the strip's human half, with
   a test). The **server half** — `/api/cases` stating the same thing in `CreateCaseResponseV2.provenance` — is
   WP14b's and is not in this branch. Until it lands, a call whose provenance file says `simulated` is still labelled
   correctly, because the page's merge wins; a call missing from that file is labelled `recorded`.
3. `src/generated/calls.json` is still `[]` in this worktree, so `/call/s01` shows "Call unavailable" here. Unchanged
   from WP7·2 item 3: it needs WP9's manifest deployed.
4. The Dental console fixture is pinned against `data/relays/dental-deposit.json`. If WP17 changes that blueprint's
   fields, groups, stage labels or phone, `tests/unit/ui/ui-spec.test.ts` fails **by design**; update
   `DENTAL_UI_SPEC` in `src/client/fixtures/dental.ts` to match rather than loosening the test.
5. `docs/notes/requests/wp7-to-wp15.md` is the Test-tab embedding contract for WP15·3.

### Where WP7·4 starts

- `mode="test"`: "Back to editor" inside the console and the post-run **"What the AI inherited"** panel (the case
  snapshot taken at compile, with evidence chips) — the orchestrator already keeps that snapshot for the provisional
  QA, so the panel is a reader, not new plumbing.
- The gallery **Run** entry (`mode="test"` on the pre-generated sim, Express) and `mode="published"` wired to WP18's
  injected controller factory (`RelayConsoleProps.wiring`).
- The end card's **"Open your workspace →"** (`/app` through `/start`, TASKS-v3 §7); the `/call` path still needs no
  session.
- The "Answer the AI yourself (mic)" toggle on a sim in `mode="test"` (WP11's autopilot is the other half).
