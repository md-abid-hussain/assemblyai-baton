# WP4 → WP2: STT token route (#5), queue cancel (#6), session reports (#7)

The browser side is built and tested against the contract (`src/client/stt/{api,channel-manager}.ts`). What the
client expects from your routes:

1. **#5 `POST /api/stt/token` builds the params on the server** with WP4's pure helper:
   ```ts
   import { buildSttParams } from "@/core/aai/stt-params";
   params = { rep: buildSttParams(call, policy, "rep"), customer: buildSttParams(call, policy, "customer") };
   ```
   (`call` = the case's CallManifestEntry, `policy` = its PolicyRecord). It sets model, `min_latency`,
   encoding/rate, `inactivity_timeout: 30`, prompt, policy keyterms, per-channel Hinglish, and `TUNING_8K` for 8 kHz.
   Do not add `speaker_labels`, `redact_pii` or `llm_gateway`. `SttTokenGrantedSchema.params` requires **both** keys,
   so send both even for n = 1 (the client uses only the requested channel's).
2. **n = 1 requests always carry `channel`** (a one-channel reconnect, §5.1.9, or an iOS resume of one channel) and
   `reconnect: true`. n = 2 with `reconnect: true` is the iOS resume of both channels. Count every reconnect against
   the 4-opens/min limit like a first open.
3. **Queue:** the client polls #5 with the same body plus `ticket` every `pollMs` (min 250 ms) and cancels with #6
   `DELETE /api/stt/queue/[ticket]` when the run ends first.
4. **Errors:** anything that is not a `SttTokenResponse` (an ApiError 4xx/5xx) is treated by the client as
   `denied` → labelled cached replay (429 → `E_RATE_LIMITED`, others → `E_BUDGET`). Prefer returning a proper
   `denied` body with `fallback:"cached_turn_replay"`.
5. **#7 `POST /api/sessions/report`** (case token in `Authorization`), one per live-sessions id from `sessionIds`:
   - `opened`: `{sessionId, kind:"stt", event:"opened", providerSessionId: Begin.id}` right after `Begin`;
   - `closed`: `{…, event:"closed", billedSeconds, closeCode, providerSessionId}`. `billedSeconds` =
     `Termination.session_duration_seconds` when there was a Termination, the wall-time estimate for an inactivity
     close (3006, no Termination), and absent otherwise. A failed connect reports `closed` with `billedSeconds: 0`.
   On pagehide the orchestrator (WP7) sends these with `fetch(…, {keepalive:true})`.
6. **Token window:** the client connects both channels immediately and in parallel after the grant (8 s Begin
   timeout each), so the 10 s token window of DESIGN §5.1.6 is enough.

Test fakes that mirror these shapes: `tests/unit/client/stt/fakes.ts` (`FakeApi`, `grant()`).
