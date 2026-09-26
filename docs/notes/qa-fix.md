# QA-FIX notes: the two QA passes' blockers and majors (integrator, D2 Sat Sep 26, ≈22:45–00:15 IST)

**Status: every blocker and every major from both reports is fixed and re-verified on the production build.**
Typecheck clean; `npm test` is **3468 passed, 0 skipped (229 files)** — up from 3397/223, with **no test
weakened**. `npm run build` is OK and the artefact went from **4045 files / 319.1 MiB to 2967 files / 88.7 MiB**.
All four migrations apply on a throwaway database and re-run as a no-op.

Two independent QA passes ran the product end to end: a **judge-path** run (4 PASS · 8 FAIL · 2 N/A) and an
adversarial **break-it** run (4 blockers, 3 majors, 3 minors). Between them they found nine distinct defects.
Eight of the nine are invisible to `next dev` and to the unit suite — they live in the *deploy artefact*, in the
*boot wiring*, or in Next's **duplicate module graph** — which is why this file is long: each section says what
made the bug unobservable, not only what changed.

Nothing live was called: **$0 AssemblyAI, $0 OpenAI, $0 Polar, $0 Zerops.** **Not pushed and not deployed** —
the orchestrator owns both.

---

## 0. The two root causes behind five of the findings

Before the table, the two patterns worth remembering, because both will recur.

### 0.1 One process, two copies of a class — `instanceof` is not identity

