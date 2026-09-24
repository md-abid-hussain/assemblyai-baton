# WP4 notes: browser audio engine, per-channel STT replay, case sync, cached replay, lifecycle

Round 1 (gate G1), 2026-09-25, branch `wp/wp4`.

**Status.**
- `npm run typecheck` is clean and `npm test` is green: 23 files, 356 tests; WP4 added 7 files and 84 tests.
- Every module in the WP4 section of TASKS is built and tested against the frozen contracts.
- The whole STT path was verified **live**: product manager → FrameBatcher → two U3.5 Pro sessions. The runs used the TTS
  dialog fixture at 16 kHz and at 8 kHz µ-law.
- The browser pieces were verified in Chromium 153 and Firefox 155 (Playwright on Windows).
- Still pending:
  - the real-take T-D1-6 grid (takes are recorded D1 10:00–15:00);
  - iPhone and Safari (T-D1-7), which need a real device and the HTTPS deployed URL;
  - live STT *in the browser*, which needs WP2's route #5 (the browser has no way to get a token until then).
- Live spend: **$0.1086** of the $0.80 budget. That is 13 STT sessions: 6 pairs + 1 Hinglish session.

## What was built (all owned paths, TASKS §3.0)

| Path | What |
|---|---|
| `src/core/aai/stt-params.ts` | `buildSttParams` (DESIGN §5.1.5), `keytermsFromPolicy`, `STT_PROMPT`, `TUNING_8K` + `TUNING_8K_GRID`, `hinglishChannel` (s20 = both channels, other Hinglish = customer), `checkBeginConfiguration`, format helpers |
| `src/client/audio/worklets/*.ts` | Plain-JS worklet sources as strings, one Blob-URL module: CallPlayer, VA output ring buffer, clock (feeder), mic capture |
| `src/client/audio/call-clock.ts` | `CallFeedClock`: worklet frame counter → call clock + the exact source bytes per tick (§5.1.4) |
| `src/client/audio/call-player.ts` | `CallPlayback`: ticks → `CallTick`, `stop` (clock keeps ticking), `onEnded`, `duck`, `channelEnergyDb`, `playSpan`, `playHandoffClip` (rep line + 300 ms + acceptance) |
| `src/client/audio/va-output.ts` | `VaOutputPlayer` (§5.9.3): leading-silence drop, 120 ms / 200 ms start, `holdUntil`, adaptive underruns (+80 ms, max 400), `flush`, first-audible **as rendered**, `slowUplink()` badge helper |
| `src/client/audio/paced-feeder.ts` | `PacedFeeder` (§5.9.2): 24 kHz 50 ms / 2400 B frames on the worklet clock; mic > clips > silence; `enqueueClip → {endCtxMs}` |
| `src/client/audio/{mic-capture,resampler}.ts` | `MicSource`: AEC on, NS off, AGC on; device rate → 16/24 kHz (FIR decimator for integer ratios, 6th-order Butterworth + linear otherwise) |
| `src/client/audio/engine.ts` | `AudioEngine`: one context, no `sampleRate`, `unlockSync` (resume + `audioSession="playback"` + silent-loop fallback), `whenRunning(300)`, `loadCall`, factories, `openMic` (play-and-record ↔ playback), `playPcm24k` |
| `src/client/stt/channel-manager.ts` | `SttChannelManager` (§5.1.4–§5.1.9, §5.2): n=2 grant, parallel connects, Begin check, feed, turn ids, `agent_context` carry, one reconnect per channel, inactivity → paused, pause/resume (offset path), cached fallback, queue polling, `finishAfterSilence`, metrics |
| `src/client/stt/api.ts` | Routes #5/#6/#7 client (case token, keepalive reports) |
| `src/client/stt/loopback.ts` | $0 stand-in sessions for /dev/audio and browser checks (rejects bad frames like the server; replays cached turns "live") |
| `src/client/case/case-sync.ts` | `CaseSync`: in-order `/api/extract`, dedupe, retries, newest-version state, `drain` |
| `src/client/replay/cached-replay.ts` | Cached-turn replay (§5.1.10): per-channel activation, `recvMs`-timed emission, the mode label and fallback event |
| `src/client/platform/{lifecycle,audio-session,ios}.ts` | `PageLifecycle` (iOS-only background pause, audio interruption anywhere), audio-session helpers, iOS/iPadOS detection |
| `src/app/dev/audio/{page,audio-lab}.tsx` | `/dev/audio`: loopback / cached / live modes, handoff clip, VA tone, feeder clip, mic; `window.__wp4` diagnostics, `window.__wp4ctl` controls |
| `scripts/day1/stt-*.ts` | `stt-fixtures` (public fixtures), `stt-live` + `stt-replay` (live replay through the product manager), `stt-grid` (T-D1-6), `stt-browser` (Playwright), `stt-score`, `stt-hooks` |
| `public/fixtures/**` | Dialog fixture per channel (16 kHz PCM16, 8 kHz µ-law), peaks, `calls.json` (2 manifest entries + a matching fictional policy), `cached-turns.{16k,8k}.json` (recorded live), `health_16k.pcm` (the F7 full-check fixture of DESIGN §4.5) |
| `tests/unit/client/{audio,stt,case,platform}/**` | 84 tests. The **real worklet sources** run in vitest through a `with`-scope harness (`worklet-harness.ts`) |

