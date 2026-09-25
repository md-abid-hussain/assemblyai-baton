# WP5 → WP7 (call console, orchestrator)

Mounting the takeover controller on `/call` (G2, D2 14:00). The full wiring sketch is in `docs/notes/wp5.md` §6.2.

- **Pass button.** Call `engine.unlockSync()` synchronously in the click handler, then `void ctl.arm("manual")`.
  Disable the button unless `ctl.manualPassAllowed`, which is false for `aiHalf:"recorded"` runs, after 3 passes, and
  while a pass is running.
- **State.** Subscribe with `ctl.subscribe(() => …)` and read `ctl.view()`: `phase`, `pass.{source, tArmMs, tCutMs,
  midUtterance, capHit, attempt, compiledBy, timings}`, `notice`, `verificationJobId`, `lastOutcome`. The phase stepper
  can also use the `takeover.phase` BatonEvents the controller emits through your sink.
- **STT finals.** Forward every `stt.final` turn to `ctl.noteFinal(turn)`, which marks the cut turn. Give WP4's STT
  manager `takeover: () => ctl.armInfo()`, which sets the late flag.
- **End call.** Call `ctl.endCall("user_end")`. On unmount, call `ctl.dispose()`. The controller handles pagehide
  itself: `session.end`, keepalive `/end`, run release.
- **Notices.** Show `view().notice`:
  - `level:"error"` notices are also emitted as `error` BatonEvents, e.g. "The AI half could not start: …" when an arm
    is refused and the recording keeps playing;
  - `level:"info"` notices are the recorded-run tooltip case and "Call ended: live AI unavailable; see the Explorer."
- **The recorded AI half** (phase `fallback`): the controller emits `mode:recorded_ai` and a labelled `fallback` event,
  then calls `recorded.play()`. Pass a `RecordedAiPlayer` that binds WP11's `ReplayPlayer` to your sink.
