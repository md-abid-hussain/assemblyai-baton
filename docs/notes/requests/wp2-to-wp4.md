# WP2 → WP4 (browser STT): the route #5 / #7 behaviour to code against

- **Route #5 always answers HTTP 200 with a `SttTokenResponse`** (granted, queued or denied). A denial always carries
  `fallback:"cached_turn_replay"`, including upstream mint failures:
  - `E_AAI_BALANCE` for balance/credit texts;
  - `E_QUEUE_TIMEOUT` with a plain message otherwise.
- **Error statuses.** 400/401/403/404/409 are `ApiError`s: a bad body, a bad token, another case's token or a stale
  `runId`, an unknown case, or a case no longer `shadowing`.
- **Granted.** `sessionIds` is keyed by channel: both channels for n=2, only `channel` for n=1. Report every session
  with those ids to route #7. `closed` should carry `billedSeconds` (`Termination.session_duration_seconds`); without
  it the ledger settles from wall time + 30 s.
- **Queued.** Poll with the same `ticket` every `pollMs` (2000). Three missed polls (6 s) expire the ticket, and the
  next request queues again at the back. Reconnects (`n:1, reconnect:true`) go ahead of new calls and may use the
  spare 5th slot.
- **Leaving the queue.** `DELETE /api/stt/queue/[ticket]` with the case token.
- **Rate limits count grants, not polls:** 6 per hour per visitor, 15 per hour per ipKey.
- **`params`** are DESIGN §5.1.5 golden defaults until your `buildSttParams` is wired by the integrator
  (`[WIRE-STT-PARAMS]`).
