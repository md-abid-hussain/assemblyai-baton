# WP3 → WP9: the files WP3 serves, and the extractor for `scripts/eval/extract.ts`

1. **`data/cache/extract/<callId>/v3.pc_ctx.json` (`ExtractCacheFileSchema`).**
   - WP3 serves it only when `extractorVersion` equals the bound engine's. Today that is **`f03ba7a71306`**, which is
     WP1's `EXTRACTOR_VERSION_V3`; WP3's pre-G1 stub has the same value.
   - Key the `turns[]` by cached turn id (`${ch}-c${turn_order}`).
   - WP3 gives a served event the id `${caseId}:${turnId}:${index}`, where `index` is its position in your `events`
     array for that turn. So keep the order stable.
   - Events carry `turnEndMs` = the turn's `endMs` on the call clock.
2. **`public/data/cached-turns/<callId>.json` (`CachedTurnsFileSchema`).**
   - WP3 reads it for the Express prefill: the finals, meaning `type:"Turn"` with `end_of_turn:true`. The last such
     message of a `turn_order` wins.
   - It takes `words[].start/end` as call ms.
   - Its existence also sets `cachedTurnsUrl`.
3. **`src/generated/calls.json` and `src/generated/scenarios.json`.**
   - WP3 expects `calls.json` as `CallManifestEntry[]` (or `{calls:[…]}`), and `scenarios.json` as `Scenario[]`
     (`id` + `policy`).
   - At G1 they are registered by static import (see wp3-to-integrator.md §2).
   - Until then WP3 maps the kit's `data/scenarios/sNN.json` to a `PolicyRecord` with the same rules as WP1's
     fixtures: `phoneOnFileLast4` = the last 4 policy-number digits, and the label = `"<year> <make> <model>"`.
     Please keep `normalizeScenario` identical, or tell me.
4. **The production path for §6.3 ("replays cached finals … through the production `applyTurn` path").**
   - Use `OpenAIExtractor` (`src/server/openai/extractor.ts`) with the bound engine.
   - Either call `extractTurn({caseId, policy, callDate, state, recent, newTurns:[turn]})` sequentially, feeding
     `state` from `engine.deriveCaseState` over the events so far;
   - or run `ExtractService` against a scratch DB, which is what the live test does
     (`tests/integration/extractor.test.ts`).
   - `ExtractTurnResult` adds `coveredTurnIds`, `failedTurnIds`, `attempts`, `usd`, `error` and `noFacts`. `ms` is
     the measured `extractMs` for the cache.
   - Use single-turn calls. 3-turn batches were measurably less accurate (7–9/10 vs 10/10 labelled events).
5. **Spot-check cases (`mode:"spot"`, §6.7):** call
   `getCaseRepository().create({mode:"spot", callId, scenarioId, visitorId, ipKey, prefillUntilMs})`. The prefill
   runs inside `create`.
