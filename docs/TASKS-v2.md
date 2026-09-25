# Changeover: work packages from the current state (v2.1)

This plan is the companion to `docs/PLATFORM.md` v2.1, which is the spec. Section references with "P§" point there; "§" alone points to `docs/DESIGN.md` v1.1. v2.1 applies the feasibility-cost and judge-pitch reviews (P Appendix A) and the WP5/WP9 round-1 results.

**Supersedes:** `docs/TASKS.md` v1.1 §1, §3 (for the WPs listed here), §4, §6 and §7. The v1.1 ground rules (§0) still hold, except where §2 below changes them.

**Deadlines:**
- lablab closes **2026-09-30 20:30 IST**.
- **We submit by 10:00 IST on Sep 30.**
- Deploy freeze: 08:00 IST on Sep 30.
- Feature freeze: Sep 28 22:00.

---

## 1. Current state (verified D1 Fri Sep 25, ≈09:55 IST, from `git`, the worktrees and `docs/notes`)

| WP | State | Evidence |
|---|---|---|
| WP0a, WP0b, WP1, WP2, WP3, WP4, WP5b, WP8, deploy | **Done; merged at G1** | `main` = `a914341 G1: integration fixes and notes`, on top of the merges. The G1 commit already: binds WP3's `src/server/cases/defaults.ts` to WP1's engine (`impl:"wp1"`); sets the env defaults `PAY_TOOL_MODE=push` and `VA_KEYTERMS=1` (`env.ts`, `.env.example`); wires WP8's `verify_takeover` step and the F6 hook through `ensureWp8Wired()`; fixes the two timing flakes (WP3 `extract-service` "batches only a backlog", WP2 `runner` "the lease makes concurrent advances run the step once"). Suite 741/741 in 5 of 5 runs. Notes: `docs/notes/g1.md` |
| WP5 takeover protocol | **Round 1 complete, not merged.** 13 commits, clean tree. Typecheck clean; all 153 WP5 tests pass, none skipped. The last uncommitted change (an iOS-backgrounded VA session → pass outcome `abandoned`) is committed | Acceptance 1 **PASS** (75 reducer tests on a fake clock covering every DESIGN 5.5 transition and timeout, rules 6–8, pagehide from every state, at most one retry; 13 controller tests end to end against fakes). Acceptance 2 **PASS** (22 tests; `/compile` passes `validateFirstUpdate` for s01/s02/s05 at 3 pass points on WP1's merged compiler; a Postgres test runs arm → compile → events → end → arm with the real WP1, WP2 and WP3 code). Acceptance 3 **PENDING** (the G2 slice). Routes #9 and #11–#13 are wired through `src/server/takeovers/default-deps.ts`. **`wp/wp5` merged `main` at `2ed3cdf`, before the G1 fix commit**, so the items WP5 reports as open (WP3 stub engine, env defaults, `verify_takeover`, the WP2/WP3 flakes) are already fixed on main: one more `git merge main` clears them |
| WP6 tools, payments, MockPhone | **In progress:** 5 commits plus a dirty tree (5 files); lacks the G1 fix commit | `.wt/wp6`: payment state machine, Polar/mock providers, webhook, routes #14–#18, `callTool`, `MockPhone`, T-D1-9 driver |
| WP7 call console | **In progress:** 3 commits plus a dirty tree (5 files); lacks the G1 fix commit | `.wt/wp7`: store, fixtures, console components, `/dev/ui`, `/call`, orchestrator skeleton |
| WP9 takes pipeline | **Round 1 built and committed** on `wp/wp9` (12 commits, includes the G1 fix). Typecheck and the full suite pass (832 tests, 1 skipped). **No real takes processed yet** (finished 09:41, before the session) | `npm run calls:build` (+ `--check`), `label-ground-truth.ts` + `review-labels.ts`, the STT cache runner (`pc_ctx`, `pc_noctx`, `mono_diar`; `RUN_LIVE=1`, `--max-usd` 0.50, resumable, stale detection), `eval:extract`, `verify-cache.ts`, 11 test files over all 22 kit scenarios. One live STT smoke on a 24 s synthetic take ($0.007; finals 350–470 ms after turn end). Labels, extraction and the verifier cache have only run on fake clients. The code beyond the v2 scope stays but is not run live (P§13 X4) |
| WP7b, WP13 | Not started (empty worktrees at `main`) | |
| WP11, WP12 | Not started | |
| WP9b, WP10 | **Cut** (P§13 X1, X2) | |

**Day-1 facts other WPs must respect** (from the notes):

**Voice Agent** (`docs/notes/wp5b.md`, `g1.md`):
- `PAY_TOOL_MODE=push`: a `reply.create` during a `hold` is silent.
- `VA_KEYTERMS=1` is safe.
- `transcription_mode` can be changed mid-session.
- A stage update needs no wait for `session.updated`.
- Inline HTTP tools are rejected, so we use function tools.
- **T-D1-3 part B** (a VA token expiring during an idle pre-open) has **not run**; the tooling landed at G1. It runs today in WP12·0. The VA token window stays 10 s unless it fails (P§8.4).
- The Baton greeting is 65–69 words (22–24 s). v2.1 makes ≤ 40 words a lint error (P§3.4 G2); WP14a·2 shortens it.

**Extraction** (`docs/notes/wp3.md`): luna p50 is 2.1 s, which is above `DRAIN_MAX_MS` (2.0 s).

**Async verification** (`docs/notes/wp8.md`): verified ≈22 s after the end (poll path).

**STT** (`docs/notes/wp9.md`): WP4's `TUNING_8K` turn settings are provisional until they are checked on 2 real takes (WP9·2). STT caches made before a tuning change show as STALE.

**Zerops:**
- Live at `https://app-2b25-3000.prg1.zerops.app`. **App secrets are not set yet**; this is a user GUI action (`docs/notes/deploy.md`, `g1.md` "Deploy").
- The user confirmed SSH access through the Zerops VPN (the user's note: "you can ssh into the zerops with zcp vpn up"; the CLI command is `zcli vpn up`). Read-only use only (§2 rule 5).

---

## 2. Ground rules: changes from v1.1 §0

1. **Worktrees** live at `C:/Users/abid1/Desktop/assembly-ai/.wt/<wp>` on branch `wp/<wp>`. A new WP starts with `git -C <repo> worktree add .wt/<wp> -b wp/<wp> main` **after the latest gate or C-merge**. Commit locally when a unit is green. Never push or merge `main`. The integrator (the user, or WP12 when delegated) merges with `--no-ff`. **Every in-flight branch runs `git merge main` before its next unit** (wp5, wp6 and wp7 lack `a914341`).
2. **Concurrency: at most 5 agents at once.** Work is planned in **task units (T)**. One T is one agent session of about 3 h that ends in a green commit plus an appended `docs/notes/<wp>.md` section. A 5-hour usage window completes about 7 T. Every WP below is sized in T.
3. **v2 contracts:**
   - Platform types live in `src/core/contracts/v2/**` (owned by WP14a). They freeze at **C2 (D1 13:00)**, and the integrator merges that commit alone right away, so WP14b, WP15, WP16 and WP17 branch from it.
   - **The C2 commit must include the v2.1 review items** (they cannot be added later without breaking the freeze): the safe regex grammar (`v2/regex.ts`, `RegexSchema` refine, `ToolPatternSchema`), `customer.address`, nullable secret refs, `GreetingSchema.maxWords` 20–40, the one state route, `CHANGEOVER_DEMO_ECHO_SECRET`, the async draft and `kind` shapes, `ToolOutcome.nextStep`, and the quota buckets `sim:dryrun` and `greeting:hear` (§5).
   - After C2, v2 changes are additive only.
   - WP-local types still go in `src/core/contracts/ext/<wp>-<topic>.ts`.
4. **Ownership moves at gates** (§4.2). Until the gate, the old owner's files are read-only to everyone else. Use request files (`docs/notes/requests/<from>-to-<to>.md`). **Exception (v2.1):** WP2's and WP8's paths move **now** (both WPs are done), to WP12 and WP18 respectively.
5. **Zerops access:**
   - Agents may use `zcli vpn up` plus `ssh` or `psql` for **read-only** diagnostics (logs, `SELECT`s, `node bundle/cron.mjs`, header probes).
   - Deploys (`zcli push`) happen only at gates, by the integrator.
   - **Secrets are only ever set by the user in the GUI.** No agent writes secrets, anywhere.
6. **Spend:**
   - Every AssemblyAI open still goes through the limits authority.
   - **Every OpenAI call now reserves and settles in the ledger too** (provider `openai`, env `dev-<wp>`), through `src/server/openai/client.ts` or `scripts/lib`.
   - Live tests run only with `RUN_LIVE=1`, within the budgets in §7.
7. **Model routing (user preference):** reading and review tasks run on Sonnet, coding tasks on Opus. In-product LLM calls use OpenAI only (the LLM Gateway is locked).
8. **Definition of done** is unchanged:
   - typecheck clean;
   - `npm test` green;
   - the acceptance tests pass;
   - `docs/notes/<wp>.md` written.

   **Additionally:** the parity suite (P§4.6) stays green on every merge after **K-P (D2 16:00)**.
9. **WP14a·3 (spec injection) adds only an optional trailing `spec?: IntentSpec` parameter** to WP1 core functions. It never changes an existing parameter or return type, and it merges only after G2, so WP5, WP6 and WP7 merge onto unchanged signatures.
10. **Blueprint regexes are matched only through `safeTest()`** (P§3.2 "Regex safety"). A raw `new RegExp(<blueprint string>)` outside `src/core/contracts/v2/regex.ts` fails the boundaries test.

---

## 3. Waves, gates and the slot plan (≤ 5 concurrent agents)

### 3.1 Gates

| Gate | When (IST) | Exit criteria | Commit gate |
|---|---|---|---|
| **G1** | D1 Fri ≈09:45 | **Done** (`a914341`). Done branches merged; typecheck and tests green (741/741 × 5) | 2 |
| **C2** | **D1 13:00** | WP14a's first commit merged alone: `src/core/contracts/v2/**` (blueprint zod with the v2.1 items in §2 rule 3, `IntentSpec`, `UiSpec`, services, API zod, quota bucket names, `regex.ts`), plus the template parser and a lint skeleton. Typecheck green | — |
| **G2 Baton slice** | **D1 22:00** | **Baton only (v2.1).** Merged: WP5, WP6 (round 1), WP7 (Baton console), WP9 (round 1 + the real takes if labelled). Deployed. **With secrets set:** on Zerops, s01 **Express** (live STT) → Pass → greeting audible → confirm → disclose → pay (Simulate) → close → "✓ Verified from recording". WP14a/WP14b branches may merge if green, but parity and migration 0001 are **not** G2 exit criteria (parity has K-P) | 3 |
| **K-B Baton slice check** | **D2 10:00** | The live Baton slice has passed on Zerops | If not: S3 and S5 switch to Baton fixes until it passes (§9) |
| **G3 Relay engine** | **D2 Sat 22:00** | The **Dental relay** (gallery) runs end to end on Zerops on its pre-generated simulated call **with Express**: live STT → `UiSpec` case card → auto-baton → VA → deposit link (Polar sandbox with the address prefilled, or Simulate) → confirmation → verified QA, under the provenance strip. The "add a field" preset runs (fake upstream at least). The Studio edits Track, Case, Listening, Handoff and Playbook with the live compiled preview. The connectors `payment_link`, `confirmation`, `sms_mock` and `lookup_table` are live. The safe-regex and SSRF suites are green. The tightened F6 audit is live. Migration 0001 applied. (No Baton-on-kernel run: P3) | 4 |
| **K-G3 platform** | **D3 12:00** | The Dental relay is end to end on Zerops, and Studio Test (spec S) is green | If not: **Baton-first fallback** (P§13.4) |
| **G4 Full judge path** | **D3 Sun 19:00** | On Zerops: landing → "Watch the handoff" → Baton Express (< 45 s from the click to the pass); landing gallery **Run** → Dental Express; Studio → Dental → **Try an edit** → run → verified QA → Publish (or the P-1/P-3 fallback) → Analytics (Recorded/Simulated columns). The wizard drafts a lint-clean relay and runs a TEXT DRY RUN. e2e specs 1/S/R green (fake upstream). Quotas, tranches and the OpenAI ledger verified. **Rough video at 20:00 (user)** | 5 |
| **G5 Feature freeze** | **D4 Mon 22:00** | Fixes from the rough video are in. Both recorded AI bundles play under forced `replay_only`, hash-matched. The browser pass is done. The pass loop is on the landing page. **Final video recorded at 19:00** | 6 |
| **RC** | D5 Tue 22:00 | Fixes only. The live spec passes on Zerops D3, D4 and D5. Pitch assets and field notes are final. Tag `rc1` | 7 |
| **Submit** | D6 Wed 08:00 freeze → **10:00 submit** | `LEDGER_EPOCH`, `AAI_JUDGING_BUDGET_USD` and `OPENAI_JUDGING_BUDGET_USD` set from the dashboards; `/status` green | 8 |

### 3.2 Slot plan (S1–S5 = the five concurrent agents; `WPx·n` = task unit n of WPx)

| Block (IST) | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|
| **D1** 09:45–13:00 | WP14a·1 contracts v2 (with the v2.1 items), blueprint, template, safe regex, lint → **C2** | WP7·1 Baton console: `git merge main`, wire real controllers | WP6·1 finish round 1 (`git merge main` first) | **WP12·0** (≈1 h): `git merge main` into the idle `wp/wp5`; P-0 ipKey probe + fix; T-D1-3 part B. Then **WP18·0** probes P-1/P-2/P-3 (local, postman-echo) and the tightened F6 audit *(user records 10:00–14:30)* | WP13·1 positioning v2.1, numbers v1, lablab copy, `src/content` |
| D1 13:00–17:00 | WP14a·2 kernel compilers, Baton JSON, **the ≤ 40-word legacy greeting and the recorded rep line before the oracle**, compile parity | WP7·2 G2 slice UI, MockPhone mount, Express default | WP16·1 connector runtime core (new §6.2 guards) | WP18·0 (continued) → WP9·2 takes → assets, handoff labels, `TUNING_8K` check (after 14:30) | WP14b·1 migration 0001 (incl. `last_used_at`, `args_hash`, `moderation`), registry with LRU eviction, `/api/relays`, seed |
| D1 17:00–21:00 | WP14a·3 spec injection (optional params only; merges after G2), safety block, B1/K1/K2 | **WP12·1 G2 integration and deploy** | WP17·1 TTS module (settled from chars), sim assembler (90 s), `sim_calls`, asset route | WP9·3 picker takes, `pc_ctx` cache, cached turns | WP14b·2 engine-for-version server wiring, moderation, platform-stub ipKey swap |
| **D2** 09:00–13:00 | WP14b·3 widening lands, Dental server path, preset versions, Express re-extraction | WP15·1 Studio shell, gallery with **Run**, **Track** view, Case tab, preview | WP16·2 `RelayToolService` (`nextStep`, dedupe), Polar adapter, SMS/lookup/confirmation *(or Baton fixes if K-B fails)* | WP17·2 sim script (≤ 14 turns), Dental curated, **2 presets + clips**, gallery sim with Express caches | WP7·3 `RelayConsole` from `UiSpec`, **provenance strip** *(or Baton fixes if K-B fails)* |
| D2 13:00–17:00 | WP18·1 publish service, gateway, state route | WP15·2 Listening/Handoff/Playbook tabs, lint UX | WP16·3 `http_action` + SSRF + host allowlist, echo, console API, secrets | WP11·1 autopilot + chips (s01, Dental, preset clips), mic toggle | WP7·4 test/published modes, "what the AI inherited", gallery Run entry |
| D2 17:00–21:00 | **WP12·2 G3 integration, deploy, e2e scaffolding** | WP15·2 (continued) | WP17·3 async drafting, TEXT DRY RUN, on-demand sims | WP13·2 video script v1 (P§12.3), shot list, slide outline (10 + backup), field notes v1 | WP14b·3 (continued) / fixes |
| **D3** 09:00–13:00 | WP18·2 share page (labels, no mic), `createPublishedVaController`, published-run mode | WP15·3 **Try an edit** card, Test tab (dry run default, hash-mismatch view), Connectors, Publish, wizard UI | WP7b·1 landing first viewport, directions strip, gallery Run cards | WP11·2 recorded AI bundles (s01, Dental sim) | WP12·3 e2e 1/S/R, guards (tranches, `nextLiveAt`, global caps, `STUDIO_MODE`) — **K-G3 at 12:00** |
| D3 13:00–17:00 | WP18·3 analytics (Recorded/Simulated), Hear the greeting (SHOULD) | WP15·4 Analytics tab, `/r`, read-only mode, a11y, 390 px | WP7b·2 status pill, field notes, numbers row, polish | WP17·4 Telecom (e-sign) or blueprint-only cards, wizard eval set | WP13·3 README v1 (field notes), slides v1, cover v1 |
| D3 17:00–19:00 | **WP12·4 G4 integration and deploy** → rough video 20:00 (user) | | | | |
| **D4** | fix list from the rough video (4–6 T spread over S1–S4) | | | | WP12·5 browser pass, 3-concurrent smoke, runbook; WP13·4 final script with measured numbers, the pass loop cut from the rough video; **final video 19:00**; **G5 22:00** |
| **D5** | buffer: fixes only (≤ 4 T) | | | | WP13·5 video edit, slides PDF, README, cover final; **RC 22:00** |
| **D6** | 08:00 freeze (user + WP12) → **10:00 submit (user)** | | | | |

**Totals:**
- about 50 T of planned work (v2.1 adds ≈ 4 T: the Track view, Try an edit, TEXT DRY RUN, the provenance strip, the guards), plus about 10 T of fix and buffer;
- capacity at about 3 usage windows per day is about 70 T;
- the critical path is **WP14a → WP14b → (WP16 ∥ WP17 ∥ WP7·3) → G3 → K-G3 → WP15·3 / WP18 → G4 → video**. Baton is never on it (G2 and K-B protect it).

---

## 4. Ownership map v2 (disjoint)

### 4.1 New and re-scoped owners

| WP | Owns |
|---|---|
| **WP14a** kernel | `src/core/contracts/v2/**` (incl. `regex.ts`), `src/core/relay/**` (except `draft/**`; incl. `safety.ts`, `brand-denylist.ts`), `data/relays/baton-add-driver.json`, `scripts/relay/**`, `tests/unit/core/relay/**`, `tests/fixtures/relay-parity/**`. **From G1 (now):** WP1's `src/core/{intents,case,compiler,qa,evidence}/**` + `tests/unit/core/{intents,case,compiler,qa,evidence}/**`, WP4's `src/core/aai/stt-params.ts` (so the `TUNING_8K` decision from WP9·2 lands here). **For the one widening commit (P§4.7):** `src/core/contracts/**` (not `ext/`, not `v2/`), then back to the integrator |
| **WP14b** server engine + registry | `src/server/relays/**` (incl. `moderation.ts`), `src/server/engine/**` (`RelayEngineFactory`, `CallCatalog`), `src/app/api/relays/**`. The additive schema in `src/server/db/schema.ts` plus `drizzle/0001_relays.sql` (only that migration). **From G1:** WP3's `src/server/cases/**` (incl. the `platform-stub.ts:50` ipKey swap), `src/server/openai/{extractor,verifier}.ts`, `src/server/data/**`, `src/app/api/{cases,extract}/**`, `tests/unit/server/cases/**`, and WP2's `src/server/runs/**`. **From G2:** WP5's `src/server/takeovers/**`, `src/app/api/takeovers/**`, `tests/unit/server/takeovers/**`, and WP8's `src/server/qa/build-input.ts` (that file only). Also `tests/unit/server/{relays,engine}/**` |
| **WP15** Studio UI | `src/app/studio/**`, `src/app/r/**`, `src/components/studio/**`, `src/client/studio/**`, `tests/unit/studio/**` |
| **WP16** connectors + tools | `src/server/connectors/**`, `src/server/secrets/**`, `src/app/api/{connectors,secrets}/**` (except `connectors/pub/**`), `tests/unit/server/{connectors,secrets}/**`, the `ipaddr.js` dependency line in `package.json`. **From G2:** every WP6 path (`src/server/{tools,rating,payments,polar}/**`, `src/app/api/{tools,payments}/**`, `src/app/api/webhooks/polar/**`, `src/app/pay/**`, `src/client/tools/**`, `src/components/phone/**`, `scripts/polar/**`, their tests) |
| **WP17** drafting + simulated calls + templates | `src/core/relay/draft/**`, `src/server/{draft,sim}/**`, `src/server/openai/{draft,sim-script,tts}.ts`, `src/app/api/{drafts,sim-calls}/**`, `scripts/sim/**`, `public/calls/sim-*/**`, `public/data/cached-turns/sim-*.json`, `src/generated/sim-calls.json`, `data/relays/{dental-deposit,telecom-plan-change}.json`, `data/relays/*.presets.json`, `data/relays/cards/**` (blueprint-only cards), `tests/unit/server/{draft,sim}/**`, `tests/unit/core/relay-draft/**` |
| **WP18** publish + analytics | `src/server/{publish,analytics}/**`, `src/app/api/{publications,analytics}/**`, `src/app/api/connectors/pub/**`, `src/app/a/**`, `scripts/probes/**`, `tests/unit/server/{publish,analytics}/**`. **From G1 (now; WP8 is done):** WP8's remaining paths (`src/server/{jobs/verify-takeover,jobs/va-audit,aai/va-rest}.ts`, `src/server/qa/**` except `build-input.ts`, `src/app/api/{webhooks/assemblyai,verifications,va-sessions}/**`). **From G2:** WP5b's `src/client/va/**` and WP5's `src/client/takeover/**` (for the stored-agent start mode and Hear the greeting) |
| **WP7** consoles | Unchanged v1.1 paths, plus `src/components/call/{relay-console,provenance-strip}.tsx`. **From G1:** WP4's client code `src/client/{audio,stt,case,platform}/**` and `src/client/replay/cached-replay.ts`, changed only for relay listening pass-through |
| **WP7b** landing | Unchanged (`src/app/page.tsx`, `src/app/{about,status}/**`, `src/components/{landing,about,status}/**`, `tests/unit/ui-static/**`) |
| **WP9** takes | Unchanged v1.1 paths (the eval-only scripts it already built stay, not run live) |
| **WP11** customer input | `src/client/customer/**`, `src/client/replay/recorded-session.ts`, `scripts/tts/**`, `public/tts/**`, `public/replays/**`, `tests/unit/client/customer/**`. `src/server/openai/tts.ts` moves to WP17; WP11 imports it. `/api/tts` is cut |
| **WP12** integration + ops | v1.1 paths, plus **from G1 (now; WP2 is done)** WP2's `src/server/{limits,flags.ts,health,registry,auth}/**` (incl. the ipKey fix in `auth/visitor.ts`), `src/server/jobs/{runner,purge,budget-guard}.ts`, `src/app/api/{stt,va,runs,sessions,status,internal,admin}/**` (except `runs` service code under `src/server/runs/**`, which is WP14b's), `src/proxy.ts`, the deploy files (`zerops.yml`: the V8 regex flag), and `drizzle/**` except `0001_relays.sql`; `src/server/db/**` after WP14b's 0001 lands |
| **WP13** pitch | Unchanged (`README.md`, `docs/pitch/**`, `public/cover.png`, `src/content/**`), plus `public/landing/**` (the pass loop) |

### 4.2 Paths nobody owns any more

Cut or read-only:
- `src/app/{evals,explorer}/**`, `src/components/{evals,explorer,promote}/**`, `src/server/promote/**`, `src/core/protocol/simulate.ts`, `src/core/eval/**`, `scripts/eval/{sweep,live-spotcheck,k1,k2,report}.ts`: **cut** (P§13).
- `src/core/protocol/takeover-machine.ts`: WP5's, frozen after G2. Changes go through the integrator.

---

## 5. v2 contracts (WP14a, frozen at C2 D1 13:00)

The files are:

| File | Contents |
|---|---|
| `src/core/contracts/v2/blueprint.ts` | exactly P§3.2 (v2.1) |
| `src/core/contracts/v2/regex.ts` | `isSafeRegexSource`, `isSafeToolPattern`, `safeTest` (P§3.2 "Regex safety") |
| `src/core/contracts/v2/relay.ts` | `IntentSpec`, `PhraseScope`, `UiSpec`, `CompiledListening`, `LintIssue` (P§4.1) |
| `src/core/contracts/v2/services.ts` | below |
| `src/core/contracts/v2/api.ts` | zod request/response schemas for the routes below, `QUOTA_BUCKETS`, `CHANGEOVER_DEMO_ECHO_SECRET`, `ProvenanceStrip` |

```ts
// src/core/contracts/v2/services.ts (types only)
export interface LintIssue { code: string; severity: "error" | "warn"; path: (string | number)[]; message: string }
export interface RelaySummary { id: string; slug: string; title: string; industry: string; visibility: "private" | "unlisted" | "gallery";
  flagship: boolean; origin: "seed" | "user" | "draft" | "clone"; versionCount: number; lintErrors: number; lastRunAt: string | null; updatedAt: string }
export interface RelayDetail extends RelaySummary { draft: Blueprint; draftRev: number; lint: LintIssue[]; currentVersionId: string | null;
  publication: PublicationView | null; readOnly: boolean; presets: { id: string; label: string; versionId: string }[] }
export interface RelayRegistry {                                                     // WP14b
  listGallery(): Promise<RelaySummary[]>; listMine(ws: string): Promise<RelaySummary[]>;
  get(id: string, ws: string): Promise<RelayDetail | null>;
  create(ws: string, from: { kind: "blank"; industry: string } | { kind: "clone"; relayId: string }
                          | { kind: "blueprint"; blueprint: unknown; origin: "draft" | "user" }): Promise<RelayDetail>;   // never blocked by the global cap (P§10.2)
  saveDraft(id: string, ws: string, blueprint: unknown, expectedRev: number): Promise<{ rev: number; lint: LintIssue[] } | { conflict: true; rev: number }>;
  snapshotVersion(id: string): Promise<{ versionId: string; version: number; hash: string; created: boolean }>;   // content-addressed
  getVersion(versionId: string): Promise<{ relayId: string; version: number; blueprint: Blueprint; hash: string } | null>;
  moderate(versionId: string): Promise<{ flagged: boolean; categories: string[] }>;   // once per version (P§7.4)
  remove(id: string, ws: string): Promise<void>;
  seedGallery(): Promise<{ upserted: string[] }>;                                    // idempotent; at start-up; incl. preset versions
}
export interface CompiledRelay {                                                     // WP14a kernel output
  versionId: string | null; hash: string; blueprint: Blueprint | null; spec: IntentSpec; ui: UiSpec;
  listening(account: AccountRecord): CompiledListening;
  extractor: { prompt: string; format: { name: string; strict: true; schema: Record<string, unknown> }; versionId: string;
               buildInput(i: { callDate: string; account: AccountRecord; state: Pick<CaseState, "fields">;
                               recent: readonly Pick<TurnInput, "turnId" | "channel" | "text">[];
                               newTurns: readonly Pick<TurnInput, "turnId" | "channel" | "text">[] }): string };
  greeting(snapshot: Pick<CaseState, "fields">, account: AccountRecord): GreetingResult;
  prompt(snapshot: Pick<CaseState, "fields">, account: AccountRecord, stage: Stage, opts: { deployId: string }): string;   // + safety block (P§4.4)
  tools(stage: Stage): VaFunctionTool[];
  disclosure(id: string, ctx: { snapshot: Pick<CaseState, "fields">; account: AccountRecord; opts: { taxSuffix: boolean } }): DisclosureText;
  values(ctx: { snapshot: Pick<CaseState, "fields">; account: AccountRecord }): Record<string, string | null>;
  nextStage(current: Stage | null, s: Pick<CaseState, "readiness" | "disclosuresGiven" | "payment"> & { connectorsSucceeded: string[] }): Stage;
  takeover(snapshot: CaseState, account: AccountRecord, opts: CompileTakeoverOptions): CompiledTakeover;  // runs validateFirstUpdate
}
export interface RelayEngineFactory { forVersion(versionId: string | null): Promise<CompiledRelay> }   // null → legacy Baton; LRU 50
export interface CallCatalog {                                                        // WP14b (generated calls) + WP17 (sims)
  resolve(callId: string): Promise<(CallManifestEntry & { simulated: boolean; relayVersionId: string | null; account: AccountRecord | null }) | null> }
export interface ConnectorCtx { mode: "test" | "live" | "published" | "console"; caseId: string | null; takeoverId: string | null;
  workspaceId: string;   // the RELAY OWNER's workspace (never the visitor's on published runs)
  origin: string; publicationId: string | null }
export interface ConnectorOutcome { status: "ok" | "error" | "blocked" | "timeout" | "refused"; succeeded: boolean;
  result: Record<string, unknown>;   // connector data under `data` (P§6.2)
  ui?: { sms?: string; link?: string; paymentId?: string; esignId?: string } }
export interface ConnectorRuntime { execute(i: { compiled: CompiledRelay; connectorId: string; args: Record<string, unknown>; ctx: ConnectorCtx }): Promise<ConnectorOutcome> }   // WP16
export interface SecretStore { put(ws: string, name: string, value: string): Promise<{ id: string; name: string; createdAt: string; expiresAt: string }>;
  list(ws: string): Promise<{ id: string; name: string; createdAt: string; expiresAt: string }[]>; remove(ws: string, id: string): Promise<void>;
  resolve(ws: string, ref: SecretRef): Promise<string> }                                // server-only; never serialized
export interface DeskInput { industry: string; businessName: string | null; repHandles: string; aiFinishes: string[]; verbatim: string | null;
  payment: string | null; tone: string | null; voice: string | null }
export interface DraftView { draftId: string; status: "queued" | "running" | "ok" | "invalid" | "failed"; step: string | null;
  relayId: string | null; notes: string[]; lint: LintIssue[]; usd: number; repairs: number }
export interface Drafter {                                                             // WP17; async (P§7.4)
  start(i: DeskInput, who: { ws: string; visitorId: string; ipKey: string }): Promise<DraftView>;
  get(draftId: string, ws: string): Promise<DraftView | null> }
export interface SimCallService { request(i: { relayId: string; sampleIndex: number; kind: "audio" | "text_dry_run"; ws: string; visitorId: string; ipKey: string }):
  Promise<{ simCallId: string; status: "ready" | "generating"; etaSec: number }>; get(simCallId: string): Promise<SimCallView | null> }   // WP17
export interface PublicationView { id: string; relayId: string; version: number; shareSlug: string; agentId: string | null;
  status: "creating" | "live" | "deleting" | "deleted" | "failed"; mode: "stored_agent" | "inline_fallback"; configRedacted: Record<string, unknown> }
export interface Publisher { publish(relayId: string, ws: string): Promise<PublicationView>; unpublish(pubId: string, ws: string): Promise<void>;
  bySlug(slug: string): Promise<PublicationView | null>; acquireRun(pubId: string, takeoverId: string): Promise<boolean>;
  heartbeat(pubId: string, takeoverId: string): Promise<void>; release(pubId: string, takeoverId: string): Promise<void> }   // WP18
export interface RelayAnalytics { forRelay(relayId: string, version: number | "all"): Promise<RelayAnalyticsView> }            // WP18; Recorded/Simulated split
```

**Extensions to v1 route shapes** (in `v2/api.ts`, all additive):
- `CreateCaseRequest` gains `relayId?: string` and `relayVersionId?: string` (a version of that relay, e.g. a gallery preset), and the server snapshots a version when only `relayId` is given.
- `CreateCaseResponse` gains `relay: UiSpec`, `listening: CompiledListening`, `simulated: boolean` and `provenance: ProvenanceStrip`.
- `ToolOutcome` (widening commit, P§4.7) gains `nextStep: string | null`.
- `/api/status` gains `nextLiveAt: string | null` (WP12).

**New routes (owner):**

| Route | Owner |
|---|---|
| `GET/POST /api/relays`, `GET/PUT/DELETE /api/relays/:id`, `PUT /api/relays/:id/draft`, `POST /api/relays/:id/versions`, `GET /api/relays/:id/compiled` | WP14b |
| `POST /api/drafts` (→ `DraftView` queued), `GET /api/drafts/:id` (poll) | WP17 |
| `POST /api/sim-calls` (`kind: audio | text_dry_run`), `GET /api/sim-calls/:id`, `GET /api/sim-calls/:id/:file` | WP17 |
| `POST /api/connectors/test`, `POST /api/connectors/echo`, `GET/POST/DELETE /api/secrets` | WP16 |
| `POST /api/connectors/pub/:pubId/:tool` | WP18 |
| `POST /api/relays/:id/publish`, `DELETE /api/publications/:id`, `GET /api/publications/:slug`, **`GET /api/publications/:pubId/runs/:takeoverId/state`** (the one state route; P§8.3) | WP18 |
| `GET /api/relays/:id/analytics` | WP18 |

`QUOTA_BUCKETS` = P§10.2's names (incl. `sim:dryrun`, `greeting:hear`). WP12 owns the limits and their config.

---

## 6. Work packages

Effort is in T (≈3 h agent units). "Consumes/Provides" names the v2 or v1 interfaces.

### In-flight WPs (re-scoped)

#### WP5: Takeover protocol (**0.2 T; merge at G2**)

- **State:** round 1 complete (§1). Acceptance 1–2 PASS.
- **Remaining:** `git merge main` (brings `a914341`; WP5's "open" items are fixed there), re-run the suite, and hand over. The integrator (WP12·0 does the merge while WP5 is idle; WP12·1 merges at G2) runs acceptance 3 (the G2 slice) with WP7, mounting the controller on `/dev/audio` then `/call` per `docs/notes/wp5.md` §6.2.
- **v2 change:** a compile port. `TakeoverService` gets its compile function from `RelayEngineFactory.forVersion(case.relay_version_id).takeover(...)`. WP14b·2 wires it after the ownership transfer.
- **Acceptance:** v1.1 WP5 acceptance 3 at G2.

#### WP6: Tools, payments, MockPhone (**1 T; D1 AM → G2**)

- **First:** `git merge main`.
- **Finish round 1:** the Polar lab e2e (`scripts/day1/polar-lab-e2e.ts`), T-D1-9, notes, the v1.1 acceptance 1–5.
- **Push mode** per WP5b (`PAY_TOOL_MODE=push`, result `{status:"link_sent"}`).
- **At G2** every WP6 path moves to WP16. Write `docs/notes/wp6.md` with an explicit "handler contract" section, which WP16 replays as the tool-parity test, and a "Polar inputs" section (what `buildCheckoutCreate` reads from `PolicyRecord` and `POLAR_DEMO_CUSTOMERS`) for WP16's adapter.

#### WP7: Call console → RelayConsole (**4 T: 2 T by G2, 2 T on D2**)

- **By G2 (Baton):** the v1.1 WP7 goal, trimmed:
  - `git merge main` first;
  - the orchestrator wired to the real WP4, WP5, WP5b and WP6 controllers;
  - MockPhone mounted;
  - the QA card from WP8's `/api/verifications`;
  - **Express as the default entry**, and `/call/[id]?express=1` starting after a 3 s countdown ("Full call instead" link; the provenance text as a banner; the `AudioContext` created in the landing click handler, DESIGN autoplay rule).

  **Cut from v1.1:** the narrator-strip polish beyond the basics, coach marks, recorded-mode picker variants.
- **D2 (v2, P§7.6):**
  - `RelayConsole({callId, relayVersionId, mode})`;
  - the case card, stage strip, QA card and phone rendered from `UiSpec` (from `CreateCaseResponse.relay`);
  - the `listening` pass-through into `SttChannelManager.open` (WP4 client code, now WP7's);
  - **the provenance strip** (four segments; replaces every stacked badge) and the sim QA wording;
  - `mode="test"` (back to the editor; the "What the AI inherited" panel; the "Answer the AI yourself (mic)" toggle wired to WP11);
  - the gallery **Run** entry (`mode="test"` on the pre-generated sim, Express);
  - `mode="published"` hooks for WP18 (the controller factory is injected; no mic).
- **Consumes:** `UiSpec`, `CompiledListening`, `ProvenanceStrip`, `BatonEvent`s, WP16's MockPhone, WP18's `createPublishedVaController` (injected).
- **Acceptance:**
  1. v1.1 WP7 acceptance 1–4 at G2.
  2. The s01 fixture renders byte-identically through `RelayConsole` (snapshot) with the Baton `UiSpec`.
  3. The Dental fixture log renders its fields, stages and deposit phone from its `UiSpec`.
  4. The provenance strip is present on every run, with the right four values for recorded, sim, dry-run and replay runs (unit + e2e S); no stacked badges remain.
  5. No component imports `src/server/**`.

#### WP7b: Landing (**1.5 T; D3**)

- **Goal:** P§12.1–P§12.2. The first viewport at 1366×768: H1, subline, the pass loop (a still until WP13 delivers the MP4), **one** primary CTA ("Watch the handoff · recorded role-play over a real phone line · no signup · no mic · ~3 min" → `/call/<s01>?express=1`), the secondary "Build a relay →" link, the status pill with `nextLiveAt`. Below: Shadow → Pass → Prove with the exact product names, the four-directions strip, the measured-numbers row with provenance, gallery cards with **Run** (`GET /api/relays?scope=gallery`), field notes, honest limits, footer.
- `/about` is folded into `/`. `/status` stays minimal. At most three terms in the first viewport (P§1.4).
- **Consumes:** `src/content/**` (WP13), `/api/status`, the gallery API.
- **Acceptance:**
  1. It renders with the API down (static fallback).
  2. Lighthouse a11y ≥ 90 on `/`.
  3. The CTA and every gallery Run resolve; with fake upstream, the click → baton pass time is < 45 s on both paths.
  4. At 390 px there is no horizontal scroll.
  5. The first viewport carries the H1, the subline, one primary CTA and the status pill at 1366×768.

#### WP9: Takes → assets (**2 T left; D1 PM → D2 AM**)

- **State:** round 1 built and committed (§1).
- **Round 2 (after the takes, ≈14:30):** `calls:build` for today's takes produces:
  - **featured s01** plus ≤ 3 picker takes (s02, s05 and one declined call);
  - handoff labels (`repLineStartMs/EndMs`, `acceptStartMs`), matching **either** handoff wording ("…one tap away if you need me" or "…I'll stay on the line"); a mismatch with `scenario.handoff.line` is flagged for the user's review, not failed; the user reviews ≤ 4 calls (≈10 min);
  - the `pc_ctx` STT cache and `public/data/cached-turns/*.json` **for those ≤ 4 calls only** (the labelled cached replay and Express);
  - **the `TUNING_8K` check** on 2 real takes (≤ $0.05); the result goes to WP14a (owner of `stt-params.ts`) as a request file.
- **Not run live:** extraction caches v1/v2/v3, `pc_noctx`, `mono_diar`, eval labels beyond the handoff (P§13 X1, X4). The code stays.
- **Acceptance:**
  1. v1.1 acceptance 1–2.
  2. Exactly one `featured` entry, which is publishable and has assets.
  3. Cached turns exist for every picker call; s01's `decisionPointMs` is set.
  4. The manifest's `scenarioId` resolves through `policyToAccount`.
  5. `docs/notes/wp9.md` records which handoff line s01 carries (it decides P§11's framing).
- **Live budget:** $1.00.

#### WP11: Customer input (**2 T; D2 PM → D3 AM**)

- **Re-scope:**
  - autopilot plus chips for s01: the recorded tail pack if it exists, else TTS clips generated once and committed;
  - for sims: an autopilot player over `sim_calls.ai_clips` by suggestion kind (`confirm`/`consent`/`answer:<field>`/`close`), including the preset answer clips;
  - the mic: optional on Baton; **the "Answer the AI yourself (mic)" toggle** for sims in Studio Test; never on `/a/` or `/r/` for non-gallery relays.
- **Two recorded AI bundles:** s01, and the Dental gallery sim, through the recorder `?record=1`. Each bundle stores its `blueprint_hash`; the player refuses a hash mismatch (P§10.4). **SHOULD:** one bundle per preset.
- **Cut:** typed TTS, the luna classifier, chips for every scenario.
- **Acceptance:**
  1. A mic-blocked s01 run completes on autopilot with **zero** live TTS calls.
  2. A Dental sim's AI half (and the "add a field" preset's) completes on autopilot.
  3. Both bundles play under forced `replay_only` with their provenance strip and verified QA, and an edited relay never plays a bundle.
- **Live budget:** $0.50 (+ $0.30 for the SHOULD preset bundles).

#### WP12: Integration, e2e, deploy, ops (**5.5 T; D1 AM → D6**)

- **WP12·0 (D1 09:45–11:00, new):**
  - `git merge main` into the idle `wp/wp5` and run its suite;
  - **P-0 ipKey probe** over `zcli vpn up` + ssh (read-only): a request with a spoofed `X-Forwarded-For`, and the headers the app receives, read from the log; then fix `ipKey` in `src/server/auth/visitor.ts` (the balancer-appended hop, /24 and /48) and export a helper that WP14b uses in `platform-stub.ts:50` (P§10.2); if no hop is trustworthy, ipKey buckets are switched off;
  - **T-D1-3 part B** (`RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t3-idle.ts --idle-ms 8000` with the token auth; ≈ $0.003). Pass → the VA token window stays 10 s; fail → 20–30 s and a note in `g1.md`'s successor.
- **Integrator (delegated by the user):**
  - C2 (13:00), G2, G3, G4 and G5 merges with `--no-ff`;
  - typecheck, tests and **parity** at each gate after K-P;
  - `zcli push`;
  - post-deploy `/api/health`;
  - the relay seed check over SSH (`SELECT slug, current_version_id FROM relays`).
- **Guards:**
  - the OpenAI judging ledger and dynamic cap (P§10.3) in `src/server/limits/ledger.ts`, with **four 6-hour tranches** for both providers and `nextLiveAt` in `/api/status`;
  - the quota config for `QUOTA_BUCKETS`, with the global caps as the real guard (P§10.2);
  - `CONNECTOR_HOST_ALLOWLIST` and `STUDIO_MODE` (`full | readonly`, the K-G3 fallback) flags;
  - the V8 regex backstop: test `--enable-experimental-regexp-engine-on-excessive-backtracks` in `NODE_OPTIONS`; if rejected, the `zerops.yml` start command or `v8.setFlagsFromString` in `instrumentation.ts`;
  - `/status` shows both budgets, the tranche and the mode.
- **e2e (fake upstream):**
  - **spec 1:** the Baton s01 Express path;
  - **spec S:** the Studio (gallery Run → Dental → Try an edit "add a field" → the AI asks only the new question → QA card with the provenance strip → clone → edit the greeting → the preview updates);
  - **spec R:** forced `replay_only` (the Studio is still editable; runs replay hash-matched with labels; an edited relay shows the "live calls resume at" view; **a production-mode database has no analytics fixtures**).

  The live spec runs on Zerops on D3, D4 and D5.
- **Also:** a 3-concurrent smoke (replacing K4); the browser pass (Chrome, Safari desktop, one iPhone Safari); `docs/RUNBOOK.md`:
  - the kill switch, `replay_only` after an F6 flag, `STUDIO_MODE`;
  - budgets, tranches and the daily balance step (AssemblyAI and OpenAI);
  - `zcli vpn up` diagnostics;
  - rollback (`zcli push` of the previous tag);
  - publication cleanup.
- **Acceptance:** every gate's exit criteria (§3.1) are recorded in `docs/notes/integrate.md`, and specs 1/S/R are green by G4.
- **Live budget:** $1.50.

#### WP13: Pitch pack (**5 T; D1 → D5**), re-positioned to Changeover

**Dates:**

| When | Deliverable |
|---|---|
| D1 18:00 | `docs/pitch/numbers.md` v1: every number tagged measured / sourced / assumption; metrics stated as "n runs over k distinct recorded takes"; headline metrics from recorded takes only; **no freed-rep-minutes claim unless s01 carries the new handoff line** (P§11); the loaded CSR cost sourced or labelled. `descriptions.md`: title "Changeover: your rep starts the call, AI finishes it", short ≤ 255 chars naming Universal-3.5 Pro Realtime, the Voice Agent API and async transcription, long ≥ 100 words, tags. `src/content/landing.ts` copy (P§12.1–12.2 wording rules) |
| D2 18:00 | `video-script.md` v1 + `shot-list.md` (P§12.3, ≈ 4:30); slide outline (P§12.4: 10 + backup, incl. Market and Team); field notes v1 (P§12.5) |
| D3 12:00 | README v1 (Changeover H1; "Baton · insurance add-a-driver" as flagship; field notes; architecture; how to run; honest limits; the LLM Gateway line; licence); slides v1; cover v1 (the pass moment) |
| D3 22:00 | `public/landing/pass-loop.mp4` (6–8 s, muted, captioned, ≤ 1.5 MB) cut from the rough video |
| D4 16:00 | final script with the measured numbers (k takes × n runs, re-asked, verbatim %, facts correct at the pass, dead-air p50) |
| D5 18:00 | final PDF, cover, README, descriptions, edited video (≤ 4:30, captions, MP4) |

**Acceptance:** every number in the deck and video appears in `numbers.md` with its provenance. The wording follows `research/14` §A.7 ("not found in our market scan"); no absolute "every builder" claims; the video says "simulated" whenever a sim is on screen.

### New WPs

#### WP14a: Blueprint schema, kernel and Baton parity (**4 T; D1 09:45 → D2 AM; critical path**)

- **Goal:** P§3–P§5 in `src/core`. The Baton JSON reproduces today's behaviour (with the shortened greeting), proven by snapshots.
- **T1 (→ C2 13:00):**
  - `src/core/contracts/v2/{blueprint,relay,services,api,regex}.ts` (P§3.2 v2.1, P§4.1, §5 above), including every v2.1 item in §2 rule 3;
  - `src/core/relay/template.ts` (parser, renderer, reference extraction);
  - the `lint.ts` skeleton (L1–L3, G1, C1, S1, X3 safe grammar).
- **T2:**
  - **first, in the legacy compiler:** shorten Baton's greeting to ≤ 40 words (opening ≤ 14 words with "AI assistant", "not a person", "recorded"; the facts; the one PENDING question), closing wp5b-to-wp1; update WP1's greeting tests;
  - `formatters.ts`, `normalizers.ts` (generic kinds plus `insurance.*` wrappers over the unchanged legacy functions), `spec.ts` (`buildIntentSpec`), `compile.ts` (`compileRelay`, `compileRelayTakeover`), `extractor.ts` (generated prompt, strict format, input builder, `assertStrictSchema`), `prompt-default.ts`, `account.ts` (`policyToAccount`);
  - **`data/relays/baton-add-driver.json`**, with `handoff.repLine` = the line s01 was recorded with (ask WP9/the user after 14:30; `repLinePatterns` accept both wordings);
  - `scripts/relay/snapshot-legacy.ts` → `tests/fixtures/relay-parity/baton/*.json` (after the greeting change);
  - parity for greeting, prompt, tools, first update and extractor.
- **T3:**
  - an optional trailing `spec?: IntentSpec` on `deriveCaseState`/status rules/apply, `nextStepOf`, `inputModeFor`, `vaSessionCapMs`, `caseStateJson`, `disclosureText`, `computeQa`/`classifySentence`/`valueBearing`, `suggestReplies`, `buildSttParams` (§2 rule 9; merges after G2);
  - `LEGACY_BATON_SPEC`;
  - `safety.ts` (the kernel safety block, P§4.4) and `brand-denylist.ts`;
  - the full parity corpus (P§4.6);
  - the remaining lint rules (incl. G2, W3, B1, K1, K2).
- **T4 (D2 AM):** the contract-widening commit (P§4.7, incl. `ToolOutcome.nextStep`), with an integrator merge immediately after; a browser compile-time benchmark; the `TUNING_8K` request from WP9 if any.
- **Consumes:** WP1's pure core (now owned); WP5's `compile-scenarios` harness data; the WP3 and WP8 fixtures.
- **Provides:** `CompiledRelay`, `IntentSpec`, `lintBlueprint`, `migrateBlueprint`, `compileRelay` (isomorphic), `policyToAccount`, `validateToolArgs`, `assertStrictSchema`, `safeTest`.
- **Acceptance:**
  1. The gallery JSONs parse and lint clean. Every lint code has a pass and a fail fixture (≥ 30 cases), including `(a|a)*$`, `(a+)+$`, `(a|ab)*c`, a backreference and a lookahead (must fail) and every Baton pattern (must pass).
  2. Template round-trip. Unknown path or formatter → a lint error. Depth > 3 → an error. **Property test:** 500 random snapshots, and the rendered greeting never contains a non-VERIFIED field value outside the confirm clause.
  3. **Parity:** 0 diffs over the P§4.6 corpus for every item in the P§4.3 parity column, including `EXTRACTOR_VERSION_V3` equality.
  4. Dental: `compileRelay` → `validateFirstUpdate` passes at every stage, and `assertStrictSchema` passes. The tool-result fixture (P§4.4): `instruction` only at the top level of system-tool results, connector data only under `data`.
  5. **Safety block:** present in every compiled prompt of every non-flagship relay, including one with a custom `promptTemplate` that tries to drop it; absent from Baton (parity).
  6. **Greeting:** Baton's rendered greeting is ≤ 40 words at every parity snapshot, with the first fact within 24 words.
  7. A kernel compile of Baton in Chromium takes < 20 ms p50.
  8. The boundaries test passes: no node, DOM or server imports in `src/core/relay/**`; no raw `new RegExp` on blueprint strings.
  9. After widening: typecheck green on main plus every active branch after a `main` merge.
- **Live budget:** $0.

#### WP14b: Server engine, relay registry, runtime switch (**3 T; D1 13:00 → D2 PM**)

- **Goal:** the server runs any version's compiled relay, including the gallery presets.
- **T1:**
  - `schema.ts` additions plus `drizzle/0001_relays.sql` (P§2.4 v2.1: `last_used_at`, `args_hash`/`result`, `moderation`, `sim_calls.kind`, the async draft statuses);
  - `RelayRegistry` (Drizzle), with workspaces from the visitor cookie; **create never blocks on the global cap** (LRU archive of idle non-gallery, unpublished relays; P§10.2);
  - the `/api/relays/**` routes with the quota buckets;
  - `seedGallery()` from `data/relays/*.json` and `*.presets.json` at start-up, idempotent by hash.
- **T2:**
  - `RelayEngineFactory` (LRU);
  - `CallCatalog`: generated calls, then `sim_calls` through WP17's store port, then `src/generated/sim-calls.json`;
  - `/api/cases`: relay version (incl. `relayVersionId` for presets), account record, the `UiSpec`/`listening`/`provenance` response fields; moderation before a version's first run (`moderation.ts`, free endpoint, through the OpenAI client);
  - the extractor and verifier through `compiled.extractor`;
  - the WP5 compile port → `compiled.takeover`;
  - `buildQaInput` from the compiled relay;
  - `platform-stub.ts:50` → WP12's ipKey helper.
- **T3:**
  - Express prefill for relays: cached fact events when the extractor `versionId` matches, otherwise one batched re-extraction of the cached turns (P§7.5);
  - `RELAY_ENGINE=kernel` implemented and tested with fake upstream only (no Zerops run; P3);
  - an integration parity check over Postgres (s01/s02/s05 `/compile` deep-equal to legacy; the WP3 extractor fixture replays to identical events with fake luna);
  - the Dental server path end to end (fake upstream), and the "add a field" preset.
- **Consumes:** WP14a; WP2 auth and limits (now WP12's); WP3's repository.
- **Provides:** `RelayRegistry`, `RelayEngineFactory`, `CallCatalog`, the relay routes, the switch.
- **Acceptance:**
  1. The migration applies on fresh Postgres and on Zerops; a second run is a no-op; `drizzle-kit generate` shows no diff.
  2. Route tests:
     - gallery relays are read-only (403), but their preset versions run;
     - clone works, and still works when the global cap is reached (an idle relay is archived instead);
     - a draft rev conflict → 409;
     - `snapshotVersion` is idempotent by hash;
     - workspace isolation (404 across visitors);
     - quota 429s never block a $0 action.
  3. Seed: two boots create 0 new versions.
  4. A Dental case gets the right `UiSpec`, listening and provenance, and a `<intent>_patch` extractor format; a flagged moderation result blocks the run.
  5. Kernel parity over Postgres (above).
  6. WP8's QA fixture is equal through `buildQaInput`.
- **Live budget:** $0.05.

#### WP15: Changeover Studio UI (**4 T; D2 → D3**)

- **Goal:** P§7.1–P§7.3, P§7.5.3 (the Try an edit card) and the wizard UI of P§7.4.
- **T1:** the `/studio` gallery (cards with **Run** and **Open in Studio**) and My relays; the editor shell (tabs, top bar, lint badge, autosave with rev); the **Track** view (default: rep lane, the Pass marker, AI stage cards, "What the AI inherits"); the **Case** tab; the compiled preview panel (the client-side kernel; greeting for 4 canned states, prompt per stage, tools, extractor, first update).
- **T2:** the **Listening**, **Handoff** and **Playbook** tabs (the greeting editor with drop-order preview, word/second count against 40 words; stages; disclosures; session cap; Advanced JSON import and export); lint jump-links.
- **T3:** **Try an edit** (preset diff → run the preset version, "Keep editing" → clone); the **Test** tab (call picker, TEXT DRY RUN as the default for drafted/blank relays, run plan, embedded `RelayConsole`, the hash-mismatch replay view of P§10.4); the **Connectors** tab (instances, secrets, the test console UI); the **Publish** tab UI; the wizard `/studio/new` (4 steps, async progress polling, notes, the plain "text dry run" notice for domains without a sim).
- **T4:** the **Analytics** tab (tiles with Recorded/Simulated columns plus the runs table, per-version comparison); `/r/[slug]` (the "User-made relay · fictional" banner, no mic); `STUDIO_MODE=readonly` rendering (the K-G3 fallback: "The blueprint behind Baton"); a11y and 390 px; empty and error states; the plain-words quota notices.
- **Consumes:** `RelayRegistry` routes, `compileRelay`/`lintBlueprint` (isomorphic), `RelayConsole` (WP7), and the WP16, WP17 and WP18 routes.
- **Acceptance:**
  1. Clone Dental → edit a field and the greeting → reload → the edits persist. A rev conflict shows a merge prompt.
  2. The preview updates ≤ 300 ms after an edit, and the client and server compiled hashes are equal.
  3. Lint errors disable Test and Publish and link to the offending input.
  4. Try an edit "add a field" runs on the Dental pre-generated sim inside the editor, and the QA card shows re-asked 0, newly asked 1 (e2e spec S).
  5. The wizard shows progress and opens the drafted relay on a TEXT DRY RUN; failure offers templates.
  6. `STUDIO_MODE=readonly` hides Test, Publish, Try an edit and the wizard, and keeps Track/Case/Handoff/Playbook, preview, lint and Download JSON.
  7. Lighthouse a11y ≥ 90 on `/studio` and the editor. At 390 px the tabs collapse to a select.
  8. The boundaries test passes.
- **Live budget:** $0.

#### WP16: Connectors runtime, generic tools, secrets (**3 T + WP6 hand-over; D1 13:00 → D2 PM**)

- **Goal:** P§6 (v2.1).
- **T1 (new paths only, before G2):**
  - `http.ts`: the host allowlist in production, `dns.promises.Resolver` (timeout 1500 ms, tries 1), the `ipaddr.js` `unicast` allowlist incl. embedded IPv4 forms, the pinned `lookup` honouring `options.all` with `autoSelectFamily:false`, https:443 only, no redirects, no `Accept-Encoding`, timeout, 8 KiB cap, header allowlist, HMAC signing, `responsePick` under `data`;
  - `validateToolArgs` usage;
  - the `lookup_table` parser (results under `data`);
  - the `SecretStore` (AES-256-GCM, HKDF fallback key, 7-day expiry);
  - the `connector_calls` log;
  - `/api/connectors/echo` with the fixed demo secret.
- **T2 (after G2):**
  - `RelayToolService` (stage gate, built-ins, dispatch, `(takeoverId, call_id)` idempotency, `nextStep`);
  - `payment_link` (over WP6's `PaymentService`, push mode) with **`accountToPolarCustomer`**, the generic Polar sandbox demo customer, the amount clamp and the Simulate fallback; `confirmation`, `sms_mock`, `esign_mock`;
  - `/api/tools/[name]` routing (legacy `Wp6ToolService` vs relay);
  - WP6's handler suite replayed against `RelayToolService` with Baton.
- **T3:** the `http_action` connector end to end; `/api/connectors/test` (dry runs for money connectors; the raw response capped at 2 KiB in production); the `/api/secrets` routes; secrets resolved in the relay owner's workspace; the completion webhook (SHOULD).
- **Consumes:** `CompiledRelay`, `RelayEngineFactory` (WP14b), WP6's payments.
- **Provides:** `ConnectorRuntime`, `RelayToolService`, `SecretStore`, and the executor (with the `argsHash` dedupe) that the WP18 gateway uses.
- **Acceptance:**
  1. **SSRF suite:** refuses loopback, RFC1918, link-local and metadata, CGNAT, the reserved ranges, IPv6 ULA and link-local, `::`, `100::/64`, and the IPv4-mapped, IPv4-compatible, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 and Teredo forms of private addresses; names resolving to private addresses (mock resolver); DNS rebinding (resolver flip → the pinned IP is used); `http:`, ports other than 443, redirects; a non-allowlisted host in production mode. Accepts `/api/connectors/echo` and one allowlisted public echo (live, at G3).
  2. **DoS:** a hanging resolver times out at 1.5 s while a concurrent `crypto.pbkdf2` completes (the threadpool is not blocked); a Node 22 `autoSelectFamily` connect works through the pinned lookup; a gzip response is refused.
  3. Size, time and header limits; `responsePick` flattening under `data`.
  4. HMAC verifies with the documented algorithm; the echo rejects a tampered signature or a stale timestamp.
  5. A secret value never appears in any response, log line (log-capture test), export or published config; expiry works; published runs resolve the owner's secrets.
  6. Tool parity: WP6's handler tests pass on `RelayToolService` with Baton.
  7. Dental: a lookup gives the deposit, then the payment link (mock, and Polar sandbox with the billing address prefilled), then the confirmation, which is refused before paid and succeeds after. An amount outside $1–$999 is clamped.
  8. An out-of-stage tool → `not_available`, and nothing executes.
- **Live budget:** $0.30.

#### WP17: Drafting, simulated calls, gallery templates (**4.5 T; D1 PM → D3**)

- **Goal:** P§7.4, P§7.5 (incl. 7.5.2 and 7.5.3) and the gallery templates.
- **T1:**
  - `src/server/openai/tts.ts` (pinned `gpt-4o-mini-tts-2025-12-15`, pcm 24k, `tts_cache`, cost settled from the character count);
  - the assembler (resample to 8k, mu-law, timeline, peaks, handoff times, 90 s cap);
  - the `sim_calls` store (incl. `kind`); the asset route (immutable caching); the `SimCallStore` port for WP14b's `CallCatalog`.
- **T2:**
  - `sim-script.ts` (luna, strict `sim_script`, **8–14 turns, ≤ 1200 chars**, validation, one regeneration);
  - **`data/relays/dental-deposit.json`**: drafted with the pipeline (sol, offline), then hand-curated and lint-clean, with fictional billing addresses in every sample;
  - **`data/relays/dental-deposit.presets.json`**: 2 presets ("add a required field", "change the deposit"), a 3rd SHOULD;
  - `scripts/sim/build-gallery.ts` → `public/calls/sim-dental-deposit/*`, `src/generated/sim-calls.json` with `decisionPointMs = handoff.repLineStartMs`, the `ai_clips` (incl. each preset's answer clip), and the Express caches (`pc_ctx` STT + cached fact events → `public/data/cached-turns/sim-*.json`).
- **T3:**
  - the drafting pipeline, **async** (`POST /api/drafts` → a runner job; `GET /api/drafts/:id`): `src/core/relay/draft/{schema,expand}.ts`, the luna call with `max_output_tokens` 8000, `IncompleteError` as a repair, ≤ 2 repair rounds, the compliance post-fixes (≤ 40-word greeting);
  - **TEXT DRY RUN** (`kind:"text_dry_run"`, P§7.5.2);
  - on-demand voiced `/api/sim-calls` with quotas and the ledger.
- **T4 (SHOULD):** `telecom-plan-change.json` (act = e-sign only: confirm → read the new terms verbatim → e-sign → confirm) plus its sim; **or, if Telecom is cut,** 2–3 blueprint-only cards drafted offline with sol (`data/relays/cards/*.json`, ≈ $0.06 each, lint-clean, "Template · not yet run"); a 10-desk evaluation of the wizard.
- **Consumes:** `BlueprintSchema`, `lintBlueprint`, `compileRelay` (WP14a); `RelayRegistry.create` (WP14b); the ledger and quotas (WP12).
- **Provides:** `Drafter`, `SimCallService`, `SimCallStore`, the gallery JSONs, presets and sims.
- **Acceptance:**
  1. `build-gallery` is deterministic: a re-run with a warm cache is byte-identical and $0. The handoff line is exact and the acceptance follows it.
  2. On Zerops the Dental sim's human half yields the script's facts at the pass: ≥ 80% correct VERIFIED or PENDING, recorded in `docs/notes/wp17.md` (**an internal check only**; never a deck or README metric).
  3. The gallery sim and both presets start in Express with prefilled cached turns; the "add a field" preset's AI half asks exactly the new field (fake upstream); the "deposit" preset's disclosure says $75.
  4. On-demand sims and dry runs respect the quota, reserve and settle in the ledger, and poll to `ready`.
  5. Wizard evaluation: ≥ 8 of 10 desk descriptions give lint-error-free blueprints after ≤ 2 repairs; every greeting passes C1 and G2; every disclosure is marked SAMPLE; real brands are replaced.
  6. The `sim_script` and draft schemas pass `assertStrictSchema`.
- **Budgets:** live $0.50 AssemblyAI; OpenAI ≈ $1.00.

#### WP18: Publish, published runs, analytics (**3.5 T; D1 AM probes, then D2 PM → D3 PM**)

- **Goal:** P§8 and P§9.
- **T0 (D1, S4, ≤ $0.20):**
  - **`scripts/probes/publish-p1-p3.ts`** (local; no deploy): create a stored agent with a relay prompt, no greeting, and an HTTP tool to `https://postman-echo.com/post`; run 3 sessions: `{agent_id}` → `session.update{system_prompt}` → `reply.create` greeting; measure greeting verbatim similarity and first audible (P-1); read the echoed body and **all request headers** from `tool_calls[].result` (P-2); check that the next reply follows an in-band `next_step` (P-3); delete the agent. Record the results and choose the stored-agent or inline path in `docs/notes/wp18.md`.
  - **The tightened F6 audit** in `src/server/jobs/va-audit.ts` (now WP18's): flag any running session not matched to `live_sessions`/`takeovers`, a publication run, or a count-matched dev lease, whatever its marker; any flag trips `replay_only` (P§8.4).
- **T1:** the publish service: compile the published config, `POST`/`DELETE /v1/agents` through `va-rest`, the publications table, the key hash, republish ordering, moderation and K1 checks, quotas and the global cap, the 72 h purge step; the gateway `/api/connectors/pub/:pubId/:tool` (key check, the active-run binding, `RelayToolService`, `next_step` in the body, the `(takeoverId, tool, argsHash)` 30 s dedupe, `ConnectorCtx.workspaceId` = the relay owner); the state route `GET /api/publications/:pubId/runs/:takeoverId/state`.
- **T2:**
  - `createPublishedVaController` (the stored-agent start mode in `src/client/va`; **never sends `tools`**) and the takeover wiring;
  - the `/a/[shareSlug]` page (the "User-made relay · fictional" banner; no mic);
  - F6: publication agent ids are known.
- **T3:** `RelayAnalytics` (P§9) with the Recorded/Simulated split and provenance counts; analytics fixtures **only under `tests/`**; **SHOULD:** "Hear the greeting" (P§7.5.2).
- **Consumes:** `va-rest`; `RelayToolService` (WP16); `CompiledRelay`; `RelayConsole` `mode="published"` (WP7).
- **Provides:** `Publisher`, `RelayAnalytics`, the published run mode.
- **Acceptance:**
  1. P-1/P-2/P-3 results are in `docs/notes/wp18.md` on D1, with the chosen mode and the headers AssemblyAI sends.
  2. Publish: first publish 201; republish creates a new agent and then deletes the old one (204); unpublish deletes; the redacted config has no header values; quotas and the cap hold; a flagged or K1-failing version cannot publish.
  3. Gateway: a bad key → 401; no active run → `no_active_call`; out of stage → `not_available`; a repeated call within 30 s returns the stored result and creates no second checkout; a stage change carries `next_step`; Dental tools execute.
  4. A published run (or the inline fallback) completes deposit and confirmation on the Dental sim, and F6 raises no false alarm; an unregistered session (fake `/v1/sessions`) trips `replay_only`.
  5. Analytics equals hand-computed values on a test fixture, every metric carries n and provenance, and recorded and simulated runs never blend.
  6. The 72 h purge works on a fake clock.
- **Live budget:** $0.50.

### Cut WPs

- **WP9b:** cut entirely (P§13 X1).
- **WP10:** cut. Promote is folded into WP18.

---

## 7. Budgets (before the judging epoch)

| WP | AssemblyAI $ | OpenAI $ | Main uses |
|---|---|---|---|
| Spent so far (G0–G1, WP9 smoke) | ≈1.5 | ≈0.1 | Day-1 VA tests, async, probes |
| WP7 | 0.30 | 0.02 | G2 live checks |
| WP9 | 1.00 | 0.05 | `pc_ctx` on ≤ 4 calls, handoff labels, the `TUNING_8K` check |
| WP11 | 0.80 | 0.05 | 2 recorded bundles (+ preset bundles, SHOULD), s01 clips if there is no tail pack |
| WP12 | 1.50 | 0.30 | T-D1-3 part B, live spec D3–D5, 3-concurrent smoke |
| WP14b | 0.05 | 0.02 | Dental server path smoke |
| WP16 | 0.30 | 0.02 | payment runs |
| WP17 | 0.50 | 1.00 | gallery drafting (sol, offline), sims TTS, Express caches, preset clips, wizard evaluation |
| WP18 | 0.50 | 0.02 | P-1/P-2/P-3 (D1), 2 published runs |
| Video (user) | 1.00 | 0.05 | rough + final |
| Slack | 1.50 | 0.40 | |
| **Total** | **≈9.0** | **≈2.0** | Leaves ≈$39 AssemblyAI → judging ≈$30 (balance − $5) + slack. OpenAI judging budget $4 → **≤ $7 total** |

---

## 8. Integration checkpoints

| When | Integration | Glue owner | Test |
|---|---|---|---|
| D1 11:00 | `wp/wp5` merged with main (G1 fixes); P-0 and T-D1-3 B results | WP12·0 | WP5 suite |
| D1 13:00 **C2** | v2 contracts on main (with the v2.1 items) | WP12 | typecheck |
| D1 ≈14:30 | P-1/P-2/P-3 results; the tightened audit | WP18·0 | `docs/notes/wp18.md` |
| D1 18:00 | WP14a compile parity on `wp/wp14a`; WP14b registry on `wp/wp14b` | WP14a/b | parity suite; route tests |
| D1 22:00 **G2** | WP5 + WP5b + WP4 + WP6 + WP7 on `/call/<s01>` (Express) — Baton only | WP7, WP12 | the Baton slice on Zerops |
| D2 10:00 **K-B** | The live Baton slice | WP12 | pass → the platform plan continues; fail → S3/S5 fix Baton |
| D2 11:00 | Widening commit on main; every branch merges main | WP14a, WP12 | typecheck on every branch |
| D2 13:00 | `CallCatalog` + the Dental gallery sim + presets + `RelayToolService` + `RelayConsole` | WP14b, WP17, WP16, WP7 | the Dental run and the "add a field" preset, fake upstream |
| D2 22:00 **G3** | Everything above on Zerops, live | WP12 | the G3 criteria |
| D3 12:00 **K-G3** | The platform slice | WP12 | pass → full Studio; fail → `STUDIO_MODE=readonly` |
| D3 13:00 | Studio Test tab + Try an edit + publish + share page + analytics | WP15, WP18 | spec S |
| D3 19:00 **G4** | The full judge path | WP12 | specs 1/S/R + the live spec |

---

## 9. Kill criteria and fallbacks

| Check | When | Pass | If it fails |
|---|---|---|---|
| **K-B Baton slice** | D2 10:00 | The live Baton slice passed on Zerops | S3 and S5 switch to Baton fixes until it passes; WP16·2 and WP7·3 slide by that much. Baton outranks every platform task |
| **K-P1 publish** | **D2 10:00** (the probes run on D1) | P-1 greeting similarity ≥ 0.95, P-2 tools arrive with the body and key, P-3 the next reply follows `next_step` (3 of 3) | The share page uses the inline session (labelled); the stored agent stays as the API handle |
| **K-P parity** | D2 16:00 | 0 diffs (P§4.6) | Baton stays on legacy anyway (P3). The Studio shows the Baton blueprint labelled "reference · parity N of M", and the deck states "N of M parity checks" honestly. Generic relays are unaffected |
| **K-S sims** (internal) | G3 | The Dental sim reaches ≥ 80% correct facts at the pass, and the run completes | Hand-tune the script (slower pauses, clearer lines, `telephony_8k` tuning); keep only curated pre-generated sims; on-demand voiced sims move to SHOULD 8 |
| **K-G3 platform** | **D3 12:00** | The Dental relay is end to end on Zerops, and Studio Test (spec S) is green | **Baton-first fallback** (P§13.4): `STUDIO_MODE=readonly` ("The blueprint behind Baton"); Test, Publish, Try an edit and the wizard hidden; the landing page has only "Watch the handoff"; the platform video beat is 15 s; freed slots go to Baton polish, the bundles and the pitch |
| **K-D drafting** | D3 12:00 | ≥ 8 of 10 lint-clean | The wizard becomes "pick a template + rename + fill disclosures" (the deterministic expand only), or sol with 1 draft per visitor per day |
| **K2 handoff latency** (v1.1, measured from real runs' QA, not a sweep) | G3 | Dead air p50 ≤ 0.5 s; the early pass completes | v1.1 remedies (pre-open, `leadMs`); the greeting is already ≤ 40 words (lint G2) |
| **Late overall** | any gate slip > 4 h | — | Cut in the P§13.3 SHOULD order; never below P§13.2 |

---

## 10. Day-1 recording session (D1 10:00–14:30, user + volunteers)

The procedure is unchanged: `docs/recording-day.md` and v1.1 §5. What changed for v2.1:

**The rep's handoff line (changed; P§1.3, P§11):** in every take, the rep says
> **"OK if my assistant finishes the paperwork? I'll be one tap away if you need me."**

and then stops talking, as before. The kit and `data/scenarios/*.json` still print "…I'll stay on the line"; say the new line anyway (a sticky note on the rep's screen helps). That older wording promises the rep stays, which contradicts the freed-rep-time value. Takes already recorded with the old line stay usable, but **s01 must carry the new line** in at least one publishable take. WP9's labels accept either wording.

**Order (fewer takes are needed now that the sweep is cut):**
1. sound check;
2. **s01 twice** with the new line (keep the better one; the pair must be `"scope":"public"`);
3. **the tail pack** immediately after (same two people);
4. s02, s05;
5. one declined call (s03 or s14);
6. the corrections block;
7. the rest only if time allows. The Hinglish takes are optional.

**Rules that matter:** the rep's handoff line must be clear and followed by a pause, and the acceptance must be spoken clearly ("Sure, go ahead"), because both are cut from the recording and replayed.

**By 15:00:** `.\kit report`, then tell the build session which takes are public **and which handoff line s01 used**. WP9 runs `calls:build` and the handoff labels; the user reviews the handoff labels for ≤ 4 calls (≈10 min, D2 by 10:00).

---

## 11. What the user must do

| When | Action |
|---|---|
| **D1 now, before the first take** | **Tell the rep to say the new handoff line** (§10): "OK if my assistant finishes the paperwork? I'll be one tap away if you need me." |
| **D1 now** | **Set the Zerops app secrets in the GUI** (`docs/notes/deploy.md` "Secrets", steps 1–2; `g1.md` "Deploy"). This blocks every live feature at G2. Set an OpenAI hard usage limit ($10). Recording 10:00–14:30 |
| D1 15:00 | `.\kit report`; say which takes are public and which handoff line s01 used |
| D1 by 18:00 | Answer P§14 Q1–Q9 (defaults apply otherwise), including Q9 (Team slide names and roles) |
| D1 22:00 | Approve the G2 merge and push (or delegate it to WP12) |
| D2 by 10:00 | Review the handoff labels (≤ 4 calls). Register the Polar webhook, set `POLAR_WEBHOOK_SECRET` and the embed allowlist (DESIGN §10.2), and set `PAYMENTS_MODE=polar` with the product variables (incl. the generic relay demo customer, WP16·2) |
| D3 12:00 | Confirm the K-G3 decision (full Studio or the Baton-first fallback) |
| D3 20:00 | Record the rough video from WP13's shot list (P§12.3). Approve the landing copy |
| D4 19:00 | Record the final video on the Zerops URL (provenance strip visible) |
| D5 | Edit the video; approve the slides, cover and README |
| D6 08:00 | Set `LEDGER_EPOCH`, `AAI_JUDGING_BUDGET_USD` (dashboard balance − $5) and `OPENAI_JUDGING_BUDGET_USD` ($4); check `/status` |
| D6 10:00 | Submit on lablab |
| Oct 1–21 | Each morning, post the AssemblyAI balance (`/api/admin/flags {aaiBalanceUsd}`), glance at the OpenAI usage page and at `/status`; if the F6 audit tripped `replay_only`, look at the flagged session before clearing it |