## Decisions

1. **The CallPlayer worklet resamples on the fly** and holds source-rate Float32 samples. DESIGN §5.1.2 transfers
   pre-resampled Float32 instead. The result is the same linear interpolation, but a 2-minute call takes 2 × 4 MB,
   not 2 × 23 MB, and loading is instant. The main thread keeps its own decoded copy for spans and energy.
2. **The STT byte clock is sample-exact.** `start(fromMs)` snaps to a whole source sample and sends the *snapped*
   offset to the worklet, so the worklet and `CallFeedClock` agree. The feed offset is
   (call ms elapsed) − (audio sent + batcher pending). It measured **7e-12 ms** live and 9e-13 ms in Chromium and
   Firefox: exactly 0, as designed.
3. **Word times:** `callMs = word.start + base[ch]`, where `base` = the call ms of the session's first byte. This
   equals DESIGN's `startOffsetMs + reconnectOffsetMs`, with no double counting after a reconnect.
4. **Nothing is fed after Terminate is sent.** Found live: before this fix, the offset metric grew by the ~1.5 s it
   takes the Termination to arrive.
5. **`playHandoffClip` resolves when the clip is scheduled**, with the planned `endCtxMs`, so WP5 can call
   `vaOutput.holdUntil(endCtxMs)` before the clip ends. `playSpan` resolves when its span ends.
6. **`VaOutputPlayer.push(b64, replyId, audible)`:** `audible` is the caller's `ReplyTracker` verdict for that reply
   (`firstAudibleAtMs !== undefined` after observing the chunk). Chunks with `audible=false` are leading silence and
   are dropped. The first audible chunk of a reply carries the first-audible marker. An **underrun** counts only when
   the buffer ran dry and more audio of the *same* reply arrived later; a normal end of reply is not an underrun.
7. **Begin check.** The echo is `{model, mode, …}` (10b). `speech_model` is accepted too. With
   `strictBegin: true` (dev/CI), a mismatch terminates the session and the channel goes cached with `E_STT_INPUT`.
   In production it logs a warning and continues. Both runs passed live, 12/12 sessions.
8. **Reconnect seeding:** the customer channel gets `agent_context` = the last rep final (when `ctxCarry` is
   `last_rep_turn`). The rep channel gets nothing (nothing flows customer → rep, §5.2).
9. **Mic resampling on the main thread** with a stateful resampler. The capture worklet stays trivial (it posts
   ~20 ms batches).
