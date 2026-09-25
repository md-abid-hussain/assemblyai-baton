# WP4 → WP7 (orchestrator / call console): how to drive the audio + STT pieces

All modules are under `src/client/{audio,stt,case,platform,replay}`. The dev page `src/app/dev/audio/audio-lab.tsx`
is a working reference wiring (loopback, cached and live modes).

1. **Inside the first click handler, synchronously** (Watch on `/`, pre-flight Start/Express on `/call`):
   ```ts
   const engine = getAudioEngine();   // creates THE AudioContext (no sampleRate option)
   engine.unlockSync();               // resume + iOS audioSession "playback" (+ silent <audio> loop on old iOS)
   lifecycle.attachContext(engine.ctx);
   ```
   After that, `await engine.whenRunning(300)`. If it returns false, show "Tap to enable sound". On iOS, the
   pre-flight card must say "No sound? Turn off silent mode." A context muted by the switch still reports `running`.
2. **Run start** (after #3 `/api/cases` and #5a `/api/runs`):
   ```ts
   const player = await engine.loadCall(create.call, create.assets, onProgress);
   const caseSync = new HttpCaseSync({ caseToken, visitorToken, sink, now, initialState: create.state });
   const cached = new CachedReplay({ caseId, sink, caseSync, now, url: create.cachedTurnsUrl, takeover });
   void cached.ensureLoaded().catch(() => {});                       // prefetch; needed for any fallback
   const stt = new LiveSttChannelManager({ api: new HttpSttApi({ caseToken, visitorToken }), sink, caseSync, cached,
     now, takeover, strictBegin: process.env.NODE_ENV !== "production" });
   player.onTick((t) => stt.feed(t));                                // the ONLY feed path (worklet clock)
   player.onEnded(() => void stt.finishAfterSilence(1500));          // then show "Call ended without a baton pass"
   if (plan.sttHalf === "cached") cached.activate("both", startOffsetMs, plan.reason ?? "cached");
   else await stt.open({ caseId, caseToken, runId, call, policy, startOffsetMs, ctxCarry: "last_rep_turn", seedAgentContext });
   player.start(startOffsetMs);
   ```
   `open()` returns `"queued"` while the run waits in the STT queue. The manager keeps polling, and
   `stt.status`/`stt.status` events tell you when both channels are `open`. Start playback when you want (DESIGN:
   immediately when cached).
3. **`takeover` callback** = `() => ({ armed, tArmMs })`, so finals after the arm carry `late:true`. For the
   takeover: `stt.hasOpenPartial(ch)`, `stt.forceEndpoint(ch)` (only while that channel is fed silence, never
   mid-speech), `caseSync.drain(2000)`, `player.stop(30)`, then `player.playHandoffClip(call.handoff)`. That call resolves
   when the clip is **scheduled** and returns `endCtxMs`, which goes to `vaOutput.holdUntil(endCtxMs)`. Keep
   feeding ticks after `stop()`: the clock keeps running and STT gets silence.
4. **Lifecycle** (`createPageLifecycle()`): `onPause` → `stt.pause()` (iOS only: terminates both sessions cleanly).
   `onResume` → show "Paused: tap to resume". In the tap, call `engine.unlockSync()`, then `stt.resume()` (the
   reconnect-offset path; turn ids become `-r1`). Emit the `paused` BatonEvent yourself.
5. **pagehide:** call `stt.dispose()` (sends Terminate). The `closed` reports and the #5b run release are keepalive
   fetches with the Authorization header (G0 decision 10).
6. **Events the manager emits:** `stt.status`, `stt.partial`, `stt.final`, `error`, `paused` (inactivity), `mode` +
   `fallback` (the cached replay label, once). CaseSync emits `case.state` and `case.facts`. The HUD's session ids
   are in `stt.providerSessionIds`.
