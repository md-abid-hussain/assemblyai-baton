# WP1 notes: the pure case engine (round 1 → gate G1)

**Status: ready for G1.**

- `npm run typecheck` is clean.
- `npm test` passes: 27 files, 426 tests. WP1 adds 14 files and 154 tests; the other 13 files and 272 tests are from G0.
- Everything is committed on `wp/wp1`.
- Live spend: **$0**. WP1 made no AssemblyAI, OpenAI or Twilio calls and did no deploys.
- Everything WP1 ships is pure: no `node:*`, DOM or `process.env`, and it imports nothing outside `src/core`. The
  boundaries test passes.

## What ships (all pure, `src/core/**`)

| Module | Exports |
|---|---|
| `intents/add-driver.ts` | `normalizeField`, `displayValue`, `compatible`, `mergeValues`, `resolveRelativeDate` (re-export), `parseMoney`, `effectiveDateInRange` (`EFFECTIVE_DATE_MAX_DAYS` = 90), `confirmPhrase`, `askPhrase`, `GREETING_PRIORITY`, `FIELD_LEXICON`, `targetedFields`, `ADVICE_RE`, `spokenForms`, `vehicleLabelOf`, `firstNameOf`, `relationWord`, `licenseWords`/`licenseAdjective` |
| `case/apply.ts` | `applyExtraction`, `alignEvidence`, `locateQuote`, `verifierDisagreementEvents` (F2 step 3, G0 encoding), `toolUpdateEvent` |
| `case/status-rules.ts` | `deriveField` (§5.4.2), `verifierViewOf`, `verifierDisagrees`, `isLate`, `DerivableEvent` (`seq` optional) |
| `case/derive.ts` | `deriveCaseState(policy, events, ctx)`, `deriveV1`, `sortEvents`. `DeriveCtx` takes `tArmMs`, `verifier`, `rules: {lateCut, verifierOverlay}` (for sweep v2 and the verifier-off ablation), plus the row fields to carry through |
| `case/state.ts` | `emptyCaseState`, `emptyFieldState`, `readinessOf` |
| `case/extractor.ts` | `EXTRACTOR_PROMPT_V3` (verbatim §5.3), `EXTRACTOR_PROMPT_V1`, `ADD_DRIVER_PATCH_FORMAT` (in `extractStructured`'s format shape), `buildExtractorInput`, `extractorVersionOf`, `EXTRACTOR_VERSION_V3`/`_V1`, batching constants |
| `case/{dates,text,sha256}.ts` | calendar helpers and `parseExplicitDate`; `wordsToNumbers`, Levenshtein/LCS; a sync `sha256Hex` (core cannot use `node:crypto`) |
| `compiler/tool-schemas.ts` | `TOOL_SCHEMAS` (verbatim §5.8), `PAY_LINK_PUSH_TOOL`, `STAGE_TOOL_NAMES`, `toolsForStage(stage, {payToolMode})`, `ALLOWED_SCHEMA_KEYWORDS` |
| `compiler/stages.ts` | `initialStage`, `nextStage` (forward-only), `nextStepOf`, `inputModeFor` (typed as the contract's `InputModeFor`), `staticInputMode` (T-D1-4 fallback), `vaSessionCapMs` (typed `VaSessionCapMs`), `DEFAULT_VA_CAP_ENV`, and the §5.8/§5.9.5 timing helpers `advanceHoldDeadline`, `holdTimedOut`, `reassuranceDue`, `wrapUpDue`, `absoluteCeilingReached`, `onPaymentSucceeded` |
| `compiler/first-update.ts` | `buildFirstUpdate`, `validateFirstUpdate` (the contract's `ValidateFirstUpdate`; throws `BatonError("E_VA_CONFIG")`), `firstUpdateErrors`, `checkToolSchema` |
| `compiler/greeting.ts` | `compileGreeting` → `{text, wordCount, asserted, asks, confirms, nextStep, dropped}`, `compileGreetingV1`, `assertGreetingInvariant` |
| `compiler/prompt.ts` | `PROMPT_V3`, `STAGE_INSTRUCTIONS`, `PAY_PUSH_INSTRUCTIONS`, `PROMPT_VERSION`, `compilePrompt(state, policy, stage, {deployId, payToolMode})` → **string**, `caseStateJson`, `deployMarkerOf`/`deployMarkerLine` |
| `compiler/compile.ts` | `compileTakeover(snapshot, policy, {deployId, voice, keytermsEnabled, capEnv, compiledBy, payToolMode, stage})` → `CompiledTakeover` (validates its own first update), `keytermsFor` |
| `compiler/disclosures.ts` | `disclosureText(kind, ctx, {taxSuffix})` → `{text, criticalTokens}`, `resolvePremium`, `resolveDueToday`, `TAX_SUFFIX` |
| `compiler/suggest.ts` | `suggestReplies(ctx)` (the loop breaker and the "Try this" chip included), `classifyAgentText` (WP11 calls its luna fallback when `kind==="request"` has no field), `answerFor`, `truthSpoken`, `explicitStatement` |
| `compiler/spoken.ts` | `spokenDate`, `spokenDateLong`, `spokenDob`, `spokenMoney`, `spokenMonthly`, `spokenZip`, `spokenChars`, `stateName`, `ordinal` |
| `qa/*` | `computeQa(QaInput)` → `QaResult`, `verbatimCheck`, `verbatimSimilarity`, `isRequest`, `targetedFields`, `classifySentence`, `valueBearing`, `norm`/`normTokens`, `splitSentences` |
| `evidence/clip.ts` | `clipWindow(ev, turn, "stream" \| "async", durationMs)` |

Barrels: `src/core/case/index.ts`, `src/core/compiler/index.ts` and `src/core/qa/index.ts`.

## Acceptance (TASKS WP1)

| Item | Status | Evidence |
|---|---|---|
| Every DESIGN §9.1 case for normalizers, status rules, greeting, prompt, stage tools, first update, input mode, dynamic cap and hold, re-ask, verbatim and evidence | PASS | `tests/unit/core/{intents,case,compiler,qa,evidence}/**` (see "Test map" below) |
| Property test: 500 random states; the greeting asserts only VERIFIED values plus at most one PENDING confirm value | PASS | `greeting.test.ts`: a seeded PRNG over 2 policies. It checks structure (`asserted` ⊆ VERIFIED, `confirms` = the first PENDING in priority order) and text (no spoken form of any other non-VERIFIED value appears). It also checks the disclosure regexes, ≤ 70 words and determinism |
| `validateFirstUpdate(buildFirstUpdate(compile(s)))` for s01/s02/s05 in both initial stages | PASS | `first-update.test.ts`: 12 combinations (3 scenarios × {confirm, disclose} × keyterms {off, on}) |
| …equal to WP5b's T-D1-0 fixtures (shape) | **PENDING: needs WP5b.** Their `scripts/day1/fixtures/first-update-*.json` do not exist in this worktree | The shape test already runs when those files exist. The compiler's own fixtures are committed in `tests/unit/core/compiler/__fixtures__/` (see `requests/wp1-to-wp5b.md`) |
| Scenario fixtures s01/s02/s05 give `expectedAtHandoff`; greeting snapshots committed | PASS | `scenarios.test.ts` sends a synthetic talk-track call through raw patch → `applyExtraction` → `deriveCaseState`. All 22 scenarios reproduce every designed status (0 mismatches after decision 1). The derived greeting equals the one from the designer's state. Snapshots: `__snapshots__/greeting.test.ts.snap` (6 canonical states) |
| ≥ 90% line coverage on `src/core/case` and `src/core/compiler` | PASS (measured with a scratch V8 collector; the official `--coverage` needs a dependency, see `requests/wp1-to-integrator.md`) | Istanbul-style lines: case **100%** (866/866), compiler **99.9%** (772/773). Strict (every mapped segment on the line ran): case 97.5%, compiler 96.9% |
| Early deliverable: `tool-schemas.ts`, `stages.ts`, `first-update.ts`, `greeting.ts` | PASS | First commit on the branch (`7f57372`), before the rest of the WP |

## Decisions (and where WP1 departs from DESIGN; also listed for the planner in `requests/wp1-to-integrator.md`)

1. **Effective-date window: 90 days, not 60 (§5.4.1).**
   - The kit's s07 has a VERIFIED start date 84 days out, and a 60-day guard made the pipeline disagree with its own
     labels.
   - The window is the `EFFECTIVE_DATE_MAX_DAYS` constant.
   - The 30-day guardrail in `confirm_effective_date` (§5.8) is WP6's and is unaffected.
2. **Readiness.** The premium (SERVER_RESOLVABLE) never blocks `ready`, even when it is PENDING (for example, a premium
   the customer stated is a `rep_only_violation`). The AI cannot ask for it or set it, and the disclosure uses the
   rating tool.
3. **Dynamic cap.** `open` = required fields that are not VERIFIED, **minus the premium**. So s01 → 150 s,
   s02/s05 → 165 s, and an empty case → 285 s. The 420 s maximum is reachable only with a custom environment.
4. **`deriveField`.**
   - It follows the §5.4.2 pseudo-code, plus the explicit "conflict only (keep cur)" branch: a different value against
     a confirmed value from the other party records a conflict.
   - A `tool_update` that replaces a confirmed, incompatible value flags `customer_corrected_verified` and emits an
     unresolved conflict card with the resolution `ai_recorded_customer_correction`. This keeps the tool event
     encoding G0-compatible; no new FactEvent field is needed.
   - A value the AI confirmed stays as it is when a later human statement disagrees.
5. **Late rule.** `isLate(e) = e.late || (tArmMs !== null && e is a human event && e.turnEndMs > tArmMs)`, so
   `recompute(caseId, {tArmMs})` works even for events stored before the turn was marked late.
6. **Verifier overlay.** `ctx.verifier` (the latest `VerifierResult`) is preferred. The fallback is the verifier
   events with the largest `turnEndMs`, which is the latest run.
   - Why: F2 inserts events for disagreements only, so an agreeing newer run inserts nothing and would otherwise
     leave an old disagreement standing.
   - Sol never upgrades a field. For a field luna left MISSING, it only fills `verifier_only` PENDING.
7. **Age rule (§5.4.1).**
   - A VERIFIED DOB implies the age: a MISSING age becomes VERIFIED with the computed value, and a consistent
     stated-once age is upgraded.
   - An inconsistent DOB and age → both PENDING (`conflict`) with a card, unless one of them was confirmed by the AI.
   - This makes the kit's `driver_age: VERIFIED` labels reproducible.
8. **Greeting.**
   - Without a VERIFIED name, the text reads "add a new driver on the {vehicle}", not "add a new driver as a driver
     on…".
   - `{d}` and `{label}` inside confirm and ask phrases come only from VERIFIED values ("the new driver", "the car").
   - The premium clause needs `status VERIFIED ∧ source "rep"`.
   - The DESIGN s02 example elides the premium clause, but its rules include it. WP1 follows the rules:
     s02 → "…on the 2014 Toyota Corolla, at $171 a month."
9. **QA lexicon: strong and weak patterns.** Generic words ("car", "vehicle", "license", "name") count only when no
   specific pattern matched. So "What's the ZIP code where the car is kept?" targets only `garaging_zip` and cannot
   inflate the headline re-ask count.
10. **QA sentence split.** A trailing tag question ("Is that right?") is merged into the sentence before it, so the
    greeting's own confirm counts as `pendingConfirmed` (§5.13 step 2).
11. **QA `norm`.**
    - "dollars and N cents" → "dollars N cents", so "$34.10" ≡ "thirty-four dollars and ten cents".
    - "oh" next to a digit → 0.
    - Disclosure spans come from the best verbatim window. A sentence is excluded when at least half of its tokens
      fall inside that window.
12. **Evidence alignment (§5.3 step 5).**
    - The LCS ratio = LCS/|quote| over windows of |quote|·0.8 … |quote|+2 tokens; the shortest best window wins.
    - Char spans map to words exactly when the token counts agree, and proportionally otherwise.
    - The evidence quote is the matched span of the transcript. In the fallback it is the model's quote, cut to 200
      chars.
13. **`applyExtraction` ids** default to `${caseId}:${turnId}:${index}`, which is deterministic; an injectable `newId`
    overrides them.
14. **v1 pipeline (§6.4).**
    - `deriveV1`: the latest non-null value is VERIFIED with reason `stated_once`, the most honest member of the frozen
      reason enum.
    - `compileGreetingV1` asserts every known value, plus a recap sentence of the other known priority fields.
15. **Suggested replies.**
    - A confirm question's value is recovered from the sentence, either as a spoken form of the snapshot or truth
      value, or with the normalizer for extractable kinds, so "ZIP 4 4 1 0 8, right?" gets "No, it's 4 4 1 0 7."
    - A sentence listing alternatives ("… or …") is an open ask.
16. **`SYSTEM_PROMPT_MAX_CHARS = 8000`** in the whitelist. It is not measured live; compiled prompts are 3.48k–3.57k
    chars.
17. **`PROMPT_VERSION`** = sha256(template + stage instructions + push instructions)[0:8], marker excluded. The
    extractor version = sha256(prompt + schema JSON + model + effort)[0:12].

## Day-1 tests

WP1 owns no live Day-1 test. **T-D1-0** (WP5b) consumes WP1's first updates. The fixtures are committed and the
validator already rejects every §9.1 case: a hold tool, a `format`/`oneOf`/`$ref` keyword, keyterms with the flag
off, more than 100 keyterms, a 51-char keyterm, an unknown voice, an unknown `input`/`output`/`session` key, and a
null greeting. Result: **needs another WP (WP5b, live)**.

## Measured numbers (this worktree, Windows 11, Node 22.23.2)

| What | Number |
|---|---|
| WP1 unit tests | 154 in 14 files; the full suite (426) runs in ≈1.6 s |
| Property test | 500 random states, 0 violations |
| Scenario status reproduction (synthetic talk-track calls through apply + derive) | 22/22 scenarios, every designed fact status reproduced |
| `compileTakeover` (greeting + prompt + tools + validation) | ≈0.07 ms per call |
| `deriveCaseState` over 300 events | ≈0.10 ms |
| `computeQa`, 40 agent utterances + 1 disclosure | ≈11 ms |
| Compiled system prompt | s01 3539 (confirm) / 3573 (disclose) chars; s02 3481 / 3515. Template alone < 3500 |
| First `session.update` JSON | 6.1–6.5 KB |
| Greeting word counts | s01 69, s02 65, s05 67 (cap 70) |
| Coverage | See the acceptance table. Measured by a scratch vitest config: a setup file starts `Profiler.startPreciseCoverage` at module load, then the V8 block ranges are mapped through vite's inline source maps to source lines and merged across the 14 test files. Line semantics = istanbul's (a line is covered if any statement on it ran). Nothing in the repo was changed for it |

## Known gaps

- **Official coverage report.** It needs `@vitest/coverage-v8@5.0.1` (a request to the integrator). The numbers above
  come from the scratch collector.
- **WP5b shape parity.** It runs automatically once `scripts/day1/fixtures/first-update-{confirm,disclose}.json` are
  merged.
- **Normalizer coverage of real speech is unmeasured.** It is tested on the kit truth values (all 22 scenarios) and on
  hand-written phrasings, not on real STT output. WP9's K1/extraction caches will show the misses.
  - Known weak spots: prices spoken without "dollars" ("one forty-two"); state codes said as words ("O H");
    relations like "friend" with no residence cue (these deliberately return null).
- **`suggestReplies`** uses generic relation words ("Maya is my child"), because the normalized truth has no
  gendered form. WP11's tail pack or TTS can override the phrasing.
- **`resolveRelativeDate`**: "this Friday" said on a Friday means today. A bare weekday means the next one.
  "next Friday" means the Friday of the following Monday-start week (on Friday 9/25 that is 10/2).
- **`computeQa`** uses only the sentence start time (the utterance's first word) for the disclosure window, not
  per-token times.

## What the integrator wires at G1 / G2

1. **G1: merge `wp/wp1` first.** WP5, WP5b, WP6, WP3 and WP9b import from it. No DB, env or route changes. No new
   dependency is required to build or test.
2. **WP5 (`TakeoverService.compile`).**
   - `compileTakeover(frozenSnapshot, policy, {deployId: env BATON_DEPLOY_ID, voice: env VA_VOICE, keytermsEnabled: env VA_KEYTERMS === "1", capEnv: {baseMs, perFieldMs, maxMs} from env, payToolMode: env PAY_TOOL_MODE, compiledBy: "server"})`.
   - The client fallback compile uses the same function with `compiledBy: "client"`.
   - Store `promptVersion`, `vaSessionCapMs`, `greeting` and the prompt hash on the takeover.
3. **WP5b.** Call `validateFirstUpdate(msg, {keytermsEnabled})` right before sending, and `buildFirstUpdate(compiled)`
   for the message. Re-run T-D1-0 with the committed fixtures.
4. **WP3.**
   - `applyExtraction` after `extractTurn`.
   - `deriveCaseState(policy, eventsWithSeq, {caseId, version, tArmMs, verifier: latestVerifierResult, stage, disclosuresGiven, payment, confirmationNumber})`
     in `applyEvents`/`recompute`/`freezeSnapshot`.
   - `verifierDisagreementEvents` for F2. Prompts, format, input builder and version come from `case/extractor.ts`.
     See `requests/wp1-to-wp3.md`.
5. **WP6.** Tool handlers use `resolveRelativeDate`, `normalizeField`, `compatible`, `toolUpdateEvent`, `nextStage`,
   `toolsForStage`, `compilePrompt` (returns a string), `inputModeFor`, `disclosureText`, `resolvePremium` and
   `resolveDueToday` (see `requests/wp1-to-wp6.md`).
6. **G2 and later.**
   - WP8: `computeQa` with `disclosures` = `takeovers.metrics.disclosures[kind]` (`{text, criticalTokens}`) plus the
     `get_disclosure` result time.
   - WP9b: `deriveCaseState` with `rules` for v2 (`{lateCut:false}`) and the verifier-off ablation
     (`{verifierOverlay:false}`); `deriveV1`; `compileGreeting(V1).asserted`.
   - WP11: `suggestReplies` and `classifyAgentText`.
   - WP7: `clipWindow`.

## Test map (`tests/unit/core/**`)

- `intents/add-driver.test.ts`: dates ("this Friday" from Monday 2026-09-28 → 10-02, and more); money ($142 /
  "142 dollars" / "14200 cents" / words, signed changes); ZIP; relation synonyms; vehicle matching (unique model,
  ambiguous → null); name subset compatibility; every other kind; displays; the phrase table; the lexicon; spoken
  forms.
- `case/status-rules.test.ts`: the §9.1 status table (stated once, cross-party ack, same-party ack, read-back,
  conflict + card, corrected, denied, late/cut, verifier downgrade-only and `verifier_only`, rep-only premium,
  `tool_update`, policy, out-of-range, determinism by seq), readiness, the age rule, `deriveV1`.
- `case/apply.test.ts`, `case/scenarios.test.ts`, `case/utils.test.ts`, `case/barrels.test.ts`.
- `compiler/greeting.test.ts` (examples, rules, 6 snapshots, the 500-state property test, v1),
  `tool-schemas.test.ts`, `first-update.test.ts`, `stages.test.ts` (input mode, stages, cap, wrap-up, hold,
  reassurance, late success), `prompt-disclosures.test.ts`, `suggest.test.ts`.
- `qa/qa.test.ts`: re-ask of a VERIFIED ZIP = 1, confirm with value = `verified_reconfirm`, greeting confirm =
  `pending_confirm`, disclosure spans excluded, distinct-field counting, exact = 1.0, paraphrase < 0.9, number words
  ≡ digits, a missing critical token → not ok.
- `evidence/clip.test.ts`: edge-word rules, minimum and maximum lengths, clamps.
