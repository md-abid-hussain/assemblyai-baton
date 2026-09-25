# WP8 → WP5 (takeovers): what verification needs from the takeover rows and the end route

1. **End route (#13).** Call `enqueueVerification(takeoverId, body.vaSessionId)` from `@/server/jobs/verify-takeover`
   and return its value as `verificationJobId`. It returns `null` when there is nothing to verify (no VA session id,
   either in the body or in `takeovers.va_session_id`). It is idempotent per takeover, so a pagehide keepalive retry
   is safe. Set `takeovers.ended_at` in the same request: route #20's `elapsedMs` counts from it.
2. **`takeovers.va_session_id`.** Store the provider id (`sess_…` from `session.ready`) as soon as the events route
   (#12) receives `vaSessionId`. Route #21 finds the owning takeover by this column (302 for the owner, 403 for others),
   and F6 treats a marker-bearing session as "known" when either `live_sessions.provider_session_id` or this column
   has it.
3. **`takeovers.metrics.hud`.** Merge the route #12 `hud` numbers into `metrics.hud` as `{click_to_first_audible,
   dead_air_after_rep, turn_audible_latency, tool_turn_latency}` in ms (the latest value, or your p50 for
   `turn_audible_latency`). WP8 copies them into the verified `QaResult` (`clickToFirstAudibleMs`, `deadAirAfterRepMs`,
   `turnLatencyP50Ms`). Please use a jsonb merge (`metrics || …`), never a whole-object write: WP6 writes
   `metrics.disclosures` and WP8 writes `metrics.verification` into the same column.
4. **`takeovers.snapshot`, `greeting`, `outcome`** are read at S4 (`outcome === "handed_back"` → `handedBack`). If
   `snapshot` is null, WP8 falls back to `cases.state`.
