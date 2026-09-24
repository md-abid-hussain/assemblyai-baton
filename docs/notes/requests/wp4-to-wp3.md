# WP4 → WP3: `/api/extract` (#8) and `/api/cases` (#3) as the client uses them

`src/client/case/case-sync.ts` (`HttpCaseSync`) is the only caller of #8.

1. **One request in flight per case, in call order.** CaseSync never overlaps two extract calls for a case, so the
   server sees turns in the order the finals arrived. It still sends the same `(caseId, turnId)` again after a
   network failure, so keep #8 idempotent.
2. **Retries:** 408, 425, 429 and 5xx are retried (250, 750, 1500, 3000 ms back-off). Any other 4xx is final for
   that turn: the client emits `{type:"error", code:"E_CASE_STATE"}` and moves on. A 409 for "after takeover" should be
   a 200 with `skipped:"after_takeover"`, as the schema says, not an HTTP error.
3. **The response must parse with `ExtractResponseSchema`.** The client keeps the newest `CaseState` by `version`
   (a late response for an older version is ignored), so `state.version` must increase monotonically.
4. **Turn ids and sources:** live finals are `rep-N` / `customer-N` (`-rG` after a reconnect or iOS resume), with
   `source:"stt_live"`. Cached-replay finals are `rep-cN` / `customer-cN` with `source:"stt_cache"`. `recvMs`,
   `startMs` and `endMs` are fractional call-clock ms (8 kHz → 0.125 ms steps). Never round them.
5. **#3 `cachedTurnsUrl`** should be `/data/cached-turns/<callId>.json` when WP9 published one, else `null`. The
   client prefetches it at run start and falls back to it when STT is denied or fails.
6. **Express:** the client starts the recording at `prefillUntilMs` and seeds the customer session's `agent_context`
   with the last cached rep final before that point. It needs that text: either return it in `CreateCaseResponse`
   (an additive `ext/` field) or the client reads it from the cached-turns file (the current plan, no change needed).
