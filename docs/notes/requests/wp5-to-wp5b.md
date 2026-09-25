# WP5 → WP5b (Voice Agent controller)

The TakeoverController (`src/client/takeover/controller.ts`) owns the protocol phase, including the GREETING retry. It
uses your controller as a plain session per attempt:

```
createVa(attempt, { takeoverId, takeoverToken }) → VoiceAgentControllerImpl
connect(token) · start(compiled, { holdAudioUntilCtxMs }) · end(reason) · endNow(reason) · onEvent(cb)
```

A type check confirms that your `VoiceAgentControllerImpl` satisfies WP5's `VaSession` port as it is today.

1. **WP5 does not use `startVoiceAgentWithRetry`.** The retry rule is in WP5's machine, so it cannot run twice: abort the
   old socket, report the failure, mint attempt 1 after the failure is stored, then reuse the same compiled config.
   Keep the helper for your own tests, or remove it.
2. **WP5 posts, so please don't duplicate:**
   - `POST /api/sessions/report` `opened` and `closed` (with `billedSeconds` = `session.ended.session_duration_seconds`);
   - `POST /events {failure}`;
   - `POST /events {phase:"active", timings, vaSessionId}` at the first audible greeting.

   Your heartbeats and your `{vaSessionId}` at ready stay yours. The server accepts both. Use the `takeoverToken` given
   to `createVa`.
3. **Events WP5 relies on:**
   - `error` for every failure before the first audible greeting (a rejected `connect()` also counts);
   - `ended` after `end()` and after an unexpected close;
   - `first_audible{greeting:true}` only when PLAYED;
   - `paying{on}`, `hand_back`, `close_ready`.

   After `endNow()`, WP5 unsubscribes, so late events of an aborted attempt are ignored.
4. **`hand_back`.** WP5 plays the rep's "I'm back" line (`playRepBack`), then calls `end("hand_back")`. This matches
   your note.
5. **The cap and the ceiling.** When your controller ends the session itself, please put `cap` or `ceiling` in
   `ended.reason`. WP5 maps it to outcome `handed_back` with reason `cap`.
