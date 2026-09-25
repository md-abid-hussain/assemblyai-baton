# WP14a notes: blueprint schema, kernel and Baton parity

## WP14a·1: contracts v2 (C2), template grammar, lint skeleton (D1 Fri Sep 25, 09:55–10:40 IST)

Branch `wp/wp14a` (worktree `.wt/wp14a`), based on `main` = `458fe18` (the merge of `main` was a no-op).

| Commit | What |
|---|---|
| **`f341a9f` wp14a: C2 contracts v2 …** | **The C2 commit. Merge it alone.** `src/core/contracts/v2/**` plus its tests (`tests/unit/core/relay/{regex,contracts-v2}.test.ts`, `fixtures/mini-blueprint.ts`). Touches nothing outside WP14a's paths |
| `f4fe822` wp14a: template parser/renderer and lint skeleton | `src/core/relay/{template,lint}.ts` plus tests. Not needed for C2; merge whenever convenient |

### Done

- **`src/core/contracts/v2/`** (barrel `@/core/contracts/v2`; deliberately not re-exported from the v1 barrel, because `StageSchema` and `TRANSCRIPTION_MODES` exist in both):
  - `blueprint.ts`: P§3.2 v2.1 copied line for line (only a header comment added). Includes `customer.address`, nullable secret refs (`http_action` header values and `hmacSecret`, `completion_webhook.hmacSecret`), `GreetingSchema.maxWords` 20–40, `RegexSchema` refine and `ToolPatternSchema`.
  - `regex.ts`: the safe grammar (`checkRegexGrammar`, `checkSafeRegexSource`/`checkSafeToolPattern` returning the reason and the offending group, `isSafeRegexSource`, `isSafeToolPattern`), `safeTest`/`safeExec` (flags `iu`, LRU 500, input clipped to 1000 chars; an unsafe source never compiles and returns false), `safeTestToolPattern` (no flags), `compileSafeRegex` and `compileSafeUnion` (for `IntentSpec.adviceRe`).
  - `relay.ts`: `IntentSpec`, `PhraseScope`, `UiSpec`/`UiSpecSchema`, `CompiledListening`/schema, `LintIssue`/schema, `LINT_CODES`; plus shared vocabularies (`BUILTIN_TOOL_NAMES`, `REQUIRED_STAGE_TOOLS`, `CONNECTOR_TYPES`, `STAGE_KIND_ORDER`, `STAGE_KIND_TO_STAGE` with act → pay, `CANNED_STATES`, `SECONDS_PER_WORD`, `StoredAccountSchema` with the `"$kind":"account"` marker); and the generic `GreetingResult`, `DisclosureText` and `CompileTakeoverOptions` that `CompiledRelay` returns.
  - `services.ts`: TASKS-v2 §5 verbatim (types only), plus the C2 additions marked in the file (see Decisions).
  - `api.ts`: `QUOTA_BUCKETS` (all 11 P§10.2 names, including `sim:dryrun` and `greeting:hear`), `CHANGEOVER_DEMO_ECHO_SECRET`, `CONNECTOR_HEADERS`/`HMAC_WINDOW_SEC`, `ID_PREFIXES`, `GALLERY_WORKSPACE`, `RELAY_ENGINES`, `CONSOLE_MODES`, `V2_ROUTES` (every new route; **the one state route** is `V2_ROUTES.publicationRunState` + `PublishedRunStateSchema`), `V2_ERROR_CODES` with statuses and `ApiErrorV2Schema`, `ProvenanceStripSchema`, and zod for every route in TASKS-v2 §5: relays (list, create, update, draft save/conflict, versions, compiled view); drafts (async `DraftView`, `DeskInput`); sim calls (`kind: audio | text_dry_run`, `SimScriptSchema`, `TextDryRunResultSchema`, `SimCallViewSchema`); connectors test/echo/request body; secrets; publish; publication page; gateway response (`next_step`); analytics. It also has the additive v1 extensions: `CreateCaseRequestV2Schema`, `CreateCaseResponseV2Schema`, `StatusResponseV2Schema` (`nextLiveAt`), and `ToolResponseV2Schema` (`nextStep`, generic tool names, `ui.esignId`).
