# WP17 → WP12 (integration, purge job, proxy, ledger)

From WP17·1 (branch `wp/wp17`).

## 1. Purge job: two new steps (PLATFORM §2.4 size guards), after migration 0001 is applied

```ts
import { purgeSimCalls, purgeTtsCache } from "@/server/sim/store";
await purgeSimCalls(db);   // non-gallery sims idle > 7 days, then the least-recently-used beyond 150 rows
await purgeTtsCache(db);   // tts_cache rows older than 14 days that no remaining sim plays as an AI clip
```

Both return the number of deleted rows. (The third §2.4 step, relay LRU archiving, is WP14b's.)

## 2. Proxy matcher: exclude `.pcm`

`src/proxy.ts` excludes `ulaw|json|…` but not `pcm`. The sim AI-half clips are served at
`/api/sim-calls/<id>/clip.<sha256>.pcm` with `Cache-Control: public, max-age=31536000, immutable`; a first-time
visitor would get a `Set-Cookie` on that immutable response. Please add `pcm` to the extension list.

## 3. Ledger note (dev, laptop guard, env `dev-wp17`)

The WP17·1 live smoke recorded **$0.0077** of OpenAI TTS, settled at the pre-calibration rate. The usage-based cost
(from the SSE `speech.audio.done` usage) was **≈ $0.0100**, so the laptop ledger under-counts by ≈ $0.0024. The
settlement formula is now calibrated (`src/server/openai/tts.ts`: $0.0004 per request + $16 per 1M chars, slightly
above usage), so this is a one-off. A corrective ledger entry was not written (the one-off write was blocked in this
session); add one if the dev tally matters.

## 4. Nothing else to deploy yet

No new env vars and no new dependency. The asset route `GET /api/sim-calls/[id]/[file]` works once 0001 is applied.

---

## 5. One `JobKind` for the drafting job (WP17·3)

`POST /api/drafts` answers `{draftId, status:"queued"}` in one round trip and the client polls, because up to three
luna calls take 30–40 s (PLATFORM §7.4). The work is written as a job step and lives in my path
(`src/server/draft/index.ts`, `DraftService.step(draftId)`, exactly the `{ state, next }` shape
`JobRunner.register` takes). Two small things are in yours:

1. **`JobKind`** in `src/core/contracts/services.ts` is `"verify_takeover" | "purge" | "va_audit" | "budget_guard"`.
   Please add `"draft"`. (`src/server/db/schema.ts:280` has a comment listing the kinds; it is a comment only.)
2. **One registration** in `installBuiltinSteps` (`src/server/jobs/runner.ts`):

   ```ts
   const { getDrafter } = await import("../draft");
   runner.register("draft", (job) => getDrafter().step(job.refId));
   ```

   and, in `src/server/draft/index.ts`, I then swap `inProcessQueue` for
   `{ enqueue: (id) => getJobRunner().enqueueOnce("draft", id) }` — my line, after yours lands.

**Until then it still works.** The default queue runs the step in this process, detached from the request, and the
**`drafts` row** carries the status, the step, the notes and the lint, so a poll served by any container is correct.
What the in-process queue does not give is a retry after a container restart mid-draft: such a draft stays `running`
until the row is read (it never lies about being `ok`). One container, one 40-second window — fine for the demo,
worth the two lines afterwards.

**Not urgent, and not a blocker for G3.** No env var, no migration, no dependency.
