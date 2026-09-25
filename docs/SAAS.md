# Changeover SaaS layer (v3.1)

**Status:** buildable spec, **v3.1**, 2026-09-25 (D1). It is written for coding agents working in parallel. The work packages, gates, slot plan and **priority order** are in `docs/TASKS-v3.md`, a delta on `docs/TASKS-v2.md`.

**v3.1** applies two reviews of v3.0: four blocking fixes (the shared-device claim rule §2.6 R1; the guest-start limits and their degraded 429 §3.3; the reserved judging tranche §4.2; and, in `TASKS-v3.md`, the D2 12:00 VERIFY checkpoint with pre-reserved float) and eight further fixes. Every decision is logged in **§17**. Sections whose numbering or content changed: §2.6, §3.3, §3.4, §4.2, §5.5, §6.1, §6.4, §8.5, §10.4, §10.6, §13.2, §15, §16.

**Why it exists.** The user gave two instructions:
1. *"Build it as SaaS, no compromise."* Changeover becomes a real multi-tenant SaaS: accounts; organizations with roles and invites; a guest "Try it free" path that upgrades to an account; plans with entitlements; billing (Polar sandbox) and usage metering; org API keys with a public REST API and outbound webhooks; settings; an audit log; onboarding; and a marketing site. **The judge path stays no-signup.**
2. *"It is difficult to build complete no code; it could be low code if required."* Changeover is a **low-code** platform, not a no-code visual builder:
   - a relay is a versioned **blueprint file** (YAML or JSON) that teams keep in git;
   - the Studio is **config-first**: form editors for the essentials, plus the **full blueprint as code** (Monaco, JSON Schema, diff, live compiled preview);
   - there is **no drag-and-drop flow canvas**;
   - it is **extended through code**: HTTP actions to your own endpoints, webhooks, a REST API, a TypeScript SDK and a CLI;
   - AI drafting ("Describe your desk") is optional and **outputs blueprint code**.

   This overrides the word "no-code" everywhere in PLATFORM, DESIGN, the README, the deck and the video.

**Source-of-truth order when documents disagree:**
1. **this file.** It overrides `docs/PLATFORM.md` v2.1 and `docs/DESIGN.md` v1.1 wherever they conflict. It is the only spec for tenancy, identity, plans, billing, the public API, webhooks, settings, audit, the app shell, marketing and the low-code surface (§5);
2. `docs/PLATFORM.md` v2.1 (relays, blueprint, kernel, connectors runtime, publish, analytics, cost guards);
3. `docs/DESIGN.md` v1.1;
4. `research/10*` (live-verified API behaviour), then `research/17-saas-stack.md` (library facts and versions);
5. `docs/notes/*.md`.

**Tags:**
- `[VERIFY]`: a library option name or behaviour taken from docs summaries. Confirm it in the first hour of the owning unit and record the result in the WP notes. Each one has a named fallback (§16).
- `[HYPOTHESIS]`: a price or a business assumption.
- `P1`…`P5`: the priority tiers of `TASKS-v3.md` §3. P1 is never cut.

---

## 0. Decisions (one screen)

| # | Decision | Why |
|---|---|---|
| S1 | **Tenancy is user → organization → everything.** Relays, versions, drafts, runs (cases), connectors, secrets, publications, API keys, webhook endpoints, usage, entitlements and the audit log each belong to exactly one organization. **`workspace_id` ≡ `organization.id`** everywhere the v2 code already takes a `ws` string. | The v2 contracts already pass an opaque `ws` into every service (`RelayRegistry`, `SecretStore`, `Drafter`, `Publisher`, `ConnectorCtx.workspaceId`). Tenancy changes *what the string is*, not any signature. |
| S2 | **Better Auth 1.7.6** is the identity layer: email and password, optional GitHub, and the `anonymous`, `organization` and `@better-auth/api-key` (org-owned keys) plugins, with the Drizzle adapter and `nextCookies`. There is one `betterAuth()` instance, in `src/server/identity/auth.ts`. | research/17 §1: it is maintained, it has every primitive we need as a plugin, and it fits Next 16 + Drizzle + pg. |
| S3 | **A guest is a Better Auth anonymous user who owns a personal guest org.** One background `POST /api/guest/start` (≤ 400 ms, no external calls) creates it and seeds it with **Baton** (pinned, read-only flagship) and a **Dental deposit** copy. | "Try it free · no signup" is a real, account-shaped workspace, not a cookie, so sign-up can carry it over. |
| S4 | **Sign-up carries everything over** (`onLinkAccount`). The guest org's membership moves to the new user. The org id, relay ids, run ids, secrets and publications do not change. | The same org id means no re-keying: secrets are AAD-bound to `(ws, name)`. |
| S5 | **The device identity (the `bvid` visitor cookie) stays** as the rate-limit and case-token identity. Case tokens (the `vid` claim) are unchanged and gain an optional `org` claim. **Baton's `/call` path needs no session at all.** | The flagship (never-cut) path does not move. Tenancy is added beside it, not under it. |
| S6 | **Four roles: owner, admin, member, viewer**, with one permission matrix (§3.7). The matrix is pure data in `src/core/contracts/v3/permissions.ts`, used by our routes and by Better Auth's access control. | One source of truth, and testable. The guest is the owner of its own guest org. |
| S7 | **Every org-shaped mutation is server-mediated**: `/api/app/**` calls `auth.api.*` after the permission check, the plan check and the audit row. Better Auth's client endpoints for those mutations are blocked in the catch-all route (§3.8). | Plan limits, audit rows and role rules cannot be bypassed through `/api/auth/*`, and we do not depend on plugin hook names. |
| S8 | **Plans: Guest, Free, Pro, Business** (§4.1). Entitlements come from **Polar's Customer-State API** and are cached in `org_entitlements`. **No plan can raise a global cap:** the v2 global daily caps, tranches and ledger remain the hard stop, and paid actions still degrade to labelled replays. | "Zero extra money" is a structural property, not a promise. |
| S9 | **Polar SANDBOX only**, through `@polar-sh/better-auth` 1.8.4: checkout with `referenceId = orgId`, portal, webhooks, and `createCustomerOnSignUp: false`. A `BILLING_MODE=simulated` fallback runs the same UI with a labelled simulated checkout. | The 4242 upgrade demo costs $0. Anonymous users never create Polar customers. The judge path survives a Polar outage. |
| S10 | **Usage metering.** Every billable unit (AI-finished minutes, live runs, dry runs, voiced sims, drafts, publishes) is an append-only `usage_events` row with an idempotency key. It is shown in-app and can optionally be ingested into a Polar meter. | "$0.30 per AI-finished minute" becomes a real, visible meter. |
| S11 | **Public REST API `/api/v1/**`**: org-owned API keys (`cko_…`, scoped, per-key rate limits); zod schemas → OpenAPI 3.1 (`zod-openapi` 6.0.2) → **`/docs/api`, rendered by Scalar** under the existing CSP. It covers relays **including their source code**, validation, versions, compiled previews, dry runs, runs, cases, published agents, usage and webhooks. | Developers, the CLI, the SDK and judges all call one documented API. The docs are generated from the schemas the handlers validate with. |
| S12 | **Outbound webhooks**: `run.completed`, `case.verified` and `payment.succeeded` (+ `webhook.test`). They use **Standard Webhooks** signing (`standardwebhooks` 1.1.1, already a dependency), a transactional outbox, retries with backoff, a delivery log, and a **built-in test inbox** so nobody needs their own server. | A judge sees a signed delivery arrive within 5 s without leaving the app. |
| S13 | **Append-only audit log.** The row is written in the same transaction as the change wherever we own the transaction. A Postgres trigger refuses `UPDATE` and `DELETE`, except for the retention purge. | Real, cheap and demonstrable. |
| S14 | **One additive migration `0002_saas`** (Better Auth tables, our tables, additive columns), plus the custom `0003_audit_guard`. Both are owned by WP19 and designed up front here (§2.7). | Parallel WPs do not serialize on schema, as with P10. |
| S15 | **No email is sent** (`EMAIL_MODE=off`): invites are copyable links, there is no email verification, and password reset is explained honestly. Resend (free, no card) is an optional P5 switch. | Zero cost, zero setup, no deliverability risk on the judged URL. |
| S16 | **The app shell lives at `/app/**`**: Relays, Runs, Analytics, Connectors and Settings, with an org switcher. The Studio editor is `/app/relays/[id]/[tab]`, and `/studio/**` redirects there. Marketing is at `/`, `/pricing`, `/docs`, `/docs/api`, `/changelog` and `/legal/*`. | A recognizable SaaS information architecture, with the Studio inside it. |
| S17 | **Kill switches:** `TENANCY_MODE=orgs|legacy` (legacy = the v2 visitor workspaces), `BILLING_MODE=polar|simulated`, `WEBHOOK_INBOX_LOOPBACK=0|1`, `STUDIO_MODE` (v2), `CODE_EDITOR=monaco|textarea`. | Every SaaS layer has a labelled way down that keeps the judge path working. |
| S18 | **The Baton-first fallback still yields a SaaS.** If K-G3 trips (P§13.4), Baton runs are claimed into the guest org and emit the same events, so sign-up → upgrade → API key → webhook still works on Baton runs alone. | The SaaS layer does not depend on the platform critical path. |
| **L1** | **Low-code, not no-code** (§5.1). The product line is "a low-code studio for relay agents: forms for the essentials, the whole relay as code, and an API for everything else." No drag-and-drop, no flow canvas. | The user's clarification. It is also honest: the kernel is already schema-driven, so code is the natural second face. |
| **L2** | **Relay-as-code** (§5.2–§5.4). A relay is a blueprint file in **YAML or JSON**, validated by the C2 zod schema (`changeover.blueprint/2.0`) and linted by the kernel. A **published JSON Schema** is generated from that zod schema. The **source text is stored** next to the canonical JSON, so comments and formatting survive, and the version hash stays on the canonical JSON. | Teams keep relays in git and review them like code. Formatting changes never create a version. |
| **L3** | **The Studio is config-first plus code** (§5.5). Tabs: Overview, Configure (forms for the essentials), **Code** (Monaco with JSON Schema), Preview (compiled), Versions (diff), Test, Publish and Analytics. Forms and code edit the **same source** through one comment-preserving codec. | "Fewer visual widgets, more developer ergonomics." |
| **L4** | **Extensibility through code** (§5.6–§5.8): `http_action` connectors to **the customer's own HTTPS endpoints** in any language (HMAC-signed; per-org allowed hosts on Pro+), org webhooks, the REST API, a thin **TypeScript SDK** and a zero-install **CLI** (`changeover validate|pull|push|diff|run`). | The customer's code does the business logic. We own the call, the handoff and the proof. |
| **L5** | **The CLI and SDK ship from our own origin**, as npm tarballs (`npx -y <APP_URL>/cli/changeover-cli.tgz validate relay.yaml`) and as a single-file script. npm publishing is an optional user action (P5). | $0, no registry account, and it works on the judged URL. |
| **L6** | **Monaco is self-hosted** (`public/vendor/monaco`), lazy-loaded on the Code and Versions tabs only. The CSP is unchanged. The fallback is `CODE_EDITOR=textarea`, with the same diagnostics. | No new third-party origin, and no impact on the LCP of other pages. |

---

## 1. What v3 overrides

| Where | v2 rule | v3 rule |
|---|---|---|
| P§0 P1, P§1.1–1.2, README, deck, lablab copy | "a no-code studio for relay agents"; "Changeover vs. no-code voice builders" | "a **low-code** studio for relay agents" (§5.1); the comparison table is titled "Changeover vs. voice-agent builders" |
| P§0 P8, P§2.1 "Workspace" | `ws_<visitorId>` from the signed cookie; no table; no signup | `ws` ≡ `organization.id`. Guests get an anonymous user and a guest org (§3.3). `ws_gallery` is unchanged. `ws_<visitorId>` rows are legacy and are claimed (§2.6) |
| P§6.1 `http_action` + `CONNECTOR_HOST_ALLOWLIST` | the host allowlist in production for everyone | guest/free: the env allowlist; Pro+: the env allowlist **plus the org's allowed hosts** (§5.6). The SSRF guard always applies |
| P§6.4 secrets | 10 per workspace, 7-day expiry | per plan (§4.1): guest 3 / 7 days, free 5 / 30 days, pro 50 / none, business 200 / none. K1 (never in gallery or pinned publications) is unchanged |
| P§7.1 routes | `/studio`, `/studio/new`, `/studio/[id]/[tab]` | `/app/relays`, `/app/relays/new`, `/app/relays/[id]/[tab]`; `/studio/**` → 308 to the `/app` equivalent |
| P§7.2 editor tabs | Track, Case, Listening, Handoff, Playbook, Connectors, Test, Publish, Analytics, Advanced (textarea; "Monaco is not installed") | Overview, **Configure** (forms), **Code** (Monaco, JSON Schema), Preview, **Versions** (diff), Test, Publish, Analytics (§5.5). Listening, QA, extraction, compliance and the prompt template are code-only. No drag-to-reorder |
| P§7.4 wizard | four-step wizard; the result opens on TEXT DRY RUN | optional; the result opens on the **Code** tab, with the drafting notes as YAML comments (§5.9) |
| P§8.4 publish guards | 2 live per workspace, 1/day per visitor, 72 h idle purge | per plan (§4.1). The global 25 live agents and 10 publishes a day stay the hard stop |
| P§10.2 quotas | per visitor, per ipKey, global | **plan (per org) → per visitor/ipKey → global**, in that order (§4.2). Global stays authoritative. A plan limit on a paid action degrades to the labelled replay, like the global cap |
| P§11 headline price | "$0.30 per AI-finished minute; the relay studio is included" | "$0.30 per AI-finished minute; **the low-code studio, API, SDK and CLI are included**" (§4.1) |
| P§12.1–12.2 landing | one CTA, "Watch the handoff" | the same CTA also creates the guest workspace in the background ("Try it free · no signup"); the header nav adds Pricing, Docs, Changelog and Sign in (§8.6) |
| P§12.3 video | ≈ 4:30, no SaaS or code beat | ≈ 4:40, with a low-code beat and a 45 s SaaS beat (§13.2) |
| P§13.3 SHOULD order | completion webhook first … Publish last | replaced by the priority tiers of TASKS-v3 §3. `completion_webhook`'s runtime becomes P5, because org webhooks (§7) are the supported integration |
| DESIGN §4.3 visitor identity | the only identity | kept as the **device** identity (limits, case tokens, STT queue); the **principal** (§2.3) is the tenant identity |
| TASKS-v2 §4 | no `src/server/identity/**` and so on | the ownership additions in TASKS-v3 §6 |

Everything else in PLATFORM and DESIGN still holds: the limits authority, the ledger and tranches, Watch mode, the takeover protocol, fail-closed payments, QA, the user-content fences, the provenance strip, Express and parity.

---

## 2. Tenancy model

### 2.1 Entities and identities

```
User (Better Auth; isAnonymous for guests) ──< Member(role) >── Organization (kind guest|personal|team)
                                                                 │
   Device (bvid cookie: visitorId, ipKey) ── limits, case tokens │
                                                                 ├──< Relay (draft + draft_source) ──< RelayVersion (+ source) ──< Publication
                                                                 ├──< Run (= cases.org_id) ──< takeover, payment, verification
                                                                 ├──< ConnectorSecret, Draft, ConnectorCall, allowed connector hosts
                                                                 ├──< ApiKey (org-owned), WebhookEndpoint ──< WebhookDelivery
                                                                 ├──1 OrgEntitlements (plan, Polar state)   ├──< UsageEvent
                                                                 └──< AuditLog, DomainEvent (outbox), Invitation
```