- **`src/core/relay/template.ts`**: the P§3.3 grammar. `parseTemplate` (throws `TemplateSyntaxError` with the offset) and `tryParseTemplate`; `printTemplate` (exact round-trip); `renderTemplate(nodes, scope)` (pure; the scope resolves paths, tests conditions and applies formatters); `templateVars` (each var with its enclosing guards), `templateConds`, `templateRefs`, `templateDepth`; `parseTemplatePath` (also used for `from` paths).
- **`src/core/relay/lint.ts`** skeleton: `lintBlueprint` covers L1, L2, L3, G1, C1, S1 and X3. `lintBlueprintJson(json)` maps zod issues to `SCHEMA`, or to `X3` (naming the group) for a regex refinement. Also `blueprintTemplates`, `blueprintRegexes`, `TYPE_NORMALIZERS`, `sampleOpeningScope`, `hasLintErrors`, `LINT_RULES_IMPLEMENTED`/`LINT_RULES_PENDING`.

### Decisions (C2 contract calls; please object via a request file before WP14b/15/16/17 build on them)

1. **Regex grammar:** `{n}` with n > 1 counts as `{n,n}`, a repeating quantifier, so `(ab+){2}` is rejected. "Contains a quantifier" includes `?` at any depth, so `(an? )+` is rejected but `(an? )?` passes. Only `(`, `(?:` and `(?<name>` groups are allowed; `(?i:…)` modifiers are rejected. Polynomial patterns such as `\s*\s*$` pass the grammar; the V8 backstop (WP12) and the 1000-char clip cover them.
2. **Generic result types:** `GreetingResult`, `DisclosureText` and `CompileTakeoverOptions` in v2 are string-keyed supersets of the legacy compiler types. The legacy values are assignable to them (pinned by type tests), so the Baton kernel can return legacy results unchanged. `DisclosureText.kind` is the blueprint disclosure id. `GreetingResult.dropped` holds clause ids (Baton's clause ids must be `date` and `vehicle`, with `dropOrder` 0 and 1).
3. **services.ts additions:**
   - `RelayRegistry.setVisibility` backs `PUT /api/relays/:id`. That route changes only `private`/`unlisted`; everything else lives in the draft.
   - `RelayToolService`, `RelayToolContext` (`callId` nullable on the published gateway) and `RelayToolOutcome` (= `ToolOutcome` + `nextStep` + `ui.esignId`). They carry `nextStep` now; the §4.7 widening later adds `nextStep` to v1 `ToolOutcome` itself.
   - `SimCallView` and `RelayAnalyticsView` are `z.infer` of their route schemas.
4. **`CreateCaseResponseV2`:** `policy` becomes nullable (null for non-Baton relays), and `account: AccountRecord` is added next to `relay`, `listening`, `simulated` and `provenance`.
5. **Drafts:** `saveDraft` never stores a body that fails `BlueprintSchema`: 422 `E_LINT` with `SCHEMA`/`X3` issues, rev unchanged. So `RelayDetail.draft` is always a `Blueprint`.
6. **`sim_script`** is stored in luna's snake_case shape (`left_for_ai`, `ai_half_answers`, …). `CreateSimCallRequest.kind` defaults to `"audio"`.
7. **Template paths:**
   - Beyond P§3.3, the grammar also accepts `roles.rep|customer|org` and `persona.tone`, which the P§4.4/§5 kernel prompts use; only `promptTemplate` (and `roles` in stage goals) may use them.
   - Allowed paths depend on the site: `{clause.*}` only in `greeting.summary`, `{phrase.confirm}`/`{phrase.ask}` only in `greeting.next.confirm`/`.ask`, and `{case.json}`/`{stage}` only in `promptTemplate`.
   - The only `opt.` id is `tax_suffix`.
   - There is no `{arg.*}` path for `sms_mock` templates yet; WP16 can request one (additive).
8. **G1 scope:** besides `summary` and `clauses`, G1 also checks `opening`, `optOut` and `playbook.subject`, because the greeting embeds the subject. `greeting.next.*` may not name a field directly. A guard is `{?f.X.verified}` or `{?f.X.rep}` (then branch), or the `{:}` branch of the negated form.
9. **L1** treats the ids of fields, stages, disclosures, connectors, values and tables as ONE namespace, and tool names as another (built-ins, `confirmTool` names, connector tool names).
10. **Boundary (TASKS-v2 §2 rule 10):**
    - `tests/unit/core/relay/boundaries-regex.test.ts` bans any `new RegExp(`/`RegExp(` in `src/core/relay`, `src/core/contracts/v2` (except `regex.ts`) **and in the future blueprint-handling dirs of other WPs**: `src/server/{relays,engine,connectors,draft,sim,publish,analytics}`, `src/components/studio` and `src/client/studio`. A non-blueprint dynamic regex there needs a request to WP14a.
    - Kernel code uses regex literals.

### Tests

- Typecheck clean. **`npm test`: 66 files, 896/896** (baseline 805 at `f341a9f` → +91 from `f4fe822`).
- `regex.test.ts`: 21 must-fail cases (the P§3.2 fixtures `(a|a)*$`, `(a+)+$`, `(a|ab)*c`, `(\w+\s?)*$`, `\1`, `(?=a)`, plus lookbehind, `\k<…>`, `{2,}`/`{1,3}`/`{2}` on complex groups, nested groups, `(?i:`, unbalanced input) and 17 must-pass cases. Every legacy Baton pattern passes (`FIELD_LEXICON`, `ADVICE_RE`, `GREETING_DISCLOSURE_RES`). Also covered: iu vs no-flag compile, the 1000-char clip, the LRU bound, no catastrophic run, and `compileSafeUnion`.
- `contracts-v2.test.ts`: the mini fixture parses; each v2.1 item has a test; vocabularies equal v1 (`HAND_BACK_REASONS`, `TRANSCRIPTION_MODES`, stages, connector types); and type-level checks that the route schemas produce the service interfaces and that the legacy compiler types are assignable to the v2 ones.
- `template.test.ts`: 13 round-trips, 13 syntax errors (unknown path, bad formatter, lone `}`, unclosed section, two `{:}`, depth 4, …), rendering and reference extraction.
- `lint.test.ts`: the clean mini fixture plus **46 fail fixtures**, each making exactly one rule fire (L1 ×4, L2 ×7, L3 ×18, G1 ×5, C1 ×2, S1 ×6, X3 ×4). Also: G1 guard variants, C1 on the first sample, `lintBlueprintJson` → `X3`/`SCHEMA`, and **a G1 property test over 500 seeded random snapshots** (a G1-clean greeting never renders a non-VERIFIED field value).
- `boundaries-regex.test.ts`: no string-built RegExp outside `regex.ts`; `src/core/relay` has no Node, DOM, server or client imports; scanner self-test.

### Live spend

$0. No AssemblyAI or OpenAI calls, no Zerops access.

### What the integrator must do

1. **C2:** merge **`f341a9f` alone** into `main` (e.g. `git merge --no-ff f341a9f`) and run the typecheck. It adds files only. WP14b, WP15, WP16 and WP17 branch from that merge.
2. `f4fe822` (template + lint skeleton) can follow with the next WP14a merge. It is not needed by the other WPs at C2, but WP15's editor will import `lintBlueprintJson` and `parseTemplate`.

### Known gaps for later units (no action now)

- Until the §4.7 widening (WP14a·4), v1 `VaFunctionTool.name`, `CaseStateSchema.fields` (keys) and `CaseStateSchema.intent` (literal `"add_driver"`) are Baton-only. `CompiledRelay.tools()` and `takeover()` are typed against them per the spec, so generic relays need a cast until then. The v2 route schemas already use `VaFunctionToolV2Schema`. **WP14a·4 must also widen `CaseStateSchema.intent`**, which P§4.7 does not list.
- Rendering the C1 opening uses only the plain formatters (`raw`, `title`, `first_name`, `lower`; the others fall back to raw) until `relay/formatters.ts` lands in WP14a·2.

### Where WP14a·2 starts

1. `git merge main` (after C2 lands).
2. **First, the legacy greeting:** shorten Baton's greeting to ≤ 40 words (opening ≤ 14 words with "AI assistant", "not a person" and "recorded"; the facts; the one PENDING question). Lower `GREETING_MAX_WORDS` in `src/core/compiler/greeting.ts`, update WP1's greeting tests, and close `docs/notes/requests/wp5b-to-wp1.md`.
3. Then `formatters.ts` (the renderer's `format` for `RenderScope`), `normalizers.ts`, `spec.ts`, `compile.ts`, `extractor.ts`, `prompt-default.ts`, `account.ts` and `migrate.ts` (`migrateBlueprint`, `blueprintHash`, `canonicalJson`), in `src/core/relay/`.
4. `data/relays/baton-add-driver.json`: the clause ids must be `date` and `vehicle`. `handoff.repLine` = the line s01 was recorded with (ask WP9 or the user after 14:30).
5. Then `scripts/relay/snapshot-legacy.ts` and the parity fixtures.

Lint `TYPE_NORMALIZERS` already admits Baton's kinds (incidents → text/`insurance.incidents`, vehicle → lookup/`insurance.vehicle`, age → integer/`insurance.age`, relation/license status/discounts → enum/`insurance.*`).

## WP14a·2: kernel compilers, Baton JSON, ≤ 40-word greeting, recorded rep line, compile parity (D1 Fri Sep 25)

Branch `wp/wp14a`; `git merge main` was a no-op (main = `175a6b7`, C2 already in). The unit was interrupted by a usage limit once; the resumed run committed the pending kernel tests and finished.

| Commit | What |
|---|---|
| `bbe308f` | **Legacy greeting ≤ 40 words first** (before the oracle), push-mode pay texts; closes `requests/wp5b-to-wp1.md` (resolution section in that file). WP1's greeting tests and first-update fixtures updated |
| `9d69c50` | Kernel modules in `src/core/relay/`: `formatters`, `normalizers`, `spec` (`buildIntentSpec`), `scope`, `extractor`, `prompt-default`, `safety`, `account`, `migrate`, `compile` |
| `0219b2b` | `data/relays/baton-add-driver.json`, the oracle `scripts/relay/{snapshot-legacy,parity-corpus}.ts`, `tests/fixtures/relay-parity/baton/*.json`, `parity-baton.test.ts` |
| `839615d` | `kernel.test.ts` (generic relay = the mini dental fixture); the greeting now counts `{subject}`'s VERIFIED field as asserted |
| `5a7a63e`, `8b43695` | `repLinePatterns` cover every scripted handoff line; WP14b's `blueprintHash` vector pinned; the Baton JSON has no keys zod strips |

### Done

- **Legacy greeting (P§3.4 G2):** 13-word opening ("Hi Priya, I'm Daniel's AI assistant, not a person. This call is recorded."), the facts ("I'll finish adding Maya to the 2021 Honda Civic, starting …, at $142 a month."), "Ask for Daniel anytime.", one next step. Over 40 words the clauses drop date → vehicle → premium. s01 = 39 words, s02 = 40.
- **Kernel** (`compileRelay(bp, { flagship?, versionId?, relayId? })` → `CompiledRelay`; `compileRelayTakeover`): greeting (clauses, `dropOrder`, `asserted` tracked through VERIFIED/REP guards and `{subject}`), case JSON (legacy cap order), prompt (flagship: the Baton text; otherwise the generated default or `promptTemplate`, **always with the safety block** before the deploy marker), tools per stage (built-ins + `confirmTool` + connector tools), disclosures, named values, `nextStage`, extractor (generated field guide, strict format, input builder, `assertStrictSchema`), listening, `UiSpec`, first update (`validateFirstUpdate` gained an optional `toolNames`). `normalizers.ts` wraps the unchanged legacy `insurance.*` functions (now exported from `add-driver.ts`); `account.ts` has `policyToAccount`, `storedAccount`, `accountFromStored`; `migrate.ts` has `canonicalJson`, `blueprintHash`, `hash8`, `migrateBlueprint`.
- **Baton JSON:** clause ids `date`, `vehicle`, `premium` (dropOrder 0/1/2). `handoff.repLine` = **"OK if my assistant finishes the paperwork? I'll be one tap away if you need me."** (the s01 recording line). `repLinePatterns` = `\b(finish|finishes|wrap|wraps) (up )?the paperwork\b` and `\b(one tap away|stay on the line)\b`: they detect the recorded line, the older "stay on the line" wording and all 22 scenario handoff lines (s02 "wraps up …", s06 "finishes up …"), tested through `safeTest`.
- **Parity (P§4.6, T2 scope), 0 diffs:** 17 named snapshots (s01/s02/s05 × 3 pass points, 4 canned, 4 WP1 states) with full texts, 200 seeded random snapshots (sha for prompts/disclosures), 300 phrases, 609 normalize inputs, 21 extractor inputs. Covered: `GreetingResult` deep-equal, ≤ 40 words and the first fact by word 24 (acceptance 6); case JSON; prompts at every stage (push mode + deploy marker); tools; first `session.update` (confirm, disclose); takeover; `nextStage` table; disclosures × tax suffix; values; extractor prompt/format/**`EXTRACTOR_VERSION_V3`**; normalize/display/spoken forms; phrases; keyterms for 22 scenarios. Listed difference: `promptVersion = relay:<hash8>`. `npx tsx scripts/relay/snapshot-legacy.ts --check` → "oracle up to date".
- Node timing: `BlueprintSchema.parse` + `compileRelay(baton)` p50 0.9 ms (first call 26 ms); the Chromium benchmark stays in T4.

### Decisions (additive v2 changes after C2; consumers with exhaustive switches must handle them)

1. `FORMATTERS` gains `as_spoken` (the spoken words when known, else the value).
2. `FieldSchema.setBy` gains `rep_or_customer`: either party counts, but the field is not in the `update_case_field` enum (Baton: age, start date, discounts, coverage).
3. The greeting's `asserted` includes a field stated through `{subject}` (the mini dental greeting asserts `treatment`, `patient_name`).
4. Lint L3 accepts the P§5 context paths `table.<id>` and `table.<id>.<col>`; lint C1 renders with the kernel formatters.

### Tests

Typecheck clean. `npm test`: 68 files, **810 passed, 124 skipped, 0 failed with `SKIP_DB_TESTS=1`**. Without the flag, the 16 real-Postgres suites (server/cases, limits, jobs, registry, runs, verify) fail with `ECONNREFUSED 127.0.0.1:55432`: Docker Desktop is not running here, so the `baton-pg` container is down. This is environmental and none of those suites touch WP14a paths. `tests/unit/core/relay`: 7 files, 193 tests.

### Live spend

$0 (no AssemblyAI, OpenAI or Zerops calls).

### Requests to WP14a picked up for WP14a·3

- `wp14b-to-wp14a.md`: §1 **done** (vector pinned in `kernel.test.ts`; same definition); §2 **done** (no stripped keys, tested); §3 signatures kept: `lintBlueprintJson(json) → { blueprint, issues }`, `blueprintHash(bp) → string`; §4 the blank relay goes through full lint in T3.
- `wp16-to-wp14a.md`: `validateToolArgs` with WP16's signature and semantics, the `lookup_table` parser moved into `src/core/relay/`, lint mirrors of the header/URL refusals, and the P§4.4 tool-result fixture: all T3/T4.

### What the integrator must do

Merge `wp/wp14a` with `--no-ff` whenever convenient (not a G2 exit criterion). After the merge, WP14b·2 swaps its kernel port to `lintBlueprintJson` + `blueprintHash`. Re-run `npx tsx scripts/relay/snapshot-legacy.ts --check` on merged main.

### Where WP14a·3 starts

The optional trailing `spec?: IntentSpec` parameters (§2 rule 9), `LEGACY_BATON_SPEC`, `brand-denylist.ts`, the full P§4.6 corpus (QA, derive), the remaining lint rules (C2, S2, S3, F1, F2, X1, X2, G2, W3, B1, K1, K2, W2), then the WP16 requests above.