Next loads a module graph more than once (the server-component graph, each route's chunk, dev reloads). An
object built by one copy of a class fails `instanceof` against the other. `src/server/read-models/app-guard.ts`
already had to learn this at G3 and left the comment; nothing generalised it. It caused **three** of this
round's findings:

| Symptom | Where the `instanceof` was |
|---|---|
| cross-tenant `PUT`/`DELETE /api/relays/:id` → **500** while the log showed the correct `BatonError E_NOT_FOUND` | `src/server/relays/http.ts` (thrower: `registry.ownRow`, a different chunk) |
| `POST /api/internal/limits/*` → **404 "Not the limits authority."** on the process that *is* the authority, while `/api/admin/ledger` worked in the same process | `getDbAuthority()` in `src/server/limits/index.ts` |
| the boot registration of the scenarios would have silently no-opped | `registerGeneratedData` in `src/server/data/index.ts` |

**The rule now:** every cross-module error and singleton is recognised by **brand** — `name` + a code the
contract knows, or an explicit `readonly isX = true` — never by `instanceof` alone. `isBatonError`,
`isSaasError`, `isRelayError`, `isSecretError`, `isConnectorError`, `isDbLimitsAuthority` and
`isOrgConnectorHostPolicy` all follow it, and each keeps `instanceof` as its first (fast, exact) leg. The duck
leg is deliberately narrow: a `pg` error with `code: "23505"` or a plain `Error` with a stray `.code` is **not**
ours and still becomes a logged 500. `tests/unit/server/error-identity.test.ts` builds the "foreign twin" —
same shape, unrelated prototype — that vitest cannot otherwise produce, because in vitest there is only ever
one module instance.

### 0.2 A registry with no caller is a default that looks like a feature

Three ports existed, were tested, and were never wired: the generated **scenarios**, **billing**, and (found
during re-verification) the v3 `SaasError` branch in the v1/v2 route wrappers. Each one degraded *silently* to
its safe default, and each default was indistinguishable from "configured correctly" from the outside — the
billing page even rendered "Polar Sandbox (Test Mode)" while the provider was simulated. `src/instrumentation.ts`
now carries **six** `[WIRE-*]` steps, and `tests/unit/platform/instrumentation.test.ts` asserts each one by
observing the *effect* (a scenario resolves; the entitlements port is no longer the C3 in-memory default), not
by spying on the call.

---

## 1. What was fixed

Ten fixes; every one has a regression test, listed with it.

| # | Report | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | both | **Blocker** | `/` 404'd — `src/app/page.tsx` never existed | `tests/unit/app/landing-page.test.tsx`, `tests/unit/app/links-resolve.test.ts` |
| 2 | break-it #2 | **Blocker** | cross-tenant relay `PUT`/`DELETE` → 500 instead of 404 | `tests/unit/server/error-identity.test.ts` |
| 3 | both | **Blocker** | scenario `s01` missing from the bundle — the whole guest demo dead | `tests/unit/platform/instrumentation.test.ts`, `tests/unit/platform/deploy-config.test.ts` |
| 4 | break-it #4 | **Blocker** | `bundle/` contained itself 10 levels deep (235 MB of 329 MB) | `tests/unit/platform/deploy-config.test.ts` |
| 5 | break-it #5 | **Major** | the per-IP limiter was bypassed by a spoofed `X-Forwarded-For` | `tests/unit/server/auth/client-ip.test.ts`, `tests/unit/server/limits/platform-routes.test.ts` |
| 6 | break-it #6 | **Major** | `POST /api/internal/limits/*` 404'd on the authority | `tests/unit/server/error-identity.test.ts` |
| 7 | break-it #7 | **Major** | Firefox logged a CSP `eval` violation on `/app`, `/call`, `/studio` | verified in both browsers (§3) |
| 8 | judge (k) | **Major** | billing had **no path to Pro at all** in either mode | `tests/unit/server/billing/wiring.test.ts`, `tests/unit/platform/instrumentation.test.ts`, `tests/unit/server/billing/routes.test.ts` |
| 9 | judge (j2) | **Major** | an invited second account ended with 1 workspace, not 2 (a G3 criterion) | `tests/unit/app/accept-invite-workspace.test.tsx` |
| 10 | judge (i) | **Major** | the Studio's **Publish** and **Test** buttons were dead controls | `tests/unit/studio/top-bar-actions.test.tsx` |

Plus one defect **found while re-verifying** these (§2.11) and the minors in §4.

### 1.1 `/` 404'd (blocker, both reports)

`src/app/page.tsx` had never existed on any branch (`git log --all -- src/app/page.tsx` is empty). `landing.ts`
and `about.ts` were written, reviewed and enforced by `tests/unit/content/wording.test.ts`, and not one word of
them reached a browser. Sign-out redirects to `/`, so it 404'd too.

- `src/app/page.tsx` is the route (metadata + the one async thing: which recorded call the CTA opens);
- `src/components/marketing/{landing,rich-text,status-pill}.tsx` is the markup. `Landing` is **synchronous and
  takes its links as props**, so the whole page is assertable with `renderToStaticMarkup`.
- **Every word comes from `src/content/**`.** A sentence typed into the JSX would be a marketing claim outside
  the wording test's reach, so the test asserts the *absence* of the h1 literal in the route file as well as its
  presence in the render.
- The status pill renders the "unavailable" wording first and upgrades on `/api/status`, so a dead API cannot
  keep the landing from rendering (WP7b acceptance 1) and the server never waits on it.
- Landmarks are deliberate: one `<main>`, every `<section>` labelled — the axe `landmark-one-main` and two
  `region` violations the break-it pass reported *were* this page's absence.

### 1.2 Cross-tenant relay writes answered 500 (blocker)

§0.1. `relayRoute` now uses `isSaasError` / `isRelayError` / `isBatonError`. Verified live: `DELETE` and `PUT`
on another org's relay both answer **404 `E_NOT_FOUND`**, the row survives, and a genuinely unknown error is
still a leak-free 500 (the test asserts the word "password" never reaches the body).

The same predicates replaced the bare `instanceof` in **nine** wrappers: `auth/http.ts`, `cases/http.ts`,
`draft/http.ts`, `identity/{app-http,routes}.ts`, `payments/http.ts`, `publish/routes.ts`, `qa/routes.ts`,
`relays/http.ts`, `secrets/routes.ts`.

### 1.3 Scenario `s01` never reached the bundle (blocker — the centrepiece)

`FsCaseDataSource.getPolicy` reads `src/generated/scenarios.json`, falling back to `data/scenarios/<id>.json`,
**by a computed relative path** — which Next's tracer cannot see. `src/server/data/index.ts`'s own header says
these files are "imported, never fs-read… REGISTERED (`registerGenerated`, G1 wiring)", and the G1 wiring was
never done. So on the built server every `POST /api/cases` answered `404 "Unknown scenario s01."` and the UI
said "This call isn't available". `next dev` reads both files off the live checkout, so it was perfect there.

Three locks, in order of strength:

1. **`[WIRE-SCENARIOS]`** in `src/instrumentation.ts` statically imports `src/generated/scenarios.json` and
   calls `registerGeneratedData`. A static import travels inside the JS chunk: no cwd, no file tracing, nothing
   to forget.
2. `registerGeneratedData` is duck-typed (§0.1), so a duplicate module graph cannot drop the registration.
3. `outputFileTracingIncludes["/api/cases"]` now lists `./src/generated/scenarios.json` and
   `./data/scenarios/*.json`, so the **fs fallback** is honest too.

Verified live on the built server: `POST /api/cases` → **200**, and `bundle/src/generated/scenarios.json` plus
`bundle/data/scenarios/` are in the artefact. The instrumentation test points the data source at an empty
directory first, so it proves the *registration* rather than the files.

### 1.4 `bundle/` contained itself (blocker)

`next build` traces the working tree **before** `assemble-bundle.mjs` deletes the previous `bundle/`, so each
unclean rebuild nested one level deeper. Fixed three ways: `./bundle/**` in `outputFileTracingExcludes`; a
`node scripts/assemble-bundle.mjs --clean` step **before** `next build` in the `build` script; and an assertion
at the end of `assemble-bundle.mjs` that fails the build if `bundle/bundle` ever exists again. The `--clean`
step warns rather than fails when the directory is locked (a running server on Windows holds it) — refusing to
build over that would be worse than building, and the assertion is the check that actually matters.

**Result: 4045 files / 319.1 MiB → 2967 files / 88.7 MiB.** `./spikes/**` was being swept in through the nested
copy too, which is why the excludes list looked like it was not working.

### 1.5 The per-IP limiter was bypassed by a spoofed `X-Forwarded-For` (major)

A 40-request burst tripped `ipkey_hour`; 10 more with 10 attacker-chosen `X-Forwarded-For` values all got
through. `clientHop`'s `real-ip` mode fell back to the rightmost XFF entry, which is only the balancer's hop if
a balancer actually appended it — and nothing in the process can tell an appended hop from a forged one.

`real-ip` (the default) now reads **`X-Real-IP` only**, and otherwise answers `"unknown"`: one shared bucket,
exactly what a header-less request already got. The fallback is still available as an explicit operator
assertion — `IPKEY_TRUST_XFF=1`, or the `xff-right` mode, which says the same thing by its name.

**No deployment change is needed:** both supported edges set `X-Real-IP` themselves and overwrite any client
value (Zerops's L7 balancer per its docs; Vercel likewise). What changed is what an *unproxied* process is
willing to believe. Verified live: 62 requests with rotating XFF values trip one bucket, three further spoofed
values stay 429, and a request with `X-Real-IP` still gets its own bucket.

Two existing tests asserted the old fallback. Both were **corrected, not removed**, and both now cover more
than before (the trusted-proxy leg as well as the untrusted one).

### 1.6 The internal limits API 404'd on the authority (major)

The reporter could not root-cause this black-box and flagged it as possibly "another instance of finding #2's
bug class". It was exactly that: `getDbAuthority()` tested `instanceof DbLimitsAuthority` against the *other*
copy of the class, returned null, and the route answered its own `404 "Not the limits authority."` — the same
message `requireLimitsKey` produces, which is what made it look like an env problem. `/api/admin/ledger` worked
because its chunk happened to hold the copy that built the singleton.

`DbLimitsAuthority` now carries `readonly isDbLimitsAuthority = true` and `getDbAuthority` brand-checks it.
Verified live with `LIMITS_ROLE=authority`: `POST /api/internal/limits/summary` answers **200** with the key and
still **403** without it. **The documented remote kill-switch path works again.**

### 1.7 Firefox blocked an `eval` under the shipped CSP (major)

Not Monaco (the report's hypothesis). It is **zod 4's JIT feature probe** —
`try { Function(""); … } catch { … }` in `node_modules/zod` — which decides whether to compile validators with
the `Function` constructor. Under our CSP it always throws, zod always falls back, and nothing is broken; but
Firefox logs a hard red error on three of the four pages a judge opens, on a product whose pitch includes
"trust by design". Chromium does not report a caught `Function()` the same way, which is why only Firefox saw it.

`src/components/common/zod-jitless.tsx` sets `config({ jitless: true })` in the **client** bundle (rendered once
by the root layout), so the probe never runs. Validation behaviour is identical — the JIT is a performance
optimisation over the same checks — and the server keeps its JIT, since the server has no CSP. Verified in
Firefox **and** Chromium on `/`, `/app`, `/call` and `/studio`: **zero CSP violations, zero console errors**,
and Monaco still loads and renders (`.monaco-editor` present, line numbers drawn).

### 1.8 Billing had no path to Pro at all (major)

Two independent faults that together sealed a dead end on a *correctly configured* deployment:

1. **`registerBilling()` was never called by anything.** It is the only thing that hands `getBilling()` the
   Better Auth `checkout` endpoint, so the provider always degraded to simulated. → `[WIRE-BILLING]` in
   `src/instrumentation.ts`, with a lazy resolver (it builds no auth instance and opens no connection at boot).
2. **The page and the buttons read different things.** `billingViewOf` and `postCheckout` reported
   `billingMode()` (pure env → "polar") while the provider had degraded to simulated, and
   `postSimulatedConfirm` *refused* the simulated path for the same reason. Upgrade went to the simulated
   checkout; confirming there answered "Billing is configured on this deployment; use the real checkout".
   → both sides now read `effectiveBillingMode()` = `getBilling().mode`.

Also: the resolver is held on `globalThis` (like `src/server/saas/ports.ts`'s registry), so the boot
registration cannot be lost to a duplicate module graph — the failure §0.1 describes, waiting to happen.

**A consequence worth stating plainly:** a deployment whose env says Polar but whose plugin will not mount now
falls back to the *labelled* simulated checkout instead of refusing both paths. That is SAAS §4.7's designed
degradation ("K-BILL trips → simulated"), the badge still reads "Pro · simulated" and the row's `source` is
still `simulated`, so nobody is told they bought something real. The alternative is the dead end.

Verified live with a mounted plugin: `GET /api/app/billing` reports `"mode":"polar"` and the simulated confirm
is refused with **409 `E_CONFLICT`** — *because a real checkout exists*, which is what that refusal always
meant. No Polar call was made (nothing clicked Upgrade); `tests/unit/server/billing/routes.test.ts` covers both
directions against the real DB.

### 1.9 An invited second account got one workspace, not two (major, a G3 criterion)

TASKS-v3 §4 requires "an invite link accepted by a second account → the switcher shows 2 orgs", and SAAS §3.1
says "a new account lands in its auto-created personal org". G3's own check passed because that account signed
up *first* and accepted afterwards. A judge does it the other way round: open the link, "Create an account to
join", sign up, join — and by the time `/app` first resolves, B already holds the inviter's org, so
`appContextOrNull`'s "signed-in user with **no** org" branch never fires and no personal workspace is ever
created, then or later.

`ensureOwnWorkspace(userId)` (in `app-guard.ts`, wrapping the unchanged idempotent `ensurePersonalOrg`) is
called by `/accept-invite/[id]` when the visitor is signed in — one page *earlier*, before the membership that
hides the gap exists. It is a no-op for a guest (anonymous users are refused, so SAAS §2.2's "guests own
exactly 1" holds and the carry-over is untouched) and it never fails the invitation card.

Verified live end to end through the real Better Auth endpoints: owner signs up → invites → invitee signs up →
opens the card → accepts → `GET /api/app/orgs` returns **2**.

### 1.10 The Studio's Publish and Test buttons were dead controls (major)

Both `<Button>`s rendered enabled with no `onClick`: a click produced no request, no dialog, no toast. The
actions are WP15·3's and have not shipped — which the Publish **tab** already says honestly. An
enabled-looking button that swallows the click is not the same thing, and a judge cannot tell the difference
from the outside.

They now navigate to their tabs. A lint-blocked action stays a **real disabled `<button>`** rather than a
styled link, because `disabled` means nothing on an anchor — the detail that turns a fix into the next bug.
WP15·3 replaces the hrefs with its own handlers.

### 1.11 Found while re-verifying: `POST /api/cases` answered 500 for its own guard

Re-running finding #3 on the built server showed `POST /api/cases` → **500 `E_INTERNAL`** while the log read
`SaasError E_CSRF: This request did not come from the app`. The v1/v2 wrappers predate `SaasError` and only
knew `BatonError`, but `requirePrincipal` — and its same-origin check — is v3 and is called from v2 routes. So
a cross-origin `POST /api/cases` and a foreign `relayId` both answered 500 instead of 403/404.

`isSaasError(e) → saasErrorResponse(e)` added to `auth/http.ts`'s `handler`, `cases/http.ts`, `payments/http.ts`
and `qa/routes.ts`, which is the ruling `relays/http.ts` already took at WP14b·4. Verified live: a foreign
`relayId` is now **404 `E_NOT_FOUND`**.

---

## 2. Minors: fixed

| From | Fix |
|---|---|
| break-it #8 (axe, **serious**) | `/call`'s case-card scroller was unreachable by keyboard (`scrollable-region-focusable`). It gets `tabIndex`/`role`/`aria-label`, as `transcript-lanes.tsx` already had. Three Studio preview panes and the compiled-preview pane had the same defect and are fixed with it |
| break-it #8 (axe, moderate) | `/studio` had **two** `<main>` landmarks: the Studio components render one inside the app shell's `#cx-main`. The nested ones are `<div>`s now (`editor-shell`, `relays-list`, `new-relay`; `public-relay` keeps its `<main>` — `/r/[slug]` is a standalone page) |
| break-it #8 (axe, moderate) | the app shell's guest/degraded notice sat between `<header>` and `<main>` in no landmark; it is wrapped in `<aside aria-label="Workspace notice">` |
| break-it #8 (axe, minor) | `role="log"` is not an allowed role for `<ol>`; the live region moved to a wrapper so the list keeps its list semantics |
| break-it #9 | `DELETE /api/secrets/:id`'s always-204 is now documented **at the handler**, with the reason (any difference between "deleted", "not yours" and "never existed" is a free existence oracle over `sec_…` ids) |
| judge (l)/(m), g3.md §6.3 | the settings nav listed **four** rows whose pages did not exist — API keys, Webhooks, Usage, CLI & SDK — so the nav 404'd and `/app` logged two prefetch errors on every load. Each now has an honest placeholder naming the WP that owns it, the same ruling `src/components/studio/tabs.ts` already took. Each owner replaces its own file wholesale |
| judge (minor) | `/legal/terms` 404'd **from the sign-up form** — "by creating an account you agree to the terms", 404. It is now a real page that invents no legal text: WP13's reviewed honest-limits and privacy copy, plus the plain statement that this is a hackathon demo with no contract behind it |
| (found here) | `/docs` 404'd from the app shell's top bar on every `/app` page. Placeholder, pointing only at things that exist today |

`tests/unit/app/links-resolve.test.ts` is the guard for that whole class: it walks every literal `href="/…"` in
`src/**` plus WP13's copy links and asks the filesystem. It would have caught `/` itself. A link to a page a WP
has not merged is fine — but then *something* has to exist at that path saying so.

---

## 3. Verification: what was actually run

Production build (`npm run build` → `node bundle/server.js`, `NODE_ENV=production`, port 3310) against a
**freshly created and migrated throwaway database** (`baton_qafix` on the existing `baton-pg` container),
`TENANCY_MODE=orgs`, `E2E_FAKE_UPSTREAM=1`, `LIMITS_ROLE=authority`, and fake-but-well-formed `POLAR_*` values
so the Polar plugin mounts. **No Polar, AssemblyAI or OpenAI call was made** — nothing clicked Upgrade and no
STT/VA session was opened.

**22/22 HTTP checks passed**, run three times across three rebuilds:

| Check | Result |
|---|---|
| `GET /` renders the landing (h1, one `<main>`) | PASS |
| `POST /api/guest/start` → guest workspace with its relays | PASS |
| `POST /api/cases` resolves **s01** | PASS (was `404 Unknown scenario s01.`) |
| the call console renders (no "This call isn't available") | PASS |
| `DELETE` / `PUT` another org's relay | **404**, was 500 |
| `GET` another org's relay; the row survives the write attempt | PASS |
| `POST /api/cases` with a foreign `relayId` | **404**, was 500 |
| `POST /api/internal/limits/summary` with the key / without it | **200** (was 404) / 403 |
| `GET /api/app/billing` mode | **polar**, and the simulated confirm 409s *because* of it |
| rotated `X-Forwarded-For` against a tripped bucket | stays 429; `X-Real-IP` still gets its own bucket |
| invite → second account signs up → accepts → `GET /api/app/orgs` | **2 orgs** (was 1) |

**Browser pass, Chromium and Firefox** (Playwright 1.63), on `/`, `/app`, `/call` and `/studio`:

| | before | after |
|---|---|---|
| CSP `eval` violations (Firefox) | 1 per page on `/call`, `/studio` | **0** |
| console errors | 2 × 404 prefetch on `/app` | **0** |
| `<main>` landmarks per page | 2 on `/studio` | **1** everywhere |
| scrollable regions with no keyboard access | 1 on `/call`, 4 on `/studio` | **0** |
| WCAG AA contrast failures (in-page sweep) | — | **0** |
| Monaco on the Code tab | loads | still loads, both browsers |

The a11y sweep is computed in-page from the live DOM (no external script is loaded into the page, and no
dependency was added): it walks every text node, resolves the effective background, and applies the WCAG AA
thresholds. It is not a substitute for a full axe run — it checks contrast, landmarks and scrollable regions,
which is the set the break-it pass flagged.

Repeatable: `qa-artifacts/qa-fix-browser-check.mjs` (git-ignored) and the HTTP script in this session's
scratchpad. Results in `qa-artifacts/qa-fix-browser.json`.

### Checks on `main`

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **3468 passed, 0 skipped (229 files)** — parity, SSRF and tenancy all green, tenancy included in the run |
| `npm run build` | OK — **2967 files, 88.7 MiB** (was 4045 / 319.1), no nested `bundle/`, scenarios present in the artefact |
| migrations, fresh throwaway DB | `applied: 4, publicTables: 40`; second run `applied: 0` (no-op). Dropped afterwards |
| pre-commit key scan | ran on the commit and blocked nothing (§5) |
| conflict markers | none |

**One flake worth naming, not a regression:** `tests/unit/core/relay-code/roundtrip.test.ts` (200 random form
edits ×2) timed out twice at 20 s during a full-suite run on a loaded machine, and passes in 12.9 s when its
file runs alone. It is a property test near its own timeout, not a behaviour change; if it recurs, raise that
file's `testTimeout` rather than shrinking the run count.

---

## 4. Merges and worktrees

**No branch had unmerged commits** (`git rev-list --count main..<branch>` is 0 for all 27), so there was nothing
to merge and the `QA-FIX: merge wp/<wp>` form was never needed. Every fix is a direct commit on `main`.

`git merge --no-edit main` then ran in all **27** `.wt/**` worktrees. Every one was clean, none had unmerged commits, and every one **fast-forwarded to `2a4731c`** with no conflicts and nothing aborted.

---

## 5. The pre-commit key scan

`scripts/ci/staged-key-scan.mjs` **blocked nothing** on this commit. The brief's two known offenders
(`tests/unit/core/relay-code/codec.test.ts`, `tests/unit/server/secrets/secret-store.test.ts`) were already
rewritten to runtime-built values at C3b (`c3b.md` §2.5) and are still clean. The new tests follow the same
rule by construction: `tests/unit/server/billing/wiring.test.ts` builds its fake Polar token as
`["polar", "oat", "w".repeat(24)].join("_")`, and the verification harness builds its keys the same way. The
hook was never bypassed, and no secret value appears in this file or in any test.

---

## 6. Still open after QA-FIX

1. **The Zerops half is unverified** — by instruction, the orchestrator pushes and deploys. Everything in §3 is
   the local production build.
2. **WP22 / WP24 / WP23 / WP21·2 are still unmerged**, so API keys, Webhooks, CLI & SDK and Usage are honest
   placeholders rather than features. Unchanged from `g3.md` §6.3; the difference is that they no longer 404.
3. **`/pricing` and `/changelog` do not exist** and nothing links to them (`links-resolve.test.ts` proves it).
   They are WP7b·2's, as are the real `/docs` and `/legal/terms`.
4. **`POST /api/auth/sign-out` answers 415 when called with no JSON content-type.** That is Better Auth's own
   contract, the UI's button sends the right headers and works, and no product surface is affected. Not fixed.
5. **The account menu briefly shows "No account yet" right after a successful sign-up** (judge report, cosmetic).
   The panel renders from the server-rendered viewer until the client refetches. Not fixed; it is one frame of
   stale copy on a path the judge passes through once.
6. **`IPKEY_TRUST_XFF` is not in `.env.example` or `zerops.yml`**, because `IPKEY_MODE` is not either — both are
   read straight from `process.env` and both default safely. Named here so the knob is findable.
7. **The in-page a11y sweep is not axe.** A full axe run needs `axe-core`, which is not a dependency of this
   repo and was not added for a QA pass. The three rules the break-it report flagged are covered; the rest of
   axe's catalogue is not re-checked.

---

## 7. Cleanup

The throwaway database (`baton_qafix`) was dropped and the local production server stopped. `qa-artifacts/` is
git-ignored and keeps the browser-check script and its JSON. Nothing was pushed and nothing was deployed.
`.env` was never modified — every QA value was passed to the one throwaway server process.
