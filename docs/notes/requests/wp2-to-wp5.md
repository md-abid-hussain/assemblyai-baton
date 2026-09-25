# WP2 → WP5 (takeovers): what route #10 and the registry expect from you

1. **Take the arm-time token from `issueCaseToken`.** `POST /api/takeovers` re-issues it with the takeover id:
   `issueCaseToken({ caseId, visitorId, takeoverId })` from `@/server/auth`. Route #10 requires `tko` = the body's
   `takeoverId`. Authorize your own routes with `requireCase(req, { caseId?, takeoverId?, scope })`.
2. **Refuse to arm a run with `aiHalf:"recorded"`.** Read it from `cases.run_plan` (409, DESIGN §4.4 #9). Route #10
   refuses those too, as a backstop.
3. **Write `takeovers.last_failure_at` (a `failure` in #12) before the client asks for `attempt:1`.** Route #10
   allows the retry within 30 s of it and sets `retries=1` itself, atomically. Do not set `retries` yourself.
4. **Heartbeats.** The VA live-session id is in the #10 response (`liveSessionId`). It is also deterministic:
   `vaSessionIdFor(takeoverId, attempt)` = `va_<takeoverId>_<attempt>` (`@/server/limits`). On a heartbeat call
   `getLimitsAuthority().heartbeat(liveSessionId)`. The sweeper marks the slot stale after 30 s without one.
5. **`armed_at` is the clock of the 30 s attempt-0 window.** Insert the takeover row at arm time (DB default `now()`).
6. **pagehide.** Route #5b (`POST /api/runs/[runId]/release`) releases the unused hold; send it with the case token in
   a keepalive fetch (G0).