| Identity | What it is | Where it is checked |
|---|---|---|
| **Device** | `bvid` = `<visitorId>.<hmac>` (unchanged, `src/server/auth/visitor.ts`), plus `ipKey` (WP12's P-0 fix: the balancer-set `X-Real-IP`, /24 and /48) | rate limits, `/api/cases` and case tokens, the STT queue, guest-start limits |
| **Session** | the Better Auth session cookie `co.session_token` (+ `activeOrganizationId`) | `/app/**`, `/api/app/**`, `/api/relays/**` and the other org routes, and `/api/v1/**` (UI use) |
| **API key** | `cko_…`, owned by an organization, scoped | `/api/v1/**` only (the CLI and SDK use it) |
| **Case token** | a per-case JWT (unchanged; an optional new `org` claim) | case, takeover, tool and payment routes (unchanged) |

### 2.2 Organizations

| Field | Rule |
|---|---|
| id | an opaque string. Prefix `org_` through Better Auth's id generator `[VERIFY advanced.database.generateId]`. Nothing depends on the prefix |
| kind (`org_meta.kind`) | `guest` (owned by an anonymous user), `personal` (the first org of a real user) or `team` (any other) |
| slug | `guest-<8>` for guests; `<email-local>-<4>` for personal orgs; user-chosen for teams |
| plan (`org_entitlements.plan`) | `guest` for guest orgs, `free` by default, `pro`/`business` from Polar |
| orgs per user | a real user owns at most 3 orgs (a claimed guest org may exceed this; data is never lost). Guests own exactly 1 and cannot create more |
| `ws_gallery` | a reserved pseudo-org for the public gallery (no row in `organizations`), read-only to everyone |

**`workspace_id` ≡ `organization.id`.** The v2 columns `relays.workspace_id`, `connector_secrets.workspace_id` and `drafts.workspace_id` keep their names. After `TENANCY_MODE=orgs`, every new row carries an org id. No v2 contract signature changes.

### 2.3 The principal

Every org route resolves a `Principal` (the contract is in §14) through **`requirePrincipal(req, need?)`** from `src/server/saas/principal.ts`:

1. `Authorization: Bearer cko_…` or `x-api-key: cko_…` → an **API-key principal** (`/api/v1/**` only; ignored elsewhere). It is verified by `auth.api.verifyApiKey`. The org is the key's org, `scopes` come from the key's permissions, and `role = null`.
2. Otherwise, a Better Auth session → a **session principal**: `userId`, `isAnonymous`, `orgId = session.activeOrganizationId` (it must still be a membership; otherwise the most recent membership; otherwise `null`), `role` from `members`, and `plan` from `org_entitlements`.
3. Otherwise → a **visitor principal** (`orgId = null`). Under `TENANCY_MODE=legacy` (and at C3, before Better Auth lands), the visitor principal gets `orgId = "ws_" + visitorId`, `role = "owner"` and `plan = "guest"`, which is exactly the v2 behaviour.

`need` options: `perm` (a `Permission`, §3.7), `account: true` (refuses anonymous users with `E_ACCOUNT_REQUIRED`) and `allowVisitor: true`. Rules:
- no org and no `allowVisitor` → 401 `E_AUTH_REQUIRED` with the body `{ start: "/start?next=<path>" }` (the UI starts a guest automatically, §3.3);
- a missing permission or scope → 403 `E_FORBIDDEN` / `E_SCOPE`;
- **a foreign or unknown resource id → 404 `E_NOT_FOUND`, never 403** (no existence leak);
- session-authenticated non-GET requests must pass the same-origin check (§3.9). API-key requests are exempt and never read cookies.

The `device` fields (`visitorId`, `ipKey`) are always present, so the v2 limits keep working unchanged.

### 2.4 Table-by-table scoping

| Table (owner) | How it is scoped | Change in `0002_saas` |
|---|---|---|
| `relays` (WP14b) | `workspace_id` = the org id (gallery: `ws_gallery`) | + `created_by_user_id text`, **+ `draft_source text`, `draft_source_format text`** (§5.2) |
| `relay_versions` (WP14b) | through `relay_id` | **+ `source text`, `source_format text`** |
| `relay_publications` (WP18) | through the relay; denormalized for plan counts | + `org_id text` |
| `drafts` (WP17) | `workspace_id` = the org id | — |
| `connector_secrets` (WP16) | `workspace_id` = the org id; the AAD binds `(ws, name)` | — |
| `connector_calls` (WP16) | through the case/version; denormalized for Usage and Analytics | + `org_id text` |
| `sim_calls` (WP17) | gallery rows are global; others go through `relay_version_id` → relay | — |
| `tts_cache` | global, content-addressed, not tenant data | — |
| `cases` (WP14b) | **`org_id`** = the org that owns and is billed for the run: (a) Studio, gallery and Baton runs → the runner's active org (null if there is no session yet; claimed later); (b) published runs → the publication's org | + `org_id text`, `created_by_user_id text`, index `(org_id, created_at desc)` |
| `turns`, `fact_events`, `takeovers`, `tool_calls`, `payments`, `verifications`, `verifier_runs` | through `case_id` → `cases.org_id` | — |
| `spend_ledger`, `rate_events`, `jobs`, `app_flags`, `health_checks`, `webhook_events` (inbound), `stream_queue`, `live_sessions` | system-wide (provider budgets, device limits, queues) | — (plan buckets use the rate keys `org:<id>:<bucket>`) |
| `promoted_agents` | cut (P§13) | — |
| Better Auth tables, `org_meta` (incl. `connector_hosts`), `org_entitlements`, `usage_events`, `domain_events`, `webhook_*`, `audit_log` | `org_id` (or membership) | new (§2.7) |

### 2.5 Route-by-route scoping

| Route(s) | v2 identity | v3 identity | Owner |
|---|---|---|---|
| `GET /`, `/pricing`, `/docs/**`, `/changelog`, `/legal/*`, `/status`, `/api/status`, `/api/health`, `/schemas/*.json`, `/cli/*`, `/sdk/*` | public | public (static files for the last three) | WP7b, WP22 (`/docs/api`), WP12, WP23 (static devtools) |
| `/call/[id]`, `/a/[slug]`, `/r/[slug]`, `GET /api/publications/:slug` | public + device | **unchanged** (no session needed) | WP7, WP18, WP15 |
| `POST /api/cases` | device | device, **plus** `org_id`/`created_by_user_id` from the session principal when there is one; the plan checks `liveRunsPerDay` + `aiMinutesPerMonth` (over plan → the labelled replay, §4.2) | WP14b |
| `/api/cases/[id]`, `/api/runs/**`, `/api/stt/**`, `/api/va/token`, `/api/sessions/report`, `/api/takeovers/**`, `/api/tools/**`, `/api/payments/**`, `/api/verifications/**`, `/api/va-sessions/**` | case token / device | **unchanged** (the case token is the runtime capability; the token gains an optional `org`) | WP14b, WP16, WP18, WP12 |
| `/api/relays/**` (incl. `/compiled`, `/versions`, `/analytics`, **`/source`**) | device → `ws_<vid>` | **session principal**, `perm` per §3.7; `ws = orgId` | WP14b, WP18 |
| `/api/drafts/**`, `/api/sim-calls/**` | device → `ws_<vid>` | session principal (`run:start`) | WP17 |
| `/api/connectors/test`, `/api/connectors/echo`, `/api/secrets/**` | device | session principal (`connector:test`, `secret:read|write`) | WP16 |
| `POST /api/relays/:id/publish`, `DELETE /api/publications/:id` | device | session principal (`relay:publish`) | WP18 |
| `/api/connectors/pub/:pubId/:tool` | publication key | unchanged; `ConnectorCtx.workspaceId` = the publication's org | WP18 |
| `/api/admin/**`, `/api/internal/**` | `ADMIN_KEY`, `CRON_SECRET` | unchanged | WP12 |
| `/api/webhooks/polar` (payments), `/api/webhooks/assemblyai` | provider signatures | unchanged (the payments handler ignores subscription events) | WP16, WP18 |
| **new** `/api/auth/[...all]` | — | Better Auth (with the blocked-path filter, §3.8) | WP19 |
| **new** `POST /api/guest/start` | — | device + rate limits → creates the guest session | WP19 |
| **new** `/api/app/{orgs,members,invitations,audit}/**` | — | session principal | WP19 |
| **new** `/api/app/connector-hosts/**` | — | session principal (`secret:write`, Pro+) | WP16 |
| **new** `/api/app/billing/**` | — | session principal (`billing:*`) | WP21 |
| **new** `/api/app/api-keys/**` | — | session principal (`apikey:manage`), `account: true` | WP22 |
| **new** `/api/app/webhooks/**` | — | session principal (`webhook:*`), `account: true` | WP24 |
| **new** `/api/v1/**` (except `/api/v1/webhooks/**`) | — | API key **or** session principal; scopes and permissions per §6.2; `POST /api/v1/blueprints/validate` also accepts no auth (§6.2) | WP22 |
| **new** `/api/v1/webhooks/**` | — | API key or session (`webhooks:*`) | WP24 |
| **new** `POST /api/webhook-inbox/:inboxId` | — | public, rate-limited, unauthenticated (the test receiver) | WP24 |
| **new** `/api/auth/polar/webhooks` | — | the Polar signature (plugin), optional | WP21 (config) |

### 2.6 Legacy mapping: visitorId, `ws_<visitorId>`, case tokens

- **The device identity is unchanged.** `src/proxy.ts` keeps minting `bvid`. Limits, the STT queue and case tokens keep using `visitorId` and `ipKey`.
- **Case tokens are unchanged**, plus an optional `org` claim set at issue time (`issueCaseToken({..., orgId})`). Routes that verify case tokens do not read it. It lets `/api/cases` responses and events know the org without a lookup.
- **`claimVisitorData(visitorId, orgId)`** (`src/server/identity/claim.ts`, WP19) runs idempotently, in one transaction. **It is never called automatically on a plain sign-in** (see "When the claim runs" below):
  1. `UPDATE cases SET org_id = :org WHERE visitor_id = :vid AND org_id IS NULL AND created_at > now() - interval '7 days'`;
  2. `UPDATE relays SET workspace_id = :org WHERE workspace_id = 'ws_' || :vid AND deleted_at IS NULL`;
  3. `UPDATE drafts SET workspace_id = :org WHERE workspace_id = 'ws_' || :vid`;
  4. secrets: `getSecretRebinder().rebind('ws_' || vid, org, tx)` (a WP16 port: open with the old AAD, re-seal with the new one, keep the same row id);
  5. `relay_publications.org_id` for the moved relays;
  6. one audit row, `guest.claimed_device {cases, relays, drafts, secrets}`.

  A device whose `ws_<vid>` data another org already claimed is not claimed again (step 2 finds nothing). The HMAC on `bvid` means one device cannot forge **another device's** cookie.

- **When the claim runs (shared-device rule, R1).** The HMAC binds the cookie to the device, **not to a person**, so an automatic claim on every sign-in would move the previous person's unclaimed guest work into the next person's org on a shared or public machine (a library PC, a demo laptop, a kiosk, a judge's borrowed browser). So:

  | Trigger | Behaviour |
  |---|---|
  | **Guest start** (`POST /api/guest/start`, §3.3 step 6) | automatic. The device is claiming its own data into the org it just created in the same request. |
  | **Guest → account in the same session** (`onLinkAccount`, §3.4) | automatic. The signer-up *is* the guest whose data it is; the org id does not even change. |
  | **Sign-in to an existing account** on a device carrying unclaimed `ws_<vid>` data | **never automatic.** The sign-in completes untouched. If `countClaimableDevice(visitorId)` finds anything, `/app` shows a **dismissible** card: "This browser has guest work that isn't in any workspace yet — 2 relays, 1 run. Add it to <Org>?" with **Add to this workspace** / **Not mine** (and a "what is this?" link). Only the button calls `POST /api/app/claim-device`, which re-derives `visitorId` from the signed cookie server-side (the body carries no id), re-checks the permission matrix (member+), runs the same transaction and audits `guest.claimed_device {via:"confirmed", cases, relays, drafts, secrets}`. |
  | **Not mine** | writes `claim_declined_at` into `org_meta` for that `(orgId, visitorId)` pair; the card never returns for that pair. The legacy rows stay unclaimed and expire on the v2 LRU / purge schedule. |

  The card is **not** on the judge path (a judge signs up, they do not sign in), so this costs the demo nothing.

  **Tests (WP19·3):** signing in to account B on a device whose `ws_<vid>` data was created while account A's guest was active moves **nothing** until the button is pressed; the card does not appear when there is nothing claimable; `POST /api/app/claim-device` with a forged or absent `bvid` is a 401 and with another org's active session claims nothing; declining is idempotent and permanent.
- **Events are not back-filled.** A run that finished before its case had an org emits no webhook event (for example, a Baton run on a device with no session yet). The endpoint page offers "Send the latest event of this type" (§7.6), which covers the judge path.
- After `TENANCY_MODE=orgs`, no new `ws_<vid>` rows are created. Unclaimed legacy rows are removed by the v2 LRU and purge rules.

### 2.7 Migration `0002_saas` (+ custom `0003_audit_guard`), owned by WP19

**Better Auth tables** are generated by the CLI (`npx auth@1.7.6 generate`) from the exact config of §3.1, with `usePlural: true`, into `src/server/db/schema-auth.ts` (committed, never hand-edited): `users` (+ `is_anonymous`), `sessions` (+ `active_organization_id`), `accounts`, `verifications`, `organizations`, `members`, `invitations` and `apikeys` (org-owned; the plugin's reference columns). App tables never add foreign keys to `users`, because the anonymous user row is deleted on link. They reference `organizations(id)`.

**Our tables and columns** (`src/server/db/schema-saas.ts`; `drizzle-kit generate` produces the SQL):

```sql
CREATE TABLE org_meta (
  org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,                              -- guest | personal | team
  created_via text NOT NULL,                       -- guest_start | onboarding | switcher | claim | auto_personal
  pinned_relay_ids text[] NOT NULL DEFAULT '{}',   -- Baton for guest/personal orgs
  connector_hosts text[] NOT NULL DEFAULT '{}',    -- §5.6: lowercase hostnames the org's http_action connectors may call (Pro+)
  onboarding jsonb NOT NULL DEFAULT '{}',          -- {templateId, dismissedChecklist}
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE org_entitlements (
  org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL,                              -- guest | free | pro | business
  status text NOT NULL,                            -- active | trialing | past_due | canceled | none
  source text NOT NULL,                            -- default | polar | simulated | admin
  billing_user_id text,                            -- Better Auth user id = Polar customer external id
  polar_subscription_id text, polar_product_id text,
  current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  overrides jsonb NOT NULL DEFAULT '{}',           -- per-org limit overrides (admin only)
  state jsonb,                                     -- trimmed Customer-State snapshot (ids, statuses; no card data)
  synced_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE usage_events (
  id text PRIMARY KEY,                             -- use_<nanoid>
  org_id text NOT NULL, kind text NOT NULL,        -- ai_minutes | live_run | dry_run | voiced_sim | draft | publish
  quantity double precision NOT NULL, unit text NOT NULL,   -- minutes | count
  case_id text, relay_id text,
  source text,                                     -- recorded | simulated | text_dry_run | published | replay
  idempotency_key text NOT NULL UNIQUE,            -- e.g. ai_minutes:<takeoverId>
  occurred_at timestamptz NOT NULL DEFAULT now(),
  polar_ingested_at timestamptz, polar_error text);
CREATE INDEX usage_events_org_time_idx ON usage_events (org_id, occurred_at);
CREATE INDEX usage_events_ingest_idx ON usage_events (occurred_at) WHERE polar_ingested_at IS NULL;

CREATE TABLE domain_events (                       -- transactional outbox
  id text PRIMARY KEY,                             -- evt_<nanoid>; also the webhook-id header
  org_id text NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
  dedupe_key text UNIQUE,                          -- e.g. run.completed:<takeoverId>
  created_at timestamptz NOT NULL DEFAULT now(), fanned_out_at timestamptz);
CREATE INDEX domain_events_pending_idx ON domain_events (created_at) WHERE fanned_out_at IS NULL;
CREATE INDEX domain_events_org_type_idx ON domain_events (org_id, type, created_at DESC);

CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY,                             -- whe_<nanoid>
  org_id text NOT NULL, url text NOT NULL, description text,
  events text[] NOT NULL,
  secret_ciphertext bytea NOT NULL, secret_iv bytea NOT NULL, secret_tag bytea NOT NULL, key_version integer NOT NULL,
  secret_hint text NOT NULL,                       -- "whsec_…9fQ2" (last 4)
  inbox_id text UNIQUE,                            -- set when url is our test inbox
  enabled boolean NOT NULL DEFAULT true, disabled_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by_user_id text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (org_id) WHERE deleted_at IS NULL;

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,                             -- whd_<nanoid>
  org_id text NOT NULL, endpoint_id text NOT NULL, event_id text NOT NULL, event_type text NOT NULL,
  status text NOT NULL,                            -- pending | succeeded | failed | exhausted | canceled
  attempt integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz, last_attempt_at timestamptz,
  response_status integer, response_ms integer, response_body text,    -- body ≤ 2 KiB
  error_code text,                                 -- timeout | dns | refused_ssrf | tls | http_status | ...
  manual boolean NOT NULL DEFAULT false,           -- "Send test event" / "Send latest" / "Redeliver"
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id, manual));
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','failed');
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

CREATE TABLE webhook_inbox_requests (
  id text PRIMARY KEY, inbox_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  headers jsonb NOT NULL, body text NOT NULL,      -- body ≤ 64 KiB; kept 24 h, ≤ 50 per inbox
  signature_valid boolean, event_type text);
CREATE INDEX webhook_inbox_idx ON webhook_inbox_requests (inbox_id, received_at DESC);

CREATE TABLE audit_log (
  id text PRIMARY KEY,                             -- aud_<nanoid>
  org_id text,                                     -- null only for user-level events without an org
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,                        -- user | guest | api_key | system
  actor_id text, actor_label text,                 -- label frozen at write time ("ada@…", "key cko_…a1b2")
  action text NOT NULL, target_type text, target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',            -- never secret values, never raw IPs
  ip_key text, request_id text);
CREATE INDEX audit_log_org_time_idx ON audit_log (org_id, occurred_at DESC);

ALTER TABLE cases ADD COLUMN org_id text;
ALTER TABLE cases ADD COLUMN created_by_user_id text;
CREATE INDEX cases_org_created_idx ON cases (org_id, created_at DESC);
ALTER TABLE relays ADD COLUMN created_by_user_id text;
ALTER TABLE relays ADD COLUMN draft_source text;            -- §5.2: the author's YAML/JSON text (≤ 256 KiB); null = serialize the canonical draft
ALTER TABLE relays ADD COLUMN draft_source_format text;     -- yaml | json
ALTER TABLE relay_versions ADD COLUMN source text;          -- the source text at snapshot time
ALTER TABLE relay_versions ADD COLUMN source_format text;
ALTER TABLE relay_publications ADD COLUMN org_id text;
ALTER TABLE connector_calls ADD COLUMN org_id text;
```

**`0003_audit_guard`** (`drizzle-kit generate --custom`; drizzle does not track triggers, so `drizzle-kit generate` stays diff-free):

```sql
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('changeover.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
```

The retention purge runs `SET LOCAL changeover.audit_purge = 'on'` inside its own transaction.

### 2.8 Migration order and `TENANCY_MODE`

1. `0000_init` (exists) → `0001_relays` (WP14b; merged at G2, or at C3b at the latest) → **`0002_saas`** → **`0003_audit_guard`**. WP19 writes its schema in `schema-saas.ts` / `schema-auth.ts` and **generates the SQL only after `0001` is on `main`**, so the drizzle journal never forks.
2. No data migration runs at deploy. Legacy rows are claimed lazily (§2.6).
3. `TENANCY_MODE` defaults to `legacy` until the G3 deploy, where WP12 sets `orgs` (the user sets `BETTER_AUTH_SECRET` first). `legacy` is also the kill switch if Better Auth fails on Zerops (K-AUTH): the relay routes fall back to visitor workspaces, and the SaaS pages show "Accounts are temporarily unavailable".

---

## 3. Authentication and organizations

### 3.1 Better Auth configuration (`src/server/identity/auth.ts`, WP19)

```ts
import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";   // [VERIFY] package name/version at install (research/17 §1.5)
import { anonymous, organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { apiKeyPlugins } from "../api-v1/keys-plugin";     // WP22 (a `[]` stub from C3)
import { polarPlugins } from "../billing/polar-plugin";    // WP21 (a `[]` stub from C3)
import { ac, roles } from "./access";                      // built from contracts/v3 ROLE_PERMISSIONS
import { onLinkAccount } from "./link";
import { pickActiveOrg } from "./active-org";

export const auth = betterAuth({
  appName: "Changeover",
  baseURL: env.BETTER_AUTH_URL,                 // the public https origin (= APP_URL)
  secret: env.BETTER_AUTH_SECRET,               // user-set in the Zerops GUI; ≥ 32 chars
  trustedOrigins: [env.APP_URL, ...(isDev ? ["http://localhost:3000"] : [])],
  database: drizzleAdapter(getDb(), { provider: "pg", usePlural: true, schema: authSchema }),
  emailAndPassword: { enabled: true, requireEmailVerification: false, autoSignIn: true,
                      minPasswordLength: 10, maxPasswordLength: 128 },
  socialProviders: env.GITHUB_CLIENT_ID
    ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, scope: ["user:email"] } } : {},
  account: { accountLinking: { enabled: true, trustedProviders: ["github"] } },
  session: { expiresIn: 30 * 86400, updateAge: 86400, cookieCache: { enabled: true, maxAge: 300 } },
  rateLimit: { enabled: true, storage: "memory", window: 60, max: 100, customRules: {
    "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 3600, max: 10 },
    "/sign-in/anonymous": { window: 3600, max: 10 }, "/sign-in/social": { window: 60, max: 10 } } },
  advanced: {
    useSecureCookies: isProd, cookiePrefix: "co",
    ipAddress: { ipAddressHeaders: ["x-real-ip"] },        // [VERIFY] WP12 P-0: the balancer-set header
    database: { generateId: ({ model }) => prefixedId(model) },   // [VERIFY]; optional
  },
  databaseHooks: { session: { create: { before: async (s) =>
    ({ data: { ...s, activeOrganizationId: await pickActiveOrg(s.userId) } }) } } },
  plugins: [
    anonymous({ emailDomainName: "guest.changeover.invalid", generateName: () => "Guest", onLinkAccount }),
    organization({ ac, roles, allowUserToCreateOrganization: async (u) => !u.isAnonymous,
                   invitationExpiresIn: 7 * 86400, sendInvitationEmail: async () => { /* link-only, §3.6 */ } }),
    ...apiKeyPlugins(),      // apiKey({ references: "organization", defaultPrefix: "cko_", enableMetadata: true, ... })
    ...polarPlugins(),       // polar({ client, createCustomerOnSignUp: false, use: [checkout, portal, usage, webhooks] })
    nextCookies(),           // last
  ],
});
```

- **Route:** `src/app/api/auth/[...all]/route.ts` = `toNextJsHandler(auth)`, wrapped by the blocked-path filter (§3.8).
- **Client:** `src/client/identity/auth-client.ts` (`createAuthClient` with `anonymousClient`, `organizationClient`, `apiKeyClient` and `polarClient`). Components never import `better-auth` server code.
- **`pickActiveOrg(userId)`:** the membership with the latest `org_meta.last_active_at`.
- **`ensurePersonalOrg(userId)`** (WP19): if a real user has no membership, the `/app` layout creates a personal org, "<Name>'s workspace" (`created_via: "auto_personal"`, plan `free`), and makes it active. It is idempotent (an advisory lock on the user id). No user ever lands in an org-less app, so onboarding (§8.3) is about templates, not forms.

### 3.2 Email + password; GitHub (optional)

- `/sign-up`: email, password (≥ 10 characters) and an optional name (it defaults to the email's local part). **No verification email.** A terms checkbox links `/legal/terms` (a placeholder). The form says: "No verification email. A throwaway address like you+changeover@example.com works."
- `/sign-in`: email and password. "Continue with GitHub" appears only when `GITHUB_CLIENT_ID` is set (a user action: a free GitHub OAuth App with the callback `https://<app>/api/auth/callback/github`; P4).
- Both pages accept `?next=` (same-origin paths only) and `?invite=<id>`.
- When the browser holds an anonymous session, both forms say **"Your guest workspace comes with you"**, and Better Auth fires `onLinkAccount` (§3.4).

### 3.3 Guest: "Try it free · no signup"

**Entry points:** the landing page's primary CTA, "Build a relay →", any `/app/**` deep link without a session (through `/start`), and the end card of the Baton console.

**`POST /api/guest/start`** (`src/app/api/guest/start/route.ts`, WP19), body `{ next?: string }`:
1. If a session exists → `200 { orgId, reused: true }`.
2. Limits (device + ipKey + global). **This endpoint costs $0 and makes no external call, so its limits are anti-junk-row limits, not spend limits** — the spend guard lives downstream on paid actions (§4.2), and these numbers are deliberately far above anything a judging session can reach: ≤ 10 per device per day; ≤ `GUEST_PER_IPKEY_HOURLY` (**30**) per ipKey per hour and 120 per day; ≤ `GUEST_DAILY_CAP` (**2000**) per day globally. A whole evaluation panel behind one office or VPN egress IP, re-running the flow, stays inside this.
   Over a limit → `429 { fallback: ["/sign-up", "/call/<s01>?express=1"], degraded: true }`. **The 429 degrades, it does not block.** The UI keeps the user exactly where they were and shows a quiet one-line notice — "Continuing without a saved workspace — the demo works the same. Create a free account (10 s) to keep your edits." — with **Create account** and **Dismiss**. `/call/**` is unaffected either way (S5), and `/app/**` renders read-only over the device-scoped legacy workspace. Nothing says "paused" or "unavailable": on the judged URL a rate-limit notice must never read like an outage.
3. `auth.api.signInAnonymous({ headers, asResponse: true })` `[VERIFY asResponse]`. The Set-Cookie headers are copied onto our response.
4. In one transaction: insert the organization ("Guest workspace", `guest-<8>`), the owner membership, `org_meta {kind:"guest", pinned_relay_ids:[baton]}` and `org_entitlements {plan:"guest", source:"default"}`; set the session's `activeOrganizationId`.
5. Seed: `getGuestSeeder().seed(orgId)` (a WP14b port). It clones the Dental gallery relay as **"Dental deposit (your copy)"** (DB only: no compile, no moderation call). Its `draft_source` is the YAML serialization (§5.3) under a short header comment (`# Your copy of the Dental deposit template. Edit it here or in Configure.` plus the `$schema` line). Baton is **pinned, not cloned**: it is the flagship on the legacy path (P3). It is shown at the top of Relays as "Flagship · read-only", with **Run** and **View code**.
6. `claimVisitorData(visitorId, orgId)` (§2.6).
7. Audit `org.created {via:"guest_start"}`; respond `200 { orgId, relayIds }`.

Budget: ≤ 400 ms p50, ≤ 1 s p95, no external calls.

**The landing CTA never waits for it.** The click handler primes the `AudioContext` (the DESIGN autoplay rule), fires `fetch("/api/guest/start", {method:"POST", keepalive:true})` without awaiting it, and client-navigates to `/call/<s01>?express=1`. The Baton path needs no session, so the click-to-pass target of < 45 s is untouched. The case gets its `org_id` if the guest exists by the time `/api/cases` runs (≈ 3 s later, after the countdown), or later through the claim.

**`/start?next=/app/...`** (WP20) is a page that POSTs `/api/guest/start` on mount and then calls `location.replace(next)`. It shows "Setting up your guest workspace — no signup needed", with a `<noscript>` button. This is the only "wall", and it needs no input.

**What a guest can do:** every $0 Studio action (forms, Code, Preview, Versions, lint, the JSON Schema, Download/Import), test runs within the Guest plan (§4.1), 1 live publication (24 h), and the built-in connectors. **What needs an account** (`E_ACCOUNT_REQUIRED`): invites, API keys (and so the CLI's pull/push/run and the SDK), webhooks, checkout and creating another org. The offline `changeover validate` needs nothing. The guest banner explains this (§8.2).

**Guest lifetime:** guest users idle for 14 days are purged together with their guest org and its data: relays soft-deleted, publications unpublished and their agents deleted, secrets and drafts deleted (a guest has no webhook data). Runs follow the v2 case retention.

### 3.4 Guest → account: `onLinkAccount` carry-over (`src/server/identity/link.ts`, WP19)

`onLinkAccount({ anonymousUser, newUser })` runs before Better Auth deletes the anonymous user. In one transaction:
1. `UPDATE members SET user_id = :new WHERE user_id = :anon` (the guest org is now owned by the real user).
2. For each moved org with `kind = 'guest'`:
   - `kind` → `personal` if the new user has no other org, otherwise `team`;
   - rename "Guest workspace" → "<name>'s workspace" (or "Guest workspace (claimed <date>)" when the user already had orgs);
   - `org_entitlements.plan` `guest` → `free` (`source: default`).
3. `UPDATE cases/relays/webhook_endpoints SET created_by_user_id = :new WHERE created_by_user_id = :anon`.
4. Audit `guest.claimed {fromUserId, toUserId, orgId}`. The audit log itself is never rewritten; older rows keep the guest actor label.
5. `org_meta.last_active_at = now()`, so `pickActiveOrg` makes the claimed org active in the new session.

This fires **for sign-up and for sign-in to an existing account** (in the second case the guest org becomes an additional org). The org id and every resource id stay the same, so open tabs, share links, API resources, secrets and `changeover.lock.json` files keep working.

**This is not the shared-device claim.** `onLinkAccount` moves only what the **current anonymous session** owns — the person signing in is demonstrably the guest who did the work, in the same browser session. Unclaimed `ws_<vid>` data with no live anonymous session behind it is governed by §2.6's rule R1 and needs the confirmation card; `link.ts` never calls `claimVisitorData` for a session that is not anonymous.

**Tests:**
- signing up while anonymous keeps the same org id, relay ids, run ids and secret ids;
- signing in to an existing account adds the org;
- the anonymous user row is gone;
- the claimed org's plan is `free`;
- the audit row exists;
- there is no orphaned membership;
- `ensurePersonalOrg` does not create a second, empty org for a linked user.

### 3.5 Organizations, active org, switcher

- **Create:** "New organization" in the switcher, and the onboarding step (§8.3). Both go through `POST /api/app/orgs` (server-mediated; `!isAnonymous`; ≤ 3 owned).
- **Switch:** `authClient.organization.setActive({ organizationId })` (Better Auth checks the membership), then `router.refresh()`. A deep link to a resource of another org the user belongs to switches automatically; otherwise it is a 404.
- **Rename / slug:** admin+.
- **Delete:** owner only, with a typed confirmation. It unpublishes publications (agents deleted), revokes keys, disables endpoints, soft-deletes relays, and keeps the audit rows for 30 days.
- **Leave:** any member except the last owner.
- **Transfer ownership:** owner → an existing admin.

### 3.6 Invitations as copyable links

- `POST /api/app/invitations {email, role}` (admin+; `role ≤` the inviter's role; seats checked, §4.1) → `auth.api.createInvitation` → `{ id, link: "<APP_URL>/accept-invite/<id>", expiresAt }`. `sendInvitationEmail` is a no-op (or Resend when `EMAIL_MODE=resend`, P5).
- The Members page lists pending invites with **Copy link**, Revoke and the expiry (7 days).
- `/accept-invite/[id]` shows the org name and the role. If signed out → sign-up or sign-in with the invited email prefilled. Better Auth accepts only when the session user's email equals the invitation's email, so **the link alone is not enough**. On accept, the active org is switched and `member.joined` is audited.
- A guest who opens an invite is asked to create an account first; the guest org comes along (§3.4).

### 3.7 Roles and the permission matrix

`src/core/contracts/v3/permissions.ts` is pure data (`can(principal, perm)`). `src/server/identity/access.ts` builds Better Auth's `ac`/`roles` from it, plus the plugin's default `organization`/`member`/`invitation` statements for owner and admin `[VERIFY defaultStatements]`.

| Permission | owner | admin | member | viewer | API scope |
|---|---|---|---|---|---|
| `relay:read` (list, detail, **source**, compiled, versions, diff, analytics) | ✓ | ✓ | ✓ | ✓ | `relays:read` |
| `relay:write` (create, clone, import, save draft/source, snapshot a version, restore, delete own) | ✓ | ✓ | ✓ | – | `relays:write` |
| `relay:delete_any` | ✓ | ✓ | – | – | `relays:write` |
| `relay:publish` (publish, unpublish) | ✓ | ✓ | – | – | `relays:publish` |
| `run:read` (runs, cases, QA, dry-run results, usage by run) | ✓ | ✓ | ✓ | ✓ | `runs:read` |
| `run:start` (Test, Try an edit, dry run, sim, draft) | ✓ | ✓ | ✓ | – | `relays:write` (dry runs only) |
| `connector:test` | ✓ | ✓ | ✓ | – | – |
| `secret:read` (names only) | ✓ | ✓ | ✓ | – | – |
| `secret:write` (incl. the allowed connector hosts) | ✓ | ✓ | – | – | – |
| `member:read` | ✓ | ✓ | ✓ | ✓ | – |
| `member:invite` (up to one's own role) | ✓ | ✓ | – | – | – |
| `member:manage` (role change, remove; never an owner by an admin) | ✓ | ✓ | – | – | – |
| `org:update` | ✓ | ✓ | – | – | – |
| `org:delete`, ownership transfer | ✓ | – | – | – | – |
| `billing:read` (plan, period, portal link) | ✓ | ✓ | – | – | – |
| `billing:manage` (checkout, portal, cancel) | ✓ | – | – | – | – |
| `usage:read` | ✓ | ✓ | ✓ | ✓ | `usage:read` |
| `apikey:manage` | ✓ | ✓ | – | – | – |
| `webhook:read` (endpoints, delivery log) | ✓ | ✓ | – | – | `webhooks:read` |
| `webhook:manage` (create, update, delete, redeliver, test) | ✓ | ✓ | – | – | `webhooks:write` |
| `audit:read` | ✓ | ✓ | – | – | – |

"Members build, admins ship": publishing, secrets, allowed hosts and API/webhook configuration are admin+. Plan limits (§4.1) apply on top, so a guest owner still cannot invite, create keys or add webhooks.

### 3.8 Server-mediated mutations (blocked client paths)

The catch-all auth route rejects these Better Auth client paths with 403 `E_USE_APP_API` (`BLOCKED_CLIENT_AUTH_PATHS` in `src/server/identity/blocked-paths.ts`): `/organization/{create,update,delete,invite-member,cancel-invitation,update-member-role,remove-member,add-member,leave}`, `/api-key/{create,update,delete}`, `/checkout`, `/delete-user` and `/usage/ingestion`.

Our `/api/app/**` routes call the same operations **server-side** (`auth.api.*` with the caller's headers, so Better Auth's own role checks also apply), after `requirePrincipal` + `can()` + the entitlement check, and they write the audit row.

Reads stay on the client plugin: `get-session`, `organization/list`, `get-full-organization`, `set-active`, `accept-invitation`, `list-invitations`, `customer/portal`, `customer/state`, sign-in/up/out, `list-sessions`, `revoke-session` and `change-password`.

### 3.9 Sessions, cookies, CSRF and rate limits behind the Zerops L7 proxy

- **Origin:** `baseURL = BETTER_AUTH_URL` = the public `https://` URL; `trustedOrigins = [APP_URL]` (+ localhost in dev). Zerops terminates TLS at its shared L7 balancer and forwards plain HTTP, so **`useSecureCookies: true` in production** is mandatory (research/17 §1.12).
- **Cookies:** `co.session_token` (+ Better Auth's cache cookie), `HttpOnly; Secure; SameSite=Lax; Path=/`; 30-day sessions refreshed daily. `cookieCache` is 5 min, so a revoked session can live ≤ 5 min; sign-out clears it at once. `bvid` is unchanged.
- **CSRF:** Better Auth checks `Origin` on its own endpoints. Our session-authenticated non-GET routes (`/api/app/**`, `/api/v1/**` with a session, `/api/relays/**` and the other org routes) require `Origin` equal to `APP_URL` **or** `Sec-Fetch-Site: same-origin`; otherwise 403 `E_CSRF` (`assertSameOrigin` inside `requirePrincipal`). SameSite=Lax is the second layer. API-key requests (the CLI, the SDK) never read cookies, so they are CSRF-immune.
- **Client IP:** Better Auth's rate limiter keys on `x-real-ip`, the header that WP12's P-0 probe found the balancer sets (`IPKEY_MODE`). If `IPKEY_MODE=off`, Better Auth's IP rules still run on the balancer value, and our global caps are the guard.
- **Rate limits:**
  - Better Auth: the custom rules of §3.1, in memory (one container);
  - guest start: §3.3;
  - `/api/app/**`: 120 mutations/h per user;
  - `/api/v1/**`: per key (§6.4);
  - `/api/v1/blueprints/validate` without auth: 30/min per ipKey;
  - `/api/webhook-inbox/*`: 60/min per inbox.
- **Security headers:** unchanged (`next.config.mjs`). No auth token ever goes into a URL. `?next=` accepts same-origin relative paths only.

### 3.10 Password reset and account deletion

- **Password reset:** with `EMAIL_MODE=off` there is no reset mail, and the sign-in page says so plainly: "Password reset needs email, which this demo does not send. Sign in with GitHub (if linked), or ask an org owner to re-invite you." `EMAIL_MODE=resend` (P5) enables Better Auth's `sendResetPassword`.
- **Change password, sessions:** the Profile page (list and revoke sessions).
- **Delete account** (P5): server-mediated. It is refused while the user is the sole owner of an org with other members. Solely owned orgs are deleted as in §3.5. Audit rows keep the frozen actor label.

---

## 4. Plans, entitlements, billing, usage

### 4.1 Plans (`src/core/contracts/v3/plans.ts`)

The prices are a `[HYPOTHESIS]` for the pitch, consistent with P§11. **The headline: "$0.30 per AI-finished minute. The low-code studio, API, SDK and CLI are included."** **Everything runs in the Polar sandbox; no real money moves.**

| Limit | Guest | Free | Pro | Business |
|---|---|---|---|---|
| Price (sandbox) | — | $0 | **$49 / month** | **$299 / month** |
| Account required | no | yes | yes | yes |
| Seats (members + pending invites) | 1 | 3 | 10 | 50 |
| Relays (non-gallery, not archived) | 3 | 5 | 50 | 500 |
| **Studio: forms, Code (YAML/JSON), JSON Schema, Preview, Versions and diff, Import/Export, offline `changeover validate`** | ✓ | ✓ | ✓ | ✓ |
| Live runs per day (live STT + Voice Agent) | 3 | 5 | 25 | 100 |
| AI-finished minutes included per month | 10 | 15 | 150 | 1,000 |
| Overage per AI-finished minute | blocked | blocked | $0.30 (sandbox meter) | $0.25 (sandbox meter) |
| TEXT DRY RUNs per day (Studio Test, `changeover run`) | 3 | 5 | 30 | 100 |
| Voiced simulated calls per day (when enabled, P5) | 0 | 0 | 2 | 5 |
| Drafts ("Describe your desk") per day | 1 | 3 | 10 | 30 |
| Live publications (stored agents) | 1, 24 h | 1, 72 h idle | 5, no idle expiry | 25, no idle expiry |
| Connectors | built-ins + the echo | built-ins + the echo | + `http_action` to **your own hosts** | + `http_action` to your own hosts |
| Allowed connector hosts (§5.6) | 0 | 0 | 10 | 50 |
| Secrets (count / expiry) | 3 / 7 days | 5 / 30 days | 50 / none | 200 / none |
| API keys (scopes) | 0 | 2 (**Build**: `relays:read`, `relays:write`, `runs:read`, `usage:read`) | 10 (all) | 50 (all) |
| CLI `pull/push/diff/run` and the SDK (they need a key) | – | ✓ | ✓ | ✓ |
| API rate per key | — | 60 / min | 600 / min | 1,200 / min |
| Webhook endpoints | 0 | 0 | 3 | 10 |
| Audit log retention | 7 days | 7 days | 90 days | 365 days |
| Analytics history | 7 days | 30 days | 90 days | 365 days |

`PLANS[plan].limits` is data. `org_entitlements.overrides` can raise a limit for one org (admin only, audited). The pricing page, the Billing page, the Usage meters and every limit check read this one table.

**How the plans are positioned:** the developer surface (code, schema, CLI validate) is free on every plan, because that is how teams adopt it. Pro sells **the connection to your own systems** (`http_action` hosts, webhooks, full API scopes) and the included AI-finished minutes.

### 4.2 Enforcement order and credit safety

Every metered action checks, in order:
1. **Plan** (per org, `Entitlements.assertCount` / `checkRate`). Counts come from the DB (`usage_events`, `relays`, `members`, `apikeys`, `webhook_endpoints`, `relay_publications`, `org_meta.connector_hosts`) for the plan period (the UTC day, or the subscription period / calendar month).
2. **Device and ipKey buckets** (v2 P§10.2, unchanged). **The device bucket is a browser-UI control only.** `src/proxy.ts` injects `bvid` into the *current* request and relies on the client returning the `Set-Cookie`; a scripted client (the CLI, the SDK, `curl`, any API-key caller) keeps no cookie jar, so `requireVisitor` would mint a fresh random `visitorId` on every call and the bucket would count to one forever. So for **API-key-authenticated requests the device bucket is not used at all**: the bucket key is `key:<apiKeyId>` — a stable pseudo-identity derived from the authenticated key, never a random id — and the real controls for that traffic class are the per-key limiter, the per-org bucket (§6.4), the plan counts and the global ledger. Unauthenticated scripted traffic is bucketed by `ipKey` only. A no-op bucket that *looks* like a control is worse than none, so the layer is named honestly here and in §6.4.
3. **Global caps, tranches and the ledger** (v2 P§10.3, unchanged, authoritative).

Outcomes:
- a **$0 action** over a count limit (relays, seats, keys, endpoints, hosts) → 402 `E_PLAN_LIMIT {limit, plan, upgradeUrl}`, shown as "Your Free plan includes 5 relays. Upgrade, or archive one.";
- a **paid action** (live run, sim, dry run, draft) over its plan limit → the **same labelled replay** that the global cap produces (P§10.4), with the notice "Plan limit reached · Upgrade for more live runs". For a dry run started from the CLI or the API it is a 402 with the same text, since there is no replay to show;
- **no plan, including Business, can raise a global cap.** Paying (in the sandbox) changes quotas and features, never the provider budget. The Usage page shows both: "Your plan: 3 of 25 live runs today" and "Shared demo capacity: live now / replay until 17:30 IST" (`/api/status.nextLiveAt`).

**Why the real credits are safe:**
- The plan allowances summed over all orgs can far exceed our credits — at the §3.3 limits, 2000 guests a day × 10 included minutes is orders of magnitude past the whole AssemblyAI balance. **That is fine, and it is the point:** plan allowances are a product promise, not a spend control, and raising the guest limits (v3.1) changed nothing about the real guard below.
- Total spend is bounded only by the v2 ledger: the dynamic daily cap over the judging budget (AssemblyAI balance − $5; OpenAI $4, under the $10 hard limit), released in four 6-hour tranches, with every over-cap action degraded to a labelled replay.
- The SaaS layer adds **no new paid call**: Better Auth, the Polar sandbox, webhooks, the API, the codec and the CLI are all $0.
- The only paid actions reachable through the API are TEXT DRY RUNs (≈ $0.01 of OpenAI each, gated by plan + ledger) and publishes (a stored-agent create, $0).

**What the ledger does *not* protect: the judge's own live run.** The ledger bounds **total spend**, which is the money question, and it answers it. It does not bound **who spends it first**. v3 widens the scriptable surface a great deal — a public REST API, a CLI, an SDK and an OpenAPI page we actively promote in the video, the README and `/docs/api` — so a third party with a Free account and two API keys can burn the day's TEXT-DRY-RUN allowance at 03:00 IST, and the judge who opens the link at 11:00 gets a correct, labelled replay instead of the live thing. That is a **presentation** risk, not a cost risk, and the controls above do nothing about it (they are working as designed when it happens). Three mitigations, all cheap:

- **Reserving the last tranche.** The v2 ledger releases the judging budget in four 6-hour tranches on a fixed clock. From RC (D5 22:00) the user sets `LEDGER_JUDGING_WINDOW_IST` (for example `09:00-14:00`) and the scheduler holds the **final tranche closed until that window opens**, then releases it whole. Judging is a known few hours, not a uniform day; spending the reserve against the clock instead of against the calendar is what makes the live path live when it is actually looked at. Unset → the v2 fixed clock, unchanged.
- **The reserve is org-scoped, not global.** While the reserve is open, a **single org** may draw at most 25 % of it (`LEDGER_RESERVE_ORG_SHARE`). One scripted tenant cannot take the window from the next visitor.
- **Non-interactive callers yield first.** When the remaining tranche is under 20 %, paid actions arriving over an **API key** (CLI/SDK/API) degrade to the labelled replay *before* browser-session actions do. Someone reading the API docs loses nothing real — the response is identical in shape and explicitly labelled — and the person watching a call keeps the live path. This is a one-line ordering rule in the ledger check, not a new mechanism.

`/status` shows the reserve state ("Live now" / "Live from 09:00 IST"), so the state is never a surprise.

### 4.3 Polar sandbox wiring (`src/server/billing/**`, WP21)

**Products:** "Changeover Pro" at $49/month and "Changeover Business" at $299/month, recurring, with the metadata `{changeover_plan}`. They are created in the sandbox dashboard, or by `scripts/billing/create-plans.ts` run once with the sandbox token from the local `.env` (it prints ids only). Their ids go into `POLAR_PRODUCT_PRO` / `POLAR_PRODUCT_BUSINESS` (not secrets; `zerops.yml`). **Optional meter (P4):** "AI-finished minutes" = the Sum of `metadata.minutes` over events named `ai_finished_minutes`, attached to Pro as a $0.30/unit metered price.

**Token scopes:** the sandbox OAT needs `checkouts:read|write`, `products:read|write`, `customers:read|write`, `subscriptions:read`, `customer_sessions:write` (portal) and `events:write` (meter, P4) `[VERIFY in WP21·1 step 0 against the v2 token]`. If the existing `POLAR_ACCESS_TOKEN` lacks them, the user creates a new sandbox token and replaces it in the Zerops GUI and the local `.env` (TASKS-v3 §11).

**Plugin** (`polarPlugins()` in `src/server/billing/polar-plugin.ts`):
```ts
polar({ client: new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: "sandbox" }),
        createCustomerOnSignUp: false,                  // anonymous users must never create Polar customers
        use: [ checkout({ products: [{ productId: env.POLAR_PRODUCT_PRO, slug: "pro" },
                                     { productId: env.POLAR_PRODUCT_BUSINESS, slug: "business" }],
                          successUrl: "/app/settings/billing?checkout_id={CHECKOUT_ID}",
                          returnUrl: `${env.APP_URL}/app/settings/billing`, authenticatedUsersOnly: true }),
               portal({ returnUrl: `${env.APP_URL}/app/settings/billing` }),
               usage(),
               webhooks({ secret: env.POLAR_BILLING_WEBHOOK_SECRET, onCustomerStateChanged, onSubscriptionActive,
                          onSubscriptionCanceled, onSubscriptionRevoked, onSubscriptionUncanceled }) ] })
```
- At boot the server asserts `POLAR_SERVER=sandbox` for billing. Any other value disables billing (`BILLING_MODE=simulated`).
- **Checkout** is server-mediated: `POST /api/app/billing/checkout {plan}` (`billing:manage`, `account: true`, org not already on that plan) → `auth.api.checkout({ body: { slug, referenceId: orgId }, headers })` → `{ url }` → the browser goes to `sandbox.polar.sh`. `org_entitlements.billing_user_id` = the caller.
- **Customer identity:** the Polar customer's `external_id` = the paying Better Auth user id (the checkout creates it; `createCustomerOnSignUp` is off). `[VERIFY in WP21·1 step 0]`: the plugin's checkout sets the customer external id to the session user and stores `referenceId` in the subscription metadata. **Fallback** (same interface): `src/server/billing/polar-direct.ts` calls `@polar-sh/sdk` `checkouts.create({ products, externalCustomerId: userId, metadata: { referenceId: orgId }, successUrl, returnUrl })`.
- **Portal:** `authClient.customer.portal()` (owner) for cancel, resume, payment method and invoices.
- **Webhook** (optional, P4): the Polar endpoint `https://<app>/api/auth/polar/webhooks` with its own secret, `POLAR_BILLING_WEBHOOK_SECRET`. Every handler calls `syncByBillingUser(externalId)`. The v2 payments endpoint `/api/webhooks/polar` ignores subscription events, and billing ignores orders that carry a `caseId`.

### 4.4 Entitlement cache and sync rules

`Entitlements.get(orgId)` reads `org_entitlements` and never blocks on Polar. `syncOrg(orgId)`:
1. `billing_user_id` is null → the plan follows `org_meta.kind` (guest → `guest`, otherwise `free`).
2. Otherwise, read the Customer State by external id (`customers.getStateExternal({ externalId })`) → the active subscriptions whose `metadata.referenceId === orgId` `[VERIFY: metadata is present in the state; otherwise subscriptions.list filtered by customer and metadata]` → product → plan; `status`, `current_period_end`, `cancel_at_period_end`.
3. Upsert. If the plan changed, audit `billing.plan_changed {from, to, source}` and apply §4.6.

**Sync triggers:**
- the checkout return (`?checkout_id=` → `syncCheckout(checkoutId, orgId)`, which first checks that the checkout's `metadata.referenceId` equals the active org **and** that the paying user is still an owner of it);
- a Billing page load when `synced_at` is older than 60 s;
- the Polar webhook (P4);
- an hourly tick for orgs with `source = polar` (P4).

**Fail-static:** a Polar error keeps the last known row (logged; `E_BILLING_UNAVAILABLE` is shown on the Billing page only). It never grants a higher plan than the last confirmed one.

### 4.5 Usage metering

**Writers** (`getUsageMeter().record(u, tx?)`, idempotent on `idempotency_key`; the DB writer is WP19's, the summaries are WP21's):

| Kind | Quantity | Written by (owner) | Key |
|---|---|---|---|
| `live_run` | 1 | the takeover terminal transition (WP14b, `src/server/takeovers/**`) | `live_run:<takeoverId>` |
| `ai_minutes` | the VA session's billed seconds / 60 (from the ledger settle / `live_sessions`); 0 for replays | the same place (WP14b) | `ai_minutes:<takeoverId>` |
| `dry_run`, `voiced_sim` | 1 | the sim service (WP17) | `dry_run:<simCallId>` |
| `draft` | 1 | the drafter (WP17) | `draft:<draftId>` |
| `publish` | 1 | the publisher (WP18) | `publish:<publicationId>:<version>` |

`source` = `recorded | simulated | text_dry_run | published | replay`. Replays are recorded with a quantity of 0 minutes, so runs are countable but never billed.

**In-app:** Settings → Usage (all members) shows:
- this period's AI-finished minutes against the plan allowance (a bar), split Recorded / Simulated / Published (never blended, as in P§9);
- live runs today against the daily limit, and dry runs, sims and drafts today;
- an overage estimate, "(sandbox, not charged)";
- a 30-day daily chart;
- the shared demo capacity line (§4.2).

The `/app` overview shows the minutes meter.

**Polar meter ingestion** (P4, WP21·3): a 5-minute tick sends the un-ingested `ai_minutes` rows of orgs with `source = polar` through `polarClient.events.ingest({ events: [{ name: "ai_finished_minutes", externalCustomerId: billing_user_id, metadata: { minutes, orgId, runId, source } }] })` and stamps `polar_ingested_at` (errors → `polar_error`, retried). It never runs from the browser (the plugin's `/usage/ingestion` client path is blocked, §3.8).

### 4.6 Upgrade demo (4242), downgrade, cancel, over-limit

**Upgrade (the judge path):**
1. Settings → Billing → **Upgrade to Pro**.
2. A guest first sees **"Create your free account to upgrade (10 s) — your workspace comes with you"** (§3.4).
3. Checkout on sandbox.polar.sh with the card **4242 4242 4242 4242**, any future date and any CVC.
4. The return page shows "Confirming your subscription…" and polls the sync every 1 s for ≤ 20 s.
5. It then shows the badge **"Pro · Test mode (Polar sandbox) — no real money"**. The new limits apply at once, and the audit rows `billing.checkout_started` and `billing.plan_changed` exist.

**Cancel:** Manage subscription → the Polar portal → cancel → `cancel_at_period_end` → the banner "Pro until <date>, then Free". Resume restores it.

**Downgrade to Free** (at the period end, on revoke, or on a failed payment beyond `past_due`) is **never destructive**:
- relays over the limit stay readable, runnable and editable (code included); creating new ones is blocked until the org is under the limit;
- publications over the limit: the most recently used ones are kept and the rest are unpublished (agents deleted; audited);
- API keys: all but the newest two are disabled (not deleted), and the survivors are reduced to the Build scopes;
- webhook endpoints are disabled (the delivery log is kept) and re-enabled on upgrade;
- allowed connector hosts are kept but inactive: `http_action` calls to them return `blocked` with "Your plan does not include custom hosts";
- seats: existing members keep access; invites are blocked until the org is under the limit;
- secrets over the count are kept, but new ones are blocked. The audit and analytics windows shrink at the next purge.

### 4.7 `BILLING_MODE=simulated`

It is selected automatically when `POLAR_ACCESS_TOKEN` or a product id is missing, when `POLAR_SERVER` is not `sandbox`, or when K-BILL trips (TASKS-v3 §10). Upgrade then goes to `/app/settings/billing/simulated-checkout`, a page clearly titled **"Simulated checkout · billing is not configured on this deployment"**, whose confirm button sets `org_entitlements {source: "simulated"}`. Everything downstream (limits, API keys, webhooks) behaves identically, and every plan badge reads "Pro · simulated".

---

## 5. Low-code: relay-as-code, the Studio, extensibility

### 5.1 Positioning and wording (overrides "no-code" everywhere)

**One line (README, deck slide 4, lablab long description, `/pricing`, `/docs`):**
> "Changeover is a **low-code** studio for relay agents: forms for the essentials, the whole relay as code, and an API for everything else."

**The three faces of one relay:**

| Face | Who | What |
|---|---|---|
| **Configure** (forms) | ops leads, CX designers | case fields, the handoff line, the greeting and voice, stage toggles, disclosures, connectors |
| **Code** (YAML/JSON) | developers, reviewers | the full blueprint in Monaco with the JSON Schema, lint, diff between versions, and the live compiled preview; files kept in git |
| **API** | integrators | HTTP actions to your own endpoints, signed webhooks, the REST API, the TypeScript SDK, the CLI |

**Wording rules** (on top of P§1.4):

| Use | Never |
|---|---|
| "low-code", "relay-as-code", "blueprint file", "config-first" | "no-code", "drag-and-drop", "visual flow builder", "canvas" |
| "your endpoints, in any language" | "write plugins", "custom code runs on Changeover" (it never does, §5.10) |
| "the same relay as YAML" | "export" as the only code story |

The first-viewport rule (≤ 3 terms: Changeover, Pass the baton, relay agent) is unchanged. "Low-code" appears below the fold ("Build your own relay · low-code"), in the header's Docs, on `/pricing`, and in the deck and README.

### 5.2 Blueprint files (relay-as-code)

- **A relay file is exactly one `Blueprint`** (C2, `src/core/contracts/v2/blueprint.ts`, `changeover.blueprint/2.0`), written as **YAML 1.2 or JSON**. It is validated by the zod schema, then by `lintBlueprint`. Lint errors block Test and Publish, not Save (P§3.4).
- **Header for IDE support** (optional; the `$schema` key is ignored by validation because the zod root object strips unknown keys, and the codec does not report it as unknown):
  - YAML: `# yaml-language-server: $schema=<APP_URL>/schemas/blueprint-2.0.json`
  - JSON: `"$schema": "<APP_URL>/schemas/blueprint-2.0.json"`

  With either header, VS Code (with the Red Hat YAML extension for YAML) gives completion and validation offline.
- **Excerpt** (the full Dental file is `examples/relays/dental-deposit.yaml`, generated from the gallery JSON by WP23):
  ```yaml
  # yaml-language-server: $schema=https://app-2b25-3000.prg1.zerops.app/schemas/blueprint-2.0.json
  meta:
    schema: changeover.blueprint/2.0
    slug: dental-deposit
    title: Dental deposit
    industry: healthcare
    # …
  handoff:
    repLine: "OK if my assistant finishes the paperwork? I'll be one tap away if you need me."
    autoBaton: true
    # …
  fields:
    - id: insurance_member_id      # the "add a required field" edit adds a block like this
      label: Insurance member ID
      type: id_code
      required: true
      setBy: ai_allowed
      # …
  ```
- **Secrets never live in files.** Secret values appear only as `{ $secret: "sec_…" }` references (`SecretRefSchema`). The codec rejects (error `CODEC_CREDENTIAL`) any `http_action` header value or `url` that looks like a credential: `Bearer …`, `Basic …`, `sk_…`, `cko_…`, `whsec_…`, `polar_oat_…`, or 32+ characters of base64/hex in a header named like `authorization`, `*key*`, `*token*` or `*secret*`.
- **Canonical form and versions.** `relays.draft` (jsonb) stays the canonical blueprint. The version hash stays `sha256(canonicalJson(blueprint))` (WP14a `migrate.ts`), so **a comment-only or formatting-only change never creates a version**.
- **Source preservation.** `relays.draft_source` / `draft_source_format` hold the author's exact text (≤ 256 KiB). `relay_versions.source` / `source_format` hold the text at snapshot time. A read of a relay's source returns the stored text when present (`stored: true`); otherwise the codec serializes the canonical blueprint (`stored: false`). A save through a non-code path (the forms, the JSON API with `{blueprint}`) regenerates the source with `applyEdit`, which keeps YAML comments (§5.3).
- **Mapping files to relays: `changeover.lock.json`** (written by the CLI next to the files; commit it):
  ```json
  { "baseUrl": "https://…", "relays": { "relays/dental.yaml": { "relayId": "rly_…", "rev": 7, "hash": "3f2a…" } } }
  ```
  It never holds keys or secrets. A file without an entry is created as a new relay on the first `push`.

### 5.3 The codec (`src/core/relay-code/**`, isomorphic, WP23)

One module used by the Studio (browser), the server (authoritative on save) and the CLI (bundled). It depends on `yaml` (eemeli/yaml; `[VERIFY]` the current 2.x version at install) and on the C2 contracts and WP14a's `lintBlueprint`/`canonicalJson`. It has no node, DOM or server imports (the boundaries test).

```ts
export type SourceFormat = "yaml" | "json";
export interface Range { startLine: number; startCol: number; endLine: number; endCol: number }   // 1-based
export interface CodeDiagnostic {
  source: "syntax" | "schema" | "lint" | "codec"; code: string; severity: "error" | "warn";
  path: (string | number)[]; message: string; range: Range | null }
export interface ParsedSource { value: unknown | null; format: SourceFormat; diagnostics: CodeDiagnostic[];
  locate(path: (string | number)[]): Range | null }
export function sniffFormat(text: string): SourceFormat;                        // "{" or "[" first → json
export function parseSource(text: string, format?: SourceFormat): ParsedSource;
export function validateSource(text: string, format?: SourceFormat):
  { blueprint: Blueprint | null; hash: string | null; diagnostics: CodeDiagnostic[] };   // syntax → zod → lint → codec
export function serialize(bp: Blueprint, format: SourceFormat, opts?: { header?: string[] }): string;
export function applyEdit(text: string, format: SourceFormat, path: (string | number)[], value: unknown | undefined): string;
export function convert(text: string, to: SourceFormat): string;              // YAML ⇄ JSON (comments are lost going to JSON)
export function unifiedDiff(a: string, b: string, labels: { a: string; b: string }): string;
```

Rules:
- **Parsing limits** (a stranger's input): ≤ 256 KiB; YAML `{ schema: "core", uniqueKeys: true, merge: false, maxAliasCount: 50, customTags: [] }` (no custom tags, so no alias bombs and no type coercion surprises); JSON is also checked with `JSON.parse`, so JSON-invalid-but-YAML-valid text is an error in JSON mode.
- **Ranges** come from the `yaml` CST (a `LineCounter`) for both formats, since JSON is YAML-parseable. Zod issue paths and lint paths are mapped with `locate(path)`. A path that no longer exists maps to its nearest existing parent.
- **Unknown keys** (which zod strips silently) → the warning `CODEC_UNKNOWN_KEY` at their exact range, so a typo like `requried:` is visible even though it would otherwise be dropped.
- **Key order for `serialize`**: the declaration order of the zod object shapes (walked at runtime; for a discriminated union, the matching option), not alphabetical. 2-space indent. YAML strings are quoted only when needed. Long template strings use block scalars (`|-`) when they contain newlines.
- **`applyEdit`** in YAML: `parseDocument` → `setIn`/`deleteIn` → `toString()`, which keeps comments and the formatting of untouched nodes. In JSON it re-serializes. Form edits use it, so a YAML author's comments survive the forms.
- **Round-trip property test** (WP23): for every gallery blueprint and 200 random form edits, `validateSource(applyEdit(serialize(bp)))` equals the edited object, and the comments of an annotated fixture survive.

### 5.4 The published JSON Schema

- `scripts/devtools/gen-json-schema.ts` (WP23) writes `public/schemas/blueprint-2.0.json` from `BlueprintSchema` with `z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any", cycles: "ref" })` `[VERIFY the option names in zod 4.6; ValueRefSchema is a z.lazy]`, then post-processes it:
  - `$id` = `<APP_URL>/schemas/blueprint-2.0.json` (the build substitutes `APP_URL`; the committed file uses the production URL);
  - `title`/`description`, and per-property `description` from the comments of `blueprint.ts` (a small hand-kept map, `scripts/devtools/schema-docs.ts`);
  - a `$schema` property allowed at the root;
  - regex refinements (the safe grammar, P§3.2) are stated in `description` ("validated server-side: no backreferences, no lookaround, no nested quantifiers").
- The file is **committed**, and a drift test regenerates it and compares. A test also validates every gallery blueprint and `examples/relays/*` against it with `ajv/dist/2020` (a devDependency), so the schema and zod never disagree on valid files.
- It is served statically at `/schemas/blueprint-2.0.json` (also linked from `/docs/blueprint` and from the Code tab's header, and returned by `GET /api/v1/schemas/blueprint`).

### 5.5 The Studio: config-first plus code (replaces P§7.2; WP15)

**Routes:** `/app/relays` (list), `/app/relays/new`, `/app/relays/[id]/[tab]`. `/studio/**` → 308.

**Relays list:** org relays (title, version, rev, lint status, last run, updated by); Baton pinned ("Flagship · read-only": Run, View code); a Templates section (the gallery: Run, Use template); **Import blueprint** (paste or upload `.yaml`/`.json` → `validateSource` → create; the diagnostics are shown first); "New relay" → template picker or Blank; "Describe your desk" (§5.9, P4).

**Editor top bar:** a **`Changeover Studio`** label as the first element of the breadcrumb — `Changeover Studio / <relay name>`, the "Studio" word in the muted label style and linking to `/app/relays`, the name in the page-title style — then the saved state ("Saved · rev 7" / "Unsaved: 2 errors to fix"); the lint badge; **Save version**; **Test**; **Publish** (admin+); a **Copy CLI command** menu (`changeover pull <id> -o <slug>.yaml`). Viewers see everything read-only.

> **Why the label is in the spec.** The product line is "a low-code **studio** for relay agents" (§5.1), and the deck, the README and the video all say "Studio". Without this breadcrumb the word appears nowhere a judge can see it — the side nav says only "Relays" (§8.2) — so the headline term and the product chrome would visibly disagree for anyone who explores past the checklist. The side nav keeps "Relays" (it is a list of relays, and renaming it would be worse); the breadcrumb is where the product names itself. It collapses to just "Studio" below 768 px. WP13's wording test asserts the string is present in `src/components/studio/**`.

**Tabs:**

| Tab | Content | Tier |
|---|---|---|
| **Overview** (default) | the relay track, read-only: the rep lane (fields set by the rep), the **Pass the baton** marker with the rep line and the acceptance, the AI stages as cards (confirm → disclose → act → close, each with tools and exit); "What the AI inherits" (the greeting for the selected canned state, with words and seconds); the lint summary with jump links; the **Try an edit** card on gallery relays and their clones (P§7.5.3) | P1 (track + inherits), P2 (Try an edit) |
| **Configure** | form sections, each editing the same source through `applyEdit`: **Case fields** (a table: label, id, type, required, set by, examples, enum values; "Add field" presets built from WP17's `expandDraft` field defaults; **Move up / Move down** buttons, no drag); **Handoff** (rep line, acceptance phrase, auto-baton, rep return line, minimum call seconds, fields required before Pass); **Greeting & voice** (voice, opening, summary, opt-out and next-step sentences; the word counter against `maxWords`); **Stages** (a toggle per kind: confirm, disclose, act, close; goal; exit; tools checklist); **Disclosures** (title, verbatim text, critical tokens, requires ready / accepted, consent); **Connectors** (instances by type with typed forms; a secret-reference picker; "Add HTTP action" for Pro+, §5.6). Listening, QA, extraction, compliance, the case JSON and the prompt template have **no form**: each section shows "Edit in Code →" jumping to its path | P2 |
| **Code** | Monaco (§5.5.1): YAML ⇄ JSON toggle (`convert`; a warning that comments are lost going to JSON), the JSON Schema, diagnostics as markers, **Format**, **Save** (Ctrl/⌘ S), Download, Import (replace the draft after a diff confirmation), a "Schema" link | **P1** |
| **Preview** | the compiled relay, from the kernel in the browser (P§7.3, unchanged): the greeting for 4 canned states, the system prompt per stage (character count against 8000), the tools JSON per stage, the extractor prompt and strict schema (`assertStrictSchema` ✓), the first `session.update` (`validateFirstUpdate` ✓). Docked to the right of Configure and Code at ≥ 1280 px; a tab below that | **P1** |
| **Versions** | versions (number, hash, created, by, published?), **Snapshot version**, **Restore to draft** (writes the version's source into the draft with a new rev); **Diff**: Monaco's diff editor between any two versions or draft ↔ version, in YAML | P3 (list, restore, diff) |
| **Test** | as P§7.2 Test (call picker, TEXT DRY RUN as the default for drafted and blank relays, the run plan, the embedded `RelayConsole` in `mode="test"`, the hash-mismatch replay view) | P2 |
| **Publish** | as P§7.2 Publish, plus an **API** panel: `curl`, SDK and CLI snippets for this relay with the org's base URL | P3 |
| **Analytics** | P§9 tiles (Recorded/Simulated columns) and the runs table | P4 |

**Removed from P§7.2:** the Listening tab, drag-to-reorder, the Playbook "Advanced prompt template" UI (code only) and the Advanced textarea (replaced by Code).

**One source of truth in the browser:** `src/client/studio/source-store.ts` (zustand, WP15) holds `{ relayId, format, text, rev, savedText, parsed, diagnostics, compiled }`.
- A code edit re-parses and re-compiles, debounced 150 ms.
- A form edit calls `applyEdit(text, format, path, value)` and then re-parses.
- **If the text has a syntax error, the forms are read-only** with the banner "Fix the code to use the forms". The forms show the last valid parse.
- **Autosave** (every 2 s of idle, and on Save) sends `PUT /api/relays/:id/source { source: { format, text }, expectedRev }` when the text passes zod. Lint errors are allowed. A zod-invalid text is not saved: the bar says "Unsaved: 2 errors to fix". A per-viewer copy of the unsaved text is kept in `localStorage` (wrapped in try/catch) and restored with a prompt after a reload.
- **A rev conflict (409)** opens Monaco's diff editor (theirs ↔ yours) with "Keep mine" / "Take theirs". A CLI push while the Studio is open produces this same prompt.
- The server re-validates with the same codec and is authoritative. A client/server hash mismatch shows the P§7.3 banner.

#### 5.5.1 Monaco

- **Packages:** `@monaco-editor/react` and `monaco-editor` `[VERIFY versions at install]`, loaded lazily (`next/dynamic`, `ssr: false`) only on Code and Versions.
- **Self-hosted:** `scripts/devtools/copy-monaco.mjs` copies `node_modules/monaco-editor/min/vs` to `public/vendor/monaco/vs` at build time (it is git-ignored), and `loader.config({ paths: { vs: "/vendor/monaco/vs" } })`. **The CSP does not change:** scripts, styles and the codicon font are same-origin, and the workers are same-origin or `blob:` (`worker-src 'self' blob:` already exists). `[VERIFY]` in WP15·1 on a production build (`next build && next start`) before relying on it.
- **JSON mode:** `monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, enableSchemaRequest: false, schemas: [{ uri: "<origin>/schemas/blueprint-2.0.json", fileMatch: ["*"], schema }] })` gives completion, hover docs and schema diagnostics. Our `lint` and `codec` diagnostics are added as markers with the owner `changeover`.
- **YAML mode:** Monaco's built-in YAML highlighting plus **all** our diagnostics (syntax, schema, lint, codec) as markers. YAML completion (`monaco-yaml`, which needs its own worker build) is P5.
- **The fallback** `CODE_EDITOR=textarea` (K-MONACO): a monospace `<textarea>` with line numbers and the same diagnostics as a clickable list (the P§7.2 Advanced design). The JSON Schema, the CLI and the API are unaffected.
- Accessibility: Monaco's accessibility mode is on by default for screen readers. The forms remain the accessible primary editing path. The 390 px layout shows Code read-only with "Edit on a larger screen or in your editor".

### 5.6 Extensibility 1: HTTP actions to your own endpoints (any language)

- **The runtime is unchanged** (WP16, P§6.2): `POST` or `GET` over https:443 only, the SSRF guard (pinned DNS, the `ipaddr.js` unicast allowlist, no redirects), timeouts, an 8 KiB response cap, and **only `responsePick` paths reach the agent**, under `data`. Requests are signed with the C2 headers: `X-Changeover-Timestamp`, `X-Changeover-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<rawBody>")>` and `X-Changeover-Delivery`.
- **Host policy (new).** WP16's `http.ts` asks `getConnectorHostPolicy().isAllowed(orgId, host)` (a v3 port; WP16 implements it):
  - the built-in echo and `CONNECTOR_HOST_ALLOWLIST` (env) are allowed for everyone;
  - on Pro and Business, **also the org's allowed hosts** (`org_meta.connector_hosts`; Settings → Connectors → Allowed hosts; admin+; ≤ the plan limit; exact lowercase hostnames, no wildcards, no IP literals; a host must resolve to public unicast addresses when it is added; never our own origin; audited `connector.host_added|host_removed`);
  - published runs use **the publication's org** (unchanged P§6 rule).
- **Recipes** (in `/docs/connectors`, WP23): 15-line endpoints that verify the signature, in **Node (Express)**, **Python (FastAPI)** and **Go (net/http)**, plus the rule "return JSON; list the keys the agent may see in `responsePick`". The connector test console (P4) and `changeover run` exercise them.
- **What we do not do:** we never run customer code (§5.10). The customer's logic runs on the customer's endpoint.

### 5.7 Extensibility 2: the TypeScript SDK (`packages/sdk`, WP23)

```ts
import { Changeover, verifyWebhook } from "@changeover/sdk";
const co = new Changeover({ apiKey: process.env.CHANGEOVER_API_KEY!, baseUrl: "https://…" });
const { data: runs } = await co.runs.list({ relayId: "rly_…", limit: 10 });
const src = await co.relays.getSource("rly_…", { format: "yaml" });
await co.relays.saveSource("rly_…", { format: "yaml", text: edited }, { expectedRev: src.rev });
const event = verifyWebhook(rawBody, headers, process.env.CHANGEOVER_WEBHOOK_SECRET!);   // standardwebhooks inside
```

- **Surface** = the `/api/v1` endpoints of §6.2: `relays.{list,get,getSource,create,saveSource,saveBlueprint,versions,snapshot,compiled,publish,unpublish}`, `blueprints.validate`, `dryRuns.{start,get,wait}`, `runs.{list,get}`, `cases.get`, `agents.list`, `usage.get`, `webhooks.{list,create,remove,deliveries}`, and `verifyWebhook`. Pagination helpers (`for await (const r of co.runs.iterate())`). Errors are thrown as a `ChangeoverError { status, code, message, docsUrl }`.
- **Types** come from `src/core/contracts/v3/public-api.ts` (`z.infer`), emitted as `.d.ts` by `tsc --emitDeclarationOnly` at build time. There are no runtime zod schemas in the SDK (small), and it has zero runtime dependencies (`standardwebhooks` is bundled).
- **Distribution ($0, no registry):** `npm pack` at build → `public/sdk/changeover-sdk.tgz` → **`npm i <APP_URL>/sdk/changeover-sdk.tgz`**. The package name is `@changeover/sdk`. npm publishing is a P5 user action.

### 5.8 Extensibility 3: the CLI (`packages/cli`, WP23)

**Run it:**
- `npx -y <APP_URL>/cli/changeover-cli.tgz <command>` `[VERIFY: npx runs the single bin of a tarball URL]`;
- or `curl -fsSLO <APP_URL>/cli/changeover.mjs && node changeover.mjs <command>` (a single-file esbuild bundle; Node ≥ 20);
- in this repo: `npm run changeover -- <command>`.

**Auth:** `CHANGEOVER_API_KEY` (or `--key`), never stored on disk by the CLI. The base URL comes from `CHANGEOVER_URL` (or `--url`); it defaults to the URL the tarball was built for. `validate` needs neither.

| Command | Does | Exit codes |
|---|---|---|
| `changeover validate <files…> [--remote] [--json]` | **Offline:** codec + zod + lint (bundled; no network, no key). Prints `file:line:col  severity  code  message`. `--remote` also calls `POST /api/v1/blueprints/validate` (the server authority, incl. the kernel compile and `validateFirstUpdate`) | 0 clean, 1 errors, 2 usage/network |
| `changeover pull <relayId> [-o file] [--format yaml|json]` | writes the stored source (or the serialized draft) and updates `changeover.lock.json` | 0 / 2 |
| `changeover push <file> [--snapshot] [--dry-run] [--force]` | validates locally; if the lock maps the file: `GET` the current rev and hash; if the remote changed since the lock's hash and there is no `--force` → refuse ("remote changed since your last pull; run `changeover diff`"); else `PUT …/source` with `expectedRev`. Without a lock entry: `POST /relays` (create from source). `--snapshot` also creates a version. Prints the Studio URL | 0, 1 (invalid), 3 (conflict) |
| `changeover diff <file>` | a unified diff, remote draft ↔ local | 0 same, 1 different |
| `changeover run <file|relayId> [--sample N]` | (push first if a file) → `POST …/dry-runs` → polls → prints the transcript turns, the stages reached and the QA summary. One TEXT DRY RUN (plan + ledger) | 0 ok, 1 failed run, 4 plan/cap limit |
| `changeover schema [-o file]` | prints or saves the JSON Schema | 0 |
| `changeover publish <relayId>` (P4) | publishes the current version; prints the share URL and the `agent_…` id | 0 / 1 |

**CI recipe** (docs + `examples/github-action.yml`, P4): on push to `main`, `validate relays/*.yaml`, then `push --snapshot` with the `CHANGEOVER_API_KEY` repository secret.

**Distribution:** `scripts/devtools/build-devtools.mjs` (WP23) builds, in the app's `build` step: the esbuild single file (`public/cli/changeover.mjs`), the tarball (`npm pack` of `packages/cli` → `public/cli/changeover-cli.tgz`), and the SDK tarball. The outputs are git-ignored and shipped in the deploy bundle.

### 5.9 "Describe your desk": optional, outputs code (WP17 pipeline, WP15 UI, P4)

- The P§7.4 pipeline is unchanged (async, luna, ≤ 2 repairs, deterministic post-fixes, moderation).
- The UI is one dialog on `/app/relays/new` (the four P§7.4 questions on one screen) with the step progress.
- The result opens **on the Code tab**, in YAML, with the drafting notes as a comment block at the top (`# Assumptions I made: …`) and a banner: "Drafted by AI · review the code, then Test". **Versions** shows its diff against the closest template.
- There is no separate wizard route.
- `changeover draft "<description>" -o relay.yaml` is P5.

### 5.10 What stays out (and why)

- **No drag-and-drop canvas and no free-form flows.** The stage skeleton is fixed (P5: confirm → disclose → act → close); the forms toggle and configure it.
- **No customer code runs on our servers.** The kernel's only extension point stays the closed registry of normalizers, formatters and values (P4). Templates are a logic-less grammar. Regexes use the safe grammar. Business logic lives in the customer's HTTP endpoints.
- **No plugin marketplace, no custom tags in YAML, no includes** (one file = one relay).

---

## 6. Public REST API

### 6.1 Auth: org API keys and scopes

- **Plugin** (`apiKeyPlugins()` in `src/server/api-v1/keys-plugin.ts`, WP22): `apiKey({ references: "organization", defaultPrefix: "cko_", enableMetadata: true, rateLimit: { enabled: true } })` `[VERIFY option names]`. Keys are SHA-256 hashed by the plugin (research/17 §1.9) and owned by the organization, so they survive their creator leaving.
- **Ownership is a guarantee, not an implementation detail.** A key belongs to the **org**; `created_by_user_id` is a display column and nothing authorizes off it. This must hold on the §16 fallback path too (user-owned keys carrying `metadata.orgId`, re-checked per request against the membership), where it is *not* free: the natural implementation of that fallback rejects a key whose creator is no longer a member. It must not. The removal flow (`members.remove`, `leave`, `transfer`) therefore never touches `apikeys`, and the per-request check validates **the key's `orgId` against the org**, never the creator's membership. Revoking a person's access revokes their sessions, not the org's automation — the alternative is a departing employee silently breaking production integrations, which is exactly the failure a SaaS audience will probe.
- **Acceptance test (WP22·1, must pass on either path):** *"an API key keeps working after its creator is removed from the org."* Create a key as admin A, remove A from the org as the owner, then call `GET /api/v1/runs` with that key → 200, with the org's runs and the same scopes. A second case: A's own session is 401 immediately after removal. This test is in `tests/api/**` and is **not** allowed to be rewritten to match whichever path ships — it is the reason the `[VERIFY]` fallback is acceptable at all.
- **Header:** `Authorization: Bearer cko_…` (preferred) or `x-api-key: cko_…`.
- **Scopes:** `relays:read`, `relays:write`, `relays:publish`, `runs:read`, `usage:read`, `webhooks:read` and `webhooks:write`, stored as the plugin's permissions `{relays:[...], runs:[...], usage:[...], webhooks:[...]}`. Presets: **Build** (`relays:read`, `relays:write`, `runs:read`, `usage:read`; what the CLI needs) and **Full access** (all). The Free plan allows Build only.
- **Management** (Settings → API keys; admin+; account required): name, preset or custom scopes, an optional expiry (30/90/365 days/never). The key is **shown once**, with a copy button and ready lines for `curl`, the SDK and `CHANGEOVER_API_KEY=… npx -y …/changeover-cli.tgz pull …`. The list shows the name, the prefix + last 4, scopes, created by, last used and expiry. Revoke is immediate. Management is server-mediated through `POST/DELETE /api/app/api-keys` (plan count and scope checks; audit `apikey.created|revoked`).

### 6.2 Endpoints (`/api/v1`)

| Method and path | Scope | Returns / does | Tier |
|---|---|---|---|
| `GET /me` | any | `{ org: {id, name, plan}, key: {id, scopes} | null, user: {id} | null }` | P2 |
| `GET /relays?include=gallery&cursor&limit` | `relays:read` | `Page<RelaySummaryV1>` (org relays + pinned; the gallery on request) | P2 |
| `GET /relays/{id}` | `relays:read` | `RelayDetailV1` (the draft blueprint with secret refs only, rev, hash, lint, versions, current publication) | P2 |
| `GET /relays/{id}/source?format=yaml|json&version=N` | `relays:read` | `RelaySourceV1 { format, text, rev, hash, stored }` | P2 |
| `GET /relays/{id}/versions` | `relays:read` | `Page<VersionV1>` | P2 |
| `GET /relays/{id}/compiled?version&state&stage` | `relays:read` | `CompiledPreviewV1` (greeting and word count, prompt, tools, extractor schema, `firstUpdateOk`) | P3 |
| `GET /agents?cursor&limit` | `relays:read` | `Page<PublicationV1>` (the org's published agents: the AssemblyAI `agent_…` id, share URL, version, status) | P2 |
| `GET /runs?relayId&source&since&cursor&limit` | `runs:read` | `Page<RunV1>` | P2 |
| `GET /runs/{id}` | `runs:read` | `RunV1` (status, outcome, provenance strip, timings, stages, AI seconds, QA summary, payment summary, links) | P2 |
| `GET /cases/{id}` | `runs:read` | `CaseV1`: the evidence-linked case record (fields with value, status and evidence `{turnId, channel, startMs, endMs, quote}`; disclosures with verbatim results; payment). `{id}` = the run id | P2 |
| `GET /usage?period=current|YYYY-MM` | `usage:read` | `UsageV1` (allowances, consumed by kind and source, the overage estimate) | P2 |
| `POST /blueprints/validate` | **none**, a key or a session | body `{ source: {format, text} } | { blueprint }` (≤ 256 KiB) → `ValidateResultV1 { valid, hash, diagnostics[], compiled: { greetingWords, stages, tools, extractorStrictOk, firstUpdateOk } | null }`. No DB writes; 30/min per ipKey without auth | P2 |
| `GET /schemas/blueprint` | public | the JSON Schema (§5.4) | P2 |
| `POST /relays` | `relays:write` | create `{ from: {kind:"clone", relayId} | {kind:"blueprint", blueprint} | {kind:"source", source:{format,text}} }` → 201 `RelayDetailV1` | P3 |
| `PUT /relays/{id}/source` | `relays:write` | `{ source:{format,text}, expectedRev }` → `{ rev, hash, diagnostics }`; 409 `{ rev, hash }`; 422 with diagnostics when zod fails (lint errors still save) | P3 |
| `PUT /relays/{id}/draft` | `relays:write` | `{ blueprint, expectedRev }` → the same as above (the source is regenerated by `applyEdit`) | P3 |
| `POST /relays/{id}/versions` | `relays:write` | snapshot → `{ versionId, version, hash, created }` | P3 |
| `POST /relays/{id}/dry-runs` | `relays:write` (+ plan `dryRunsPerDay` + ledger) | `{ sampleIndex? }` → 202 `DryRunV1 { id, status }` (WP17's `SimCallService.request({kind:"text_dry_run"})`) | P3 |
| `GET /dry-runs/{id}` | `runs:read` | `DryRunV1` (status, turns, stages reached, QA summary) | P3 |
| `POST /relays/{id}/publish` | `relays:publish` | → `PublicationV1` (the same checks as the UI: lint, moderation, plan, global cap) | P4 |
| `DELETE /publications/{id}` | `relays:publish` | 204 | P4 |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries` | `webhooks:read` / `webhooks:write` | endpoint management and the log (WP24; the UI uses `/api/app/webhooks`) | P3 |
| `GET /openapi.json` | public | the OpenAPI 3.1 document | P2 |

Live voice runs cannot be started over the API in v1 (they need a browser audio session). The API reads their results and delivers their webhooks.

**Read models:** `src/server/read-models/{runs,cases,relays}.ts` (WP20·1) — `RunsReadModel.list(orgId, filter)` / `get(orgId, id)` join `cases` → `takeovers` → `verifications` → `payments` with `cases.org_id = :org`. The `/app/runs` pages (WP20) and `/api/v1/runs|cases` (WP22) both call them. The relay endpoints call WP14b's registry and `RelaySourceStore` (§14) with `ws = principal.orgId`.

### 6.3 Conventions

- JSON only; `Content-Type: application/json`; ids are the existing opaque ids; timestamps are ISO-8601 UTC.
- **Errors:** `{ "error": { "code": "E_…", "message": "…", "docs_url": "<APP_URL>/docs/api#errors" } }`, with the status map in §14 (`errors.ts`). Validation errors add `issues` (zod; paths only; secret values are never echoed) or, for source endpoints, `diagnostics` (§5.3).
- **Pagination:** `?limit` (1–100, default 20) and `?cursor` (opaque, base64url of `(created_at, id)`) → `{ data: [...], next_cursor: string | null }`.
- **Versioning:** the path `/v1`; the response header `Changeover-Version: 2026-09-25`. Breaking changes need `/v2`. Additive fields are not breaking.
- **Concurrency:** writes to a relay take `expectedRev`; responses carry `ETag: "<rev>"`.
- **Idempotency:** `POST` accepts `Idempotency-Key` (24 h, per key; P5).
- **Tenancy:** every handler takes `principal.orgId` and uses `findOwned(orgId, id)` helpers. A foreign id → 404.

### 6.4 Rate limits

- Per key: the plugin's limiter at the plan rate (§4.1), window 60 s.
- Per org: an in-memory token bucket at 2× the key rate, across all keys and the session UI (`org:<id>:api`). It also produces the `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.
- Unauthenticated or invalid-key traffic: 60/min per ipKey (validate: 30/min), then 429.
- **A global compile bucket** in front of `blueprints/validate` and `relays/:id/compile` (§10.4), independent of the per-key and per-ipKey limiters, because those are per-identity and the CPU is shared.
- **No device bucket on `/api/v1/**`.** Scripted callers keep no cookie jar, so the per-device layer would be a no-op that mints a fresh id per call; key traffic is bucketed as `key:<apiKeyId>` instead (§4.2 step 2).
- 429 → `E_RATE_LIMITED` with `Retry-After`; 503 → `E_BUSY` with `Retry-After` (shed, not throttled — the CLI retries it once automatically).

### 6.5 OpenAPI and `/docs/api`

- **Source of truth:** the zod schemas in `src/core/contracts/v3/public-api.ts`, annotated with `.meta({ id, description, example })`. `src/server/api-v1/registry.ts` lists every route `{method, path, scope, request, responses}`, and the handlers validate with the same schemas.
- **Document:** `zod-openapi` 6.0.2 `createDocument({ openapi: "3.1.0", info: { title: "Changeover API", version: "2026-09-25" }, servers: [{ url: APP_URL + "/api/v1" }], security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, paths })`, memoized and served at `GET /api/v1/openapi.json`.
- **Docs UI:** `src/app/docs/api/route.ts` = `ApiReference({ url: "/api/v1/openapi.json", cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@<pinned>", withDefaultFonts: false, hideClientButton: true })` from `@scalar/nextjs-api-reference` 0.12.3 `[VERIFY option names]`.
- **The existing CSP already allows it:** `script-src` has `https://cdn.jsdelivr.net` and `'unsafe-inline'`; `style-src 'unsafe-inline'`; `connect-src 'self'` (the "Try it" calls are same-origin, so no Scalar proxy); `font-src 'self' data:` (default fonts off). The CDN version is pinned to the `@scalar/api-reference` version that 0.12.3 depends on.
- **Fallback (K-DOCS):** `/docs/api` renders our own server component over the same document (the endpoint list, schemas and `curl` examples).
- **Tests:** every `src/app/api/v1/**/route.ts` is in the registry; each route test validates the real response against its documented schema; the document passes an OpenAPI 3.1 schema check.

---

## 7. Outbound webhooks (WP24)

### 7.1 Events and payloads (`src/core/contracts/v3/events.ts`)

The envelope (the HTTP body):
```json
{ "id": "evt_…", "type": "run.completed", "created_at": "2026-09-27T10:12:03Z", "org_id": "org_…",
  "api_version": "2026-09-25", "data": { … } }
```

| Type | Emitted when (owner) | `data` |
|---|---|---|
| `run.completed` | a takeover reaches a terminal state: `completed`, `handed_back`, `abandoned` or `failed` (WP14b, `src/server/takeovers/**`, in the same transaction) | `run_id, relay_id | null, relay_version | null, source, outcome, stages_reached[], ai_seconds, payment_status, started_at, passed_at, ended_at, links {run, api}` |
| `case.verified` | async verification finishes (non-provisional QA) (WP18, `jobs/verify-takeover.ts`) | `run_id, relay_id, qa { re_asked, disclosures[{id, similarity, ok}], verified_from_recording, provisional:false }, fields_at_pass { verified, required }, links` |
| `payment.succeeded` | a payment becomes verified, fail-closed (`verified_webhook` or `verified_poll`) (WP16, payments) | `run_id, payment_id, amount, currency, provider ("polar_sandbox" | "simulated"), verified_by, links` |
| `webhook.test` | "Send test event" (WP24) | `{ message: "Hello from Changeover", endpoint_id }` |

**Thin events:** ids, statuses and numbers only. No case field values, transcript text, audio URLs or secrets. Consumers fetch the details from `/api/v1/runs/{id}` and `/api/v1/cases/{id}` with a key (the SDK does both in two lines). Events are emitted only when `cases.org_id` is set.

`emitDomainEvent({orgId, type, data, dedupeKey}, tx?)` (the port in `src/server/saas/ports.ts`; the DB writer `src/server/events/outbox.ts`, WP19) inserts into `domain_events` in the caller's transaction when one is given. `dedupe_key` (e.g. `run.completed:<takeoverId>`) makes emission idempotent.

### 7.2 Signing (Standard Webhooks)

- Each endpoint has a secret `whsec_<base64 of 32 random bytes>`, generated server-side and **shown once** at creation (and on Rotate). It is stored with AES-256-GCM using WP16's secret crypto (AAD `changeover-webhook/v1|<orgId>|<endpointId>`); `secret_hint` keeps the last 4.
- Each attempt: `const wh = new Webhook(secret); const sig = wh.sign(event.id, new Date(), body)` from `standardwebhooks` 1.1.1 → the headers `webhook-id: <event id>` (stable across retries), `webhook-timestamp: <unix s>`, `webhook-signature: v1,<base64>`, `content-type: application/json` and `user-agent: Changeover-Webhooks/1.0`.
- `/docs/webhooks` shows the verifier in Node (`standardwebhooks` or the SDK's `verifyWebhook`) and Python (`standardwebhooks`): a 5-minute tolerance, a constant-time compare, and dedupe on `webhook-id`.
- **Rotate** (P4): a new secret; for 24 h each attempt carries two signatures (`v1,<new> v1,<old>`), as the spec allows.

### 7.3 Pipeline

1. **Outbox:** the `domain_events` rows (above).
2. **Fan-out tick** (every 2 s on the in-process worker; WP12 adds `registerTick(name, everyMs, fn)` to `src/server/jobs/runner.ts` and to `/api/internal/cron?kind=tick`): `SELECT … WHERE fanned_out_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED` → for each enabled, subscribed, non-deleted endpoint of the org, insert a `webhook_deliveries` row (`pending`, `next_attempt_at = now()`) `ON CONFLICT DO NOTHING` → stamp `fanned_out_at`.
3. **Sender tick** (every 2 s): take ≤ 20 due rows (`FOR UPDATE SKIP LOCKED`; lease them by setting `next_attempt_at = now() + 60 s`), with ≤ 5 in flight. POST with the guarded client (§7.4). **Success = any 2xx within 5 s.** Record the status, the ms and the first 2 KiB of the body.
4. **Retries:** after the first attempt, at +30 s, 2 min, 10 min, 1 h, 6 h and 24 h (7 attempts), with ±20% jitter. A `Retry-After` on 429/503 is honoured up to 1 h. Then `exhausted`. `consecutive_failures` resets on any success; at 50 the endpoint is disabled with `disabled_reason` and an audit row.
5. **Retention:** deliveries 30 days, inbox requests 24 h, domain events 30 days (purge steps, WP24).

### 7.4 Endpoint rules and SSRF

- URL: `https://` on port 443 in production (`http://localhost` only in dev), ≤ 2 KiB, no credentials in the URL, no fragments. Create-time validation resolves the host and refuses private addresses.
- **Every attempt goes through WP16's SSRF-guarded client** (`src/server/connectors/http.ts`: a pinned DNS lookup, the `ipaddr.js` unicast allowlist incl. the embedded IPv4 forms, no redirects, no `Accept-Encoding`, a 5 s timeout, a response cap), **without** the connector host policy (webhook hosts are the customer's own). WP16 exports `publicHttpsPost(url, {headers, body, timeoutMs})` for this.
- Our own origin is refused, except the test-inbox path.
- Payloads are ≤ 64 KiB; ≤ 60 deliveries per minute per endpoint (the excess stays pending).

### 7.5 Test inbox

- On "Add endpoint", the option **"Use a Changeover test inbox (no server needed)"** creates the endpoint with the URL `<APP_URL>/api/webhook-inbox/<inboxId>` (`whi_` + 24 random characters) and sets `inbox_id`.
- `POST /api/webhook-inbox/:inboxId` (public; 60/min; ≤ 64 KiB) stores the headers and the body for 24 h (≤ 50 per inbox) and **verifies the signature with that endpoint's secret**, storing `signature_valid`.
- The endpoint page shows the inbox feed: the time, the event type, "Signature valid ✓ (Standard Webhooks v1)" or "✗", and the pretty-printed payload.
- **Delivery is real HTTP** through the public balancer. If Zerops hairpinning fails (K-HOOK), `WEBHOOK_INBOX_LOOPBACK=1` makes the sender hand the exact signed request to the inbox handler in-process, and the log labels it "delivered in-process (loopback)".

### 7.6 Delivery log UI and redelivery

Settings → Webhooks (admin+, account required, Pro+):
- the endpoint list (URL, events, status, success rate over 24 h, last delivery); Add; Disable; Delete;
- the endpoint page: the **delivery log** (event type, event id, status pill, attempts, last response code, ms, next retry), with a detail drawer (the request headers incl. the signature, the payload JSON, the response snippet, the error code) and **Redeliver** (`manual = true`);
- **Send test event** (`webhook.test`) and **Send the latest `<type>`**, which re-fans the org's most recent stored `domain_events` row of that type to this endpoint (`manual = true`). This is how a judge sees `run.completed` for a run that finished before the endpoint existed;
- the secret: the hint only, plus Rotate (P4).

---

## 8. App shell and information architecture

### 8.1 Route map

| Area | Routes | Session | Owner |
|---|---|---|---|
| Marketing | `/`, `/pricing`, `/docs`, `/docs/[slug]`, `/docs/api` (Scalar), `/changelog`, `/legal/{terms,privacy,dpa}`, `/status` | none | WP7b (`/docs/api`: WP22; developer doc content: WP23) |
| Static devtools | `/schemas/blueprint-2.0.json`, `/cli/changeover-cli.tgz`, `/cli/changeover.mjs`, `/sdk/changeover-sdk.tgz`, `/vendor/monaco/**` | none | WP23 |
| Public runs | `/call/[id]` (Baton console), `/a/[slug]` (share page), `/r/[slug]` (read-only relay) | none | WP7, WP18, WP15 |
| Auth | `/sign-in`, `/sign-up`, `/start`, `/accept-invite/[id]` | — | WP20 |
| App | `/app` (overview), `/app/onboarding`, `/app/runs`, `/app/runs/[id]`, `/app/analytics`, `/app/connectors` | guest or account | WP20 |
| Studio | `/app/relays`, `/app/relays/new`, `/app/relays/[id]/[tab]` | guest or account | WP15 |
| Settings | `/app/settings/{profile,organization,members,audit}` | guest or account | WP20 |
| | `/app/settings/{billing,usage}`, `/app/settings/billing/simulated-checkout` | | WP21 |
| | `/app/settings/api-keys` | account | WP22 |
| | `/app/settings/webhooks`, `/app/settings/webhooks/[id]` | account | WP24 |
| | `/app/settings/developers` (CLI and SDK quickstart) | guest or account | WP23 |
| Redirects | `/studio` → `/app/relays`, `/studio/new` → `/app/relays/new`, `/studio/[id]` → `/app/relays/[id]` (308) | — | WP15 |

The `/app/**` layout (`src/app/app/layout.tsx`, WP20): `auth.api.getSession` (cookie cache) → no session → `redirect("/start?next=<path>")` → `ensurePersonalOrg` for a real user with no org (§3.1) → render.

### 8.2 App shell

- **Top bar:** the org switcher (on the left: the org name, plan badge and kind; the list of orgs with roles; "New organization" for accounts); the status pill (v2 `nextLiveAt`); Docs; the user menu (Profile, Sign out; "Create account" for guests).
- **Side nav:** **Relays**, **Runs**, **Analytics**, **Connectors**, **Settings**. The settings sub-nav lists the §8.4 pages the role can see, in two groups: *Workspace* (Profile, Organization, Members, Billing, Usage, Audit log) and *Developers* (API keys, Webhooks, CLI & SDK). At 390 px the nav collapses into a sheet.
- **Guest banner** (on every `/app` page for anonymous users): "You're in a guest workspace. **Create a free account** to keep it — your relays and runs come with you." It is dismissible per session.
- **Plan notices:** the §4.2 texts, inline where the limit bites, with an Upgrade link for owners ("Ask an owner to upgrade" for others). One shared component, `src/components/billing/plan-notice.tsx` (WP21).
- **Naming:** the app is "Changeover"; the editor is "Changeover Studio" (the P§1.4 rules are unchanged).

### 8.3 Onboarding and the checklist

- **A new account** lands in its auto-created personal org (§3.1) on `/app/onboarding` (P3), which has 3 steps:
  1. name your organization (prefilled "<Name>'s workspace"; skippable);
  2. pick a template: Baton · insurance add-a-driver (the read-only flagship), Dental deposit, Blank, or **Import a blueprint file**. Picking one clones it;
  3. **Run the handoff**: Baton → `/call/<s01>?express=1`; Dental → the Studio Test tab on its pre-generated simulated call (Express); Blank/Import → the Code tab.

  Until P3 lands, a new account goes straight to `/app/relays`, with the templates as the empty state.
- **Guests** skip onboarding: the guest start has already done steps 1 and 2.
- **The checklist** is on the `/app` overview. It is derived from data (no new table) and is dismissible:
  - ☐ Watch a handoff
  - ☐ Try an edit
  - ☐ **Open the relay as code**
  - ☐ Publish a relay
  - ☐ Create your account
  - ☐ Upgrade (sandbox, card 4242)
  - ☐ Create an API key
  - ☐ Receive a webhook

  Each item deep-links to its screen. **It is the judge path** (§13.1).
- The overview also shows the AI-minutes meter, the 5 most recent runs, your relays and "Invite a teammate".

### 8.4 Settings pages

| Page | Contents | Permission | Owner | Tier |
|---|---|---|---|---|
| Profile | name, email (read-only), change password, linked GitHub, active sessions (revoke), delete account (P5) | self | WP20 | P1 |
| Organization | name, slug, kind, created, leave, transfer ownership, delete (typed confirmation) | `org:update`, `org:delete` | WP20 | P1 |
| Members & invites | members (role select, remove), pending invites (copy link, revoke), the invite form (email, role), seats used / plan | `member:*` | WP20 | P1 |
| Billing & plan | the current plan and status, the period end, the cancel-at-period-end banner, Upgrade (Pro, Business), Manage subscription (portal), the "Test mode · Polar sandbox" note, the simulated-mode label | `billing:*` | WP21 | P2 |
| Usage | §4.5 | `usage:read` | WP21 | P2 |
| API keys | §6.1 | `apikey:manage` | WP22 | P2 |
| Webhooks | §7.6 | `webhook:*` | WP24 | P3 |
| CLI & SDK (Developers) | install lines with this deployment's URL (`npx -y …/cli/changeover-cli.tgz`, `npm i …/sdk/changeover-sdk.tgz`), the JSON Schema link and IDE header lines, the lock-file explanation, a link to create a Build key | `relay:read` | WP23 | P3 |
| Connectors & secrets | (`/app/connectors`) the connector catalog with the kinds the plan allows; org secrets (names, "•••• set 2 min ago", expiry; add, delete); **Allowed hosts** (Pro+, §5.6); the connector test console (P4) | `secret:*`, `connector:test` | WP20 (UI) over WP16's routes | P3 |
| Audit log | a filterable table (actor, action, target, date range), 50 per page, the retention note | `audit:read` | WP20 | P3 |

### 8.5 Empty states

- **Relays:** "Start from a template" cards (Dental · Baton pinned · Blank) + "Import a blueprint file (YAML or JSON)".
- **Runs:** "No runs yet. Run the Dental template's simulated call, or watch Baton's recorded handoff."
- **Analytics:** "Analytics appear after your first verified run. Recorded and simulated runs are never blended."
- **API keys:** "Create a key to use the REST API, the CLI or the SDK" + a `curl` preview + a Docs link.
- **Webhooks:** "Add an endpoint, or use a test inbox — no server needed."
- **API keys and Webhooks, seen by a guest** (both are `account` in §8.1, so this is what a guest actually hits): **never a redirect and never a bare `E_ACCOUNT_REQUIRED` error.** Both nav items stay visible and clickable for guests, and both render the real page **with its content disabled behind an inline upgrade card**, in the same warm style as the billing nudge of §13.1 step 8:
  - API keys → "**Create your free account to unlock API keys** — 10 s, no card, and your workspace comes with you." Below it, greyed but legible: the key-creation form and the `curl` / SDK / CLI lines that a key would produce, so the surface is visibly real before signing up.
  - Webhooks → "**Create your free account to unlock webhooks** — 10 s, no card. Then send yourself a signed `run.completed` in one click." Below it, the endpoint form and a sample signed payload with its `webhook-signature` header.
  - Both buttons go to `/sign-up?next=<this page>`, so the guest lands back on the page they wanted with the workspace intact (§3.4).

  These two pages are where a judge checks whether "real API, real SaaS" is a claim or a product. A guest bouncing off an error here loses exactly the point they came to verify, so the degraded state has to sell rather than refuse. The same pattern covers Members → Invite (guest) and any future account-only page: the rule is **show the real surface, disable the action, offer the 10-second account**.
- **Audit log:** "Every change to this workspace is recorded here."
- **Members:** "You're the only member. Invite a teammate with a link."
- **Connectors:** "Built-in connectors are ready: payment link, confirmation, SMS to the mock phone, lookup table. On Pro, call your own endpoints with an HTTP action."

### 8.6 Marketing site (WP7b renders; WP13 writes the copy in `src/content/**`; WP23 writes `src/content/docs/dev/**`)

- **Header** on every marketing page: Changeover · Product (anchor) · Pricing · Docs · Changelog · Sign in · **Try it free**.
- **Landing (P§12.2, amended):**
  - The primary CTA = the v2 "Watch the handoff" button. It now also starts the guest workspace in the background (§3.3), and is labelled so that "free" and "no signup" appear on it (WP13 wording; the ≤ 3 first-viewport terms rule is unchanged).
  - The secondary link "Build a relay →" goes to `/app/relays` (through `/start`).
  - A new section below the fold, **"Build your own relay · low-code"**: three columns (Configure / Code / API, §5.1), a 12-line YAML excerpt, and the `npx … validate` line.
  - A pricing teaser above the footer.
- **`/pricing`:** 4 columns from `PLANS` (Guest is shown as "Try it free, no signup"), the §4.1 rows, the line "Prices are a hypothesis; billing runs in Polar's sandbox (test card 4242)", and an FAQ (the demo budget and replays, data and deletion, what an "AI-finished minute" is, "Is it no-code?" → "Low-code: forms for the essentials, code for everything else").
- **`/docs`:**
  - Quickstart (the checklist in prose);
  - Concepts (relay, blueprint, Pass the baton, provenance);
  - Studio (forms and code);
  - **Blueprint reference** (generated from the JSON Schema's descriptions);
  - **CLI**, **SDK**, **HTTP actions** (recipes in Node, Python and Go);
  - **API authentication**, **Webhooks** (with the verifier);
  - Plans and limits (incl. the shared demo budget);
  - Security and data.

  The content is typed TS in `src/content/docs/**` (no new markdown dependency).
- **`/changelog`:** dated entries (Sep 25 → Sep 30) from `src/content/changelog.ts`.
- **`/legal/terms`, `/legal/privacy`, `/legal/dpa`:** clearly marked placeholders ("Hackathon demo. Not legal advice. Do not upload real customer data."), plus the real data practices of §10.5.
- **Footer:** GitHub, Docs, Pricing, Changelog, Legal, Status, "Built for the AssemblyAI Voice Agent Hackathon".

---

## 9. Audit log

- **Writer:** `getAuditWriter().write({orgId, actor, action, target, metadata}, tx?)` (`src/server/audit/**`, WP19). Where our code owns the transaction, the audit row is written in it. For Better Auth operations called server-side, it is written right after the call succeeds, in the same request.
- **Actor:** `user` (id + a frozen email label), `guest`, `api_key` (id + `cko_…a1b2`), `system` (jobs, Polar sync).
- **Actions** (`AuditAction` in `src/core/contracts/v3/audit.ts`):
  - `org.created|renamed|deleted|ownership_transferred`;
  - `member.invited|invite_revoked|joined|role_changed|removed|left`;
  - `guest.claimed|claimed_device`;
  - `relay.created|cloned|imported|source_saved|deleted|version_created|restored|published|unpublished` (`source_saved` carries `{rev, via: "studio" | "api" | "cli", hash}`; it is written at most once per rev, and Studio autosaves are coalesced to one row per 10 minutes per user and relay);
  - `secret.created|deleted` (name only);
  - `connector.tested|host_added|host_removed`;
  - `apikey.created|revoked|disabled`;
  - `webhook.endpoint_created|endpoint_updated|endpoint_deleted|endpoint_disabled|redelivered|test_sent`;
  - `billing.checkout_started|plan_changed|canceled|resumed`;
  - `entitlement.override_set`;
  - `session.signed_in` (user-level; `org_id` = the active org).
- **Never** in metadata: secret values, API key material, webhook secrets, passwords, raw IPs (only `ip_key`), case field values, blueprint source text.
- **Append-only:** the `0003` trigger. The retention purge per plan (§4.1) runs with `changeover.audit_purge = on`.
- **Viewer:** §8.4 (admin+). **Read API** (P4): `GET /api/app/audit?cursor&actor&action&from&to`.

---

## 10. Security

### 10.1 Tenant isolation rules and the cross-tenant suite

**Rules** (enforced by review and by tests):
1. Every org route calls `requirePrincipal` first. A boundaries test scans `src/app/api/**/route.ts`: each file calls `requirePrincipal`, `requireCase`/`verifyCaseToken`, a provider-signature check or `ADMIN_KEY`/`CRON_SECRET`, or it is on the public allowlist (`status`, `health`, `publications/[slug]` GET, `webhook-inbox`, `auth/[...all]`, `guest/start`, `v1/openapi.json`, `v1/schemas/blueprint`, `v1/blueprints/validate`).
2. Repositories take `orgId` as their first argument and filter on it (`findOwned(orgId, id)`). A foreign id → 404.
3. Nothing reads `orgId` from the request body, a query string, a header or a blueprint file. It comes only from the principal (the session's active org, validated against the membership, or the key's org). `changeover.lock.json`'s `relayId` is only a hint: the server resolves it inside the key's org.
4. Webhook fan-out selects endpoints by the event's `org_id`. The read models filter by `cases.org_id`. Usage and audit are read by `org_id` only.
5. Published runs execute connectors in the **publication's** org (`ConnectorCtx.workspaceId`) and under that org's host policy, never the visitor's.

**The suite** (`tests/tenancy/**`, WP19·3 core + WP19·4 extension; it runs on every merge after G3):
- **Fixtures:** two orgs A and B. Users: A-owner, A-admin, A-member, A-viewer, B-owner, a guest G. Keys: an A Build key, an A Full key, a B key, a revoked A key.
- A table-driven manifest (`tests/tenancy/manifest.ts`) lists every org route with its method, its permission and a fixture id per org.

For each route it asserts:
- B's principals get 404 on A's ids (read and write), including `GET/PUT …/source`, `versions` and `dry-runs`;
- the viewer gets 403 on writes;
- scopes are enforced (403 `E_SCOPE`); a revoked or expired key → 401; a key never works on `/api/app/**` or `/api/relays/**`;
- `set-active` to a non-member org fails, and a forged `activeOrganizationId` cookie value is ignored;
- an invite accept with a different email → 403;
- a guest cannot claim another device's data (a forged `bvid` is rejected);
- A's events never produce deliveries to B's endpoints, and B's inbox never receives A's events;
- an `http_action` to a host in B's allowed hosts is `blocked` in A's relay;
- plan limits hold under concurrency (two parallel creates at the limit → exactly one succeeds);
- CSRF: a cross-origin POST with A's cookie → 403 `E_CSRF`.

### 10.2 Secrets and key material

| Material | Storage |
|---|---|
| Connector secrets | AES-256-GCM, AAD `(org, name)`, the key from `CONNECTOR_SECRETS_KEY` or HKDF(`AGENT_TOOL_SECRET`) (P§6.4, unchanged) |
| Webhook secrets | the same crypto, AAD `(org, endpoint)` |
| API keys | SHA-256 hash (plugin); shown once; the CLI reads them from the environment only |
| Passwords | Better Auth default (scrypt) |
| Sessions | random tokens; `BETTER_AUTH_SECRET` signs the cookies |
| OAuth tokens (GitHub) | stored by Better Auth in `accounts`; only `user:email` is requested; never used after sign-in |
| Blueprint files | never contain secrets: `{ $secret }` refs only, plus the `CODEC_CREDENTIAL` check (§5.2) in the Studio, the API and the CLI |

No secret, key, token, password or webhook secret appears in any response after creation, in logs, in exports, in audit metadata, in blueprint sources or in webhook payloads. The `scrub` list gains `password`, `apikey`, `x-api-key`, `cko_`, `whsec_`, `session_token` and `email` for log lines. A log-capture test covers the SaaS routes.

### 10.3 SSRF

Outbound webhooks and connectors share WP16's guarded HTTP client (§7.4). Connectors also apply the org host policy (§5.6). The test inbox is the only allowed self-origin path. Polar and GitHub are fixed hosts called by SDKs. Nothing else fetches a user-supplied URL server-side: the codec never fetches `$schema` URLs, and Monaco runs with `enableSchemaRequest: false`.

### 10.4 Abuse controls (guests, the validate endpoint, the codec)

- the guest creation limits (§3.3) and the Better Auth `/sign-in/anonymous` rule;
- guests cannot invite, create keys or webhooks, check out, or create orgs;
- the Guest plan limits (§4.1), a 24 h publication lifetime, 7-day secrets, and the 14-day idle purge;
- **`POST /api/v1/blueprints/validate`:** ≤ 256 KiB, 30/min per ipKey without auth, pure CPU (the codec, zod, lint and one kernel compile, < 50 ms p95), no DB writes, no provider calls. A per-ipKey limit alone is not a control here: with `IPKEY_MODE=off`, or from a handful of source IPs, 256 KiB of adversarial YAML × N concurrent requests is synchronous CPU on **the one non-autoscaled Node container that also serves the judge's call**. So the route sits behind a **global compile bucket** (`VALIDATE_GLOBAL_RPS`, default **20 compiles/s with a burst of 40**, sized from the measured p99 compile time × a 20 % CPU share — WP22·1 measures it and records the number in its notes), checked **before** the per-ipKey limit and **before** the body is parsed. Over it → `503 E_BUSY` with `Retry-After: 1` and a `validate.shed` counter on `/status`; the Studio's own in-browser validation is unaffected (it never calls this route), and so is `changeover validate` offline. The same bucket covers `POST /api/v1/relays/:id/compile`;
- **the codec's parsing limits** (§5.3): no custom tags, ≤ 50 aliases, no merge keys, unique keys; the safe regex grammar is applied to every blueprint regex before anything runs;
- **the v2 guards stay:** the global caps and tranches, moderation before Test and Publish (whether the relay came from the Studio, the API or the CLI), lint K1/B1, the share-page labels, no mic on `/a/`, and the F6 audit;
- sign-up is rate-limited (10/h per IP), and the password minimum is 10.

### 10.5 PII and logging

- **Stored PII:** the user's email and name; the session IP and user agent (Better Auth `sessions`; deleted with the session; shown in Profile → Sessions); invitation emails (deleted 30 days after expiry). The audit log stores `ip_key` (an HMAC, rotated daily), never raw IPs.
- **Case data** is fictional role-play in this demo; in the product it is customer PII. So: org-scoped reads only, thin webhooks (§7.1), no field values in logs or audit, audio only through the existing case-token routes. Blueprint `context.samples` are fictional by lint rule (P§3.4) and are labelled "fictional" in the Code tab.
- **Retention:** guest data, 14 days idle; audit per plan; webhook logs, 30 days; the inbox, 24 h.
- The privacy placeholder page states exactly this.

### 10.6 Threat table

| Threat | Control |
|---|---|
| Cross-tenant read or write through a guessed id | the org id comes only from the principal, `findOwned`, 404, the suite |
| An API key used from a browser against a session route | keys are accepted only on `/api/v1/**`; cookies are ignored for key requests |
| CSRF on session routes | the Origin / `Sec-Fetch-Site` check + SameSite=Lax |
| Plan bypass via Better Auth client endpoints | the blocked client paths (§3.8) |
| Checkout with another org's `referenceId` | server-mediated checkout; the sync verifies that the payer is an owner of the referenced org |
| Guest farming to drain credits | per-device, per-ipKey and global guest caps; the global ledger is the hard stop (guest start itself is $0, §3.3) |
| **A third party drains the shared AI tranche through the public API or the CLI before the judge's run** (a *presentation* risk: the ledger bounds total spend, not who spends it first) | the reserved final tranche on `LEDGER_JUDGING_WINDOW_IST`; the 25 % per-org share of the reserve; API-key traffic degrading to the labelled replay before browser sessions when the tranche is under 20 %; `/status` shows the reserve state (§4.2) |
| **A shared or public device's unclaimed guest work absorbed into the next person's org** | the claim is automatic only at guest start and on same-session `onLinkAccount`; a plain sign-in gets a confirmation card, never a silent merge (§2.6 R1) |
| **CPU exhaustion through the unauthenticated blueprint validate endpoint** on the single non-autoscaled container | the global compile bucket in front of the per-ipKey limit, with 503 + `Retry-After` and a shed counter (§10.4) |
| Webhook or `http_action` SSRF into the Zerops network | the guarded client, https:443, pinned DNS, private ranges refused, the org host policy |
| A YAML bomb or ReDoS through a blueprint | codec limits; the safe regex grammar + `safeTest`; the V8 backtrack flag (v2) |
| A secret committed in a blueprint file | `CODEC_CREDENTIAL` blocks save/push; `$secret` refs only |
| Webhook replay by an attacker | the Standard Webhooks timestamp + signature; receivers dedupe on `webhook-id` |
| A leaked invite link | the accept requires the invited email |
| Session theft | HttpOnly, Secure, SameSite cookies; the session list and revoke; 30-day expiry |
| Audit tampering | the append-only trigger |

---

## 11. Email

**Choice: no email (`EMAIL_MODE=off`, $0, no account).**
- Invites are copyable links (§3.6).
- There is no verification mail.
- Password reset is explained (§3.10).
- Polar sends its own sandbox receipts, to sandbox-org members only (research/12).

**Optional P5:** `EMAIL_MODE=resend` with `RESEND_API_KEY` (a free Resend account, no card, 100 emails/day; the user creates it and sets the key in the GUI), used only for invites and password reset. It is not on the judge path.

---

## 12. Impact on in-flight WPs and migration order

| WP | Change (details in TASKS-v3 §7) |
|---|---|
| **WP14a** | No kernel change. Contracts v3 live in `src/core/contracts/v3/**` (WP19); v2 stays frozen. Two small asks: export `canonicalJson` and the canned snapshot states from the isomorphic core for the codec and the CLI (already planned in `migrate.ts`); keep `src/core/relay/**` free of node/DOM imports, because the CLI bundles it |
| **WP14b** | `workspaceFor(d, req)` → `requirePrincipal(req, {perm})`, so `ws = principal.orgId` (the C3 principal behaves like the v2 visitor workspace until `TENANCY_MODE=orgs`); `relayRoute` maps `SaasError`. **New:** `RelaySourceStore` (draft/version source columns; `GET/PUT /api/relays/:id/source`; create from source). `/api/cases` sets `org_id`/`created_by_user_id`, issues the token's `org` claim and runs the plan check (over plan → the labelled replay). The takeover terminal path emits `run.completed` and records `live_run` + `ai_minutes`. Also: the relay create/clone plan check; the `GuestSeeder` (a Dental copy with its YAML source); the registry accepts org ids. ≈ +0.5 T |
| **WP15** | **Re-scoped to low-code (§5.5):** the routes move under `/app/relays/**` inside WP20's shell; the tabs are Overview, Configure, **Code** (Monaco), Preview, Versions, Test, Publish, Analytics; the source store; the forms through `applyEdit`; permission-aware UI (viewer read-only, Publish admin+); plan notices; `/studio/**` redirects; K-MONACO fallback. Removed: the Listening tab, drag-to-reorder, the Advanced textarea, the wizard route (a P4 dialog instead). Still 3.5 T, re-cut: the Code tab and Preview come first (P1) |
| **WP16** | Secrets per org (unchanged signatures) + `SecretRebinder` (claim) + the plan's secret count/TTL. **New:** the `ConnectorHostPolicy` port + `/api/app/connector-hosts` (Pro+). `http_action` for Pro+ custom hosts; `payment.succeeded` emitted where payments become verified; `publicHttpsPost` exported for WP24. ≈ +0.25 T |
| **WP17** | Drafts, sims and dry runs take `ws = orgId`; plan checks for `dry_run`/`voiced_sim`/`draft` (over plan → the preview only, as with the global cap; 402 for API callers); usage records; the draft result carries its notes as YAML header comments (through WP23's `serialize({header})`). The Telecom template (T4) and on-demand voiced sims are cut (P5). ≈ +0.1 T |
| **WP18** | Publish and unpublish: the `relay:publish` permission, the plan's publication count and lifetime, `relay_publications.org_id`; the gateway's `ConnectorCtx.workspaceId` = the publication's org; `case.verified` emitted in the verify job; `RelayAnalytics.forOrg(orgId)` (P4); the `publish` usage record. The share-page published run (T2) becomes P4. ≈ +0.25 T |
| **WP7** | The console is unchanged. The end card adds "Open your workspace →" (`/app`, through `/start`). The `/call` path never requires a session |
| **WP7b** | The landing CTA's background guest start; the header nav; the low-code section; `/pricing` (P1); `/docs/**` rendering, `/changelog`, `/legal/*` (P3). +1 T |
| **WP11** | None (still flagship-critical: autopilot and chips) |
| **WP13** | Low-code positioning across README, deck, lablab copy and landing copy; pricing copy; docs guides (non-developer); changelog; legal placeholders; video beats v3 (§13.2); slides and README deltas. +0.5 T |
| **WP12** | Env and user-set secrets (§15); `registerTick`; the `scrub` additions; the log-redaction test; migrations 0002/0003 on Zerops at G3; the `TENANCY_MODE` flip; the build step for devtools (`copy-monaco`, CLI/SDK tarballs), the `.gitignore` lines, the root `tsconfig` include for `packages/*/src`; e2e spec J (the judge path); the runbook (tenancy, billing mode, webhook loopback, code editor). +1 T |
| **WP5, WP6, WP9** | None |
| **New** | **WP19** identity, tenancy, orgs, audit/event/usage writers; **WP20** app shell, auth pages, settings, onboarding, read models; **WP21** entitlements, billing, usage summaries; **WP22** API keys, `/api/v1`, OpenAPI, `/docs/api`; **WP23** relay-as-code devtools (codec, JSON Schema, SDK, CLI, developer docs); **WP24** outbound webhooks |

**v3.1 additions to the owning WPs** (≈ 0.3 T in total; they fit the D2 float that T3§5 reserves, and none of them is on the G3 critical path):

| WP | v3.1 item | Tier |
|---|---|---|
| WP19 | §2.6 R1: `countClaimableDevice`, `POST /api/app/claim-device`, the decline record, the four tests. `claimVisitorData` loses its sign-in caller | P1 (the *removal* of the automatic sign-in claim is P1; the confirmation card is P3 — without the card, unclaimed legacy data simply stays unclaimed, which is correct, just less friendly) |
| WP20 | the claim card on `/app` (P3); the two guest upgrade interstitials for API keys and Webhooks (§8.5) — WP20 owns the pattern, WP22 and WP24 drop it into their pages | P2 |
| WP21 / WP12 | the tranche reserve (§4.2): `LEDGER_JUDGING_WINDOW_IST`, the 25 % per-org share, the API-key-yields-first ordering, the `/status` reserve line. It is a change to the existing v2 ledger check, so **WP12 owns it** | P2 |
| WP22 | the global compile bucket (§10.4) and its measured number; the "key survives its creator" acceptance test (§6.1) | P2 |
| WP15 | the `Changeover Studio` breadcrumb (§5.5) | P1 (one element in a bar it is already building) |
| WP13 | the re-cut beat table, the freed-rep-time line, the webhook-cut alternative (§13.2); the wording test also asserts "Changeover Studio" is present | P1 |

**Migration and merge order:**
1. C2 (done);
2. **C3**: WP19·1, contracts v3 + ports + the legacy principal; types and pure code only;
3. G2 (the Baton slice; `0001` if ready);
4. **C3b**: WP19·2, Better Auth + `0002` + `0003`, with `TENANCY_MODE=legacy`;
5. WP20, WP21, WP22, WP23, WP24 and the owners' adoptions merge on top;
6. **G3** deploys with the migrations and flips `TENANCY_MODE=orgs`.

---

## 13. The judge path and the video

### 13.1 The judge path, end to end (the Zerops URL; every step has a labelled fallback)

| # | Step | Target | If something is down |
|---|---|---|---|
| 1 | Open `/`: the H1, the pass loop, the status pill, **Try it free · no signup** | LCP < 1.5 s | the static fallback (WP7b acceptance 1) |
| 2 | Click: the audio is primed, the guest starts in the background, and `/call/<s01>?express=1` opens with the 3 s countdown | guest ≤ 400 ms (not awaited) | guest capped (unlikely at the §3.3 limits) → the run still works, device-scoped, with the quiet "continuing without a saved workspace" line; nothing on this step waits for the guest |
| 3 | Baton Express → **Pass the baton** → the AI confirms, discloses, sends the pay link (Polar sandbox or Simulate) → close → "✓ Verified from recording" | **< 45 s from the click to the pass**; verified ≈ 22 s after the end | cap hit → the labelled replay (P§10.4) |
| 4 | End card → **Open your workspace** → `/app`: the checklist shows ✓ Watch a handoff; Relays shows Baton (pinned) + "Dental deposit (your copy)" | < 1 s | `STUDIO_MODE=readonly` → Baton's blueprint read-only (S18) |
| 5 | Dental → Overview → **Try an edit: add a required field** → run the preset on the pre-generated simulated call (Express) → the AI asks only the new question → the QA card | ≈ 60 s | the replay only when the hashes match; otherwise the "live calls resume at" view |
| 6 | **Code** tab: the same relay as YAML; the new field's block is there; type a key → schema autocomplete; a typo shows a squiggle; Save → Preview updates the greeting and the extractor schema. Versions → diff against the template | ≈ 30 s | `CODE_EDITOR=textarea` (the same diagnostics as a list) |
| 7 | **Publish** (guest: 1 live, 24 h) → share link + `agent_…` id | ≈ 5 s | the P-1/P-3 inline fallback, labelled |
| 8 | Settings → Billing → **Upgrade to Pro** → "Create your free account (10 s)" (email + password; the workspace carries over) → sandbox checkout → **4242 4242 4242 4242** → back: "Pro · Test mode" | ≈ 60 s | `BILLING_MODE=simulated`, labelled |
| 9 | Settings → API keys → **Create key (Full access)** → copy → `/docs/api` → "Try it" `GET /runs` (or the `curl` line, or `npx … changeover pull`) → the runs from steps 3 and 5 | ≈ 30 s | the K-DOCS fallback page with `curl` |
| 10 | Settings → Webhooks → **Add endpoint → Use a test inbox** → tick the three events → **Send the latest run.completed** (and Send test event) → the delivery log shows 200 and the inbox shows **"Signature valid ✓"** | ≈ 20 s | `WEBHOOK_INBOX_LOOPBACK=1`, labelled |
| 11 | (optional) Members → an invite link; the Audit log shows every step above; Usage shows the AI-finished minutes | — | — |

Nothing before step 8 asks for an email. Steps 8–10 need an account because they are account features; it takes one short form with no verification. The checklist (§8.3) walks through exactly these steps.

### 13.2 Video beats v3 (≈ 4:40; WP13 owns the script; recorded on the Zerops URL)

| Time | Beat | Screen |
|---|---|---|
| 0:00–0:12 | Cold open on the actual pass (unchanged) | `/call/<s01>` |
| 0:12–0:30 | Problem: "55% hate repeating themselves" + the human→AI line | slide 2 |
| 0:30–1:30 | Baton Express: evidence chips → Pass → confirm → verbatim disclosure → pay link → confirmation | `/call/<s01>` |
| 1:30–1:42 | Verified from recording (k takes, n runs) | QA card |
| **1:42–2:20** | **Platform, low-code:** Baton's relay track (5 s) → Dental, **Try an edit: add a field**; the simulated run asks only the new question, with "simulated" on the provenance strip and in the voiceover (20 s) → the **Code** tab: the same relay as YAML, the new field block, a key autocompleted from the schema (8 s) → a **terminal**, one continuous take, no narration of the commands: `changeover validate dental.yaml` ✓ → `push` → the Studio shows "rev 8 · pushed from CLI" (5 s). Voiceover: "Low-code: ops edit the essentials in forms; developers keep the whole relay as YAML in git, with a schema, a CLI and an SDK. Your business logic stays behind your own endpoints." | `/app/relays/…`, terminal |
| **2:20–3:00** | **"It's a product, not a demo"** (SaaS): the guest workspace → "Create account, keep everything" (5 s) → Upgrade → Polar sandbox checkout with 4242, a fast cut (7 s) → "Pro · Test mode" (3 s) → create an API key → `curl /api/v1/runs` (6 s) → the `run.completed` webhook arrives in the test inbox, "Signature valid ✓" (7 s) → a members invite link + the audit log (5 s) → Usage: the AI-finished minutes meter, and the published `agent_…` id (7 s). Voiceover: "multi-tenant: orgs and roles, usage-metered billing, a public API and signed webhooks" | `/app/settings/…` |
| 3:00–3:23 | Both AssemblyAI APIs, where each is necessary, + two field notes | architecture slide |
| **3:23–4:15** | **Competition and business (52 s):** the four-directions table and the wedge (18 s) → **the freed-rep-time line, on screen as two bars and said out loud: "the same three-minute tail costs about $1.80 to $3.00 of loaded rep time, or about $0.90 finished by the agent — and the rep is already on the next call"** (8 s; P§11, unlocked by the canonical handoff line in P§1.3) → **the live `/pricing` page**: $0.30 per AI-finished minute, Pro at $49 including 150 minutes, "the low-code studio, API, SDK and CLI are included" (16 s) → the market line and the wedge restated over the pricing page (10 s) | slides 3, 7, 8 + `/pricing` |
| 4:15–4:40 | Roadmap and close on the H1 | slide 9 |

**Two deliberate script calls for WP13 (they are decisions, not leftovers of the beat table).**

1. **The SaaS beat is doing double duty as business proof.** Demo now ends at 3:00 (64 % of the runtime) and the business block gets 52 s (19 %). lablab's own guidance (research/07 §4.1) wants the demo done by ≈ 2:30 and the business case at ≈ 30 %, and we are knowingly outside that, because for *this* rubric the 2:20–3:00 block **is** the business case: a real checkout, a real meter and a real signed webhook argue "this is a business" far better than a slide claiming it. So the 3:23–4:15 block must **not** re-explain pricing mechanics that the screen already showed — it adds the market, the wedge and the cost baseline, and nothing else. If WP13 finds the block still crowded in the rough cut, it takes the extra seconds from the architecture slide (3:00–3:23), not from the freed-rep-time line.
2. **The freed-rep-time comparison moves out of the backup slide and into the main beat.** A price with no cost baseline does not answer "why couldn't this be built without AI" — the ≈ $0.90 vs ≈ $1.80–3.00 comparison is the one number that does, and it is the Business-Value criterion's explicit ask. The backup slide keeps the full arithmetic for a judge who asks.

**If a beat's feature is cut:**
- **K-G3:** the platform beat shrinks to 20 s (Baton's relay track + Baton's blueprint in the Code tab, read-only, + `changeover validate` on `baton-add-driver.json`), and the SaaS beat keeps its 40 s on Baton runs (S18).
- **Webhooks cut** (P3 item 13, under ordinary time pressure rather than a kill criterion): the SaaS beat drops the 7 s test-inbox clip and gives ~3 s each to the billing and `curl` clips, and the voiceover becomes "orgs and roles, usage-metered billing and a public API"; "signed webhooks" moves to the roadmap beat. The beat keeps its slot and its length either way.

### 13.3 Slides and README delta (WP13)

- **Slide 4 (Product):** "Low-code: forms for the essentials, the relay as a YAML/JSON blueprint in git, and a REST API, SDK, CLI and signed webhooks. Multi-tenant SaaS: orgs and roles, guest → account, Polar-billed plans with usage metering."
- **Slide 8 (Business):** the live pricing page and the metered minute.
- **The backup slide** adds the tenancy and security diagram (§2.1, §10.6).
- **The README** gets a "Low-code" section (a YAML excerpt, `npx … validate`, the SDK snippet), a "SaaS" section (the judge path, plans, API, webhooks, the security suite, sandbox-only billing) and the new env vars. Every "no-code" goes.

---

## 14. Contracts v3 (`src/core/contracts/v3/**`, WP19; frozen at C3, additive afterwards)

```ts
// identity.ts
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export type OrgKind = "guest" | "personal" | "team";
export type PlanId = "guest" | "free" | "pro" | "business";
export interface Principal {
  kind: "session" | "api_key" | "visitor";
  userId: string | null; isAnonymous: boolean;
  orgId: string | null; orgKind: OrgKind | null;       // legacy/C3: "ws_<visitorId>"
  role: Role | null; scopes: readonly ApiScope[]; apiKeyId: string | null;
  plan: PlanId; visitorId: string; ipKey: string; requestId: string;
}
export interface OrgSummary { id: string; name: string; slug: string; kind: OrgKind; role: Role; plan: PlanId }
export interface MemberView { userId: string; name: string; email: string; role: Role; joinedAt: string }
export interface InvitationView { id: string; email: string; role: Role; link: string; expiresAt: string; invitedBy: string }

// permissions.ts
export const PERMISSIONS = ["relay:read", "relay:write", "relay:delete_any", "relay:publish", "run:read", "run:start",
  "connector:test", "secret:read", "secret:write", "member:read", "member:invite", "member:manage", "org:update",
  "org:delete", "billing:read", "billing:manage", "usage:read", "apikey:manage", "webhook:read", "webhook:manage",
  "audit:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>>;   // exactly §3.7
export const API_SCOPES = ["relays:read", "relays:write", "relays:publish", "runs:read", "usage:read",
  "webhooks:read", "webhooks:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_PRESETS: { build: readonly ApiScope[]; full: readonly ApiScope[] };
export const SCOPE_PERMISSIONS: Readonly<Record<ApiScope, readonly Permission[]>>;
export function can(p: Pick<Principal, "kind" | "role" | "scopes">, perm: Permission): boolean;

// plans.ts
export interface PlanLimits { accountRequired: boolean; seats: number; relays: number; liveRunsPerDay: number;
  aiMinutesPerMonth: number; overageUsdPerMin: number | null; dryRunsPerDay: number; voicedSimsPerDay: number;
  draftsPerDay: number; livePublications: number; publicationIdleHours: number | null; httpAction: boolean;
  connectorHosts: number; secrets: number; secretTtlDays: number | null; apiKeys: number;
  apiKeyScopes: "none" | "build" | "all"; apiRatePerMin: number; webhookEndpoints: number;
  auditRetentionDays: number; analyticsDays: number }
export const PLANS: Readonly<Record<PlanId, { name: string; priceUsdMonthly: number | null; limits: PlanLimits }>>; // exactly §4.1
export type CountLimitKey = "seats" | "relays" | "livePublications" | "secrets" | "apiKeys" | "webhookEndpoints" | "connectorHosts";
export type RateLimitKey = "liveRunsPerDay" | "dryRunsPerDay" | "voicedSimsPerDay" | "draftsPerDay" | "aiMinutesPerMonth";
export interface EntitlementView { orgId: string; plan: PlanId; status: "active" | "trialing" | "past_due" | "canceled" | "none";
  source: "default" | "polar" | "simulated" | "admin"; limits: PlanLimits; currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean; syncedAt: string | null }

// usage.ts
export type UsageKind = "ai_minutes" | "live_run" | "dry_run" | "voiced_sim" | "draft" | "publish";
export type UsageSource = "recorded" | "simulated" | "text_dry_run" | "published" | "replay";
export interface UsageRecord { orgId: string; kind: UsageKind; quantity: number; caseId?: string; relayId?: string;
  source?: UsageSource; idempotencyKey: string; occurredAt?: string }
export interface UsageSummary { orgId: string; period: { from: string; to: string }; plan: PlanId;
  aiMinutes: { recorded: number; simulated: number; published: number; allowance: number; overageUsdEstimate: number };
  today: { liveRuns: number; dryRuns: number; voicedSims: number; drafts: number }; daily: { day: string; aiMinutes: number; runs: number }[] }

// relay-code.ts (the types of §5.3; the implementation is WP23's src/core/relay-code/**)
export type SourceFormat = "yaml" | "json";
export interface RelaySource { format: SourceFormat; text: string }
export interface Range { startLine: number; startCol: number; endLine: number; endCol: number }
export interface CodeDiagnostic { source: "syntax" | "schema" | "lint" | "codec"; code: string; severity: "error" | "warn";
  path: (string | number)[]; message: string; range: Range | null }
export interface RelaySourceView extends RelaySource { relayId: string; version: number | null; rev: number; hash: string; stored: boolean }
export const MAX_SOURCE_BYTES = 262_144;
export const CODEC_CODES = ["CODEC_SYNTAX", "CODEC_UNKNOWN_KEY", "CODEC_CREDENTIAL", "CODEC_TOO_LARGE", "CODEC_ALIAS_LIMIT"] as const;

// events.ts (zod; §7.1)
export const DOMAIN_EVENT_TYPES = ["run.completed", "case.verified", "payment.succeeded", "webhook.test"] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const RunCompletedData, CaseVerifiedData, PaymentSucceededData, WebhookTestData;   // zod objects
export const EventEnvelope;  // { id, type, created_at, org_id, api_version: "2026-09-25", data }

// audit.ts
export type AuditAction = /* exactly the §9 list */ string & {};
export interface AuditEntry { orgId: string | null; actor: { type: "user" | "guest" | "api_key" | "system"; id: string | null; label: string };
  action: AuditAction; target?: { type: string; id: string }; metadata?: Record<string, unknown> }

// errors.ts
export const V3_ERROR_STATUS = { E_AUTH_REQUIRED: 401, E_ACCOUNT_REQUIRED: 403, E_FORBIDDEN: 403, E_SCOPE: 403,
  E_CSRF: 403, E_USE_APP_API: 403, E_NOT_FOUND: 404, E_CONFLICT: 409, E_VALIDATION: 400, E_UNPROCESSABLE: 422,
  E_PLAN_LIMIT: 402, E_RATE_LIMITED: 429, E_BILLING_UNAVAILABLE: 503 } as const;
export type V3ErrorCode = keyof typeof V3_ERROR_STATUS;

// public-api.ts (zod + .meta({id}) for zod-openapi; §6.2). WP19 freezes the names at C3; WP22 fills the fields additively.
export const ErrorV1, PageOf /* (schema) => zod */, MeV1, RelaySummaryV1, RelayDetailV1, RelaySourceV1, VersionV1,
  CompiledPreviewV1, CreateRelayV1, SaveSourceV1, SaveDraftV1, ValidateRequestV1, ValidateResultV1, DryRunV1,
  PublicationV1, RunV1, CaseV1, UsageV1, WebhookEndpointV1, WebhookDeliveryV1;

// services.ts (ports; the default implementations are in src/server/saas/ports.ts)
export interface PrincipalResolver { resolve(req: Request, need?: { perm?: Permission; account?: boolean; allowVisitor?: boolean }): Promise<Principal> }
export interface AuditWriter { write(e: AuditEntry, tx?: unknown): Promise<void> }
export interface DomainEvents { emit(e: { orgId: string; type: DomainEventType; data: unknown; dedupeKey?: string }, tx?: unknown): Promise<{ eventId: string; created: boolean }> }
export interface UsageMeter { record(u: UsageRecord, tx?: unknown): Promise<void>; summary(orgId: string, period?: { from: string; to: string }): Promise<UsageSummary> }
export interface Entitlements { get(orgId: string): Promise<EntitlementView>;
  assertCount(orgId: string, key: CountLimitKey): Promise<void>;                     // throws E_PLAN_LIMIT
  checkRate(orgId: string, key: RateLimitKey, add?: number): Promise<{ ok: boolean; used: number; limit: number }>;
  refresh(orgId: string, reason: string): Promise<EntitlementView> }
export interface BillingProvider { mode: "polar" | "simulated";
  startCheckout(i: { orgId: string; userId: string; plan: "pro" | "business"; headers: Headers }): Promise<{ url: string }>;
  syncOrg(orgId: string): Promise<EntitlementView>; syncCheckout(checkoutId: string, orgId: string, userId: string): Promise<EntitlementView> }
export interface GuestSeeder { seed(orgId: string): Promise<{ relayIds: string[] }> }                 // WP14b registers
export interface SecretRebinder { rebind(fromWs: string, toWs: string, tx?: unknown): Promise<number> } // WP16 registers
export interface RelaySourceStore {                                                                    // WP14b registers
  get(relayId: string, ws: string, opts?: { version?: number; format?: SourceFormat }): Promise<RelaySourceView | null>;
  save(relayId: string, ws: string, source: RelaySource, expectedRev: number, via: "studio" | "api" | "cli"):
    Promise<{ ok: true; rev: number; hash: string; diagnostics: CodeDiagnostic[] }
          | { ok: false; conflict: true; rev: number; hash: string }
          | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }>;
  create(ws: string, source: RelaySource, via: "studio" | "api" | "cli"):
    Promise<{ ok: true; relayId: string } | { ok: false; invalid: true; diagnostics: CodeDiagnostic[] }> }
export interface ConnectorHostPolicy { isAllowed(orgId: string, host: string): Promise<boolean>;      // WP16 registers
  list(orgId: string): Promise<string[]> }
```

`src/server/saas/ports.ts` (WP19) holds a get/set registry for each port, with safe defaults: the legacy visitor principal; in-memory audit/events/usage for tests; a no-op seeder and rebinder; entitlements from `PLANS` and the org kind; a source store that serializes the canonical draft (read-only); a host policy of the env allowlist only. Server code imports ports only from there. Routes map `SaasError` (`src/server/saas/errors.ts`) with `saasErrorResponse`.

---

## 15. Environment and user actions

| Variable | Secret? | Who sets it | Default |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | **yes** (≥ 32 random characters) | **the user, in the Zerops GUI, before G3** | none; missing → `TENANCY_MODE=legacy` |
| `BETTER_AUTH_URL` | no | WP12 (`zerops.yml`) | `APP_URL` |
| `TENANCY_MODE` | no | WP12 | `legacy` until G3, then `orgs` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the secret is | the user (optional, P4; a free GitHub OAuth App) | unset → no GitHub button |
| `POLAR_ACCESS_TOKEN`, `POLAR_SERVER=sandbox` | the token is | exists (v2); **the user replaces it if it lacks the §4.3 scopes** | — |
| `POLAR_PRODUCT_PRO`, `POLAR_PRODUCT_BUSINESS` | no | WP21 creates the sandbox products (or the user in the dashboard); WP12 puts the ids in `zerops.yml` | unset → `BILLING_MODE=simulated` |
| `POLAR_BILLING_WEBHOOK_SECRET` | yes | the user (optional, P4: sandbox dashboard → webhook `https://<app>/api/auth/polar/webhooks`) | unset → sync by polling only |
| `BILLING_MODE` | no | WP12 | auto (§4.7) |
| `WEBHOOK_INBOX_LOOPBACK` | no | WP12 (K-HOOK) | `0` |
| `CODE_EDITOR` | no | WP12 (K-MONACO) | `monaco` |
| `EMAIL_MODE`, `RESEND_API_KEY` | the key is | the user (optional, P5) | `off` |
| `GUEST_DAILY_CAP`, `GUEST_PER_IPKEY_HOURLY` | no | WP12 | **2000, 30** (§3.3 step 2: a $0 endpoint; the spend guard is downstream) |
| `LEDGER_JUDGING_WINDOW_IST` | no | **the user, at the D5 22:00 RC gate** (§4.2 "Reserving the last tranche") | unset → the v2 fixed 6-hour tranche clock |
| `CHANGEOVER_API_KEY`, `CHANGEOVER_URL` | the key is | the CLI/SDK user, on their own machine (never the server) | — |

**Agents never set secrets** (TASKS-v2 §2 rule 5). The user's new GUI actions: one required (`BETTER_AUTH_SECRET`), one conditional (a Polar token with the §4.3 scopes), and three optional (GitHub OAuth, the Polar billing webhook, Resend). npm publishing of the CLI and SDK is an optional P5 user action; nothing depends on it.

---

## 16. Verify at implementation (first hour of the owning unit; record in the WP notes)

| Item | Owner | Fallback if different |
|---|---|---|
| `@better-auth/drizzle-adapter` (or the core `better-auth/adapters/drizzle`) and the `usePlural` generated names | WP19·2 | map the names through the adapter's `schema` option |
| The option names `advanced.database.generateId` and `advanced.ipAddress.ipAddressHeaders` | WP19·2 | default ids; derive the IP in the catch-all route wrapper |
| `auth.api.signInAnonymous({ asResponse })` returns the Set-Cookie headers | WP19·2 | call the plugin endpoint through `auth.handler(new Request(...))` and copy the headers |
| `onLinkAccount` runs before the anonymous user is deleted, also on sign-in | WP19·2 | `disableDeleteAnonymousUser: true` + our own delete after the move |
| The organization plugin's `ac`/`roles` merge with `defaultStatements`; `allowUserToCreateOrganization` | WP19·3 | our `can()` stays authoritative; mutations are server-mediated anyway |
| `@better-auth/api-key`: `references: "organization"`, `defaultPrefix`, the permissions shape, the per-key rate limit | WP22·1 | user-owned keys with `metadata.orgId`, re-checked on each request **against the org, never against the creator's membership** — the §6.1 acceptance test ("a key keeps working after its creator is removed") must pass on this path too, or the fallback is not taken |
| The Polar plugin checkout: customer external id = the session user; `referenceId` in the subscription metadata; the `auth.api.checkout` server call | WP21·1 step 0 | `polar-direct.ts` (SDK `checkouts.create`) |
| The Polar sandbox token's scopes (§4.3) | WP21·1 step 0 | the user creates a new token (TASKS-v3 §11) |
| Customer-State subscriptions carry `metadata` | WP21·1 | `subscriptions.list` by customer + metadata |
| The Scalar options (`cdn`, `withDefaultFonts`, `hideClientButton`) and the pinned `@scalar/api-reference` version | WP22·1 | the K-DOCS fallback page |
| `z.toJSONSchema` options (`target`, `io`, `unrepresentable`, `cycles`) on `BlueprintSchema` incl. the `z.lazy` `ValueRefSchema` | WP23·1 | walk the zod schema with a small custom emitter for the unsupported nodes |
| The `yaml` package version; `LineCounter` ranges; comment preservation through `setIn` | WP23·1 | the JSON-only code view (YAML import/export only) |
| Self-hosted Monaco loads (AMD loader, same-origin workers, codicon font) under the production CSP with `next build && next start` | WP15·1 | `CODE_EDITOR=textarea` (K-MONACO) |
| `npx -y <https tarball URL> <args>` runs the CLI's single bin on npm 10/11 | WP23·2 | `curl … changeover.mjs && node changeover.mjs` (K-CLI) |
| Self-delivery to `<APP_URL>/api/webhook-inbox/*` works through the Zerops balancer | WP12 at G3 | `WEBHOOK_INBOX_LOOPBACK=1` |

---

## 17. Review log (v3.0 → v3.1)

Two reviews of v3.0 (this spec, `TASKS-v3.md`, `research/17-saas-stack.md` and the v2 code on `main`). Both agreed the credit-safety argument holds and that the judge path stays structurally decoupled from the SaaS layer. Four issues were raised at blocking tier and nine as important. **Every blocking fix is applied. Eight of the nine important fixes are applied here; one is applied in `TASKS-v3.md` instead. Nothing was dismissed.**

### Blocking (all applied)

| # | Issue | What changed | Decision note |
|---|---|---|---|
| **B1** | `claimVisitorData` merged a device's unclaimed guest data into whichever org signed in **next** on that device. The `bvid` HMAC binds the cookie to the *device*, not to a person, so on a shared or public machine person B absorbs person A's relays, runs, drafts and secrets. | §2.6 gains rule **R1** and a trigger table: the claim is automatic **only** at guest start and on same-session `onLinkAccount`. A plain sign-in never merges — it shows a dismissible confirmation card that calls `POST /api/app/claim-device`, with a permanent "Not mine". §3.4 states that `link.ts` never claims for a non-anonymous session. Four tests added; a threat-table row added. | Accepted as stated. This was the one finding that is a real cross-tenant leak rather than a demo risk, and it is cheap to fix properly. The card is off the judge path (judges sign **up**, they do not sign in), so it costs the demo nothing. |
| **B2** | D2 is budgeted at 15.25 T with zero slack, and it is exactly where the riskiest `[VERIFY]` work lands. WP19·2 (C3b) gates three of five D2 evening slots and the whole SaaS critical path, with no go/no-go before its 15:00 deadline. | `TASKS-v3.md`: a **C3b-VERIFY checkpoint at D2 12:00** (§4, §9), a **K-VERIFY** kill row (§10), **0.5 T of D2 float** pre-reserved from WP11·1 (§5, §8), and the slot plan carries the branch point. | Accepted. A schedule with no checkpoint in front of its riskiest integration is not a schedule. The float comes from WP11·1 because it is the only D2 unit with no downstream SaaS dependent. |
| **B3** | The public API + CLI + SDK widen the surface for a third party to exhaust the shared tranche **before the judge's run**. The ledger bounds total spend (correct) but not *who spends it first*, and the fallback for a hit cap is a labelled replay rather than the live thing. | §4.2 gains "What the ledger does *not* protect": the final tranche is reserved for `LEDGER_JUDGING_WINDOW_IST` instead of a fixed clock; one org may draw ≤ 25 % of the reserve; API-key traffic degrades before browser sessions under 20 %. `/status` shows the reserve state. Threat-table row added; the env var is in §15 and the user action in T3§11. | Accepted, and worth naming precisely: this is a **presentation** risk, not a cost risk. That distinction is why v3.0 missed it — every existing control is working as designed when it happens. |
| **B4** | Guest-org creation — a $0 endpoint with no external call, and the entry to judge-path steps 4–10 — was throttled like a paid action (400/day global, 5/ipKey/hour). An evaluation panel behind one egress IP could trip it, and the 429 copy read like an outage. | §3.3 step 2: **2000/day global, 30/ipKey/hour, 10/device/day**, with the reasoning stated inline so the numbers are not "optimized" back down later. The 429 now **degrades**: the user stays where they are, `/call/**` is untouched, and the notice reads "Continuing without a saved workspace — the demo works the same." §15 defaults updated. | Accepted. The original numbers were a reflex, not an analysis — the spend guard is downstream and this endpoint costs nothing. The copy mattered as much as the numbers: on a judged URL, a rate-limit notice that reads like an outage is nearly as damaging as an outage. |

### Important

| # | Issue | Decision |
|---|---|---|
| I1 | The device bucket is a no-op for API/CLI traffic — no cookie jar means a fresh random `visitorId` per call. | **Applied**, and named honestly rather than papered over: §4.2 step 2 states the device bucket is browser-UI-only, and API-key requests bucket on `key:<apiKeyId>`. A layer that looks like a control but counts to one forever is worse than no layer, because it is what you stop thinking about. |
| I2 | The api-key `[VERIFY]` fallback did not preserve "keys survive their creator leaving". | **Applied.** §6.1 makes org ownership a guarantee, forbids authorizing off `created_by_user_id`, and adds the acceptance test *"a key keeps working after its creator is removed"*, which §16 now names as the condition for taking the fallback at all. The test may not be rewritten to match whichever path ships. |
| I3 | `blueprints/validate` had only a per-ipKey cap, on a single non-autoscaled container. | **Applied.** §10.4 adds a global compile bucket (default 20/s, burst 40; WP22·1 measures and records the real number), checked *before* the per-ipKey limit and *before* body parsing, shedding with 503 + `Retry-After`. §6.4 cross-references it. Per-identity limits cannot protect a shared CPU. |
| I4 | Polar sandbox delivers checkout email only to sandbox-org members, and the recorder uses a throwaway address. | **Applied in `TASKS-v3.md` §11** (a D3 pre-recording user action), not here. Cosmetic only: the in-app "Pro · Test mode" badge is the proof on screen, and the script never shows an inbox. |
| I5 | The beat table pushed the demo to 3:12 (68 %) and squeezed the business case to 40 s. | **Applied, with the trade-off made explicit.** 12 s move from the low-code beat to the business block (demo ends 3:00; business gets 52 s), and §13.2 records *as a decision* that the 2:20–3:00 SaaS beat does double duty as business proof, so the slide block adds market, wedge and cost baseline and must not re-explain pricing. We are knowingly outside lablab's suggested ratio: a live checkout and a signed webhook argue "this is a business" better than a slide claiming it. |
| I6 | The freed-rep-time ROI number — the one that answers "why couldn't this be built without AI" — was backup-slide only. | **Applied.** It is now an 8 s on-screen line in the main 3:23–4:15 beat. A price with no cost baseline is not an ROI argument. |
| I7 | "Studio" is the headline term but appears nowhere in the product chrome. | **Applied.** §5.5's editor top bar gets a `Changeover Studio / <relay name>` breadcrumb, with the reasoning recorded so it does not get tidied away. The side nav stays "Relays" — it is a list of relays, and renaming it would be the worse fix. |
| I8 | Guests clicking API keys or Webhooks hit an account wall with no warm nudge. | **Applied, and generalized.** §8.5: both pages render the real surface, disabled, behind a billing-style upgrade card; the rule is stated for any future account-only page. These are the two pages where a judge checks whether "real API, real SaaS" is a claim or a product, so the degraded state has to sell rather than refuse. |
| I9 | Webhooks were the only named risk with no documented video fallback if cut under ordinary time pressure. | **Applied.** §13.2 "If a beat's feature is cut" gives the exact re-cut: drop the 7 s inbox clip, extend the billing and `curl` clips, move "signed webhooks" to the roadmap beat. Mirrored in `TASKS-v3.md` §10. |

### Not changed

- **The judge path, the priority tiers and the plan table** are unchanged. Both reviews found them sound, and the `/app` checklist being literally the judge path (§8.3) was called out as worth keeping as-is. It is kept as-is.
- **No code was touched.** Every change is in this file and in `docs/TASKS-v3.md`. The new work (the claim card, the global compile bucket, the tranche reserve, the two guest-nudge pages, the Studio breadcrumb) is absorbed by the owning WPs at ≈ 0.3 T in total — inside the D2 float that B2 created.
