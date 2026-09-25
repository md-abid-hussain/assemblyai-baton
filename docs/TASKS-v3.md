# Changeover: work packages v3.1 (SaaS + low-code delta on TASKS-v2)

**v3.1** (D1, after two reviews): §1 re-checked against live `git`; a **C3b-VERIFY checkpoint at D2 12:00** with a **K-VERIFY** branch and **0.5 T of reserved D2 float**; two user actions (the Polar sandbox-org member, `LEDGER_JUDGING_WINDOW_IST`); a re-cut rule for a video beat whose P3 feature is cut. Decisions in **§12**; the spec-side decisions in S§17.

This is a **delta** on `docs/TASKS-v2.md` (v2.1). The spec it implements is `docs/SAAS.md` v3.1 (cited as "S§"). "P§" points to `docs/PLATFORM.md` v2.1 and "T2§" to `docs/TASKS-v2.md`.

**What this file replaces in TASKS-v2:**
- the slot plan (T2§3.2) from D1 15:30 on;
- the gates table (T2§3.1) from C3 on (G2 is unchanged);
- the WP15 content (T2§6);
- the SHOULD cut order (P§13.3), replaced by the **priority order in §3**.

**What it adds to TASKS-v2:** rows to the ownership map (T2§4), the kill criteria (T2§9) and the user's actions (T2§11). Everything else in TASKS-v2 still holds: the ground rules, the v2 contracts, the WP acceptance lists not changed below, the budgets, and the recording procedure.

**Deadlines (unchanged):** feature freeze Mon Sep 28 22:00 · deploy freeze Wed Sep 30 08:00 · **submit Wed Sep 30 10:00 IST** (lablab closes 20:30).

**Capacity:**
- about **50 T** from now to submission, fixes included (1 T ≈ one 3 h agent unit ending in a green commit and a notes section);
- **≤ 5 agents at once**;
- about 7–10 T per 5-hour usage window.

---

## 1. Current state (D1 Fri Sep 25, re-checked against `git` at ≈ 15:15 IST)

`main` = **`c913c63`**. The parallel branch has landed most of G2: seven merge commits (`wp12`, `wp5`, `wp6`, `wp7`, `wp9`, `wp18`, `wp13`), on top of G1 + C2. **Nothing is pushed beyond `main`'s last push; the orchestrator pushes.**

| Branch | vs `main` (`c913c63`) | State |
|---|---|---|
| `main` | — | G1 + C2 + the seven G2 merges. **`wp14a` and `wp14b` are not merged yet**, so `drizzle/` still holds only `0000_init.sql` |
| `wp/wp5`, `wp/wp6`, `wp/wp9`, `wp/wp12`, `wp/wp13`, `wp/wp18` | nothing unique, 0 behind | **merged into `main`**. Their next units branch from `main` |
| `wp/wp7` | 0 / 0 | **WP7·2 merged**; the worktree already sits on `c913c63`. WP7·3 starts from it as-is |
| `wp/wp14a` | **+23** / 0 behind | **WP14a·3 is done** — the tip is `ff2105f` ("WP14a·3 completion audit … typecheck clean, 1570 tests, oracle up to date"). `main` is merged in. **Ready for the G2 merge now** |
| `wp/wp14b` | +15 / 0 behind | WP14b·1 + ·2 done (**migration `0001_relays`**, registry, routes, seed, engine wiring, moderation). `main` is merged in. **Ready for the G2 merge now** |
| `wp/wp16` | +7 / 74 behind | WP16·1 done (the connector runtime core, SSRF, `SecretStore`, `ipaddr.js`). Merge `main` first |
| `wp/wp17` | +5 / 74 behind | WP17·1 done (TTS, assembler, `sim_calls`, the empty `src/generated/sim-calls.json`). Merge `main` first |
| `wp/wp7b` | 0 / 138 behind | untouched since G0; starts with `git merge main` (a fast-forward) |
| WP15, WP19–WP24 | — | no worktree yet; created from `main` after C3 (§2 rule 11) |

**What this changes against the v3.0 draft of this section:** `wp14a` is at +23, not +21, and **WP14a·3 has already finished** rather than being in flight. So the parallel branch's remaining G2 work is only *merge `wp14a` → merge `wp14b` → deploy*, and the C3b dependency (`0001_relays` on `main`) is one merge away, not two units away. `docs/notes/g2.md` does not exist yet; the integrator writes it at the G2 merge, and it is the file to read before C3b rather than this table.

