# WP5 notes: takeover protocol (machine, server routes, controller)

Owner: WP5. Branch `wp/wp5`. Round 1 (gate G1), 2026-09-25.

**Status: round 1 done, G1 merged in, routes wired.** `main` (with the G1 merge of WP1, WP2, WP3, WP4, WP5b and WP8)
is merged into `wp/wp5`.

- `npm run typecheck` is clean. That includes Next's generated route checks in `.next/types` after a build.
- WP5's 9 test files pass: **153 tests, none skipped** (`tests/unit/core/protocol/**`, `tests/unit/server/takeovers/**`).
  - Acceptance 2 now runs in-tree on WP1's merged compiler (22 tests). `BATON_WP1_ROOT` is gone.
  - A G1 integration test runs the four routes over Postgres with WP1, WP2 and WP3 real (§3).
- The full suite: 75 files, 906 tests (9 skipped: `RUN_LIVE` integration tests). Two tests from other WPs are flaky
  under load and fail in about half of the full runs, with or without WP5's files (§7). Everything else passes.
- `next build --webpack` builds every route, including the four takeover routes over the real graph.
- Everything is committed on `wp/wp5`.
- Live spend: **$0**. WP5 made no AssemblyAI, OpenAI or Twilio calls and did no deploys.

## 1. What ships