10. **Live Node runs use the product code.** `scripts/day1/stt-live.ts` drives `LiveSttChannelManager` with
    `CallFeedClock` from wall time. The sessions are opened by `scripts/lib/aai-open.ts` (the limits guard, ledger
    and reports) and handed to the manager's `connect` seam. Importing both the client code and the server-only `ws`
    factory in one Node process needs `stt-hooks.ts`, a resolve hook that maps `client-only`/`server-only` to an
    empty module (what vitest's alias already does).
11. **`/dev/audio` "loopback" mode** runs the whole manager → CaseSync path in the browser at $0: fake sessions accept
    what the server accepts and replay the fixture's recorded turns.

## Day-1 test results

### T-D1-6: reduced PROXY grid (real-take grid PENDING)

**Input.** The TTS claim dialog (69 s, spikes `dialog_stereo_16k.wav`), anti-aliased to 8 kHz and then µ-law
encoded (`public/fixtures/dialog/*.ulaw`). One "take" × 4 grid points + a server-default baseline gives 10 sessions,
live on 2026-09-25 around 00:00 IST.

**Parameters.** Everything else is the product params: `buildSttParams`, `min_latency`, prompt + policy keyterms.

**How it was measured.**
- Latency is **recvMs − the script's end of speech** for the turn (true end of speech). The latency after the STT's
  own last-word end is ≈0.40–0.49 s p50 for every point.
- Entity recall is over 19 entities.
- The script has 8 turns per channel.

| 8 kHz point (min/max turn silence) | Entity recall | Word recall rep / cust | WER rep / cust | Finals rep / cust | Splits / merges | p50 final rep / cust | p90 rep / cust | Pass (recall ≥ 90%, p50 ≤ 1 s) |
|---|---|---|---|---|---|---|---|---|
| server default (no tuning params) | 19/19 | 1.00 / 0.97 | 0% / 4.5% | 14 / 14 | 8 / 0 | 661 / 648 ms | 1093 / 1158 ms | pass |
| **160 / 1000 (chosen, provisional)** | **19/19** | 1.00 / 0.985 | 0% / 3.0% | 12 / 11 | 7 / 0 | **721 / 746 ms** | 1479 / 1519 ms | **pass** |
| 160 / 2400 | 18/19 (missed "5 pm") | 1.00 / 0.985 | 0% / 4.5% | 11 / 10 | 7 / 2 | 706 / 704 ms | 934 / 2851 ms | pass (merges) |
| 400 / 1000 | 19/19 | 1.00 / 0.985 | 0% / 3.0% | 9 / 8 | 1 / 0 | 1020 / 1491 ms | 1427 / 1587 ms | **fail** (p50) |
| 400 / 2400 | 19/19 | 1.00 / 0.985 | 0% / 3.0% | 8 / 6 | 1 / 2 | 1015 / 1945 ms | 1099 / 2942 ms | **fail** (p50) |
| (reference: 16 kHz PCM16, no tuning) | 19/19 | 1.00 / 0.985 | 0% / 3.0% | 15 / 12 | 8 / 0 | 578 / 632 ms | 994 / 1027 ms | pass |

**Every run:** no 3007, 0 non-1000 closes, Begin 2/2 ok, feed offset ≤ 7e-12 ms, finals on the right channel
(0 unmatched), 71 billed s per session, `agent_context` updates = the number of rep finals.

**Decision.** `TUNING_8K = {min_turn_silence: 160, max_turn_silence: 1000}` (PROVISIONAL).
- Why this point: it is in the grid, keeps every entity, merges no turns, and has p50 ≈ 0.73 s.
- The 400 ms points segment the turns beautifully (1 split), but they miss p50 ≤ 1 s.
- 2400 ms merges turns and pushes p90 to about 2.9 s.
- On TTS audio the server default is a touch faster at p90, but it splits more.

**Re-run on the real takes** (D1 afternoon, after `kit report`):
```
RUN_LIVE=1 npx tsx scripts/day1/stt-grid.ts --out <dir>
```
First swap `loadDialogFixture` for the take's split channels, from WP9's `public/calls/<id>/…ulaw` or
`data/calls/split`. The **real-take grid (2 takes × 4 points = 16 sessions) is pending**: it needs the recordings.

**Hinglish × 8 kHz µ-law × prompt + keyterms** (codeswitch fixture, `language_codes:["en","hi"]` + detection +
`TUNING_8K`):
- Result: "मेरा ओर्डर अभी तक नहीं आया. Can you please check the status? ओर्डर नंबर है **481529**. और हाँ, डिलिवरी कल तक हो जाएगी क्या?"
- The digits stay digits and the English stays in Latin script. That is the same behaviour ST-12 showed at 16 kHz
  with no prompt, so 8 kHz, the prompt and the keyterms do not break it.
- Hindi words come out in Devanagari. luna reads them, and the facts are in English.
- **PASS** ($0.0019).

### T-D1-7: browser worklets (desktop PASS; iPhone and Safari PENDING)

**Method.** Playwright on Windows 11, `/dev/audio` on `next dev --webpack` port 3104, loopback STT, 16 kHz fixture,
12 s runs.

| Browser | Context | Worklet load (Blob URL, app CSP) | Ticks / pace | STT frames / 3007 / offset | Finals by channel | VA output first audible | Feeder | Mic (fake device) |
|---|---|---|---|---|---|---|---|---|
| Chromium 153 | running @ 48 kHz | ok, 0 console errors | 272 ticks in 13.6 s, pace 0.9993, max tick gap 61 ms | 272 × 1600 B per channel, 0 rejected, 9e-13 ms | rep 4 / customer 2 (correct) | played, lag 0 ms, 0 underruns | 241 × 2400 B, clip end reported | 16 kHz frames (191 990 samples ≈ 12 s) |
| Firefox 155 | running @ 48 kHz | ok, 0 console errors | 271 ticks, pace 0.9994 | 271 per channel, 0 rejected, 9e-13 ms | rep 4 / customer 2 | played, lag 21 ms, 0 underruns | 241 frames | 16 kHz frames |
| WebKit (Playwright, Windows) | **no Web Audio at all** (`AudioContext` undefined) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

**Missing: Safari and iPhone.** Playwright's Windows WebKit build has no Web Audio at all, so it is **not** a
Safari proxy. Safari (macOS) and the **iPhone with the silent switch on** need real devices and the **HTTPS**
deployed URL, because AudioWorklet and getUserMedia need a secure context and a LAN `http://` URL has neither
(`/dev/audio` now says so). Manual steps for the user (≈5 min):
1. Once WP12 deploys, open `https://<app>.zerops.app/dev/audio` in Safari on the iPhone. Flip the **silent switch
   ON** and turn the volume up.
2. Tap **Unlock audio**. Choose **cached replay** and **fixture 8 kHz**, then tap **Load** and **Start**.
   - Expected: the call is **audible despite the silent switch**, and finals appear at their times.
   - The badges show `ctx running @ 48000`, plus `audioSession true` (iOS 17+) or `silent loop true` (older).
3. Tap **VA tone**: you should hear a 1.2 s tone.
4. Press Home for about 10 s, then return. `lifecycle` in Diagnostics shows `ios_background` then `resume`. In live
   mode, STT reconnects and the new turn ids end in `-r1`.
5. Send a screenshot of the Diagnostics panel. Note the iOS version and whether the call was audible with the switch
   on. Repeat steps 1–3 in Safari on a Mac if one is available.

### Long run and background tab (acceptance 2, desktop Chromium)

See "Measured: 3-minute drift and 60 s background" below.

## Acceptance (TASKS WP4)

| # | Item | Status |
|---|---|---|
| 1 | `/dev/audio` replays through 2 live sessions: finals on the correct channel; no 3007; feed offset < 50 ms over 3 min; Begin checks pass | **PASS via the Node path; the browser live leg PENDING (needs WP2 route #5).**<br>• Live: the same `LiveSttChannelManager` + `CallFeedClock` fed 2 real U3.5 Pro sessions (16 kHz and 8 kHz fixture). Finals were on the correct channel (0 unmatched), no 3007, feed offset 7e-12 ms, Begin 12/12 ok.<br>• In the browser (loopback sessions), offset 9e-13 ms, 0 rejected frames and finals by channel, in Chromium and Firefox. The 3-minute run is below.<br>• The real s01 take is also pending (recorded D1). |
| 2 | Background tab 60 s: frames keep pace (±2%), finals keep arriving (desktop) | See the measured section below |
| 3 | T-D1-7 incl. iPhone silent switch | **Desktop PASS (Chromium, Firefox). iPhone and Safari PENDING**: needs the user's device and the deployed HTTPS URL (steps above) |
| 4 | T-D1-6 grid with `TUNING_8K` chosen | **Proxy grid done, `TUNING_8K` = 160/1000 (provisional); the real-take grid PENDING** (needs the recordings, D1 10:00–15:00). Hinglish run PASS |
| 5 | `CaseSync.drain(2000)` correct under a slow extract stub; cached replay emits finals at recvMs ±50 ms with the mode label | **PASS**.<br>• `case-sync.test.ts`: `drain(2000)` returns at 2.0 s with the in-flight and queued turns pending, in order, one request in flight.<br>• `cached-replay.test.ts`: every lag is 0..50 ms on the real worklet clock; label emitted once; `stt_cache` ids. |
| 6 | iOS: hiding the tab pauses STT cleanly; resume reconnects via the offset path | **Logic PASS in unit tests; device PENDING (needs an iPhone).**<br>• `lifecycle.test.ts`: iOS-only pause, one pause per resume.<br>• `channel-manager.test.ts`: pause → both sessions get Terminate, nothing fed while paused; resume → n=2 `reconnect:true`, `-r1` ids, base = the resume call ms; 3006 inactivity → paused → resume. |

## Measured: 3-minute drift and 60 s background

(Filled in from `scripts/day1/stt-browser.ts --long 180 --background 60`; see below.)

## Known gaps

- **No live STT in the browser yet.** The browser path (`browserConnect`: temporary token + global WebSocket) is
  the promoted client that 10b ST-16 verified. It needs route #5 (WP2) and a case/run (#3 WP3, #5a WP2).
  `/dev/audio?callId=<id>` in **live** mode is wired for G1.
- **Hot upgrade** (cached → live, §5.1.10, D4 polish, "cut first") is not built. The queue → granted path exists, so it
  is a small addition later.
- **The handoff clip without an acceptance span** plays the rep line only. The labelled synthetic "Sure." is the
  caller's (WP11 TTS, via `engine.playPcm24k`).
- **Turbopack dev fails in worktrees** ("Symlink [project]/node_modules is invalid", the junction points outside the
  root). Use `next dev --webpack`. `npm run build` was **not** run in this worktree for the same reason. The
  integrator should run it at G1, since `/dev/audio` puts the promoted streaming client (with its lazy `import("ws")`)
  into a client bundle. It worked under webpack dev in Chromium and Firefox.
- **Mic capture** was tested only with the browsers' fake devices, not a real microphone. P2 mic mode is cut; WP11
  uses `openMic(24000)`.
- **Safari/iOS specifics are untested:** the `interrupted` state, the silent loop, and `navigator.audioSession`.

## What the integrator must wire

**At G1 (D1 20:00):**
1. WP2 route #5 builds params with `buildSttParams` (`docs/notes/requests/wp4-to-wp2.md`), plus #6 and #7.
2. WP3 #3 returns `cachedTurnsUrl`, and #8 matches CaseSync's expectations (`requests/wp4-to-wp3.md`).
3. Run `/dev/audio?callId=<the s01 take>` in **live** mode. That is acceptance 1 with a real take and the checkpoint
   "Case card JSON updates live" (TASKS §8, D1 18:00).
4. Re-run T-D1-6 on 2 real takes and update `TUNING_8K` in `src/core/aai/stt-params.ts`. WP9's `pc_ctx` STT caches
   must use the same `buildSttParams` (cached and live must agree).
5. Deploy, then do the iPhone T-D1-7 (steps above) on the HTTPS URL.

**At G2 (D2 14:00):** WP7 wires the engine, the STT manager, CaseSync, the cached replay and the lifecycle into `/call` as
in `requests/wp4-to-wp7.md`. WP5/WP5b use `hasOpenPartial`/`forceEndpoint`/`drain`, `playHandoffClip` →
`holdUntil`, `createVaOutput` (`audible` flag semantics above) and `createFeeder` (start on `session.ready`).

## How to run

```bash
npm run typecheck && npm test                                   # $0
npx tsx scripts/day1/stt-fixtures.ts                            # rebuild public/fixtures (deterministic)
npx next dev --webpack -p 3104                                  # worktrees: turbopack cannot follow the node_modules junction
npx tsx scripts/day1/stt-browser.ts --browsers chromium,firefox --seconds 12 --fixture 16k      # $0
npx tsx scripts/day1/stt-browser.ts --browsers none --long 180 --background 60 --fixture 16k    # $0
RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp4 npx tsx scripts/day1/stt-replay.ts --rate 8000               # ≈ $0.018
RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp4 npx tsx scripts/day1/stt-grid.ts --out <dir>                 # ≈ $0.09
```
