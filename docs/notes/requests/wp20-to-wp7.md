# WP20 → WP7 (and WP18, for the `published` source)

## 1. Please persist the provenance strip into `takeovers.metrics.provenance`

`/app/runs/[id]` shows the provenance strip for a **finished** run. The console (WP7) is the only component
that knows the parts the database cannot see: that a replay used a cached transcript, that the AI half was a
recording rather than a live session, that the customer was the operator's own microphone.

Right now nothing writes that down, so `provenanceOf()` in `src/server/read-models/detail.ts` derives what it
can from the row and **deliberately under-claims the rest**:

| Segment | Derived from | When unknown |
|---|---|---|
| `humanHalf` | the run's source (`sim_calls.kind`, `cases.sim_call_id`) | exact |
| `transcription` | `cached` for a text dry run, else `live` | may be wrong for a cached replay |
| `aiHalf` | `live` only when the run ended **and** `aiSeconds > 0`; else `none` | reports `none`, never a guessed `live` |
| `customerInAiHalf` | `synthetic` for a sim, `recorded` otherwise | cannot detect `mic` |

So a recorded replay currently reads "Transcribed live" when it was cached, and a run where the operator spoke
into their own mic reads "Recorded customer". Both are wrong in the *direction that overstates the evidence*,
which is the one direction PLATFORM §7.6 exists to prevent.

**The fix is one line where the console already reports the session** (`POST /api/sessions/report`, or wherever
the takeover's `metrics` is last written): include the final `ProvenanceStrip` under
`metrics.provenance`. `provenanceOf` already prefers it — it parses with `ProvenanceStripSchema` and returns it
verbatim when it validates, and falls back to the derivation when it does not. So nothing breaks whenever you
land it, and no WP20 change is needed.

`tests/unit/server/read-models/detail.test.ts` covers both paths.

## 2. WP18: `takeovers.metrics.publicationId` for the `published` source

`RunsReadModel`'s `SOURCE_SQL` reports `published` when
`jsonb_exists(takeovers.metrics, 'publicationId')`. `relay_publications.active_run_id` is released when the run
ends, so it cannot be used after the fact — the durable signal has to be on the takeover.

Until WP18 sets it, no run ever reports `published`; a published run is currently labelled `recorded` or
`simulated` according to its call. The other three sources are exact. This affects `/app/runs`, the `/app/runs`
source filter, `/app/analytics` and the overview's minutes meter, plus `/api/v1/runs` once WP22 wraps the same
read model.

If you would rather expose it a different way (a column, a different metrics key), tell me the shape and I will
change the one `case` expression in `src/server/read-models/runs.ts`.

## 3. Not a request: the read-only case record

`/app/runs/[id]` renders its own read-only components (`src/components/runs/case-record.tsx`) rather than
reusing `src/components/case/**`. That is not a duplication I wanted — WP7's cards are bound to the Zustand run
store (`useBaton`, `useActions`) and cannot render from a database row. The two share the vocabulary (the same
status words, the same `StatusReason` sentences via `reasonSentence` in `read-models/cases.ts`, the same
evidence shape), so they should stay in step; if you change a status word or a reason sentence in the console,
grep `src/components/runs/case-record.tsx` and `src/server/read-models/cases.ts`.
