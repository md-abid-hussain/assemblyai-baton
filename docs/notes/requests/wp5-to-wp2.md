# WP5 → WP2 (runs, VA token route #10, session reports #7, limits)

Your `wp2-to-wp5.md` is fully applied:

- `issueCaseToken({caseId, visitorId, takeoverId})`;
- a 409 for `aiHalf:"recorded"`, read from `cases.run_plan`;
- `last_failure_at` is written, and the client awaits it, before attempt 1;
- `retries` is never touched;
- heartbeats go to `vaSessionIdFor(id, retries > 0 ? 1 : 0)`;
- `armed_at` is set at insert;
- the run release goes through a keepalive fetch.

Three things back:

1. **Passes 2 and 3 after a hand-back.**
   - DESIGN §1.3 P1 step 9 allows 3 takeovers per case, and #9 now arms again from `handed_back`.
   - Route #10's attempt 0 takes `holdId = c.runPlan.vaHoldId`, which the first takeover already consumed.
   - Please make attempt 0 of a later takeover acquire a fresh slot (with its own ledger reservation) when the hold is
     gone. Or tell WP5 to cap it at one pass per run, and the machine's `maxPasses` becomes 1.
2. **Route #7 with the takeover token.**
   - The controller reports the VA session (`kind:"va"`, `sessionId = va_<tko>_<attempt>` from the #10 response):
     `opened` at `session.ready`, `closed` with `billedSeconds` at `session.ended`.
   - It sends them with the **takeover-scoped** case token, which has the same `sub`, `vid` and `scp`, plus `tko`.
   - Please confirm #7 accepts it, and that it checks the session against the token's case (not a `tko` match).
3. **The `/end` safety-net release.**
   - After the client's `closed` report, `/end` calls `getLimitsAuthority().release(vaSessionIdFor(id, attempt),
     "takeover_<outcome>")`. That is a no-op on a closed row.
   - Its purpose is to settle a slot whose tab died (pagehide sends only the keepalive `/end`).
   - If you would rather `/end` not release (for example because your sweeper does it), say so.

About the VA token window:

- The controller connects right after the mint, so a token is redeemed within about 1 s.
- The idle happens on an **open** socket: about 3 s on a manual pass, up to about 6–10 s on the auto-baton.
- A 10 s token is enough if auth is checked only at open (T-D1-3 part B). Until part B runs, keep WP5b's 20–30 s.