**The parallel branch of this workflow** (not re-planned here): WP14a·2 and ·3 are **done**; what is left is the **rest of G2** — merge `wp14a`, merge `wp14b`, deploy. It occupies **two slots until ≈ 22:00 D1**; the slot plan (§5) leaves them free. Because WP14a·3 finished early, the `wp14a` slot may free up before 18:30; if it does, the integrator uses it for the G2 merge rather than starting anything new (§5's D1 15:30 row assumes it is busy, so an early finish is pure float).

> **The one dependency to watch.** `0001_relays` is on `wp/wp14b`, not on `main`. **C3b (D2 15:00) cannot generate `0002_saas` until `0001` lands** (§2 rule 14), and G3's SaaS criteria sit behind C3b. If the `wp14b` merge slips past **D2 09:00**, the integrator merges `wp/wp14b` alone (it is green and has `main` merged in) rather than waiting for the full G2, and WP19·2 is told the moment it lands. WP19·1 (C3) does not depend on it.

**Untracked on `main`:** `docs/SAAS.md` (this spec) and `docs/TASKS-v3.md`. The integrator commits both with C3.

---

## 2. Ground rules: v3 additions (T2§2 rules 1–10 still hold)

11. **Worktrees for the new WPs** (`.wt/wp19` … `.wt/wp24`, and `.wt/wp15`): `git -C <repo> worktree add .wt/<wp> -b wp/<wp> main`. WP19 starts at once from `main`. The others start **after C3 is merged**.
12. **Contracts v3** (`src/core/contracts/v3/**`) are WP19's and freeze at **C3 (D1 18:30)**; after that they change additively only. Exception: `public-api.ts` moves to WP22 at C3. Its names are frozen, but WP22 fills in the fields additively. v2 contracts stay frozen (T2§2 rule 3).
13. **Every new or changed org route calls `requirePrincipal`** (S§2.3). From C3b, the boundaries test (S§10.1 rule 1) fails any route that does not. **The tenancy suite** (`tests/tenancy/**`) runs on every merge after G3, and a red suite blocks the merge, like parity after K-P.
14. **Migrations:** WP19 generates `0002_saas` / `0003_audit_guard` **only after `0001_relays` is on `main`** (merged at G2), under the §6 carve-out from WP12's `drizzle/**` / `src/server/db/**` ownership. Nobody else touches `drizzle/**` or the schema files: WP12 as before (T2§4), WP14b for `0001` and `schema.ts`. **No WP other than WP19 adds a migration after `0001`** — a schema need goes to WP19 through a request file, so the drizzle journal never forks.
15. **`package.json`:** each WP adds only **its own dependency lines** (§6). `scripts`, `.gitignore`, the root `tsconfig.json`, `next.config.mjs` and `zerops.yml` stay WP12's; other WPs ask through request files.
16. **Secrets:** agents never set, print or commit secrets (T2§2 rule 5). The user sets `BETTER_AUTH_SECRET` and, if needed, a new Polar sandbox token (§11). `scripts/billing/create-plans.ts` reads the sandbox token from the local `.env` without printing it, and prints product ids only.
17. **Pushing and publishing:** agents never push. The orchestrator pushes `main` after `node scripts/ci/secret-scan.mjs`. **npm publishing is a user action (P5), and nothing depends on it** (S§5.7–5.8).
18. **`[VERIFY]` items** (S§16) are checked in the first hour of the owning unit. The result and the chosen fallback go in `docs/notes/<wp>.md`.
19. **Wording:** no UI string, content file or doc written from now on says "no-code", "drag-and-drop" or "canvas" for Changeover (S§5.1). WP13 adds `tests/unit/content/wording.test.ts` (it greps `src/**`, `README.md` and `docs/pitch/**`).
20. **Cost:** the SaaS layer adds no paid call (S§4.2). Tests use fake upstreams. The only new live spend is TEXT DRY RUNs from the CLI and spec J (≈ $0.10 OpenAI in total, ledger-gated).

---

## 3. PRIORITY ORDER (what survives if time runs out)

The tiers decide **what is cut**, not start order: some P2 units start early because they sit on the G3 critical path.

**Cut rule:** if any gate slips by more than 4 h, or the T budget runs short, cut **from the bottom of this list upward**: P5 first, then P4 from item 21 up to item 19, then P3 from item 18 up. **Never cut P1.** Inside a tier, cut the higher-numbered item first.

### P1: never cut ("a working SaaS around the flagship")

| # | Capability | Units |
|---|---|---|
| 1 | **The Baton flagship path** (T2 v2 NEVER-CUT flagship + guards + submission assets) | G2 (parallel branch), WP9·2–·3, WP11·1–·2, WP12·2–·5, WP13·2–·5 |
| 2 | **Contracts v3, the principal and the ports** (the legacy principal keeps v2 behaviour) | WP19·1 (C3) |
| 3 | **Accounts**: email + password; **guest "Try it free · no signup"** (an anonymous user + a guest org seeded with Baton pinned + a Dental copy); **sign-up carries the workspace over**; the auto personal org | WP19·2 (C3b), WP20·2, WP14b·4 (the `GuestSeeder`) |
| 4 | **Organizations**: 4 roles with the permission matrix, invites as copyable links, the org switcher, leave/transfer; the audit, event and usage **writers** | WP19·3, WP20·2 |
| 5 | **Tenancy**: relays, runs, drafts and secrets org-scoped (`requirePrincipal`, `cases.org_id`); **the cross-tenant suite (core)** | WP14b·4, WP16·3, WP17·3, WP18·1, WP19·3 |
| 6 | **The app shell** `/app`: Relays, Runs (list + detail), Analytics (simple), Connectors (placeholder), Settings (Profile, Organization, Members); the guest banner; empty states; `/start` | WP20·1, WP20·2 |
| 7 | **Plans as data**: `PLANS`, count limits (relays, seats), plan badges, **`/pricing`**, the landing CTA with the background guest start | WP19·1 (the defaults), WP7b·1 |
| 8 | **Relay-as-code minimum**: the codec, the **published JSON Schema**, the **Code tab** (Monaco, or the textarea fallback) with diagnostics, **Preview**, save through the source store, Import/Export YAML/JSON, `STUDIO_MODE=readonly` | WP23·1, WP15·1, WP14b·4 (the `RelaySourceStore`) |

### P2: "a SaaS you can pay for and program" + the platform slice

| # | Capability | Units |
|---|---|---|
| 9 | **The platform slice** (T2 v2 NEVER-CUT platform list; the K-G3 fallback applies): the Dental relay end to end with Express, **Try an edit**, the Test tab, the four built-in connectors, the RelayConsole with the provenance strip, **Configure forms** + Overview | WP14a·4, WP14b·3, WP16·2, WP16·3, WP17·2, WP17·3, WP7·3, WP7·4, WP15·2, WP15·3 |
| 10 | **Billing**: Polar sandbox checkout with **4242** → Customer-State entitlements → the Billing page; `BILLING_MODE=simulated` | WP21·1 |
| 11 | **API keys + `/api/v1` read endpoints + `blueprints/validate` + OpenAPI + `/docs/api` (Scalar)** | WP22·1 |
| 12 | **Usage metering**: the Usage page, the overview meter, the non-destructive downgrade rules | WP21·2 |

### P3: integrations and completeness

| # | Capability | Units |
|---|---|---|
| 13 | **Outbound webhooks**: the outbox, Standard Webhooks signing, retries, the **test inbox**, the delivery log UI, redeliver / send test / send latest | WP24·1, WP24·2 |
| 14 | **API write endpoints + dry runs; the CLI (`validate/pull/push/diff/run`) and the SDK** via tarballs; the developer docs; the Settings → CLI & SDK page | WP22·2, WP23·2 |
| 15 | **Publish** (a stored agent, share link, `agent_…` id) + the Publish tab | WP18·1, WP15·3 |
| 16 | **Versions tab** (list, snapshot, restore, Monaco diff) | WP15·3 |
| 17 | **Onboarding** (3 steps incl. Import), the checklist states, **Connectors & secrets** with **Allowed hosts** (Pro+), the Audit log viewer | WP20·3, WP20·2 (audit viewer) |
| 18 | **Marketing completeness**: `/docs` guides, `/changelog`, `/legal/*` placeholders | WP7b·2, WP13·2 |

### P4: polish (cut first after P5)

| # | Capability | Units |
|---|---|---|
| 19 | The Analytics tab and org analytics tiles (Recorded/Simulated); `/r/[slug]` | WP15·4, WP18·3 |
| 20 | Published-agent runs on the share page | WP18·2 |
| 21 | Polar meter ingestion, the billing webhook, the hourly sync; key and webhook-secret rotation; GitHub OAuth; the connector test console; the "Describe your desk" dialog → Code; `changeover publish`; the CI recipe | WP21·3, WP15·4, WP23·2 (if time) |

### P5: not scheduled

Resend email; npm publish (a user action); account deletion; `Idempotency-Key`; YAML autocomplete (`monaco-yaml`); `changeover draft`; the Telecom template and `esign_mock` runs (WP17·4); on-demand voiced sims; the third Try-an-edit preset and per-preset bundles; the `completion_webhook` runtime; the audit read API; "Hear the greeting".

**What the tiers guarantee:**
- If only P1 lands, the judged URL is a real multi-tenant SaaS: guest → account → org with roles and invites, org-scoped relays and runs, the pricing page, relays editable as code with a JSON Schema, and the Baton handoff.
- P2 adds money and programmability.
- P3 adds the integrations the video shows.

---

## 4. Gates v3

| Gate | When (IST) | Exit criteria | Owner |
|---|---|---|---|
| **C3** | **D1 Fri 18:30** | WP19·1 merged **alone**: `src/core/contracts/v3/**` exactly S§14; `src/server/saas/{ports,principal,errors,same-origin}.ts` with the **legacy principal** (v2 behaviour); the one-file stubs `src/server/api-v1/keys-plugin.ts` and `src/server/billing/polar-plugin.ts` (returning `[]`; then owned by WP22/WP21); `docs/SAAS.md` + `docs/TASKS-v3.md` committed. Typecheck and the full suite green, with no v2 test modified | integrator |
| **G2** | D1 22:00 | **unchanged** (T2§3.1: the Baton slice on Zerops). Seven merges are already on `main` (§1); what is left is **`wp14a` + `wp14b`** (which carries `0001_relays`, the C3b dependency) and the deploy. Also merged if green: WP23·1 (pure) and WP18·1 | parallel branch / WP12 |
| K-B | D2 10:00 | unchanged (T2§9) | WP12 |
| **C3b-VERIFY** | **D2 Sat 12:00** (new in v3.1) | **A go/no-go on WP19·2's `[VERIFY]` items, three hours before C3b's deadline and before the 13:00 and 17:00 blocks commit to the primary path.** WP19·2 posts one short block in `docs/notes/wp19.md`, and the integrator reads it: (a) the Drizzle adapter + `usePlural` names generate and apply; (b) `signInAnonymous({ asResponse })` returns Set-Cookie; (c) `onLinkAccount` fires before the anonymous user is deleted; (d) `0002_saas` generates against `0001` with a diff-free `drizzle-kit generate`. Each is **pass**, or **fallback taken** (which one, and the cost), or **blocked**. WP15·1 adds one line (Monaco loads under the dev CSP — the real check stays K-MONACO at 17:00) and WP21·1 adds one line (the Polar sandbox token's scopes, since the fix is a *user* action with a lead time) | WP19, WP15, WP21 → integrator |
| **C3b** | **D2 Sat 15:00** | WP19·2 merged: Better Auth mounted; `0002_saas` + `0003_audit_guard` generated after `0001`, applied on a fresh DB and on a populated DB, `drizzle-kit generate` diff-free; **`TENANCY_MODE=legacy` by default, and every v2 test still green**. In `orgs` mode locally: guest start → session + guest org + Dental copy; sign-up carries it over (same org id); the principal matrix tests pass | integrator |
| K-MONACO | D2 17:00 | WP15·1: self-hosted Monaco loads and saves on `next build && next start` under the production CSP | WP15 |
| **G3** | **D2 Sat 22:00** | **T2§3.1 G3 criteria** (the Dental relay on Zerops, etc.) **plus the SaaS core on Zerops:** `BETTER_AUTH_SECRET` set (user); 0002/0003 applied; `TENANCY_MODE=orgs`; `/start` → a guest workspace with Baton pinned and "Dental deposit (your copy)"; **Code tab** → edit → save (rev + 1) → Preview updates; sign-up keeps the same org id and relay ids; an invite link accepted by a second account → the switcher shows 2 orgs; a foreign relay id → 404; the **core tenancy suite green** on `main` | WP12·2 |
| K-G3 | D3 12:00 | unchanged (T2§9: Dental end to end + spec S) | WP12 |
| **K-SAAS** | **D3 Sun 12:00** | every G3 SaaS criterion passes on Zerops, and spec J steps 1–6 + the sign-up of step 8 are green (fake upstream) | WP12·3 |
| K-DOCS | D3 13:00 | `/docs/api` (Scalar) renders and "Try it" `GET /me` works under the production CSP | WP22 |
| **K-BILL** | **D3 17:00** | On Zerops: Upgrade → sandbox checkout with 4242 → "Pro · Test mode" within 20 s; new limits live | WP21 |
| **G4** | **D3 Sun 19:00** | **The full judge path S§13.1 steps 1–10 on Zerops** (step 7 may use the P-1/P-3 fallback, step 8 simulated mode if K-BILL tripped, step 10 the loopback if K-HOOK tripped); specs 1/S/R/**J** green (fake upstream). **Rough video at 20:00 (user)** | WP12·4 |
| K-CLI | D4 12:00 | From a clean directory: `npx -y <APP_URL>/cli/changeover-cli.tgz validate` exits 0 on the example, and `pull` → edit → `push` round-trips against Zerops with a Build key | WP23 / WP12 |
| **G5 Feature freeze** | **D4 Mon 22:00** | T2§3.1 G5 criteria + fixes from the rough video; webhooks with the delivery log; the CLI and SDK served from Zerops; `/docs` guides; **final video recorded at 19:00** | WP12 |
| **RC** | D5 Tue 22:00 | fixes only; the parity, tenancy, SSRF and log-redaction suites green; the live spec passes on Zerops D3, D4 and D5; the wording test green; tag `rc1` | WP12 |
| **Submit** | D6 Wed 08:00 freeze → **10:00 submit** | T2§3.1 (the judging budgets set from the dashboards; `/status` green) + `TENANCY_MODE=orgs`, `BILLING_MODE` shown on `/status` | user + WP12 |

---

## 5. Slot plan (≤ 5 agents at once; ‖ = the parallel branch, not counted here)

`WPx·n` = task unit n of WPx (§7). **Bold** = P1. A cell with "→" runs its units back to back in the same slot.

| Block (IST) | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|
| **D1 Fri** 15:30–18:30 | ‖ WP14a·3 | ‖ WP12·1 G2 prep | **WP19·1 → C3 (18:30)** | WP17·2 (Dental curated, 2 presets + clips, gallery sim) | **WP9·2** (takes → assets; after the kit report) |
| D1 18:30–21:30 | **WP23·1** (codec, JSON Schema) | ‖ WP12·1 G2 merge + deploy | WP18·1 (publish service, gateway, org hooks) | WP17·3 (async drafting, TEXT DRY RUN, org hooks) | **WP9·3** (picker takes, cached turns) |
| D1 22:00 | **G2** (parallel branch) | | | | |
| **D2 Sat** 09:00–13:00 | WP14a·4 (widening, 0.5) → WP14b·3 | **WP19·2** (Better Auth, 0002/0003, guest, link) | WP16·2 (`RelayToolService`, built-ins, Polar adapter) | WP7·3 (`RelayConsole`, provenance strip) | **WP15·1** (editor shell, **Code**, Preview) |
| **D2 12:00** | **C3b-VERIFY go/no-go** (§4). The 13:00 and 17:00 rows below are the *primary* path; §10 K-VERIFY says what each branch does instead | | | | |
| D2 13:00–17:00 | WP14b·3 → **WP14b·4** (SaaS adoption, source store, seeder) | **WP19·2 → C3b (15:00)** | WP16·3 (`http_action`, secrets per org, host policy) | **WP20·1** (app shell, runs, read models) | WP15·2 (Configure forms, Overview) |
| D2 17:00–21:00 | **WP12·2 G3 integration + deploy** | **WP19·3** (org routes, writers, suite core) | **WP20·2** (auth pages, members, settings) | WP21·1 (entitlements, Polar billing) | **WP11·1** (autopilot + chips) — **0.5 T of this slot is reserved D2 float** (below) |
| D2 22:00 | **G3** | | | | |
| **D3 Sun** 09:00–13:00 | **WP13·2** (video script v3, low-code/SaaS copy, pricing copy) | WP15·3 (Try an edit, Test, Publish, Versions) | WP22·1 (keys, `/api/v1` read, OpenAPI, Scalar) | WP24·1 (webhook pipeline, test inbox) | **WP12·3** (e2e 1/S/R/J, guards) → **K-G3 + K-SAAS 12:00** |
| D3 13:00–17:00 | WP19·4 (suite extension, 0.5) → WP21·2 (usage) | WP7·4 (test/published modes, end card) | WP23·2 (SDK, CLI, tarballs, dev docs) | WP22·2 (write endpoints, dry runs) | **WP7b·1** (landing, header, low-code section, `/pricing`) |
| D3 17:00–19:00 | **WP12·4 G4** | WP24·2 (delivery log UI) | WP21·2 (continued) | | |
| D3 19:00 | **G4** → rough video 20:00 (user) | | | | |
| **D4 Mon** 09:00–13:00 | fixes (rough video list) | fixes | WP7b·2 (`/docs`, `/changelog`, `/legal`) | WP20·3 (onboarding, connectors, allowed hosts) | **WP11·2** (2 recorded bundles) |
| D4 13:00–17:00 | fixes | **WP13·3** (README v1, slides v1, cover) | WP15·4 (P4) | WP18·2 (P4) | **WP12·5** (browser pass, runbook, spec J live) |
| D4 17:00–22:00 | **WP13·4** (final script, measured numbers; by 18:30) | fixes (0.5) | → **final video 19:00 (user)** → **G5 22:00** (WP12, 0.5) | | |
| **D5 Tue** 09:00–13:00 | fixes | fixes | WP21·3 (P4) | WP18·3 (P4) | **WP13·5** (video edit, slides PDF, README, lablab copy) |
| D5 13:00–18:00 | fixes (1) | | | | **WP13·5** (continued) → **RC 22:00** (WP12, 0.5) |
| **D6 Wed** | 08:00 freeze (user + WP12) → **10:00 submit (user)** | | | | |

**Totals:**

| Day | Planned T | Of which fixes | P4 (cut first) |
|---|---|---|---|
| D1 (from 15:30) | 7.25 | 0 | 0 |
| D2 | 15.25 (of which **0.5 is reserved float**, §5) | 0 | 0 |
| D3 | 11.25 | 0 | 0 |
| D4 | 10.75 | 3.5 | 1.5 |
| D5 | 5.5 | 3.0 | 1.0 |
| **Total** | **50.0** | **6.5** | **2.5** (→ 9 T of buffer if P4 is cut) |

**The D2 float (new in v3.1).** D2 carries 15.25 T with no fixes budget and no P4, and it is the day the highest-uncertainty library work (Better Auth core + the Drizzle adapter + the anonymous / organization / api-key / Polar plugins, the sandbox token scopes, Monaco under the production CSP) meets reality for the first time. Relying on D4's fix budget to absorb a **D2-morning** failure is relying on a bucket three days downstream of the leak. So:

- **0.5 T of the D2 17:00–21:00 S5 slot is pre-reserved as float.** It is borrowed from **WP11·1**, which is the only D2 unit with no downstream SaaS dependent (autopilot and chips feed the recording day, not a gate). WP11·1 plans for 2.5 T of work in a 3 T slot and stops at the 0.5 T mark if the float is called.
- **It is released by the C3b-VERIFY checkpoint, not by a crisis.** If 12:00 reports "fallback taken" on any item, the integrator spends the float on that fallback the same evening. If 12:00 is all-pass, the float returns to WP11·1 at 17:00 and the day runs as planned.
- **It is not spent on anything else.** Not polish, not a P3 that looks close. A reserve that gets borrowed for the first plausible thing is not a reserve.

**Critical paths:**
- **Platform:** WP17·2 → WP14b·3 → (WP16·2 ∥ WP7·3) → G3 → K-G3 → WP15·3 → G4.
- **SaaS:** WP19·1 (C3) → WP19·2 (C3b) → (WP19·3 ∥ WP20·2 ∥ WP21·1) → G3 → K-SAAS → (WP22·1 ∥ WP24·1) → G4.
- **Low-code:** WP19·1 → WP23·1 → WP15·1 (Code) → WP15·2 → WP23·2 (CLI) → K-CLI.

Baton is on none of them (G2 and K-B protect it).

---

## 6. Ownership map v3 (additions and changes to T2§4; disjoint)

| WP | Owns |
|---|---|
| **WP19** identity + tenancy (new) | `src/core/contracts/v3/**` (except `public-api.ts` after C3), `src/server/{identity,saas,audit,events}/**`, `src/app/api/{auth,guest}/**`, `src/app/api/app/{orgs,members,invitations,audit}/**`, `src/client/identity/**`, `src/server/db/schema-{auth,saas}.ts` + the one re-export line in `src/server/db/schema.ts`, `drizzle/0002_saas.sql`, `drizzle/0003_audit_guard.sql` and their `drizzle/meta/**` entries, `tests/tenancy/**`, `tests/unit/server/{identity,saas,audit,events}/**`, `tests/unit/core/contracts-v3/**`. Dependency lines: `better-auth`, the Drizzle adapter package if separate; devDependency `auth` (the CLI). **At C3 only:** the stubs `src/server/api-v1/keys-plugin.ts` (→ WP22) and `src/server/billing/polar-plugin.ts` (→ WP21) |
| **WP20** app shell + settings (new) | `src/app/app/**` **except** `relays/**` (WP15), `settings/{billing,usage}/**` (WP21), `settings/api-keys/**` (WP22), `settings/webhooks/**` (WP24), `settings/developers/**` (WP23); `src/app/{sign-in,sign-up,start,accept-invite}/**`; `src/components/{app-shell,auth,settings,onboarding,runs}/**`; `src/client/app/**`; `src/server/read-models/**`; `tests/unit/app/**`, `tests/unit/server/read-models/**` |
| **WP21** plans, billing, usage (new) | `src/server/{billing,entitlements,usage}/**` (from C3, incl. the `polar-plugin.ts` stub), `src/app/api/app/billing/**`, `src/app/app/settings/{billing,usage}/**`, `src/components/billing/**` (incl. `plan-notice.tsx`), `scripts/billing/**`, `tests/unit/server/{billing,entitlements,usage}/**`. Dependency line: `@polar-sh/better-auth` |
| **WP22** public API (new) | `src/server/api-v1/**` (from C3, incl. `keys-plugin.ts`), `src/app/api/v1/**` **except** `webhooks/**`, `src/app/api/app/api-keys/**`, `src/app/docs/api/**`, `src/app/app/settings/api-keys/**`, `src/components/api-keys/**`, `src/core/contracts/v3/public-api.ts` (after C3), `tests/unit/server/api-v1/**`, `tests/api/**`. Dependency lines: `@better-auth/api-key`, `zod-openapi`, `@scalar/nextjs-api-reference` |
| **WP23** relay-as-code devtools (new) | `src/core/relay-code/**`, `packages/{cli,sdk}/**`, `scripts/devtools/**`, `public/schemas/**`, `examples/**`, `src/content/docs/dev/**`, `src/app/app/settings/developers/**`, `tests/unit/core/relay-code/**`, `tests/unit/devtools/**`. **Generated, git-ignored:** `public/{cli,sdk}/**`, `public/vendor/monaco/**`. Dependency lines: `yaml`; devDependency `ajv` |
| **WP24** outbound webhooks (new) | `src/server/webhooks-out/**`, `src/app/api/app/webhooks/**`, `src/app/api/v1/webhooks/**`, `src/app/api/webhook-inbox/**`, `src/app/app/settings/webhooks/**`, `src/components/webhooks/**`, `tests/unit/server/webhooks-out/**` |
| **WP15** Studio (re-scoped) | `src/app/app/relays/**`, `src/app/studio/**` (redirects only), `src/app/r/**`, `src/components/studio/**`, `src/client/studio/**`, `tests/unit/studio/**`. Dependency lines: `@monaco-editor/react`, `monaco-editor` |
| **WP14b** (added) | the `RelaySourceStore` and `GuestSeeder` implementations in `src/server/relays/**`; `GET/PUT /api/relays/:id/source` in `src/app/api/relays/**` (both already WP14b paths) |
| **WP16** (added) | `src/app/api/app/connector-hosts/**`; the `ConnectorHostPolicy` and `SecretRebinder` implementations in `src/server/{connectors,secrets}/**`; the `publicHttpsPost` export |
| **WP7b** (added) | `src/app/{pricing,docs,changelog,legal}/**` **except** `src/app/docs/api/**` (WP22); `src/components/marketing/**` |
| **WP13** (changed) | `src/content/**` **except** `src/content/docs/dev/**` (WP23); `tests/unit/content/wording.test.ts` |
| **WP12** (added) | as before (`package.json` scripts, `.gitignore`, root `tsconfig.json`, `next.config.mjs`, `zerops.yml`, `src/server/jobs/**`), **minus the WP19 carve-out below**, plus `registerTick` in `src/server/jobs/runner.ts`, the purge steps that call the WP19/WP24 purge functions, and `tests/e2e/spec-j.*` |

**Two carve-outs from T2§4 (name them in the WP briefs, or they collide):**

1. **`drizzle/**` and `src/server/db/**` are WP12's in T2§4** (except `0001_relays.sql`, WP14b's). v3 carves out **for WP19 only**: `drizzle/0002_saas.sql`, `drizzle/0003_audit_guard.sql`, their `drizzle/meta/**` journal entries, and `src/server/db/schema-auth.ts` + `src/server/db/schema-saas.ts`. Everything else under `drizzle/**` and `src/server/db/**` stays WP12's, and no third WP generates a migration (§2 rule 14).
2. **`src/server/db/schema.ts` is WP14b's** (its additive `0001` schema). WP19 appends **one re-export line** for the two new schema files and changes nothing else in it. WP19·2 does this after `0001` is on `main` (C3b), so WP14b never rebases onto it; if WP14b still has the file open, the line goes in through a request file, as with `package.json`.

The Analytics page `src/app/app/analytics/**` and the Connectors page `src/app/app/connectors/**` are WP20's (UI). They consume WP18's `RelayAnalytics.forOrg` (P4) and WP16's routes.

---

## 7. Work packages

Effort is in T. Every unit ends with typecheck, `npm test`, its acceptance checks and a `docs/notes/<wp>.md` section, per T2§2 rule 8.

> **v3.1 items.** The review fixes add ≈ 0.3 T spread across six WPs. They are **not** listed again in the briefs below — **S§12's "v3.1 additions to the owning WPs" table is the authoritative assignment**, and each owner reads it with its brief. In short: WP19 the shared-device claim rule (S§2.6 R1); WP20 the claim card and the two guest upgrade interstitials (S§8.5); WP12 the reserved judging tranche (S§4.2); WP22 the global compile bucket (S§10.4) and the "a key survives its creator" acceptance test (S§6.1); WP15 the `Changeover Studio` breadcrumb (S§5.5); WP13 the re-cut beat table and the freed-rep-time line (S§13.2). Only the first is P1, and only because it is a *removal* (the automatic claim on sign-in goes away); the friendly card that replaces it is P3.

### New WPs

#### WP19: Identity, tenancy, organizations, writers (**4.25 T**; D1 → D3)

- **Goal:** S§2, S§3, S§9, the writer halves of S§4.5 and S§7.1, and the tenancy suite.
- **WP19·1 → C3 (1 T; D1 15:30–18:30):**
  - `src/core/contracts/v3/{identity,permissions,plans,usage,relay-code,events,audit,errors,public-api,services,index}.ts` exactly S§14 (zod for `events` and `public-api`; `PLANS` = S§4.1; `ROLE_PERMISSIONS` = S§3.7; `SCOPE_PRESETS`; `can()`);
  - `src/server/saas/{ports,principal,errors,same-origin}.ts`: `requirePrincipal` with the **legacy** visitor principal (`orgId = "ws_" + visitorId`, `role = owner`, `plan = guest`), `saasErrorResponse`, and the port registry with the S§14 defaults. The default `Entitlements` derives limits from `PLANS` and counts rows, so count limits work before WP21;
  - the two plugin stubs (§4 C3).
  - **Tests:** the permission matrix equals S§3.7 (snapshot); `PLANS` equals S§4.1; `can()` for roles and scopes; the legacy principal equals v2's `workspaceFor`; a boundaries rule: no `better-auth` import outside `src/server/identity/**`, `src/client/identity/**`, `src/server/{api-v1,billing}/*-plugin.ts`.
- **WP19·2 → C3b (1.5 T; D2 09:00–15:00):**
  - install `better-auth` (+ the adapter) at the S§3.1 versions;
  - `src/server/identity/{auth,access,link,claim,active-org,personal-org,blocked-paths}.ts`;
  - `src/app/api/auth/[...all]/route.ts`; `src/app/api/guest/start/route.ts`; `src/client/identity/auth-client.ts`;
  - `npx auth@1.7.6 generate` → `schema-auth.ts`; `schema-saas.ts` (S§2.7);
  - **after `main` has `0001`:** `drizzle-kit generate` → `0002_saas`, and `--custom` → `0003_audit_guard`;
  - the session principal and `TENANCY_MODE`;
  - the S§16 VERIFY items for WP19.
  - **Acceptance:**
    1. the migrations apply on a fresh DB and on a populated `0001` DB; a second run is a no-op; no drizzle diff;
    2. guest start: limits (device/ipKey/global), ≤ 400 ms p50 locally, Set-Cookie flags (`Secure` in production mode), the seeded org (Baton pinned, a Dental copy with a YAML source through the `GuestSeeder` port; the default no-op seeder is OK until WP14b·4);
    3. every carry-over test in S§3.4;
    4. `claimVisitorData` is idempotent and refuses a forged `bvid`;
    5. the principal matrix: key/session/visitor × legacy/orgs;
    6. the blocked client paths return 403 `E_USE_APP_API`;
    7. the CSRF check;
    8. `TENANCY_MODE=legacy` leaves every v2 test green.
- **WP19·3 (1.25 T; D2 17:00–21:00):**
  - `/api/app/{orgs,members,invitations,audit}` (server-mediated, S§3.5–3.8);
  - the DB writers registered in the ports: `AuditWriter` (`src/server/audit/**`, incl. the coalescing of `relay.source_saved`), `DomainEvents` (`src/server/events/outbox.ts`), `UsageMeter.record` (`src/server/saas/usage-writer.ts`);
  - `purgeIdleGuests()` and the audit retention purge (called by WP12's purge);
  - **the core tenancy suite** (`tests/tenancy/**`: fixtures, the manifest for relays, source, runs/cases, secrets, members, invitations and audit; cross-org 404, viewer 403, CSRF, forged active org, invite email mismatch).
  - **Acceptance:** the suite is green against the WP14b/WP16/WP17 adoptions on `main`; audit rows for every mutation in S§9; a trigger test (an `UPDATE` on `audit_log` fails; the purge succeeds).
- **WP19·4 (0.5 T; D3 13:00–14:30):** extend the manifest to billing, API keys, `/api/v1/**`, webhooks, connector hosts and dry runs; the concurrency test for count limits; the route boundaries test (S§10.1 rule 1).
- **Consumes:** WP14b (the registry, `workspaceFor`), WP16 (the secret crypto, `SecretRebinder`), WP12 (`ipKeyOf`, purge).
- **Provides:** contracts v3, `requirePrincipal`, the auth instance and client, the writers, the suite.
- **Live budget:** $0.

#### WP20: App shell, auth pages, settings, onboarding, read models (**3 T**; D2 → D4)

- **Goal:** S§8.1–8.5 (except the pages owned by WP15, WP21–WP24) and S§6.2's read models.
- **WP20·1 (1 T; D2 13:00–17:00; against the C3 legacy principal, switched to the session at C3b):**
  - `src/app/app/layout.tsx` (session → `/start`; `ensurePersonalOrg`);
  - the top bar with the org switcher (a server loader for `OrgSummary[]`; the switch action once `auth-client` exists), the status pill, the user menu, the side nav, the guest banner;
  - the `/app` overview (the checklist derived from data, the minutes meter slot, recent runs, your relays);
  - `/start`;
  - `src/server/read-models/{runs,cases,relays}.ts` (`cases.org_id`), `/app/runs` (filters: relay, source, date) and `/app/runs/[id]` (the case record with evidence chips, the provenance strip, the QA summary, payment; read-only reuse of WP7's display components);
  - `/app/analytics` (counts by source and outcome, with the "never blended" note; the empty state);
  - the `/app/connectors` placeholder;
  - the S§8.5 empty states.
- **WP20·2 (1 T; D2 17:00–21:00; after C3b):** `/sign-in`, `/sign-up` (the carry-over note; `?next`, `?invite`), `/accept-invite/[id]`; the switcher's switch and New organization; Settings → **Profile** (password, sessions), **Organization** (rename, leave, transfer, delete), **Members & invites** (copy link, revoke, roles), **Audit log** (a filterable table).
- **WP20·3 (1 T; D4 09:00–13:00; P3):** `/app/onboarding` (3 steps, S§8.3, incl. Import); the checklist completion states; `/app/connectors` (the catalog by plan, secrets over WP16's `/api/secrets`, **Allowed hosts** over `/api/app/connector-hosts`, the Pro+ gating); the permission-aware settings nav; 390 px; a11y.
- **Acceptance:**
  1. an anonymous visit to `/app/runs` goes through `/start` and lands on `/app/runs` with a guest org;
  2. the runs list shows only the active org's cases, including a Baton run claimed from the device;
  3. the switcher lists the orgs with roles and switching changes the data;
  4. an invite link accepted by a second account shows the member;
  5. Lighthouse a11y ≥ 90 on `/app`, `/app/runs` and Members;
  6. no horizontal scroll at 390 px;
  7. no component imports `src/server/**` (except server components calling the read models).
- **Live budget:** $0.

#### WP21: Entitlements, billing, usage (**2.5 T**; D2 → D5)

- **Goal:** S§4.
- **WP21·1 (1.25 T; D2 17:00–21:00):**
  - **step 0:** the S§16 VERIFY items for the Polar plugin and the token scopes. If the token lacks scopes → a request to the user (§11) and continue in simulated mode;
  - `scripts/billing/create-plans.ts` (sandbox products, ids only);
  - `src/server/entitlements/**` (the DB `Entitlements`: get / assertCount / checkRate / refresh; overrides);
  - `src/server/billing/**` (the plugin config, `POST /api/app/billing/checkout`, `syncOrg`, `syncCheckout`, fail-static, `BILLING_MODE` auto, the simulated checkout page);
  - the Billing page; `plan-notice.tsx`.
  - **Acceptance:**
    1. a **live sandbox** upgrade with 4242 (local, $0) → `pro` within 20 s;
    2. a forged `referenceId` or a non-owner payer is refused;
    3. a Polar error keeps the last plan;
    4. simulated mode works end to end and is labelled;
    5. anonymous users never create Polar customers.
- **WP21·2 (0.75 T; D3 13:00–19:00):** `UsageMeter.summary`; the Usage page (S§4.5) and the overview meter; `applyPlanChange(orgId, from, to)` implementing the S§4.6 downgrade rules (non-destructive; audited); the cancel banner.
  - **Acceptance:** usage equals a hand-computed fixture; Recorded/Simulated/Published are never blended; a downgrade fixture disables the extra keys and endpoints and deactivates hosts without deleting anything; an upgrade re-enables them.
- **WP21·3 (0.5 T; D5; P4):** the Polar meter ingestion tick; the billing webhook handlers (`/api/auth/polar/webhooks`); the hourly sync.
- **Live budget:** $0 (sandbox).

#### WP22: API keys, public REST API, OpenAPI, `/docs/api` (**2 T**; D3)

- **Goal:** S§6.
- **WP22·1 (1.25 T; D3 09:00–13:00):**
  - `@better-auth/api-key` (the S§16 VERIFY items) in `keys-plugin.ts`;
  - `/api/app/api-keys` + the API keys page (shown once; the Build/Full presets; the `curl`/SDK/CLI lines; revoke);
  - the `/api/v1` router (the key principal, scopes, the per-key and per-org limits, `RateLimit-*` headers, the error envelope, pagination, `ETag`);
  - **the P2 read endpoints** of S§6.2, incl. `/relays/{id}/source` (WP14b's `RelaySourceStore`), `/blueprints/validate` (WP23's codec + WP14a's kernel) and `/schemas/blueprint`;
  - `registry.ts`; the OpenAPI document; `/docs/api` (Scalar) + the K-DOCS fallback.
- **WP22·2 (0.75 T; D3 13:00–17:00):** the P3 write endpoints: `POST /relays` (clone / blueprint / source), `PUT /relays/{id}/source` and `/draft`, `POST /relays/{id}/versions`, `GET /relays/{id}/compiled`, `POST /relays/{id}/dry-runs` + `GET /dry-runs/{id}` (WP17's `SimCallService`); publish/unpublish if WP18·1 is on `main` (else P4).
- **Acceptance:**
  1. every route is in the registry, and each response validates against its documented schema;
  2. the document passes an OpenAPI 3.1 check;
  3. scopes: Build cannot publish or touch webhooks; a revoked key → 401; a key on `/api/app/**` → 401;
  4. a 429 carries `Retry-After`;
  5. `validate` without auth works, is rate-limited, and writes nothing;
  6. a source PUT with a stale rev → 409; with a zod error → 422 + diagnostics; with lint errors → saved;
  7. K-DOCS passes on Zerops.
- **Live budget:** $0 (dry runs with fake upstream).

#### WP23: Relay-as-code devtools (**2 T**; D1 → D3)

- **Goal:** S§5.2–5.4, S§5.7–5.8, the developer docs.
- **WP23·1 (1 T; D1 18:30–21:30; merges at G2 if green):**
  - `src/core/relay-code/{codec,diagnostics,order,diff,index}.ts` (S§5.3). `validateSource` takes the linter as an injected option (`{ lint }`), because `lintBlueprint` reaches `main` with WP14a at G2. `index.ts` wires the kernel's `lintBlueprint` after G2 (a 5-line follow-up in WP23·2);
  - `scripts/devtools/{gen-json-schema,schema-docs,copy-monaco}.ts|mjs`;
  - the committed `public/schemas/blueprint-2.0.json`;
  - `examples/relays/baton-add-driver.yaml` (+ `dental-deposit.yaml` once WP17's JSON is on `main`);
  - add `yaml` and `ajv`.
  - **Acceptance:**
    1. the drift test (the generated schema equals the committed file);
    2. every gallery/example blueprint validates with `ajv` against the schema **and** with zod;
    3. the round-trip property test (S§5.3), incl. the comment preservation through `applyEdit`;
    4. ranges point at the right line/column for zod, lint and unknown-key issues (fixtures in both formats);
    5. the parsing limits (an alias bomb, a custom tag, a 300 KiB file, duplicate keys) are refused with the right codes;
    6. `CODEC_CREDENTIAL` catches the S§5.2 patterns and passes `$secret` refs;
    7. the boundaries test: no node/DOM/server imports in `src/core/relay-code/**`.
- **WP23·2 (1 T; D3 13:00–17:00):**
  - `packages/sdk` (S§5.7) and `packages/cli` (S§5.8: `validate` (offline, bundled codec + kernel lint), `pull`, `push`, `diff`, `run`, `schema`; the lock file; exit codes);
  - `scripts/devtools/build-devtools.mjs` (esbuild single file, `npm pack` tarballs, `.d.ts`);
  - the developer docs content in `src/content/docs/dev/**` (the blueprint reference from the schema descriptions, CLI, SDK, HTTP-action recipes in Node/Python/Go, API authentication, webhook verification);
  - `/app/settings/developers`;
  - requests to WP12 for the `build` step, `.gitignore`, the root `tsconfig` include and `npm run changeover`.
  - **Acceptance:**
    1. the CLI against a fake `node:http` server: pull → edit → push (with the lock), the conflict refusal (exit 3), diff, and run polling to done;
    2. `validate` works with no network;
    3. the SDK types compile in a consumer fixture, and `verifyWebhook` verifies a Standard Webhooks fixture;
    4. the tarballs install in a clean temporary directory (`npm i <tgz>`) and `npx -y ./changeover-cli.tgz validate` runs (the local K-CLI proxy);
    5. no key is ever written to disk (a test greps the lock file and the temp home).
- **Live budget:** $0.

#### WP24: Outbound webhooks (**1.5 T**; D3)

- **Goal:** S§7.
- **WP24·1 (1 T; D3 09:00–13:00):**
  - `/api/app/webhooks` (CRUD; the Pro+ count; account required; the secret shown once; WP16's crypto);
  - the fan-out and sender ticks through `registerTick`; retries with jitter and `Retry-After`; the auto-disable at 50;
  - `publicHttpsPost` from WP16;
  - the test inbox route with signature verification and retention;
  - `/api/v1/webhooks/**`;
  - the purge steps.
- **WP24·2 (0.5 T; D3 17:00–19:00):** the Settings → Webhooks list and endpoint pages; the delivery log with the drawer; Redeliver, Send test event, **Send the latest `<type>`**; the inbox feed; the `WEBHOOK_INBOX_LOOPBACK` path with its label.
- **Acceptance:**
  1. a delivery verifies with `standardwebhooks` using the endpoint secret, and the `webhook-id` is stable across retries;
  2. the retry schedule on a fake clock; `exhausted` after 7 attempts;
  3. SSRF: private and loopback targets refused (except the inbox path);
  4. tenant isolation: A's events never reach B's endpoints;
  5. "Send the latest run.completed" works for a run that finished before the endpoint existed;
  6. the inbox shows "Signature valid ✓" for a real delivery and "✗" for a tampered one;
  7. K-HOOK is checked on Zerops at G4.
- **Live budget:** $0.

### Changed WPs

#### WP15: Changeover Studio, low-code (**3.5 T**, re-cut; replaces T2§6 WP15)

- **Goal:** S§5.5 (and S§5.9 as P4).
- **WP15·1 (1 T; D2 09:00–13:00; P1):**
  - `/app/relays` (org relays, Baton pinned, Templates with Run / Use template, **Import blueprint**, New relay);
  - the editor shell `/app/relays/[id]/[tab]` (the top bar, the saved state, the lint badge, permission-aware, **`STUDIO_MODE=readonly`**);
  - `source-store.ts`;
  - **Code** (lazy self-hosted Monaco through WP23's `copy-monaco`; the YAML ⇄ JSON toggle; the JSON Schema; markers from `validateSource`; Format; Save; Download; Import with a diff confirmation; the `CODE_EDITOR=textarea` fallback);
  - **Preview** (the browser kernel);
  - `/studio/**` redirects.

  Save uses `PUT /api/relays/:id/draft` until WP14b·4's `/source` lands, then `/source`. **K-MONACO at 17:00** on a production build.
- **WP15·2 (1 T; D2 13:00–17:00; P2):** **Configure**: the Case fields table (the "Add field" presets from WP17's `expandDraft` defaults; Move up/down), Handoff, Greeting & voice (the word counter), Stages (toggles, goal, exit, tools), Disclosures, Connectors (typed forms, the secret-ref picker, "Add HTTP action" for Pro+). All edits go through `applyEdit`. The forms are read-only while the code has a syntax error. **Overview** (the relay track, "What the AI inherits", the lint summary).
- **WP15·3 (1 T; D3 09:00–13:00; P2/P3):** the **Try an edit** card (P§7.5.3); **Test** (P§7.2 Test, embedding WP7's `RelayConsole` in `mode="test"`, TEXT DRY RUN as the default, the hash-mismatch view); **Publish** (P§8 UI + the API/SDK/CLI snippets); **Versions** (list, snapshot, restore, the Monaco diff editor; the 409 conflict prompt reuses it).
- **WP15·4 (0.5 T; D4 13:00–17:00; P4):** Analytics (tiles with the Recorded/Simulated columns + the runs table, through WP18's `RelayAnalytics`); `/r/[slug]`; the "Describe your desk" dialog → the Code tab with the notes as comments; a11y and the 390 px polish.
- **Acceptance** (replaces T2 WP15's):
  1. Clone Dental → edit a field in **Configure** → the Code tab shows the change with the YAML comments intact → reload → it persists. A rev conflict (a CLI push in parallel) opens the diff prompt.
  2. The preview updates ≤ 300 ms after an edit (code or form), and the client and server hashes are equal.
  3. Lint errors disable Test and Publish and link to the offending range in Code or the input in Configure. Zod errors block save and show "Unsaved: n errors".
  4. Try an edit "add a field" runs on the Dental pre-generated sim inside the editor, and the QA card shows re-asked 0, newly asked 1 (e2e spec S).
  5. `STUDIO_MODE=readonly` hides Test, Publish, Try an edit and Import, and keeps Overview, Configure (read-only), Code (read-only), Preview and Download.
  6. `CODE_EDITOR=textarea` keeps every Code-tab function except completion.
  7. Monaco is not loaded on any page other than Code and Versions (a bundle test). Lighthouse a11y ≥ 90 on `/app/relays` and the editor's Overview and Configure.
  8. The boundaries test passes.
- **Live budget:** $0.

#### WP14a (+0.5 T): WP14a·4 is unchanged (T2: the contract-widening commit, D2 09:00)

Also: keep `canonicalJson` and the canned snapshot states exported from the isomorphic core (WP23 and the CLI bundle them), and keep `src/core/relay/**` free of node/DOM imports. No kernel change for v3.

#### WP14b (+0.5 T): WP14b·3 unchanged (T2 T3) + **WP14b·4 SaaS adoption (0.5 T; D2 ≈ 14:00–16:30)**

- `workspaceFor` → `requirePrincipal(req, {perm})` in every `/api/relays/**` route; `SaasError` mapping.
- **`RelaySourceStore`** (S§14): the `draft_source` / `relay_versions.source` columns (from WP19's `0002`; until C3b, behind a feature check that treats the source as absent), `GET/PUT /api/relays/:id/source`, create from source, `relay.source_saved` audit rows.
- The **`GuestSeeder`** (the Dental copy with its YAML source).
- `/api/cases`: `org_id` / `created_by_user_id`, the token's `org` claim, the plan checks (over plan → the labelled replay).
- The takeover terminal path: `run.completed` + `live_run` / `ai_minutes` usage (in the same transaction).
- The relay count limit on create/clone/import.
- **Acceptance:** the v2 route tests pass unchanged in legacy mode; the tenancy manifest rows for relays, source and cases pass in orgs mode; the events and usage rows are idempotent on a replayed terminal transition.

#### WP16 (+0.25 T): WP16·2 unchanged; **WP16·3 = T2 T3 + SaaS adoption (1.25 T; D2 13:00–17:00)**

Secrets per org; the `SecretRebinder`; the plan's secret count and TTL; the **`ConnectorHostPolicy`** (the env allowlist ∪ the org's hosts on Pro+) + `/api/app/connector-hosts` (validation per S§5.6, audit); `payment.succeeded` emitted where payments become verified; the `publicHttpsPost` export for WP24.

**Acceptance (added):** a host outside the policy → `blocked` without any DNS lookup; an org host on Free (after a downgrade) → `blocked` with the plan message; the T2 SSRF suite still passes for org hosts.

#### WP17 (≈ +0.1 T): WP17·2 unchanged; WP17·3 + org adoption

Drafts, sims and dry runs use `ws = orgId`; the plan checks; the usage records. The draft result exposes its notes for the YAML header. **WP17·4 is cut (P5).**

#### WP18 (+0.25 T): **WP18·1 = T2 T1 + org hooks (1.25 T; D1 18:30–21:30)**

The `relay:publish` permission; the plan's publication count and lifetime; `relay_publications.org_id`; `ConnectorCtx.workspaceId` = the publication's org; `case.verified` emitted in the verify job; the `publish` usage record. **WP18·2** (the share-page published run) and **WP18·3** (analytics tiles + `forOrg`) become **P4**.

#### WP7: WP7·3 unchanged; WP7·4 + the end card

The end card adds "Open your workspace →" (`/app` through `/start`). The `/call` path never needs a session.

#### WP7b (+1 T): two units

- **WP7b·1 (1 T; D3 13:00–17:00; P1):** the landing page (T2 WP7b goal) + the CTA's background guest start (S§3.3) + the header nav + **the low-code section** (S§8.6) + **`/pricing` from `PLANS`**.
- **WP7b·2 (1 T; D4 09:00–13:00; P3):** the `/docs` + `/docs/[slug]` renderer (typed TS content from WP13 and WP23), `/changelog`, `/legal/*`.

**Acceptance (added):** the landing CTA still reaches the pass in < 45 s with the guest start in flight (fake upstream); `/pricing` renders from `PLANS` (a snapshot test fails if the table and the page disagree).

#### WP11, WP9: unchanged (P1)

WP11·1 moves to D2 17:00; WP11·2 moves to D4 AM.

#### WP12 (+1 T)

- **WP12·2 (G3):** T2 G3 + the SaaS deploy: the env of S§15 in `zerops.yml`; migrations 0002/0003 on Zerops; the `TENANCY_MODE=orgs` flip after the user sets `BETTER_AUTH_SECRET`; `registerTick`; the purge steps (guests, audit, webhooks); the `scrub` additions + the log-redaction test; the devtools build step (`copy-monaco`, the CLI/SDK tarballs), `.gitignore`, the root `tsconfig` include for `packages/*/src`, `npm run changeover`; a check that the CSP is unchanged.
- **WP12·3:** e2e specs 1/S/R + **spec J** (S§13.1 steps 1–10 with fake upstream: guest → Baton → workspace → Try an edit → Code edit/save → publish → sign-up carry-over → simulated upgrade → API key → `GET /api/v1/runs` → webhook to the test inbox with a valid signature); K-G3 + K-SAAS.
- **WP12·4 (G4), WP12·5** (the browser pass incl. `/app` on iPhone Safari; the runbook: tenancy mode, billing mode, webhook loopback, code editor, how to rotate `BETTER_AUTH_SECRET`; spec J live on Zerops D3–D5), G5 and RC integration (0.5 T each).

#### WP13 (+0.5 T)

- **WP13·2 (D3 AM):** the video script v3 + shot list (S§13.2); the low-code positioning in `src/content/landing.ts` and the lablab copy; pricing copy and FAQ; non-developer docs guides; the changelog; the legal placeholder text; the wording test.
- **WP13·3–·5:** T2's README/slides/cover/final assets with the S§13.3 deltas.

### Cut or deferred (v3)

WP17·4 (Telecom + wizard evaluation) → P5. WP18·2, WP18·3, WP15·4 and WP21·3 → P4. "Hear the greeting" → P5. The completion webhook runtime → P5 (org webhooks replace it).

---

## 8. Budgets

**T by WP (from D1 15:30):**

| WP | T | Tier of its units |
|---|---|---|
| WP19 | 4.25 | P1 |
| WP20 | 3 | P1 (·1, ·2), P3 (·3) |
| WP21 | 2.5 | P2 (·1, ·2), P4 (·3) |
| WP22 | 2 | P2 (·1), P3 (·2) |
| WP23 | 2 | P1 (·1), P3 (·2) |
| WP24 | 1.5 | P3 |
| WP15 | 3.5 | P1 (·1), P2 (·2, ·3), P4 (·4) |
| WP14a·4, WP14b·3–·4 | 2 | P2, P1 (·4) |
| WP16·2–·3 | 2.25 | P2, P1 (the org part of ·3) |
| WP17·2–·3 | 2 | P2 |
| WP18·1–·3 | 2.75 | P3 (·1), P4 (·2, ·3) |
| WP7·3–·4 | 2 | P2 |
| WP7b·1–·2 | 2 | P1, P3 |
| WP9·2–·3, WP11·1–·2 | 3.75 | P1 |
| WP12·2–·5, G5, RC | 4.5 | P1 |
| WP13·2–·5 | 3.5 | P1 |
| Fixes | 6.5 | — |
| **Total** | **≈ 50** | |

**Money:**
- The T2§7 budget table stands.
- v3 adds **$0 of AssemblyAI** and **≈ $0.10 of OpenAI**: spec J's daily TEXT DRY RUN on Zerops, the CLI `run` in the video, and the WP23·2 smoke against Zerops, all ledger-gated.
- Polar is sandbox only ($0).
- Better Auth, Scalar (jsDelivr), Monaco (self-hosted) and the tarballs are $0.
- Zerops: the deploy grows by ≈ 15–20 MB (Monaco + tarballs) and the storage cost is negligible against the $15 credit. The container count is unchanged (one Node container).

---

## 9. Integration checkpoints (v3 additions to T2§8)

| When | Integration | Glue owner | Test |
|---|---|---|---|
| D1 18:30 **C3** | contracts v3 + the legacy principal + ports on `main`; `SAAS.md` / `TASKS-v3.md` committed | integrator | typecheck; full suite unchanged |
| D1 22:00 **G2** | + WP23·1 (codec, schema) and WP18·1 if green | parallel branch / WP12 | G2 criteria; the codec tests |
| D2 11:00 | the widening commit; every branch merges `main` (incl. the new WP worktrees) | WP14a, WP12 | typecheck on every branch |
| **D2 12:00** | **C3b-VERIFY:** the `[VERIFY]` go/no-go before the afternoon commits to the primary path; the D2 float is released or returned here | WP19 (+ one line each from WP15, WP21) → integrator | the four items in §4; the result is written into `docs/notes/wp19.md` either way |
| D2 15:00 **C3b** | Better Auth + 0002/0003, `TENANCY_MODE=legacy` | WP19, integrator | migrations fresh + populated; v2 suite green |
| D2 17:00 | K-MONACO on a production build | WP15 | load, edit, save |
| D2 22:00 **G3** | the platform slice + the SaaS core + the Code tab on Zerops | WP12 | G3 criteria (§4) |
| D3 12:00 | K-G3 + K-SAAS | WP12 | spec S; spec J steps 1–6 |
| D3 13:00 | K-DOCS | WP22 | Scalar on Zerops |
| D3 17:00 | K-BILL | WP21 | 4242 on Zerops |
| D3 19:00 **G4** | the full judge path | WP12 | specs 1/S/R/J + live |
| D4 12:00 | K-CLI | WP23, WP12 | `npx` from a clean directory |

---

## 10. Kill criteria and fallbacks (v3 additions; T2§9 still holds)

| Check | When | Pass | If it fails |
|---|---|---|---|
| **K-VERIFY** | **D2 12:00** (new in v3.1) | the four WP19·2 items of §4 are **pass**, or a named S§16 fallback is already taken and costed | **One item on a fallback:** the 0.5 T D2 float (§5) is released to it now, not at D4. WP19·2 still lands C3b at 15:00 on the fallback path — a fallback taken deliberately at noon is cheaper than the primary path rescued at 21:00. **Two or more, or any "blocked":** C3b slips to **D2 17:00** and the evening slots re-order — WP19·3 takes S2 from 17:00 as planned, WP20·2 (S3) starts on the read-only shell only, and WP21·1 (S4) swaps to `BILLING_MODE=simulated` first so billing is demonstrable regardless. G3 keeps its 22:00 slot with the **SaaS core criteria only** (guest → account → org → Code tab); the org routes move to D3 09:00. **`TENANCY_MODE=legacy` is the floor:** if identity cannot be made to work at all, the v2 product ships with the marketing site, `/pricing` and the Studio's Code tab, and the video's SaaS beat is cut to the pricing page (P1 item 7 survives without P1 item 3) |
| **K-AUTH** | G3 deploy | Better Auth sessions work on Zerops (Secure cookies behind the L7 balancer, the Origin checks, anonymous sign-in) | `TENANCY_MODE=legacy` at once (the v2 visitor workspaces; the SaaS pages say "Accounts are temporarily unavailable"); D3 B6 S1 and S2 go to the fix before any P2/P3 unit. If it is still broken at D3 17:00, the video's SaaS beat is recorded locally against the same build and labelled "local build" |
| **K-SAAS** | D3 12:00 | §4 | P1 items 3–6 outrank everything but Baton: the D3 B7 slots S1 and S4 switch to SaaS-core fixes; WP22·2 and WP23·2 slide to D4 B9 (the fixes slots) |
| **K-MONACO** | D2 17:00 | §4 | `CODE_EDITOR=textarea` (the same diagnostics; no completion); the video shows the JSON Schema completion in VS Code instead |
| **K-DOCS** | D3 13:00 | §4 | the `/docs/api` fallback page (our server component over the same OpenAPI document) |
| **K-BILL** | D3 17:00 | §4 | `BILLING_MODE=simulated` (labelled "Pro · simulated"); the video shows the simulated checkout and says so; the Polar fix goes to D4 only if it takes ≤ 1 T |
| **K-HOOK** | G4 | a real delivery reaches the test inbox through the balancer | `WEBHOOK_INBOX_LOOPBACK=1` (labelled "delivered in-process (loopback)") |
| **K-CLI** | D4 12:00 | §4 | the docs, the Developers page and the video use `curl -fsSLO …/changeover.mjs && node changeover.mjs …` |
| **Late overall** | any gate slip > 4 h, or the T budget short | — | cut per §3, bottom-up; never below P1 |

**When a P3 feature is cut for time rather than by a kill criterion, the video beat that shows it is re-cut, not left dangling.** Every kill criterion above already names its fallback; ordinary time pressure did not, and the one beat that depends on a P3 feature is the webhook clip. So, mirroring S§13.4's style:

- **Webhooks cut (§3 P3 item 13):** the SaaS beat (S§13.2, 2:20–3:00) drops the 7 s test-inbox "Signature valid ✓" clip and gives ~3 s each to the billing and `curl /api/v1/runs` clips; the voiceover becomes "orgs and roles, usage-metered billing and a public API", and "signed webhooks" moves to the roadmap beat at 4:15. The beat keeps its slot and its length. WP13 is told at the moment of the cut, not at the recording.
- The same rule applies to any other P3 that a beat shows: **the cut decision includes the re-cut**, or it is not a decision yet.

---

## 11. What the user must do (v3 additions; T2§11 still holds)

| When | Action |
|---|---|
| D1 now | Nothing new beyond T2§11: `.\kit report` and the s01 handoff line at 15:00. The integrator commits `docs/SAAS.md` and `docs/TASKS-v3.md` with C3 |
| **D2 by 16:00** | **Generate and set `BETTER_AUTH_SECRET` in the Zerops GUI** (≥ 32 random characters; for example, run `openssl rand -base64 32` on your own machine and paste the output; never share it). This blocks the G3 SaaS criteria |
| **D2 by 16:00** | **Check the Polar sandbox token's scopes** (sandbox.polar.sh → Settings → Developers). If it lacks `customers:read/write`, `subscriptions:read` or `customer_sessions:write` (and `events:write` for the P4 meter), create a **new sandbox** token with the S§4.3 scopes and replace `POLAR_ACCESS_TOKEN` in the Zerops GUI and in your local `.env`. Keep `POLAR_SERVER=sandbox`. WP21·1 step 0 tells you whether this is needed |
| D2 22:00 | Approve the G3 push (the orchestrator pushes after the secret scan) |
| D3 12:00 | Confirm the K-G3 and K-SAAS decisions |
| **D3 by 18:00** (before the rough recording) | **Add the throwaway demo email you will sign up with to your Polar *sandbox organization* as a member** (sandbox.polar.sh → your org → Members → invite, accept it, then delete the member after D4 if you like). The Polar **sandbox delivers customer-facing email only to addresses that belong to the sandbox org** (research/17 §2.4, research/12), so a fresh `you+judge@…` address gets **no** checkout receipt. Nothing in the video depends on that receipt — the on-screen proof is the in-app "Pro · Test mode" badge — so if this is inconvenient, **skip it and do not film an inbox**. Decide which before recording, not during |
| D3 20:00 | Record the rough video, with the low-code beat (a terminal with Node ≥ 20 for `npx`) and the SaaS beat (a fresh browser profile; the throwaway email from the row above; card 4242) |
| D4 19:00 | Record the final video |
| **D5 22:00 (RC)** | **Set `LEDGER_JUDGING_WINDOW_IST` in the Zerops GUI** to the hours you expect the judges to open the link (for example `09:00-14:00`). This holds the **final AI-spend tranche closed until that window**, so the last of the AssemblyAI/OpenAI budget is available when it is actually watched rather than spent by whoever scripts the public API at 03:00 (S§4.2). Unset is safe — it falls back to the v2 fixed 6-hour clock — but then the live path may be a labelled replay during judging. Not a secret; it is a plain value |
| Optional (P4) | A free GitHub OAuth App → `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in the GUI; a Polar sandbox billing webhook to `https://<app>/api/auth/polar/webhooks` → `POLAR_BILLING_WEBHOOK_SECRET` in the GUI |
| Optional (P5) | A free Resend account → `RESEND_API_KEY` + `EMAIL_MODE=resend`; a free npm account → `npm publish` of `packages/cli` and `packages/sdk` (nothing depends on it) |
| Oct 1–21 | T2§11's daily check, plus a glance at Settings → Usage on the demo org and at `/status` for `TENANCY_MODE` and `BILLING_MODE` |

**The required set is still small:** one secret (`BETTER_AUTH_SECRET`, D2 by 16:00), one conditional check (the Polar sandbox token's scopes, D2 by 16:00), one plain value (`LEDGER_JUDGING_WINDOW_IST`, D5), one five-minute Polar dashboard action (the sandbox-org member, D3, and skippable), the recordings, and the pushes. Everything else is optional and nothing depends on it.

---

## 12. Review log (v3.0 → v3.1)

This file's share of the two v3.0 reviews. The spec-side decisions are in **S§17**; this section covers only what changed here. Both reviews found §3's priority tiers sound and did not ask for changes to them — the tiers are unchanged.

| Finding | Tier | What changed here | Decision note |
|---|---|---|---|
| **D2 has 15.25 T with zero slack, concentrated exactly where the riskiest library integrations get their first real test. WP19·2 (C3b) gates three of five D2 evening slots and the whole SaaS critical path, with no go/no-go before its 15:00 deadline and no budget for any of the 16 `[VERIFY]` fallbacks.** | blocking | **C3b-VERIFY at D2 12:00** (§4, §9): four named WP19·2 items plus one line each from WP15 and WP21, reported as pass / fallback-taken / blocked. **K-VERIFY** (§10) says what each branch costs, down to a `TENANCY_MODE=legacy` floor. **0.5 T of D2 float** (§5, §8), borrowed from WP11·1 and released or returned at the checkpoint. | Accepted in full. Two things made this worth more than a generic buffer: the checkpoint sits **before** the afternoon commits to the primary path, so a fallback is chosen at noon rather than rescued at 21:00; and the float has a single named source and a rule against spending it on anything else. WP11·1 is the right donor because it is the only D2 unit whose slip costs nothing downstream. |
| **The live state had moved: WP14a·3 is finished (`wp14a` at +23, tip `ff2105f`), not in flight.** | — | §1 re-checked against `git` and rewritten, with a note on what changed against the v3.0 draft and a pointer to `docs/notes/g2.md` (which does not exist yet) as the file to read before C3b. | The remaining G2 work is two merges and a deploy, so the C3b dependency on `0001_relays` is closer than v3.0 assumed. The D2 09:00 contingency in §1 stays as written — it costs nothing and the dependency is still real until the merge lands. |
| Polar sandbox will not deliver a checkout receipt to a throwaway address that is not a sandbox-org member. | important | §11: a **D3 by 18:00** user action, written so that **skipping it is an explicit, equally valid choice** — the on-screen proof is the "Pro · Test mode" badge, not an inbox. | Cosmetic, but the failure mode was "discover it while recording", which costs a take. Deciding before the camera is on is the whole fix. |
| A P3 feature cut for ordinary time pressure (rather than by a kill criterion) leaves its video beat undefined; webhooks are the only such beat. | important | §10 gains the re-cut rule and the exact webhook alternative (drop the 7 s inbox clip, extend billing and `curl`, move "signed webhooks" to the roadmap beat), mirroring S§13.4's style. | Accepted, and generalized to a rule: **a cut decision includes the re-cut, or it is not a decision yet.** Every other named risk in this plan already had a pre-planned fallback; this was the gap. |

The remaining v3.1 work (the shared-device claim rule, the guest-start limits, the reserved tranche, the compile bucket, the key-ownership test, the Studio breadcrumb, the guest interstitials, the beat re-cut) is specified in `docs/SAAS.md` and assigned in **S§12**; §7's preamble points every owner at that table. Total ≈ 0.3 T, absorbed by the D2 float.
