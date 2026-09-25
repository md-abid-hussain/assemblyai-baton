# WP8 notes: async verification, VA audit, QA service (round 1 → G1)

**Status:** round 1 is done on `wp/wp8`.
- `npm run typecheck` is clean.
- `npm test`: 326/326. WP8 adds 54 tests in `tests/unit/server/verify/**`; they create throwaway Postgres databases on
  `DATABASE_URL` and skip when there is none.
- Live verification works end to end on a real Voice Agent session. It completes about 22 s after the session ends,
  poll-only, and its `QaResult` equals the hand count.
- T-D1-0b is measured.
- Live spend: **≈ $0.22** of the $0.30 round budget.

## What was built

| File | What it does |
|---|---|
| `src/server/jobs/verify-takeover.ts` | `enqueueVerification` (TASKS §2) and the F3 step machine S1–S4 (`createVerifyStep`). Also `enqueueVerificationFromSweeper`. It registers its step on import |
| `src/server/jobs/va-audit.ts` | F6 `runVaAudit()` / `vaAuditHook`, marker parsing, and the T-D1-0b constant `DELETE_ENDS_LIVE_SESSION = false` |
| `src/server/aai/va-rest.ts` | `VaRestPort`: `getSession`, `listSessions` (cursor param verified), `createAgent`, `deleteAgent`, `deleteSession`. Also `listSessionsSince` (paging) and `artifactUrl` |
| `src/server/qa/deps.ts` | The seam. `wp8()` / `configureWp8()` hold the ports: runner, ledger, `computeQa`, auth, rate limiter, flags, VA REST, async client, artifact fetch, config |
| `src/server/qa/wiring.ts` | `ensureWp8Wired()`. A no-op in round 1; the G1 body is in `requests/wp8-to-integrator.md` §1 |
| `src/server/qa/build-input.ts` | Artifacts → `computeQa` input: channels, timeline tool calls, disclosure anchors, payment, latency, keyterms |
| `src/server/qa/verification.ts` | The `verifications` row and the `takeovers.metrics.verification` merge |
| `src/server/qa/routes.ts` | Logic of routes #19, #20 and #21 (injectable) |
| `src/server/qa/auth.ts` | Default takeover authorizer (case-token check) |
| `src/server/qa/purge.ts` | `purgeVaRecordings` (for WP2's `registerPurgeStep("va_sessions", …)`) |
| Routes | `src/app/api/webhooks/assemblyai/route.ts` (#19), `src/app/api/verifications/[takeoverId]/route.ts` (#20), `src/app/api/va-sessions/[vaSessionId]/audio/route.ts` (#21) |
| `src/core/contracts/ext/wp8-verify.ts` | `VerifyState` (zod), `Wp8QaInput` / `ComputeQa` (a structural mirror of WP1's `QaInput`), the metrics keys, `VaAuditReport` |
| `scripts/day1/session-delete.ts` | T-D1-0b (`--cursor` costs $0; `--live` runs 2 short VA sessions) |
| `tests/integration/async-verify.test.ts` | RUN_LIVE=1, ≈ $0.08: a scripted real VA session → F3 → QA vs the hand count, plus route #21 |

## Decisions

1. **One injection seam (`deps.ts`) plus one wiring file.** Neither WP2's runner, ledger, flags, auth and hooks nor
   WP1's `computeQa` are on this branch. WP8 therefore codes against the TASKS §2 contracts and reads everything
   through `wp8()`. At G1 only `src/server/qa/wiring.ts` changes; the snippet is ready in `wp8-to-integrator.md`.
   Every entry point calls `ensureWp8Wired()`, so the Vercel mirror (no in-process worker) wires itself on the
   first request.
2. **The step never throws for AssemblyAI or QA errors.** It counts consecutive failures per step in its own state:
   3 → `failed`, or at once for a `PermanentVerifyError` (budget, no recording, artifacts or transcript timeout,
   transcript error, QA engine not wired). The plain-words reason is therefore always recorded in
   `takeovers.metrics.verification.reason`. If WP2's runner fails the job anyway (DB-level throws), route #20
   reconciles the `pending` row to `failed`.
3. **Webhook only on a public https `APP_URL`** with `AAI_WEBHOOK_SECRET` set. Otherwise F3 is poll-only (3 s polls,
   60 s budget). AssemblyAI cannot reach localhost. The webhook route dedupes on `aai:<transcript_id>:<status>`,
   checks that the transcript id matches the job, makes the job due now, answers 200, and advances in `after()`.
4. **The S2 submit** is `{fresh pre-signed audio_url, speech_models:["universal-3-5-pro"], multichannel:true,
   keyterms_prompt}`. The keyterms are the snapshot's entity displays plus the policy names and vehicle models (≤ 100
   terms, each ≤ 50 chars and ≤ 6 words). On a 400 it resubmits once without keyterms. **Both live runs were
   accepted with keyterms + multichannel together**, which answers DESIGN F3's "never tested together".
5. **Ledger.**
   - S1 settles the VA entry with `duration_seconds`. It finds the row through `live_sessions.provider_session_id`,
     else `va_<takeoverId>_{0,1}`.
   - S2 reserves `aai_async` (2 × duration × $0.21/h) and releases it if the submit throws.
   - S4 settles with duration × channels.
   - On failure, the reservation is released if nothing was transcribed (or AssemblyAI reported an error); otherwise
     it is settled at the estimate.
   - F6 also settles ended sessions (once per session per process).
6. **Timeline times are epoch ms** (observed in WP5b's T-D1-12 timeline and in both live runs). `relMs()` subtracts
   `started_at_unix_ms`, and that clock matches the recording. Run 2 anchored the disclosure window on the
   `get_disclosure` result time and found the verbatim reading with similarity 1.0.
7. **Route #21: `?t=12.5` → `#t=12.5`.** A query parameter would invalidate the S3 signature; a media fragment
   survives the 302. The response carries `cache-control: no-store` and `referrer-policy: no-referrer`.
8. **Never store or log a pre-signed URL.** State holds ids and durations only. Error text passes through
   `stripUrlQueries()`, because an AssemblyAI download error can echo the S3 URL with its signature.
9. **Default authorizer = case-token check.** It checks HS256, `CASE_TOKEN_SECRET`, `scp ∋ case` and
   `tko = takeoverId`. WP2's `requireCase` adds the visitor-cookie check at G1. Route #21 finds the owner by
   `takeovers.va_session_id`: another takeover's token → 403, no token → 401.
10. **F6 audit.**
    - It is skipped on `dev-*`, `vercel-*` and `local` deploys, and when the mode is not live.
    - Markers are read from `GET /v1/sessions/{id}.config.system_prompt`. The list items carry no config (measured),
      so the audit fetches each new id once and caches the marker per process.
    - Grace windows:
      - unknown sessions younger than 90 s are skipped, because the `opened` report lags `session.ready`;
      - a row closed less than 60 s ago is not yet a zombie.
    - A session "known" by `takeovers.va_session_id` also counts.
    - A session deleted between list and get is skipped, not fatal.
    - Anomalies flip the mode through `tripReplayOnly("va_audit_anomaly")`, which keeps WP2's reason precedence.
      **The audit never deletes** (T-D1-0b).
11. **Purge.** Recordings and verification transcripts of judge takeovers are deleted after **7 days**: a week before
    WP2 drops the case rows (14 days), while the ids still exist. Each purged takeover is marked
    `metrics.recordingPurgedAt`. `spot` cases are kept.
12. **`takeovers.metrics` is shared.** WP8 reads `hud` (WP5) and `disclosures` (WP6) and writes only `verification`,
    always with a jsonb `||` merge. The requests to WP5 and WP6 ask the same of them.

## Day-1 test results

**T-D1-0b** (`scripts/day1/session-delete.ts`, 2026-09-25, 2 sessions, 15.5 s billed, $0.019):

| Case | Observed |
|---|---|
| (b) **ended** session: `DELETE /v1/sessions/{id}` | **204**. Afterwards `GET` → **404**, the session is gone from the list, and the pre-signed audio and timeline URLs → **S3 404 at once** (206 `OggS` just before). A second DELETE → 404. Artifacts had appeared 3.9 s after `session.end` |
| (a) **live** session: `DELETE` 4.2 s after start | **204, but the session is NOT ended.** The socket stayed open, a `reply.create` 2 s after the delete was answered ("banana"), and `session.ended` came only from our own `session.end` (11.06 s billed). The delete **hides** the live session: `GET` → 404 and it leaves the list at once |
| Running session record | `status:"created"`, `ended_at:null`, `duration_seconds:null`, `artifacts:[]`, `config` present |
| `GET /v1/sessions` cursor | The query param is **`cursor`**. Only it advanced the page; `after`, `starting_after`, `next_cursor` and `page_token` were ignored (page 1 again). The list is newest-first, and items have `id, agent_id, status, public_close_reason, duration_seconds, created_at, ended_at` (**no `config`**) |

**Verdict.** F6 only flips the mode, because deleting a live session would blind the next audit without stopping the
spend. The privacy copy can say ended recordings are *deleted* (request `wp8-to-wp13.md`).

**$0 live audit probe** (3 h window, page size 5): 3 pages via `cursor`, 14 sessions. Markers read from the real
config: `dev-wp5b` ×11 (WP1-compiled prompts, so the marker format matches), `dev-wp8` ×1, none ×2. WP2's synthetic
greeting-only checks carry no marker. That is harmless: they are registered in `live_sessions` and the audit ignores
unmarked sessions.

## Measured numbers (live F3, `tests/integration/async-verify.test.ts`, poll-only, S1 at +7 s as in production)

| Run | VA session | Submitted | Verified | QA (hand count) | Spend |
|---|---|---|---|---|---|
| 1 | 91.8 s | +13.5 s after end | **+22.0 s** | reAsked 1, newlyAsked 1, verifiedReconfirmed 1. The disclosure was **not read**: the test's hand-rolled `tool.result` lost the race against the dispatcher's automatic "unknown tool" error, and the agent said "I am having trouble accessing that information". So `premium_change` ok=false, similarity 0.027, missing `$171` and `$23.40`, which is **correct**: that is the hand count | $0.115 VA + $0.011 async |
| 2 | 53.6 s | +13.1 s | **+21.9 s** | reAsked 1 (the re-asked VERIFIED ZIP), newlyAsked 1 (DOB asked twice, one distinct field), verifiedReconfirmed 1 (the greeting's "ZIP code 7 8 7 0 1, right?"). `premium_change` ok, similarity 1.0, anchored at the timeline's `get_disclosure` result. `aiSeconds` 54.1. **All equal the hand count** | $0.067 VA + $0.006 async |

- Async U3.5 Pro multichannel on these recordings finished within 3–9 s of submit. Most of the ~22 s is the 7 s
  first delay plus artifact availability (about 4–7 s) plus 3 s poll granularity. With the webhook, expect about
  18–19 s.
- Route #21 on the real session: 302 → `speech-to-speech-production-euw1-sessions.s3.amazonaws.com`. A ranged GET
  → **206 `OggS`**.
- Round spend: T-D1-0b $0.019 + run 1 $0.126 + run 2 $0.073 ≈ **$0.22**, all through the file guard's ledger (the
  async reservations were settled by S4). OpenAI TTS for 3 short clips: under $0.01.

## Acceptance (TASKS WP8)

1. **Real ≈60 s VA session → artifacts → multichannel transcript → `QaResult` matching a hand count: PASS** (run 2,
   53.6 s).
   - **Poll path: PASS, live.**
   - **Webhook path: unit-tested only.** Route #19 plus the deferred advance complete a verification; duplicates and
     mismatches are ignored; auth is enforced. It needs the deployed https URL, because AssemblyAI cannot reach
     localhost. Test at G3 on Zerops: set `APP_URL` and `AAI_WEBHOOK_SECRET`; `webhook_events` should get an
     `aai:<id>:completed` row with `processed_at`.
2. **F6: PASS (unit, with fakes).**
   - A synthetic marker-bearing session unknown to the registry flips `replay_only`.
   - `dev-*` and `vercel-mirror` sessions are ignored.
   - `has_more` pagination is followed.
   - Zombies and over-concurrency are flagged.
   - The live REST behaviour (cursor, markers) was probed at $0.
   - Flipping WP2's real flag store needs G1 wiring.
3. **PASS (API side).**
   - Three consecutive failures → `failed` with a plain reason, and route #20 returns `{status:"failed", qa:null,
     reason}`.
   - "The UI keeps provisional numbers" belongs to **WP7** (request `wp8-to-wp7.md`).
   - Route #21: 302 for the owner, 403 for others, 401 without a token, 404 not ready or deleted, 429 past 30/min.
   - The ledger settles actual durations: VA at S1 and F6, async at S4 (unit-tested; live via the file guard).

## Known gaps

- **G1 wiring is pending.** Until it lands:
  - no runner, so `enqueueVerification` returns null;
  - no QA engine, so S4 fails with "QA engine not available";
  - the rate limiter is in-memory, per process;
  - the authorizer has no visitor-cookie check.

  The snippet is in `requests/wp8-to-integrator.md`. It was written against WP2's and WP1's current code but has not
  been compiled together with it.
- **`next build` cannot run in this worktree.** Turbopack refuses the `node_modules` junction: "Symlink
  [project]/node_modules … points out of the filesystem root". The integrator should confirm at G1 that the three
  routes build and that `bundle/node_modules/ws` exists (g0 gap).
- **The webhook path has not been live-tested** (it needs the deployed URL).
- **The unit tests use `TestRunner`** (a double of WP2's `DbJobRunner` with the same rules). After the merge, the
  harness can switch to the real runner.
- **Keyterms + multichannel were accepted in both runs, but they were not A/B-tested for accuracy.** The 400 fallback
  stays.
- **The live agent went off-script** twice: extra "Finally, what is the date of birth…" and double DOB questions. The
  distinct-field counts are unaffected; `details[]` lists both.

## What the integrator must wire

**At G1:**
1. The `src/server/qa/wiring.ts` body from `requests/wp8-to-integrator.md` §1.
2. `await import("./verify-takeover"); await import("./va-audit");` in WP2's `installBuiltinSteps()`.
3. WP5's end route: `enqueueVerification(takeoverId, vaSessionId)`, plus `takeovers.va_session_id`, `ended_at` and
   `metrics.hud` merges (`requests/wp8-to-wp5.md`).
4. WP6's `get_disclosure` handler: merge `metrics.disclosures[kind]` (`requests/wp8-to-wp6.md`).

**At G2/G3:**
1. Set `APP_URL` (https) and `AAI_WEBHOOK_SECRET` on Zerops, then run one live takeover to confirm the webhook path.
2. WP7 polls route #20 and renders the states (`requests/wp8-to-wp7.md`).
3. WP13 privacy copy: ended recordings are deleted (`requests/wp8-to-wp13.md`).

**For the planner** (DESIGN amendments):
- the `GET /v1/sessions` cursor param is `cursor`;
- a running session reads `status:"created"`;
- DELETE does not end a live session;
- timeline times are epoch ms;
- `?t=` becomes the `#t=` fragment on route #21.
