# WP3 notes: cases and extraction (round 1, gate G1)

**Status: done for G1, apart from the Zerops latency measurement.**

- `npm run typecheck` is clean.
- `npm test`: 19 files, 303/303 pass. WP3's own tests: 6 files, 31 tests on real Postgres, $0.
- Acceptance items 2–5 pass. Item 1 passes locally; its Zerops half waits for the deployed URL.
- The live luna test passes: 10/10, 9/10 and 10/10 on the stub engine, then 9/10 and 10/10 on WP1's engine.
- Spend: **$0 AssemblyAI; about $0.032 OpenAI.**

No push, merge or deploy. No Twilio or AssemblyAI calls.

## What WP3 ships

| Piece | Files |
|---|---|
| `CaseRepository` (TASKS §2) + WP3 extensions | `src/server/cases/repository.ts` |
| F1 extraction service: per-case queue, backlog batching, cached events, after_takeover, late-pending window | `src/server/cases/extract-service.ts` |
| F2 background verifier runner | `src/server/cases/verifier-runner.ts` |
| Express prefill and cached-event serving | `src/server/cases/prefill.ts` |
| Route #3 service; route #4 `CaseView` | `src/server/cases/{create,view}.ts` |
| Service graph and the `getCaseRepository()` seam | `src/server/cases/index.ts` |
| Route helpers (errors, 400/429, Retry-After) | `src/server/cases/http.ts` |
| Ports for WP1's engine and WP2's platform, with pre-G1 stand-ins | `src/server/cases/{engine,platform,defaults,engine-stub,platform-stub}.ts` |
| luna extractor (§5.3) | `src/server/openai/extractor.ts` |
| sol verifier (F2), with `VERIFIER_PROMPT_V1` and the strict `add_driver_audit` schema | `src/server/openai/verifier.ts` |
| Data sources: manifest, policies, extraction cache, cached turns | `src/server/data/{index,kit-policy}.ts` |
| Routes #3, #4, #8 | `src/app/api/cases/route.ts`, `src/app/api/cases/[caseId]/route.ts`, `src/app/api/extract/route.ts` |
| Tests | `tests/unit/server/cases/*.test.ts` (+ `helpers/`), `tests/integration/extractor.test.ts` |
| Fixture: the s01 call as 20 per-channel finals | `tests/fixtures/extract/s01-dialog.json` (turns 0–11 are the 12-turn live fixture with 10 labels) |

## Decisions

1. **Ports instead of imports for WP1 and WP2.** wp/wp1 and wp/wp2 are not merged, so WP3 codes against two small
   ports:
   - `CaseEngine`: WP1's `applyExtraction`, `deriveCaseState`, `verifierDisagreementEvents`, `buildExtractorInput`,
     `emptyCaseState` and the extractor artefacts. The signatures are structural subsets, so WP1's functions fit
     unchanged.
   - `CasesPlatform`: WP2's `requireVisitor`, `requireCase`, `issueCaseToken`, `issueVisitorToken`, the rate limiter
     and the ledger.

   `defaults.ts` is the only file to swap at G1; its exact content is in `requests/wp3-to-integrator.md`.

   **Pre-integration check.** I ran it in a scratch tree: wp3, plus WP1's `core/case` and `add-driver.ts`, plus
   WP2's `auth`, `limits` and `flags`, with the G1 `defaults.ts`.
   - `tsc` is clean.
   - The full unit suite passes (299).
   - All WP3 tests pass on WP1's real engine.
   - The route tests pass on WP2's real auth and DB rate limiter.

   **The stand-ins** keep WP1's contracts WP3 relies on: event ids, `(turnEndMs, seq)` order, the verifier encoding,
   and "sol never upgrades". The stub's prompt and schema equal WP1's byte for byte (checked), so both give
   `extractorVersion` **f03ba7a71306**.
