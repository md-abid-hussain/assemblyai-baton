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
6. **Express prefill cut (please implement exactly this):** insert the cached finals (and their cached fact events)
   with **`recvMs ≤ prefillUntilMs`**, on both channels. The client computes the start with
   `expressStart()` (`src/client/stt/express.ts`). It snaps back from `decisionPointMs − 25 s` to the cut with no
   cached final "in flight" (first word before the cut, arrival after it), so that every cached turn is either
   prefilled or re-transcribed live, and none is split. It then starts the live sessions at exactly
   `prefillUntilMs`. The client also reads the customer's `agent_context` seed (the last cached rep final with
   `recvMs ≤ prefillUntilMs`) from the cached-turns file, so #3 needs no new field.