| File | What |
|---|---|
| `src/core/protocol/takeover-machine.ts` | **The pure reducer** of DESIGN §5.5: `reduce(state, input) → {state, effects}`, plus `nextDeadline`, `manualPassAllowed`, `armView`, `clampLead` and `isRetryableVaCode`. It includes rules 6–8. It has no clock: every input carries `now` (AudioContext ms) and every timeout is an absolute deadline. The constants come from `TAKEOVER_TIMING` |
| `src/client/takeover/controller.ts` | **`TakeoverControllerImpl`** (`TakeoverController` + `TakeoverControllerExt`). It executes the effects against injected ports and feeds the results back as inputs. It uses one timer, set at `nextDeadline`. It samples audio on CallPlayback ticks |
| `src/client/takeover/ports.ts` | `TakeoverControllerDeps`, `VaSession`/`VaSessionEvent` (a mirror of WP5b's `VaControllerEvent`), `TakeoverApi`, `TakeoverApiError`, `RecordedAiPlayer` |
| `src/client/takeover/api.ts` | `HttpTakeoverApi`: routes #9–#13, #10, #5b and #7 over fetch. It sends Bearer tokens and `x-baton-visitor`. pagehide requests use `keepalive` (G0: never sendBeacon). ApiError bodies become `TakeoverApiError` |
| `src/server/takeovers/service.ts` | `TakeoverServiceImpl` (TASKS §2 `TakeoverService`): arm, compile (freeze → WP1 compile → `validateFirstUpdate`), recordEvents (heartbeat, failure), end (idempotent, safety-net release, WP8 enqueue), `computeLeadMs` |
| `src/server/takeovers/store.ts` | `TakeoverStore` + `DrizzleTakeoverStore`. The arm transaction locks the case row. Every jsonb write merges. `end` is idempotent and sets the case status. There is also the lead-history query |
| `src/server/takeovers/routes.ts` | Handler factories for #9, #11, #12 and #13 over `TakeoverRouteDeps`. They validate with zod, authorize through the injected `requireCase`, rate-limit (failing open) and map `ApiError` |
| `src/server/takeovers/wiring.ts` | `buildTakeoverRouteDeps(parts)`, `setTakeoverRouteDeps` (tests, overrides), `setDefaultTakeoverRouteDeps` (a lazy factory), `takeoverRouteDeps()` and `takeoverConfigFromEnv()`. With neither set, the routes answer `500 E_INTERNAL "not wired"` |
| `src/server/takeovers/default-deps.ts` | **The G1 wiring (composition root).** On import it installs a factory over WP1's compiler, WP2's auth and limits, WP3's `getCaseRepository` and WP8's `enqueueVerification`. It runs on the first request, so env and DB are read at request time. It is the only WP5 module that names another WP's implementation |
| `src/app/api/takeovers/{route, [id]/compile, [id]/events, [id]/end}/route.ts` | One line each, over `default-deps`; `runtime="nodejs"`, `dynamic="force-dynamic"` |
| `src/core/contracts/ext/wp5-takeover.ts` | Additive types: `TakeoverControllerExt` (`view`, `subscribe`, `endCall`, `noteFinal`, `armInfo`, `dispose`) and `TakeoverClientView` |

Tests (all $0):

- `tests/unit/core/protocol/takeover-machine.test.ts` (75) and `_harness.ts`;
- `tests/unit/core/protocol/controller.test.ts` (13). This is the controller and HTTP API with fakes. It sits in the protocol folder because `tests/unit/client/takeover/**` is not in the ownership map;
- `tests/unit/core/protocol/va-session-compat.test.ts` (2): a type-level check that WP5b's merged `VoiceAgentControllerImpl` is a `VaSession` and every `VaControllerEvent` is a `VaSessionEvent`, so the page passes it to `createVa` with no adapter;
- `tests/unit/server/takeovers/{service (17), routes (14), store.pg (6, real Postgres), compile-scenarios (22), default-deps (3), g1-integration.pg (1, real Postgres)}.test.ts`;
- `_fakes.ts`, `_scenarios.ts` (the kit scenarios as synthetic calls through WP1's `applyExtraction`) and `_db.ts` (a throwaway migrated database per file; the Postgres suites skip without `DATABASE_URL`).

## 2. Decisions (where WP5 goes beyond or departs from DESIGN §5.5)

1. **One clock.** The machine runs on the AudioContext clock (`engine.nowMs()`).
   - `repLineEnd` (the handoff clip's `endCtxMs`) and `holdAudioUntilCtxMs` are on that clock, so tSend, holdUntil and
     the HUD share one timebase.
   - The call clock (`callMs`) is used only for `tArm`, `tCut` and the auto-baton seal point.
2. **The VA pre-open runs in the background.** On the arm response the controller mints the token (attempt 0) and
   opens the WebSocket at once. Sealing, draining and compiling carry on in parallel.
   - A failure of the pre-open (token error, a WS that does not open within 3 s, a close) is retried in the background
     right away: abort the socket, `POST /events {failure}`, then mint attempt 1.
   - The phase shows `retrying` only from CONNECTING on.
   - If the VA is dead with no retry left, the pass still freezes and compiles. It ends at CONNECTING (FALLBACK or
     FAILED), so the Explorer and QA still get the frozen snapshot.
3. **The order of calls on the wire is guaranteed by the controller.**
   - `POST /events {failure}` completes before `POST /api/va/token {attempt:1}`. Route #10 needs `last_failure_at`,
     per WP2's request.
   - `POST /sessions/report {closed, billedSeconds}` completes before `POST /end`.
4. **An arm refused before SEALING returns to IDLE.**
   - Examples: a 429 at the 3-pass limit, or a 409.
   - The recording keeps playing, and an error notice and an `error` BatonEvent are shown.
   - After SEALING, a failed arm ends the pass in FALLBACK or FAILED.
5. **A failure after the greeting was heard is not retried.** This covers ACTIVE and PAYING. A second greeting mid-call
   would be worse than the rep taking back. The session is ended and the outcome is `failed`. DESIGN §5.9.6
   ("silent twice → RETRYING") is applied only up to the first audible greeting.
6. **The session cap and the absolute ceiling** end the pass with outcome `handed_back`, reason `cap`. The VA controller
   ends the session itself, and the wrap-up line hands the rest to the rep (§5.9.5).
7. **Backstops the DESIGN timeline leaves implicit:**

   | Backstop | Value |
   |---|---|
   | Drain | `DRAIN_MAX_MS` + 500 ms (CaseSync has its own 2 s timeout) |
   | Handoff clip that never reports its schedule | seal + 3 s |
   | Close without `session.ended` | `SESSION_ENDED_WAIT_MS` + 1 s |
   | Rep "I'm back" line | 10 s |
   | Auto-baton seal if playback stalls | the planned acceptance end + 1 s |

8. **Auto-baton (rule 6).**
   - It arms on the first idle sample with `callMs ≥ lineStartMs`, with `tArm = lineStartMs` and `midUtterance =
     false`.
   - It seals when `callMs ≥ acceptEndMs ?? lineEndMs + 1500`. There is no 1.5 s cap and no clip.
   - `repLineEnd` = the ctx time of `acceptEndMs ?? lineEndMs`.
   - It fires at most once, never on declined handoffs, and never after a manual pass.
9. **Recorded AI half (rule 7).**
   - A manual Pass is refused with an info notice. The auto-baton never arms.
   - At the acceptance end: stop playback, terminate STT, then `play_recorded` (phase `fallback`). The controller emits
   `mode:recorded_ai` and the labelled `fallback` event.
   - Without a bundle the run ends with "Call ended: live AI unavailable; see the Explorer."
10. **Releasing the run (rule 8).**
    - At the end of the recording with no pass, `release_run` fires once.
    - On pagehide, from **every** state, `release_run` (keepalive) and STT terminate fire.
    - Also on pagehide: `session.end` when a socket exists, and a keepalive `/end {abandoned}` when a pass is live.
    - After pagehide the machine is inert.
11. **Cut turns.**
    - With `capHit`, a final on the speaking channel with `startMs ≤ tCut` that arrives after the seal is added to
      `DrainReport.cutTurnIds`.
    - The page must forward every `stt.final` to `controller.noteFinal()`.
12. **Server.**
    - `arm` flips the case to `armed` from `shadowing` or `handed_back` ("Pass the baton again", §1.3 P1 step 9).
    - At most 3 takeovers per case. They are counted inside the arm transaction, so refused arms do not use up the
      limit. The route limiter adds an abuse ceiling of 10 per case per hour.
    - `end` sets `cases.status = outcome` (only from `armed` or `ai_active`) and `takeovers.phase` = `done` or
      `failed`.
    - After `/end`, #12 still merges HUD, QA, timings and a missing `vaSessionId` (WP8 reads `metrics.hud`). It
      ignores phase, failure and heartbeat.
    - Rate limits: #11 3 per takeover, #12 30 per minute, #13 2 per takeover. A limiter error fails open (logged).
13. **Adaptive lead (rule 5).**
    - The median of `firstAudiblePlayed − sessionUpdateSent` over the last 20 takeovers whose `protocol.timings` have
      both keys, clamped to 500–1500, default 900.
    - The controller posts those timings (ms since the click) in one `POST /events {phase:"active", timings,
      vaSessionId}` when the greeting is first heard.
14. **jsonb ownership.**
    - `protocol` holds `source`, `runId`, `timings`, `drain`, `compile`, `failures` and `end` (WP5), plus `freeze`
      (WP3).
    - `metrics` holds `hud`, `provisionalQa` and `verificationJobId` (WP5), plus `disclosures` (WP6) and
      `verification` (WP8).
    - Every write is `coalesce(col,'{}') || patch`, or a `jsonb_set` merge for the nested `timings`, `hud` and
      `failures`. The Postgres test proves `freeze` and `disclosures` survive.

## 3. Acceptance (TASKS WP5)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Machine unit tests: every transition and timeout (fake clock); ForceEndpoint only after `SEAL_TAIL_MS`; retry at most once with `attempt:1`; `pagehide` from every state releases the run; auto-baton; recorded runs never arm manually | **PASS** | `takeover-machine.test.ts` (74) covers every phase transition and every deadline at t−1 and t. There is one pagehide case per phase (14). ForceEndpoint: none in ARMED, none before +250 ms, only channels with open partials, once. Mints are asserted to be exactly `[0, 1]`. `controller.test.ts` (13) checks the same paths end to end through the executor, including the wire order |
| 2 | `/compile` returns a config that passes `validateFirstUpdate` for s01, s02, s05 at 3 pass points each | **PASS, in-tree, on WP1's merged compiler** | `compile-scenarios.test.ts`: 3 scenarios × {early, middle, handoff} × keyterms {off, on} go through route #11. The JSON is parsed with `CompiledTakeoverSchema` and validated again from `buildFirstUpdate(parsed)`. Plus a hold-mode case, and a check that the snapshot grows along the call. Numbers in §5. **G1 over Postgres** (`g1-integration.pg.test.ts`): s01 at the middle point goes arm → compile → events → end → arm again through the four handlers with WP1 (compiler and engine), WP2 (real tokens, `requireCase`) and WP3 (`PgCaseRepository`, real `freezeSnapshot`) real. The frozen snapshot has exactly the fields VERIFIED by tArm, the first update validates, the case goes `armed` → `ai_active` → `handed_back`, `protocol` keeps WP3's `freeze` beside WP5's keys, `/end` enqueues with the stored `sess_…`, and a second pass arms |
| 3 | G2 vertical slice: `/dev/audio` or `/call/<s01>` → Pass → greeting audible, with the correct snapshot | **PENDING: needs a page and a browser (G2).** The server half is wired and tested on real Postgres (above). The page glue (§6.2) mounts the controller on `/dev/audio` at D2 10:00; it needs a desktop browser and a live VA session (about $0.05) | The controller runs end to end against fakes. `va-session-compat.test.ts` proves WP5b's merged controller plugs in as a `VaSession`. WP4's `BrowserAudioEngine`, `CallPlayer`, `LiveSttChannelManager` and `HttpCaseSync` implement the contract interfaces the controller's deps are typed with |

## 4. Day-1 tests

WP5 owns no Day-1 test (DESIGN App. B). Round 1 made no live calls. The controller's VA assumptions rest on WP5b's
results:

- T-D1-3 part A (an idle socket before the first update is fine) → the WS pre-open at ARMED is kept.
- T-D1-2 → stage changes need no wait.
- The first update → session.ready takes 611–672 ms. The first audible chunk arrives 292–341 ms after ready. That is
  about 0.9–1.0 s from update to first audible, which matches the default `leadMs` of 900.

**Open: T-D1-3 part B** (a token expiring during the idle). See §7.

## 5. Measured numbers (Windows 11, Node 22.23.2; this worktree)

`/compile` through route #11 with WP1's real compiler and a synthetic talk-track call (acceptance 2; the rows are
identical with keyterms on):

| Scenario @ point | tArm (call ms) | VERIFIED fields | Stage | Mode | Cap (s) | Greeting words | Keyterms (on) | Prompt chars |
|---|---|---|---|---|---|---|---|---|
| s01 early | 12 810 | 3 | confirm | min_latency | 255 | 49 | 10 | 3072 |
| s01 middle | 24 830 | 8 | confirm | balanced | 195 | 66 | 10 | 3206 |
| s01 handoff | 50 000 | 15 | disclose | min_latency | 150 | 69 | 10 | 3573 |
| s02 early | 12 030 | 3 | confirm | balanced | 255 | 52 | 9 | 3053 |
| s02 middle | 23 270 | 7 | confirm | balanced | 210 | 52 | 10 | 3178 |
| s02 handoff | 43 160 | 13 | confirm | min_latency | 165 | 65 | 10 | 3481 |
| s05 early | 11 530 | 3 | confirm | balanced | 255 | 52 | 9 | 3063 |
| s05 middle | 22 270 | 7 | confirm | balanced | 210 | 59 | 10 | 3185 |
| s05 handoff | 36 380 | 13 | confirm | balanced | 165 | 67 | 10 | 3460 |

- **Route #11 server time** in process (fake freeze, WP1 compile, validate, JSON): **0.7–2.6 ms** warm, 36 ms cold. The
  real cost will be WP3's freeze transaction, which is not measured here. The `COMPILE_TIMEOUT_MS` of 1500 has ample
  room for the compile itself.
- **Greetings are 49–69 words**, about 17–24 s at WP5b's measured rate. This matches WP5b's T-D1-0 finding. It is worth
  a planner look, but it is not WP5's to change.
- **Postgres 17** (docker `baton-pg`, a throwaway database per test file): the 6 store tests pass. Three concurrent
  arms of one case give exactly one `ok` and two `conflict`. A fractional `tArm` (61234.625) round-trips.
- **Built routes smoke** (round 1, before the G1 wiring; `next start -p 3105`, webpack build):
  - `POST /api/takeovers {}` → 400 `E_BAD_REQUEST`, because the body is validated before auth.
  - `POST /api/takeovers/abc/end` → 500 `E_INTERNAL` "not wired yet (G1)". Since the G1 wiring, `default-deps.test.ts`
    shows the same routes answer from WP2's real `requireCase` (401 `E_CASE_TOKEN`, 403 for another takeover's token).
  - The server was stopped afterwards.
- **G1 integration over Postgres**: the whole arm → compile → events → end → arm test takes about 1 s, most of it the
  throwaway database's migration.

## 6. What the integrator must wire

### 6.1 G1: the routes (done by WP5)

`src/server/takeovers/default-deps.ts` wires routes #9 and #11–#13 over WP1, WP2, WP3 and WP8, as `wp5-to-integrator.md`
offered. The route files import it. Nothing is needed from the integrator for the routes themselves, but two things on
`main` still affect them:

1. **WP3's `src/server/cases/defaults.ts` still binds the pre-G1 stub case engine** (the server logs `case engine is the
   pre-G1 stub`). `freezeSnapshot` re-derives the takeover snapshot with that engine. Until the file is swapped for
   the WP1 binding in `wp3-to-integrator.md` §1, the compiled snapshot comes from the stub's simplified derivation (no
   age rule, no REP_ONLY check). WP5's G1 test binds WP1's engine the same way and passes. **This is the one G1 item
   that changes what the AI half is told.**
2. **Env.** `compileTakeover` reads `BATON_DEPLOY_ID`, `VA_VOICE`, `VA_KEYTERMS`, `PAY_TOOL_MODE` and `VA_SESSION_CAP_*`
   through `takeoverConfigFromEnv()`. WP5b's Day-1 results say to use **`PAY_TOOL_MODE=push`** and **`VA_KEYTERMS=1`**.
   `env.ts` and `.env.example` still default to `hold`/`0`. Set them on Zerops, or change the defaults.

WP8's `verify-takeover` module is imported by `default-deps`, so its import-time `installVerifyTakeover()` runs when a
takeover route loads. The job runner still needs WP8's step in `installBuiltinSteps()` (`wp8-to-integrator.md` §2) for
the ticker.

**Platform note (Changeover).** WP5's service, machine and controller take the snapshot, the policy and the compiled
config only through the contracts (`CaseRepository.freezeSnapshot`, `CompileTakeoverFn`, `CompiledTakeover`). A
compiler driven by a relay blueprint replaces the three WP1 functions in `default-deps.ts` and nothing else. The VA
`stage` event is typed as a plain string id for the same reason.

### 6.2 G2 (D2 10:00, WP5 glue): the controller on `/dev/audio` and then `/call` (WP7)

```ts
const ctl = createTakeoverController({
  ids: { caseId, runId: plan.runId, caseToken },
  aiHalf: plan.aiHalf, call: { handoff: call.handoff, recordedAiBundle: call.recordedAiBundle }, autoBaton: mode === "watch",
  engine, playback, stt, caseSync,                               // WP4
  api: new HttpTakeoverApi({ visitorToken: () => visitorToken }),
  createVa: (attempt, { takeoverId, takeoverToken }) => createVoiceAgentController({ /* WP5b deps, #12/#14/#15 with takeoverToken */ }),
  localCompile: (drain) => compileTakeover(caseSync.state!, policy, { deployId, compiledBy: "client", … }),   // WP1
  recorded: call.recordedAiBundle ? { play: () => replay.play(sink), stop: () => replay.stop() } : null,     // WP11 (after load)
  playRepBack, sink: store, hud,
});
// WP4: new LiveSttChannelManager({ …, takeover: () => ctl.armInfo() }); forward every stt.final → ctl.noteFinal(turn)
// Pass button: engine.unlockSync(); void ctl.arm("manual");  disabled unless ctl.manualPassAllowed
// UI: ctl.subscribe(() => render(ctl.view())); "End call" → ctl.endCall("user_end"); unmount → ctl.dispose()
```

The phase stepper reads `takeover.phase` BatonEvents. Each carries `detail` {source, tArmMs, tCutMs, capHit, attempt,
compiledBy}.

## 7. Known gaps

- **Acceptance 3 (the G2 slice)** has not run: it needs the merged WPs and a browser.
- **T-D1-3 part B has not run** (WP5b, integrator). The controller connects right after the mint, so the socket is
  open within about a second, then idles until tSend: about 3 s on a manual pass, up to about 6–10 s on the auto-baton.
  If auth is checked only at open (10a §1 predicts this), a 10 s token is enough. Until part B passes, WP2 should keep a
  20–30 s window (WP5b's request).
- **The synthetic "Sure."** for takes without a clean acceptance, and the labelled TTS line for takes without a clean
  rep line (§1.3 P1 step 4), are not played by the controller. `playHandoffClip` plays only the rep line then. It needs
  a clip source (WP11 TTS or the tail pack); add it at G2 as an optional dep.
- **Passes 2 and 3 after a hand-back.** The server allows them. Route #10's attempt 0 uses the run's `vaHoldId`, which
  the first pass consumed. That is WP2's call; see `requests/wp5-to-wp2.md`.
- **Two flaky tests from other WPs** fail in about half of the full `npm test` runs on this machine, with or without
  WP5's files, and pass when rerun:
  - WP3 `tests/unit/server/cases/extract-service.test.ts` "batches only a backlog…" (the order of the batched turn
    ids varies);
  - WP2 `tests/unit/server/jobs/runner.test.ts` "the lease makes concurrent advances run the step once" (the step ran
    3 times).

  They look like races under parallel Postgres load. They are not WP5's to fix. The owners should look at them
  before G1 CI relies on a green run.
- **Turbopack cannot build in a worktree** whose `node_modules` is a junction ("Symlink [project]/node_modules is
  invalid"). `next build --webpack` works. `main`, with a real `node_modules`, is unaffected.
- **WP3's drain latency** (their note): luna's p50 of about 2.1 s is above `DRAIN_MAX_MS` of 2000. Most in-flight
  finals will be `pending` and stay out of the snapshot. That is safe but common.
  - The machine uses the contract constant.
  - If the planner raises it (for example to 3 s), nothing in WP5 changes.
  - The in-flight turn would still reach the snapshot only if its extraction finishes within the window.

## 8. Change requests filed

- `docs/notes/requests/wp5-to-integrator.md`: the routes are wired (no action), WP3's engine binding still open, env
  defaults, test-folder ownership, the Turbopack worktree note, and the flaky tests of other WPs.
- `docs/notes/requests/wp5-to-wp2.md`: VA slots for passes 2 and 3, route #7 with the takeover token, the /end release.
- `docs/notes/requests/wp5-to-wp5b.md`: the retry and session reports are WP5's; the events the controller relies on.
- `docs/notes/requests/wp5-to-wp7.md`: mounting the controller on `/call`.

Requests to WP5 that are already satisfied:

- `wp2-to-wp5.md`: `issueCaseToken` with `takeoverId`; the recorded 409; `last_failure_at` before attempt 1;
  `retries` is never set by WP5; heartbeats go to `vaSessionIdFor(id, retries)`; `armed_at` is set at insert;
  pagehide release uses keepalive.
- `wp3-to-wp5.md`: `freezeSnapshot` at compile, with its state used as `snapshot`; `protocol` is merged; arm sets
  `armed`.
- `wp8-to-wp5.md`: `/end` → `enqueueVerification(id, body.vaSessionId ?? column)`; `ended_at` is set in the same
  request; `va_session_id` is stored from #12; `metrics.hud` is merged; the snapshot, greeting and outcome are on the
  row.

## 9. How to run

```bash
npm run typecheck && npm test                               # $0; the Postgres suite needs DATABASE_URL (.env) or skips
npx vitest run tests/unit/core/protocol tests/unit/server/takeovers     # WP5 only: 9 files, 153 tests
WP5_REPORT=1 npx vitest run tests/unit/server/takeovers/compile-scenarios.test.ts --reporter=verbose   # the §5 table
```