2. **F1 exactly as DESIGN §4.5, with no transaction across the LLM call.** The steps are: insert the turn
   (idempotent), plain read, extractor outside any transaction, then one short transaction.
   - The transaction takes `pg_advisory_xact_lock(hashtext(caseId))`, inserts events with `max(seq)+1…`, re-derives
     from ALL events and saves `version+1`.
   - `expectedVersion` is informational, because every commit re-derives from every event under the lock.
   - An event id that already exists is skipped (`on conflict do nothing`), so a replayed patch is harmless.
3. **A per-case in-process queue.**
   - One extraction per case at a time, sorted by `endMs`. Better context for luna, and no overlapping luna calls
     for a case.
   - Turn ids in flight are tracked, so a client retry of a slow turn waits for the running extraction instead of
     getting a stale "duplicate".
   - Across processes the lock keeps the result correct.
4. **Batching is backlog-only (§5.3 "when more than 2 turns are queued").** Up to 3 new turns per call, and only
   when more than 2 are waiting (`batchSizeFor`).
   - Measured live: 3-turn batches found 7/10, 8/10 and 9/10 of the labels, against 10/10, 9/10 and 10/10 for
     single turns.
   - WP4's CaseSync keeps one request in flight, so production calls are single-turn.
5. **The retry follows §5.3.**
   - Once, on timeout, `incomplete`, 429, 5xx, connection errors or bad JSON. The retry sends only the NEWEST turn
     (the older ones move into RECENT) with the same timeout: `1500 + 1000/150·1000 = 8167 ms`. SDK retries are off.
   - A refusal, or a config error such as a missing key, is not retried.
   - A final failure is not an HTTP error: the turn gets `extract_status='failed'` and the response is a 200 with the
     current state.
6. **After the takeover.**
   - A case is "frozen" when its status is `ai_active` or later (`freezeSnapshot` sets it). A new turn is then stored
     as `skipped` and answered with 200 `skipped:"after_takeover"`.
   - The exception is a turn in `DrainReport.pendingTurnIds` that arrives within 3 s of the freeze. It is extracted
     (late, so it can only stay PENDING), and `takeovers.snapshot` never changes.
   - The freeze record lives in `takeovers.protocol.freeze`, written with a jsonb merge.
   - `freezeSnapshot` is idempotent: it returns the stored snapshot. It also marks turns and events after `tArmMs` as
     late and the drain's cut turns as cut, then passes `tArmMs` to derive.
