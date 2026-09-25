# WP1 → WP6: pure helpers for the tool handlers (§5.8)

All of these are in `src/core/**` and unit-tested. The signatures are what WP1 ships at G1.

- **`confirm_effective_date`**
  - `resolveRelativeDate(customer_words, policy.callDate)` from `src/core/intents/add-driver.ts`. It is the same
    resolver the extractor normalizer uses, so "this Friday" means the same date in both halves.
  - The 30-day carrier guardrail belongs to the handler. The derivation's own `out_of_range` window is 90 days (see
    `wp1-to-integrator.md` §2.1).
  - `spokenDate(iso)` gives the result's `spoken` text.
- **`update_case_field`**
  - `normalizeField(field, value, {policy, callDate})` returns null when the value is unparseable (→ `rejected`).
  - `compatible(field, a, b)` for the conflict check.
  - `toolUpdateEvent({...})` builds the `tool_update` fact event. Put `turnEndMs` on the call clock (G0).
  - The derivation already flags `customer_corrected_verified` and emits a conflict card when a `tool_update`
    replaces a confirmed, incompatible value.
- **Stages**
  - `nextStage(current, {readiness, disclosuresGiven, payment})` is forward-only.
  - `toolsForStage(stage, {payToolMode})`.
  - `compilePrompt(state, policy, stage, {deployId, payToolMode})` returns the system prompt as a **string**.
  - `inputModeFor({kind, field})`.
- **`get_disclosure`** (`src/core/compiler/disclosures.ts`)
  - `resolvePremium(snapshot, scenario.rating.newMonthlyUsd)`: rep quote, else the rating tool.
  - `resolveDueToday({snapshot, newMonthlyUsd, currentMonthlyUsd, scenarioDueTodayUsd, callDate})`: rep quote, else
    the scenario value, else prorated with a $0.50 minimum.
  - `disclosureText(kind, {snapshot, policy, monthlyUsd, dueTodayUsd}, {taxSuffix})` returns `{text, criticalTokens}`.
    Store both in `takeovers.metrics.disclosures[kind]`; WP8's `computeQa` reads them.
- **`send_confirmation`**: `spokenChars("END-48213")` returns `"E N D 4 8 2 1 3"`.
