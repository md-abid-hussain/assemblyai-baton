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

Merge **`27ec817`** (the WP14a·2 tip, not the branch head; see "Resume check" below) with `--no-ff` whenever convenient (not a G2 exit criterion). After the merge, WP14b·2 swaps its kernel port to `lintBlueprintJson` + `blueprintHash`. Re-run `npx tsx scripts/relay/snapshot-legacy.ts --check` on merged main.

### Where WP14a·3 starts

The optional trailing `spec?: IntentSpec` parameters (§2 rule 9), `LEGACY_BATON_SPEC`, `brand-denylist.ts`, the full P§4.6 corpus (QA, derive), the remaining lint rules (C2, S2, S3, F1, F2, X1, X2, G2, W3, B1, K1, K2, W2), then the WP16 requests above.

### Resume check (D1 14:55, after the usage-limit interruption)

- Worktree clean on arrival; `main` (`175a6b7`) is already an ancestor, so `git merge main` is a no-op. WP14a·2 was complete at **`27ec817`**.
- The interrupted run had already started WP14a·3 and left three committed, self-contained T3 commits on top: `63b3636` (optional trailing `spec?: IntentSpec` on the WP1 core functions, `LEGACY_BATON_SPEC` in `src/core/intents/baton-legacy-spec.ts`, `relay/spec-link.ts`, `accountFor`/`policyFor`), `90c0bcc` (spec-injection parity suite `parity-spec.test.ts`, `spec-generic.test.ts`) and `b46ebcb` (non-removable safety block, `safety.test.ts`). Kept as they are; WP14a·3 continues from them (still open: `brand-denylist.ts`, the rest of the P§4.6 corpus, the remaining lint rules, the WP16 requests, and a WP14a·3 notes section).
- **§2 rule 9:** those three commits change WP1 core signatures (all additive: one optional trailing parameter each; no point-free callback use of the widened functions in any worktree, checked), so they **merge only after G2**. Before G2 merge `27ec817`, not `wp/wp14a`.
- Re-verified at `b46ebcb`: typecheck clean; `npm test` **71 files, 962/962 passed** with Postgres up (Docker's `baton-pg` is running again, so no `SKIP_DB_TESTS`); `snapshot-legacy.ts --check` → "oracle up to date". Live spend $0.

## WP14a·3: spec injection, safety block, all lint rules (B1/K1/K2 first), parity corpus, WP16 seams (D1 Fri Sep 25)

Branch `wp/wp14a`. The unit was interrupted once by a usage limit. On resume the worktree was clean, `git merge main` was a no-op (main = `175a6b7`), and the three T3 commits from the resume check above were kept unchanged.

| Commit | What |
|---|---|
| `63b3636`, `90c0bcc`, `b46ebcb` | (before the interruption) The optional trailing `spec?: IntentSpec` on the WP1 core functions, `LEGACY_BATON_SPEC`, the spec-link seam, the spec parity suite and the non-removable safety block |
| `f18822e` | **B1, K1, K2**: `src/core/relay/brand-denylist.ts` and `LintOptions` |
| `8358762` | The rest of P§3.4: C2, S2, S3, F1, F2, X1, X2, G2, W3 and W2. Adds `src/core/relay/canned.ts` (the 4 canned states) and `mergedListeningKeyterms` |
| `d4d70e3` | Parity corpus: WP1's committed first-update fixtures and WP8's QA fixture call |
| `b7395fb` | WP16 seams in core: `tool-args.ts` (`validateToolArgs`), `lookup-table.ts` and `connector-rules.ts` (the lint mirrors for S3 and L2). Also `cannedCaseState` for WP14b's binding |

### Done

- **Spec injection (TASKS-v2 §2 rule 9).** It adds only optional trailing parameters; no existing parameter or return type changed. `parity-spec.test.ts` proves the results equal with no spec, with `LEGACY_BATON_SPEC` and with the compiled Baton spec.
- **Safety block (`safety.ts`).** Every non-flagship prompt carries it, including a relay whose custom `promptTemplate` tries to drop or spoof it. Baton's prompt has none.
- **Lint implements every P§3.4 rule.** `LINT_RULES_PENDING` is now `[]`, and issues come out in the order of the rule table.
- **B1** (`brand-denylist.ts`):
  - **Lists:** 703 entries in four lists: the gallery domains (dental, telecom, payments, e-sign), the top-50 US banks, the top-50 US insurers and the Fortune 500.
  - **Matching** uses tokens on word boundaries. It folds case, accents and "and"/"&", and it never builds a RegExp from a string.
  - **Three tiers keep ordinary English out:**
    - `exact` names match in any case.
    - `capitalized` names need capitals in prose: "Target" fails, "target date" passes.
    - `name` words always fail in a sample's `org.name`. In prose they fail only as a possessive or after a cue word ("Nationwide's assistant", "calling from Frontier"), so "Nationwide 5G coverage" passes.
  - **Acronyms** outside the `exact` tier must be written in capitals, so "sign-ups" is not UPS.
  - **Surnames and place names** ("Lincoln", "Erie", "Root", "Cox") are listed only in multi-word forms, so "Root & Crown Dental" is legal.
  - **Checked texts:**
    - each sample's `org.name`;
    - `meta.title` and `meta.tagline`;
    - `persona.tone` and `persona.extraRules`;
    - the subject and the greeting;
    - the disclosures: title, text and tokens;
    - the `promptTemplate`;
    - the handoff lines;
    - the SMS and document templates.
  - **Templates:** B1 skips template vars but reads across section boundaries, so "Wells{?x}{/?} Fargo" is caught.
  - **Not checked:** field phrases, stage goals and sample data, because a port-in may name the carrier the customer is leaving.
  - `replaceDenylistedBrands` is exported for the drafting post-fix.
- **K1/K2** need context that is not in the blueprint:
  - **Options:** `lintBlueprint(bp, opts?)` and `lintBlueprintJson(json, opts?)` take an optional `LintOptions` (additive): `visibility`, `pinnedPublication`, `secretIds`, `flagship` and `simSampleRateHz`.
  - **K2 fails a `null` ref** on a used `http_action` header, and on any `completion_webhook`: a webhook always runs and is always signed. With `secretIds` set, K2 also fails refs to missing or expired secrets. An `http_action` with a null `hmacSecret` is allowed; it is simply unsigned.
  - **Consequence:** a gallery relay cannot carry a completion webhook.
- **The compiled rules** compile the relay and render it for every sample × the 4 canned states:
  - **When they run:** only when L1–L3, S1 and X3 pass. Any throw becomes an issue, so lint never throws.
  - **G2:**
    - the opening is ≤ 14 words;
    - the greeting is ≤ `maxWords` after drops;
    - `next.confirm` uses `{phrase.confirm}` and `next.ask` uses `{phrase.ask}`.
  - **W3:** the first VERIFIED value comes within 24 words. `greetingFirstFactWord` measures it by rendering with marked field values.
  - **X1:**
    - the extractor schema is strict;
    - the prompt is ≤ 6000 characters at the longest stage, checked for the all-verified and nothing states;
    - the case-JSON cap is ≤ 2400.
  - **X2:** at most 100 merged keyterms of ≤ 50 characters, counted before capping, and a `scenarioPrompt` of ≤ 1750 characters.
- **C2:** every disclosure asks a question ("?"), and its text contains at least one of its critical tokens.
  - "Consent exactly when an act stage follows" means two things:
    - the disclosure that gates the act stage (the exit of the stage before it, or the act connector's `requiresDisclosure`) must have consent;
    - a consent disclosure with no act stage after it fails.
  - Baton is correct on both: `esign_consent` is true and `premium_change` is false.
- **S2, S3, F1, F2 and W2** follow the table. Two additions:
  - S3 also mirrors WP16's runtime refusals: dropped headers, and URLs with a bad port, userinfo, localhost, a single-label host or a non-public IP literal.
  - L2 also loads each `lookup_table` connector's data against its table definition.
- **Baton lints clean,** with no errors and no warnings. This holds with no options and with `{flagship, visibility:"gallery", pinned, secretIds:[], simSampleRateHz:8000}`. Linting Baton takes 3.5 ms p50 in Node.
- **`canned.ts`** provides two builders:
  - `cannedSnapshot(bp, state, account)` returns fields only (for the Studio and lint);
  - `cannedCaseState(compiled, account, state)` returns a full `CaseState` (for WP14b's `KernelBinding.cannedSnapshot`).
- **Parity corpus additions:**
  - `parity-wp1-fixtures.test.ts`: the Baton blueprint reproduces WP1's committed `first-update-{confirm,disclose}.{s01,s02}.json` byte for byte.
  - `parity-qa-fixtures.test.ts`: WP8's QA fixture call (their transcript, timeline and snapshots through `buildQaInput`) gives equal `computeQa` results with no spec, the legacy spec and the compiled spec.
  - The rest of the corpus was already covered: the named snapshots, the 200 random snapshots, normalize over the 22 scenarios, the WP3 dialog inputs and the extractor version.
- **WP16 seams** (answers `wp16-to-wp14a.md` §1–3):
  - `src/core/relay/tool-args.ts`: `validateToolArgs`, with WP16's exact semantics.
  - `src/core/relay/lookup-table.ts`: WP16's parser, made isomorphic with `utf8Bytes`.
  - `src/core/relay/connector-rules.ts`: the lint mirrors of the runtime's refusals.
  - Their §4 (the P§4.4 tool-result fixture) needs `RelayToolService` from WP16·2; see `requests/wp14a-to-wp16.md`.

### Decisions (additive; object via a request file)

1. `lintBlueprint` and `lintBlueprintJson` take an optional second argument, `LintOptions`. One-argument calls are unchanged, so WP14b's port keeps working.
2. `LINT_RULES_PENDING` is now `[]`. It stays exported so callers that check it still compile.
3. **G2's 14-word opening applies to every relay.**
   - The mini fixture's opening is now 14 words ("… not a person. This call is recorded.").
   - **WP14b's blank relay has a 15–17-word opening, so it fails G2.** `requests/wp14a-to-wp14b.md` suggests an opening that uses `{rep.firstName}`; with it, all 7 industries lint clean.
4. Canned states work like this:
   - `one_pending` and `one_missing` change the first required, non-rep-only field in next-step priority.
   - Optional fields stay MISSING.
   - Values come from each field's first example that normalizes, otherwise from a per-type sample.
5. The header and URL mirrors report under **S3**, and lookup-table load errors under **L2**. No new lint codes.

### Tests

- Typecheck is clean.
- **`npm test`: 75 files, 1082/1082 passed** (Postgres up).
- `tests/unit/core/relay` has 14 files and 340 tests.
  - These include 80 lint fixtures (fail or warn), each firing exactly one rule.
  - Together they cover every code except SCHEMA and K1, which have their own tests.
- `snapshot-legacy.ts --check` reports "oracle up to date".

### Live spend

$0: no AssemblyAI, OpenAI or Zerops calls.

### What the integrator must do

1. **After G2**, merge `wp/wp14a` at `b7395fb` or later with `--no-ff`. It must wait for G2 because the spec-injection commits change WP1 signatures (additively; §2 rule 9).
2. Then re-run `npx tsx scripts/relay/snapshot-legacy.ts --check` on the merged main.
3. `27ec817` (WP14a·2) can still be merged on its own before G2.
4. After the merge:
   - WP16 re-exports `validateToolArgs` and imports the core `lookup-table.ts` (`requests/wp14a-to-wp16.md`).
   - WP14b binds `cannedCaseState`, passes `LintOptions` from the relay row and the workspace's secret ids, and shortens the blank relay's opening (`requests/wp14a-to-wp14b.md`).

### Left for WP14a·4 (T4, D2 AM)

- The P§4.7 contract-widening commit, including `ToolOutcome.nextStep` and `CaseStateSchema.intent`. `cannedCaseState` and the kernel still use the `"add_driver"` literal.
- The browser compile-time benchmark (acceptance 7).
- The P§4.4 Dental tool-result fixture, written against WP16·2's `RelayToolService`.
- The `TUNING_8K` request from WP9, if one arrives.

## WP14a·2 (resumed run): post-G2 re-verification on merged `main` (D1 Fri Sep 25, 15:39–15:50 IST)

A third usage-limit interruption hit the WP14a·2 slot. **No work was lost and no new kernel code was needed:** the
worktree was clean on arrival, `main` (`c913c63`) was already an ancestor of `HEAD` through the merge commit
`9d7d293`, and every WP14a·2 and WP14a·3 deliverable was already committed. What the interrupted run had *not* done
is verify the branch on top of that merge. This section records that verification.

### The merge that was already in place

`9d7d293` merges `main` = **`c913c63`** into `313d323`. That `main` carries the **G2 slice**: `G2: merge wp/wp13`,
`wp/wp18`, `wp/wp9`, `wp/wp7`, `wp/wp6`. It brings in notes, pitch docs, `scripts/{calls,day1,eval}/**` and one
`package.json` change — an `overrides` block pinning `@esbuild-kit/core-utils` to `$esbuild`, which is what shrinks
`package-lock.json` by 412 lines. No WP14a path was touched and there was nothing to re-resolve. Lock checked against
`package.json`: no dependency missing. **No `npm install` was run.**

### Verified at `HEAD`

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | **114 files, 1570 passed, 1 skipped, 0 failed** |
| `npx vitest run tests/unit/core/relay` | 14 files, **340 passed** |
| `npx tsx scripts/relay/snapshot-legacy.ts --check` | `oracle up to date` |
| `data/relays/baton-add-driver.json` `handoff.repLine` | the s01 line, byte for byte |
| `GREETING_MAX_WORDS` (`src/core/compiler/greeting.ts:24`) | `40` |
| `requests/wp5b-to-wp1.md` | still closed (resolution section intact) |

**This is the result that mattered.** The three spec-injection commits (`63b3636`, `90c0bcc`, `b46ebcb`) widen WP1
core signatures with an optional trailing `spec?: IntentSpec` (§2 rule 9), and G2 merged WP5, WP6, WP7 and WP9 — all
WP1-core consumers — onto `main` independently. A clean typecheck plus 1570 green tests on the merged tree is the
evidence that the widening is genuinely additive against the real G2 code, not just against the pre-G2 tree the
parameters were written on. **The §2 rule 9 "merges only after G2" condition is now satisfied.**

### One caveat for the integrator: re-run a red full suite before bisecting

The **first** full `npm test` after the merge came back `4 failed | 110 passed`. It is a shared-Postgres flake, not a
regression:

- the 4 files (`cases/prefill`, `cases/repository`, `limits/ledger`, `tools/g1-stack`) each sat at the 20 s
  `testTimeout`, and their errors are `pg-protocol` parse failures and `undefined` rows — starvation, not assertions;
- each passes alone; `npx vitest run tests/unit/server` (34 files, 320 tests) passes; the 2nd and 3rd full runs passed.

Cause: 17 test files each build their own `pg.Pool` with `max` 5–20 in its own vitest worker, against `baton-pg`'s
stock `max_connections = 100`. Pools fill only on a cold DB. Not WP14a's paths — filed as
`docs/notes/requests/wp14a-to-wp12.md` with three suggested fixes (raising `max_connections` is the one-line one).
WP14a's own suites are DB-free and never flake.

### Live spend

$0. No AssemblyAI, OpenAI or Zerops calls in this run.

### What the integrator must do (updated now that G2 has landed)

Supersedes item 1 of the WP14a·3 list above: the post-G2 condition is met and verified, so **`wp/wp14a` can now be
merged at `HEAD` (`9d7d293`) with `--no-ff`** — no need to stop at `27ec817` or `b7395fb`. The merge is then a
fast-forward of content already proven against this `main`. Afterwards, still re-run
`npx tsx scripts/relay/snapshot-legacy.ts --check` on merged `main`, and the WP16 / WP14b follow-ups listed in the
WP14a·3 section are unchanged.

### Still open for WP14a·4 (T4, D2 AM) — unchanged

The P§4.7 widening commit (incl. `ToolOutcome.nextStep` and `CaseStateSchema.intent`), the Chromium compile
benchmark (acceptance 7), the P§4.4 Dental tool-result fixture against WP16·2's `RelayToolService`, and the
`TUNING_8K` request from WP9 if one arrives.

## WP14a·3 (resumed run): completion audit on the G2-merged tree (D1 Fri Sep 25, 15:44–15:58 IST)

A second usage-limit interruption hit the WP14a·3 slot. **Nothing was lost and no new kernel code was needed.** On
arrival the worktree was clean, `main` (`c913c63`, the G2 slice) was already an ancestor of `HEAD` through `9d7d293`,
so `git merge main` was a no-op, and every WP14a·3 deliverable was already committed (`f18822e`, `8358762`,
`d4d70e3`, `b7395fb` on top of `63b3636`, `90c0bcc`, `b46ebcb`), as was the post-G2 re-verification `051c355`. There
was no uncommitted work to keep. This run is therefore an **audit of the unit against the TASKS-v2 §6 T3 list**
rather than new code, and it closes WP14a·3.

### T3 deliverable → evidence

| TASKS-v2 §6 WP14a T3 item | Evidence |
|---|---|
| Optional trailing `spec?: IntentSpec` on the 12 named WP1 core entry points | All present: `deriveCaseState` (`case/derive.ts:101`), status rules (`case/status-rules.ts:69,92,124`), `applyExtraction` (`case/apply.ts:115`), `nextStepOf`/`inputModeFor`/`vaSessionCapMs` (`compiler/stages.ts:46,70,115`), `caseStateJson` (`compiler/prompt.ts:84`), `disclosureText` (`compiler/disclosures.ts:45`), `computeQa` (`qa/index.ts:80`), `classifySentence`/`valueBearing` (`qa/reask.ts:56,30`), `suggestReplies` (`compiler/suggest.ts:143`), `buildSttParams` (`aai/stt-params.ts:135`) |
| …and **only** that (never an existing parameter or return) | Diff audit of `63b3636`: every deleted `export function`/`export const` line reappears identical with one trailing `spec?: IntentSpec`. Two notes below |
| `LEGACY_BATON_SPEC` | `src/core/intents/baton-legacy-spec.ts`; `parity-spec.test.ts` proves none = legacy = compiled |
| `safety.ts` + `brand-denylist.ts` | Both present; `safety.test.ts`, `brand-denylist.test.ts` |
| The full P§4.6 corpus | All six corpus bullets covered: s01/s02/s05 × 3 pass points and the 200 random snapshots (`parity-baton.test.ts`), WP1's compiler fixtures (`parity-wp1-fixtures.test.ts`), **the WP3 12-turn fixture** (`snapshot-legacy.ts:163` `extractorInputs()` reads `tests/fixtures/extract/s01-dialog.json`), WP8's QA fixtures (`parity-qa-fixtures.test.ts`), the 22 scenarios' `normalizeField` truth values (`normalize.json`, 609 inputs) |
| The remaining lint rules (G2, W3, B1, K1, K2 and the rest) | `LINT_RULES_PENDING = []` (`lint.ts:39`); 80 lint fixtures |

Two harmless shape changes the §2 rule 9 audit turned up, recorded so the integrator does not have to rediscover them:

1. `inputModeFor` and `vaSessionCapMs` lost their `: InputModeFor` / `: VaSessionCapMs` const annotations (the spec
   parameter is spelled inline instead, with `Parameters<…>` for the first argument). A function with one extra
   **optional** trailing parameter is still assignable to the original type, so every consumer is unaffected.
2. `nextStepFor`, `openRequiredFor` and `readinessFor` moved out of `relay/spec.ts` into `relay/spec-link.ts`, but
   `spec.ts:204` re-exports all three, so the old import path still resolves. No other worktree imports them yet.

### Checks re-run at `HEAD` (`051c355`)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `npm test` | **114 files, 1570 passed, 1 skipped, 0 failed** (Postgres up; no flake this time — see the caveat in the section above) |
| `npx vitest run tests/unit/core/relay` | 14 files, **340 passed** |
| `npx tsx scripts/relay/snapshot-legacy.ts --check` | `oracle up to date` |

### Inbound requests re-checked

A sweep of every worktree for `*-to-wp14a.md` found only the two already handled (`.wt/wp14b/…/wp14b-to-wp14a.md`,
`.wt/wp16/…/wp16-to-wp14a.md`); no new request has arrived. Both are answered, including the two items easiest to
miss:

- WP14b §5 asks `CompileRelayOptions` to keep accepting `{versionId, relayId, hash, flagship}` — all four keys are
  there (`compile.ts:34`), so `KernelBinding.compile` will typecheck.
- WP14b §5's canned-snapshot request is `cannedCaseState(compiled, account, state)` in `relay/canned.ts`, which
  returns a full `CaseState`, matching `KernelBinding.cannedSnapshot`.

Their remaining item (WP16 §4, the P§4.4 tool-result fixture) still needs `RelayToolService` from WP16·2 and stays in
WP14a·4, as `requests/wp14a-to-wp16.md` says.

### Live spend

$0. No AssemblyAI, OpenAI or Zerops calls in this run.

### Status

**WP14a·3 is complete.** The integrator guidance is unchanged from the section above: merge `wp/wp14a` at `HEAD` with
`--no-ff` (the post-G2 condition of §2 rule 9 is met and verified), then re-run the oracle check on merged `main`. The
"Still open for WP14a·4" list is unchanged.

---

## WP14a·4: the P§4.7 contract-widening commit, additive only (D2 Sat Sep 26, 09:40–10:05 IST)

A usage-limit interruption hit this slot too. On arrival the widening commit `6f38a93` was already in place and
sound, with four request files drafted but uncommitted; `main` had moved on (`99c1f2b`, the per-line secret-scan
marker). This run **committed the leftovers, merged `main`, and verified the widening on the merged tree**, which
is the part the interrupted run had not done. Per the unit's scope — the one contract-widening commit, then stop —
no new kernel work was started.

### Done

| # | Commit | What |
|---|---|---|
| 1 | `6f38a93` (kept from the interrupted run) | the widening itself: `FieldIdSchema`, `ToolNameSchema` and `DisclosureKindSchema` become `ID_RE` = `/^[a-z][a-z0-9_]{1,39}$/`; `cases.intent` gains `"relay"`; `ToolOutcome`/`ToolResponse` gain `nextStep`; `BatonFieldId`/`BatonToolNameSchema`/`BatonDisclosureKindSchema` keep Baton's vocabulary; 34 files, +343/−120 |
| 2 | `2a350db` | the four request files (`wp14a-to-{wp7,wp9,wp14b,wp16}.md`), which list every file the widening touched outside WP14a's paths, for its owner |
| 3 | `057100d` | one stale doc comment: `CaseStateSchema.fields` still said *"Exhaustive: every FieldId has a FieldState"*, which is exactly the assumption the widening invalidates. It now says the map is open and to index with `?.`. Comment only |
| 4 | `wp14a-to-wp23.md` | a flake found while verifying — see "For the integrator" below |

`git merge --no-edit main` brought in `99c1f2b` cleanly (2 files, no conflicts). `npm run migrate` on `baton_wp14a`:
`schema up to date (no-op)`, 25 public tables.

### Decisions

1. **The widening is additive, and that is now audited rather than asserted.** Diffing the exported-name set of
   `6f38a93` over `src/`: every `export` the commit removes reappears in the same commit, except `FieldId`, which
   moved from `add-driver.fields.ts` (where it was `(typeof FIELD_IDS)[number]`) to `contracts/case.ts` (where it
   is `z.infer<typeof FieldIdSchema>` = `string`). Nothing imported `FieldId` from the fields module — the only
   cross-module import there is `contracts/case.ts:18` re-exporting `BatonFieldId` — so no import path broke.
   `fieldLabel` (`client/store/selectors.ts:394`) kept its name and signature and now delegates to `fieldLabelOf`.
2. **`isFieldId` narrows to `BatonFieldId`, deliberately.** It still tests membership of `FIELD_IDS`, so it is the
   same predicate with the same runtime behaviour; the guard type is the same set of strings it always was. A
   generic "is this a well-formed id" check is `FieldIdSchema.safeParse`, not `isFieldId`.
3. **The two places that must *not* widen are pinned by tests, not by comments.** Route #14's 404 and
   `toolCallsOf`'s "known tools only" both went through `ToolNameSchema`, which no longer answers "is this one of
   the six"; both now use `BatonToolNameSchema`. Two existing tests caught each of them, which is the reason to
   trust the rest of the mechanical fallout.
4. **The `vitest.config.ts` global `testTimeout` was left alone** (decision 4 of the flake below). It is shared,
   and raising it to cure one file would slow every other file's failure reporting.

### [VERIFY] results

**None are owned by this unit.** SAAS §16's register has 15 rows; their owners are WP19·2 (×4), WP19·3, WP22·1
(×2), WP21·1 (×3), WP23·1 (×2), WP15·1, WP23·2 and WP12-at-G3. No row names WP14a, and the widening depends on no
library option — `ID_RE` is our own regex and zod's `z.string().regex()` is core API already used throughout the
v2 contracts. Recorded here so the first-hour check is closed rather than skipped.

### Tests

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | clean, exit 0 — run twice, before and after the comment fix |
| `npm test` | **166 files, 2316 tests** — green on 2 of 5 runs; the other 3 red *only* on WP23's `relay-code/roundtrip.test.ts` timeout (below) |
| `npx vitest run tests/unit/core/relay tests/unit/contracts` | 26 files, 624 passed |
| `npx tsx scripts/relay/snapshot-legacy.ts --check` | `oracle up to date` |
| `node scripts/ci/secret-scan.mjs` | 248 files in `origin/main..HEAD`, 16 values checked, **hits=0** |

`tests/unit/core/relay/contracts-widening.test.ts` (121 lines, from `6f38a93`) is the unit's own evidence: every
Baton field id, tool name and disclosure kind still parses under all three widened schemas; a relay's ids parse and
malformed ids (`""`, `A`, `Driver_DOB`, `1field`, `_field`, `has-dash`, 41 chars, `ä`) do not; and `ID_RE.source`
equals the grammar PLATFORM names, so it cannot drift from v2's `IdSchema` or the gateway's `TOOL_NAME_RE`.

### Live spend

**$0.** No AssemblyAI, OpenAI, Polar or Zerops call in this run; `RUN_LIVE` was never set. The flagship's s01/s02
takes are still the simulated ones.

### What the integrator must do

1. **Merge `wp/wp14a` at `HEAD` with `--no-ff`, then re-run the oracle check on merged `main`.** The P§4.7
   condition ("merged at G2+ with a full typecheck") is met: `main` is merged in, typecheck is clean, the suite is
   green apart from the pre-existing flake.
2. **Hand the four request files to their owners.** The one that cannot wait is
   `wp14a-to-wp14b.md`: `src/server/db/schema.ts:50` still declares `intent: text("intent", { enum: ["add_driver"] })`.
   The column is text with no DB check and nothing writes it today (the insert takes the default), so nothing is
   broken now — but the first relay case to write its intent needs WP14b's one-word change first.
3. **`tests/unit/core/relay-code/roundtrip.test.ts` is flaky on `main`, and it is not the widening.** It fails
   `Error: Test timed out in 20000ms` on the "200 YAML edits" cases when the suite's 166 workers contend; it passes
   every time when run alone. Those paths are byte-identical between `main` and `wp/wp14a`. **If a full-suite run
   goes red there, re-run that one file before bisecting.** `wp14a-to-wp23.md` has the timings and two one-file
   fixes for WP23.

### Still open (not this unit — TASKS-v2 WP14a T4 remainder)

Unchanged and deliberately not started, per the unit's "then stop":

- the browser compile-time benchmark (acceptance 7);
- the P§4.4 Dental tool-result fixture, which still needs WP16·2's `RelayToolService`;
- `cannedCaseState` still emits `intent: "add_driver"` for every relay — a one-line change whenever WP14b wants
  `"relay"` (the parity corpus pins Baton only).

The `TUNING_8K` request from WP9 arrived and is **answered** (`wp14a-to-wp9.md`): `stt-params.ts` unchanged,
`TUNING_8K` stays provisional, and `repLinePatterns` is an **OR** — whoever writes the auto-baton detector should
read that file, along with WP9's accepted constraint that the acceptance window gates on word end timestamps, never
on `recvMs`.

### Where the next WP14a unit starts

There is no WP14a·5 in TASKS-v3 §5. If a slot frees up, the three "still open" items above are the backlog, in that
order; the Dental fixture is the only one with a dependency (WP16·2).
