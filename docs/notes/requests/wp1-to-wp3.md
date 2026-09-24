# WP1 → WP3: how to call the case engine from the repository and the extractor

1. **Derivation context** (`deriveCaseState(policy, events, ctx)`, `src/core/case/derive.ts`). Please pass:
   - `ctx.tArmMs = cases.t_arm_ms` once it is set. Human events of turns that ended after it then count as `late`,
     so a late turn cannot make a field VERIFIED (§5.5.4 rule 2). The events' own `late`/`cut` columns still apply.
   - `ctx.verifier` = the latest `verifier_runs.result` of the case (a `VerifierResult`), or null.
     - Why it matters: F2 step 3 inserts events for disagreements only. A newer run that agrees inserts nothing, so
       without the result an older disagreement would stay.
     - Without `ctx.verifier`, derivation falls back to the verifier events of the latest run (the largest
       `turnEndMs` among `kind:"verifier"` events).
   - `version`, `stage`, `disclosuresGiven`, `payment`, `confirmationNumber` from the case row. They are copied into
     the returned `CaseState`; derivation does not read them.
   - `seq` on every event (ties on `turnEndMs` are broken by `seq`).
2. **F2 step 3.** Use `verifierDisagreementEvents(result, state, turns, {caseId, policy})` from `src/core/case/apply.ts`.
   It implements the G0 encoding: `kind:"verifier"`, `party:"verifier"`, `extractor:"sol"`, `turnId:null`,
   `turnEndMs = uptoRecvMs`, confidence mapped from support, evidence = the first cited turn.
3. **The extractor** (`src/server/openai/extractor.ts`) can import from `src/core/case/extractor.ts`:
   - `EXTRACTOR_PROMPT_V3`, `ADD_DRIVER_PATCH_FORMAT` (already in `extractStructured`'s `format` shape);
   - `buildExtractorInput({callDate, policy, state, recent, newTurns})`, the §5.3 user JSON;
   - `EXTRACTOR_VERSION_V3`, `EXTRACTOR_MODEL_ID`, `EXTRACTOR_REASONING_EFFORT`;
   - the batching constants `EXTRACT_MAX_NEW_TURNS` and `EXTRACT_RECENT_TURNS`.
4. **`applyExtraction(raw, newTurns, {caseId, policy, newId?})`.** The default event id is
   `${caseId}:${turnId}:${index}`, which is deterministic. A replayed patch for the same turn therefore collides on
   the `fact_events` primary key; pass `newId` if you want random ids. The output has no `seq` (G0).
5. **Case creation.** `emptyCaseState(caseId)` and `readinessOf(fields)` are in `src/core/case/state.ts`.