7. **The verifier (F2).**
   - It runs only when all of these hold:
     - the case is `shadowing`;
     - at least 15 s have passed since the last start;
     - at least one new final has arrived since the last run's `uptoRecvMs`;
     - there have been fewer than 8 runs;
     - no run is in flight;
     - the ledger reserves $0.03 for OpenAI.
   - The in-flight claim is synchronous, so concurrent triggers cannot race.
   - Steps 2–4 run in one transaction: store the run, insert disagreement events only while still `shadowing`, and
     re-derive with the latest applied result as `ctx.verifier` (per WP1's request).
   - A late result is stored as `result.applied=false` and is never used as the overlay.
   - The spend is settled with the actual cost.
   - On the cut list: flip `verifierEnabled` (see the integrator request §6).
8. **Prefill (§5.1.6).** It inserts every cached final with `endMs ≤ prefillUntilMs`, with its cached events, in one
   transaction and one derive, with no LLM call.
   - If a turn has no cache entry, or the cache version does not match, the turn is inserted as `skipped` with no
     events, and luna is still not called.
   - Served cached events get the id `${caseId}:${turnId}:${index}`, so a prefill and a replay through `/api/extract`
     produce identical rows (tested).
9. **Stage, disclosures, payment and confirmation number** are carried from the stored state through every derive.
   - New `repo.setCaseExtras()` writes them under the same lock. WP6 must never write `cases.state` directly (request
     filed).
10. **Route details.**
    - #3: `mode:"watch"` without a `callId` uses the featured call. An unknown call is 404; unpublished audio is 409.
      `mode:"live"` without a call uses scenario s01, and its `assets` are empty strings (P2 is cut).
    - #3 always returns `visitorToken`.
    - #4's `payment` is a minimal summary (`embed:null`, no `toolResult`); route #15 is authoritative.
    - Rate limits:

      | Route | Limit | Key |
      |---|---|---|
      | #3 | 10/h | visitor |
      | #3 | 30/h | ipKey |
      | #4 | 120/min | case |
      | #8 | 10 per 2 s (5/s, burst 10) | case |
      | #8 | 250 turns | case |

## Acceptance (TASKS WP3)

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Extractor integration (`RUN_LIVE=1`): the 12-turn fixture → ≥9/10 labelled events | **PASS (local)**; Zerops half **pending: needs the deployed URL** | `tests/integration/extractor.test.ts`. Stub engine: 10/10, 9/10, 10/10 (3 passes). WP1 engine (scratch): 9/10, 10/10. The only misses: `rep-2 driver_dob readback` once, `customer-0 driver_relation` once. The remote mode is built (`EXTRACT_BASE_URL=…`) |
| 2 | 20 turns in random order at 10/s = sequential; no duplicate `seq`; no pool exhaustion with 3 cases + payment polling (pool 15) | **PASS** | `extract-service.test.ts`. The state matches sequential application exactly (fields, readiness, conflicts, clock); seqs are unique; at most 1 concurrent luna call per case; batches ≤3. On 3 cases × 20 shuffled turns at 10/s + a payment/case poller on a 15-connection pool: 0 errors, `pool.totalCount ≤ 15` |
| 3 | The verifier never upgrades; runs never overlap | **PASS** | `verifier-runner.test.ts`. sol "stated_and_confirmed" on PENDING/MISSING fields leaves them non-VERIFIED; a disagreement downgrades a VERIFIED field to `verifier_disagrees`; 10 concurrent triggers during a slow run start 1 (max concurrency 1); the cadence, new-final, 8-run and budget gates hold; a late result gets `applied:false` and the state is untouched, even after a later re-derive |
| 4 | Prefill makes 0 OpenAI calls and equals the live-replayed state | **PASS** | `prefill.test.ts`. 0 extractor calls; fields, readiness, conflicts and the fact rows equal a turn-by-turn replay of the same cached finals through the F1 service; version mismatch is never served |
| 5 | A turn after the freeze returns `skipped` and never alters `takeovers.snapshot` | **PASS** | `extract-service.test.ts`. `skipped:"after_takeover"` (200); snapshot byte-equal before and after; a drain-pending turn within 3 s is extracted but the snapshot is unchanged; after 3.5 s it is skipped; `freezeSnapshot` is idempotent |

Routes #3, #4 and #8 are covered end to end by `routes.test.ts`, which calls the handlers against real Postgres:
schemas, 400/401/403/404/409/429 and duplicates. They also passed with WP2's real auth and rate limiter in the scratch
tree.

## Day-1 tests and measured numbers

WP3 has no AssemblyAI Day-1 test. Its D1 item is the extractor latency. Every luna row below was measured on the
Windows 11 laptop (India → OpenAI), with Postgres 17 in Docker, 2026-09-25 ≈ 00:30 IST.

| Measurement | n | p50 | p95 | max | Cost |
|---|---|---|---|---|---|
| luna single-turn `extractMs`, F1 path, stub engine, 3 passes | 36 | **2119 ms** | **3419 ms** | 3722 ms | $0.0068 |
| luna single-turn `extractMs`, WP1 engine (scratch), 2 passes | 24 | **2097 ms** | **4055 ms** | 4083 ms | $0.0046 |
| luna 3-turn batches (4 calls × 3 runs) | 12 | 2.2–3.9 s | — | 5492 ms | $0.003 |
| sol verifier, one run over the 20-turn call | 1 | **9851 ms** | — | — | $0.0104 |
| F1 server overhead per turn without the LLM (fake luna 0 ms, WP1 engine, local PG) | 60 | 31 ms | 38 ms | 46 ms | $0 |

What the numbers mean:

- **Per-turn cost.** luna costs ≈ $0.00019 per turn (≈1.4k input and ≈100 output tokens). The 20-turn sol run
  found 15 fields with sensible support, so ≤8 runs ≈ $0.08 per case.
- **`DRAIN_MAX_MS` = 2000 is below the luna p50 (≈2.1 s).** A final that arrives in DRAINING usually misses the
  snapshot. That is safe by construction, but it is common. WP9b should sweep with the measured distribution; WP5 has
  been told (`requests/wp3-to-wp5.md`).
- **Zerops (Prague) p50/p95: not measured yet.** It needs the deployed URL with WP3 merged. Run
  `EXTRACT_BASE_URL=https://<app> node scripts/lib/run-with-env.mjs RUN_LIVE=1 WP3_RESULTS_FILE=<file> -- npx vitest run tests/integration/extractor.test.ts`.
  It creates `mode:"live"` cases, posts the 12 turns in order and reports the server-side `extractMs` and the round
  trip. Cost ≈ $0.007 for 3 passes.

## Known gaps

- **Zerops latency.** Above: it needs the deployed URL.
- **Generated data at run time.** `src/generated/{calls,scenarios}.json` do not exist yet (WP9). In dev a fs fallback
  and the kit scenario mapping cover this.
  - In the bundle, route #3 needs the G1 static-import registration (`requests/wp3-to-integrator.md` §2).
  - The extraction cache needs `outputFileTracingIncludes` (§3).
- **`next build` cannot run in a worktree.** Turbopack rejects the `node_modules` junction. It needs a build on the
  merged main.
- **The per-case queue and the verifier's in-flight guard are per process.** That is correct on one Zerops container.
  With several instances (the Vercel mirror), correctness still holds (advisory lock, unique `seq`), but two
  instances could each run a verifier or a luna call for the same case at once.
- **Route #4 `payment` is a summary.** A WP6 `paymentViewOf` would replace it after G1.
- **No policy-seeded events.** DESIGN names `kind:"policy"` but gives no seeding rule, so cases start with every
  field MISSING. The `policy_record` reason stays reachable if a WP adds such events through `applyEvents`.
- **The verifier prompt is WP3's own.** DESIGN specifies none: `VERIFIER_PROMPT_V1` / `add_driver_audit`. Its output
  maps 1:1 to `VerifierResult`, with `turnIds` filtered to known turns.

## What the integrator must wire

**At G1:**

1. Replace `src/server/cases/defaults.ts` with the G1 binding: WP1's engine and WP2's platform
   (`requests/wp3-to-integrator.md` §1). Then the "pre-G1 stub" warning disappears from the logs.
2. Once WP9 writes `src/generated/*.json`, register them with `registerGeneratedData`. Also register WP2's
   `registerCallLookup((id) => getCaseDataSource().getCall(id))` ([WIRE-CALLS]).
3. Add `outputFileTracingIncludes` for `./data/cache/extract/**` on `/api/cases` and `/api/extract`.

**At G2:**

4. WP5 compile: call `getCaseRepository().freezeSnapshot`, and merge `takeovers.protocol` instead of overwriting it
   (`requests/wp3-to-wp5.md`).
5. WP6 tools: use `applyEvents` for tool updates and `setCaseExtras` for stage, disclosures and payment
   (`requests/wp3-to-wp6.md`).
6. WP4 CaseSync: raise `requestTimeoutMs` to 20 s (`requests/wp3-to-wp4.md`). The `/dev/audio` checkpoint (D1 18:00)
   works as soon as #3/#8 are merged.

**After deploy:** run the remote mode of `tests/integration/extractor.test.ts` against the Zerops URL. Record the
p50/p95 here and give them to WP9b and to the `DRAIN_MAX_MS` check.

## How to run

```bash
npm run typecheck
npm test                                   # the WP3 DB suites need DATABASE_URL (the worktree .env); SKIP_DB_TESTS=1 skips them
node scripts/lib/run-with-env.mjs RUN_LIVE=1 WP3_RESULTS_FILE=/tmp/wp3.jsonl -- npx vitest run tests/integration/extractor.test.ts
#   WP3_PASSES=n (default 3); -t batched / -t verifier for the extra measurements; EXTRACT_BASE_URL=… for the Zerops run
```

vitest hides `console.log` of passing tests, so the live test also appends its JSON line to `WP3_RESULTS_FILE`.
