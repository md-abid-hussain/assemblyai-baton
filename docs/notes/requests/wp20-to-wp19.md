# WP20 → WP19

## 1. Register the org directory so the switcher shows real orgs (WP19·3)

WP20·1 ships the switcher over a seam, because the `organization` / `members` tables do not exist until
`0002_saas`. `src/server/read-models/orgs.ts` exports:

```ts
export interface OrgDirectory { listForPrincipal(p: Principal): Promise<OrgSummary[]>; }
export function setOrgDirectory(d: OrgDirectory | null): void;
```

Please call `setOrgDirectory(...)` from wherever WP19·3 registers its other start-up ports (next to
`setPrincipalResolver`). Until you do, `orgSummariesFor()` returns the single legacy workspace derived from the
principal, which is the truth under `TENANCY_MODE=legacy`, so nothing is broken in the meantime — the switcher
simply lists one org and marks it as not switchable.

`OrgSummary` is your own type (`contracts/v3/identity.ts`); WP20 adds nothing to it.

**Status after WP20·2:** `dbOrgDirectory` (over your `listMembershipsByRecency` + `getOrg`) is the default for
any principal with a `userId`, so this is now a *preference*, not a blocker. Override it if WP19·3 has a cheaper
single query; otherwise leave it.

## 2. `ensurePersonalOrg` in the `/app` guard (WP19·2 / ·3)

**Done in WP20·2's predecessor — no action needed.** `appContextOrNull` imports `ensurePersonalOrg` from
`src/server/identity` and calls it for a signed-in, non-anonymous user with no org. Deliberately *not* for a
visitor or a guest: the guest start creates the org in the same request that creates the session.

## 3. `POST /api/guest/start` — what `/start` expects

`src/app/start/page.tsx` + `start-client.tsx` POST `{ next }` to `/api/guest/start` and then
`location.replace(next)`.

- It **ignores the response body and any error**, including the §3.3 step 2 rate-limit 429, and sets the
  `cx_start_attempt` cookie so a second failure renders the degraded device workspace instead of looping.
- It does **not** read `{ orgId, relayIds }`.
- `next` is validated by `safeNextPath` (`contracts/ext/wp20-app.ts`) before it is used.

## 4. THE ONE THAT MATTERS: the `/api/app/**` request and response shapes (WP19·3, same slot)

`src/app/api/app/{orgs,members,invitations,audit}/**` is yours (TASKS-v3 §6); the pages that call them are mine,
and we are building in the **same slot**, so this section is written as a proposal you can accept by doing
nothing, or change by telling me. Every call WP20·2 makes goes through exactly one file —
**`src/client/app/app-api.ts`** — so if you change a shape, that file is the whole of my side of the fix.

What I assumed, in every case, is *the contracts-v3 type you already froze at C3*. No new wire types.

| Call | Body | 2xx response |
|---|---|---|
| `POST /api/app/orgs` | `{ name: string }` | `{ org: OrgSummary }` |
| `PATCH /api/app/orgs/<id>` | `{ name?: string; slug?: string }` | `{ org: OrgSummary }` |
| `DELETE /api/app/orgs/<id>` | `{ confirm: string }` (the typed org name, §3.5) | `{ ok: true, nextOrgId: string \| null }` |
| `POST /api/app/orgs/<id>/leave` | `{}` | `{ ok: true, nextOrgId: string \| null }` |
| `POST /api/app/orgs/<id>/transfer` | `{ userId: string }` | `{ ok: true }` |
| `POST /api/app/invitations` | `{ email: string; role: Role }` | `{ invitation: InvitationView }` |
| `DELETE /api/app/invitations/<id>` | — | `{ ok: true }` |
| `PATCH /api/app/members/<userId>` | `{ role: Role }` | `{ member: MemberView }` |
| `DELETE /api/app/members/<userId>` | — | `{ ok: true }` |
| `POST /api/app/claim-device` | `{}` — **no visitor id in the body**, you re-derive it from the signed cookie (§2.6 R1) | `{ ok: true, claimed: ClaimCounts }` |

Notes, each of which is a thing I would otherwise have to guess:

1. **`nextOrgId`.** After a delete or a leave the browser is standing on a page belonging to an org it is no
   longer in. If you return the org the session was switched to, the page navigates there; if you return `null`
   I send the user to `/app` and let the guard sort it out. Either is fine — `null` is the safe default and my
   code handles both.
2. **Errors** are the §6.3 envelope (`{ error: { code, message } }`) with `V3_ERROR_STATUS`. My client reads
   `error.code` and shows `error.message` verbatim, so the message is user-visible copy: `E_PLAN_LIMIT` on the
   invite form renders as the seats notice, `E_CONFLICT` on a slug renders under the slug field.
3. **`InvitationView.link`** should be the absolute `<APP_URL>/accept-invite/<id>` (§3.6). The Members page has
   a Copy link button and nothing else to build it from; `appUrl()` on my side would guess the deployment URL.
4. **A 404 from any of these is treated as "WP19·3 has not merged yet"** and renders a quiet inline notice
   rather than an error toast. That is only true until you merge; after that a 404 is a real bug and I will
   remove the branch. It exists so my pages are demonstrable in my own worktree, not as a permanent excuse.
5. **`PATCH /api/app/members/<userId>` keys on the *user* id, not the membership row id.** `MemberView.userId`
   is what the contract gives the page. If your route wants the `members.id` instead, say so and I will carry it
   — but then `MemberView` needs a `memberId` field, which is a contracts change and therefore yours.

## 5. Reads: I do NOT call `/api/app/**` for them

Settings → Members, Organization and Audit render server-side from **my own read models**
(`src/server/read-models/{members,audit,org-settings,invite,profile}.ts`), which SELECT from your tables
directly. That is SAAS §6.2's "one read path" rule and it means:

- your routes only need the **mutations** above to unblock me;
- `GET /api/app/audit` (§9, P4) is not on my critical path — build it for the public API, not for the viewer;
- if you add columns, my read models see them; if you *rename* one, they break. The tables I read are
  `members`, `users`, `invitations`, `organizations`, `org_meta`, `org_entitlements`, `audit_log` and
  `sessions`. Please mention a rename in `docs/notes/wp19.md`.

## 6. `/accept-invite/[id]` reads the invitation **before** there is a session

SAAS §3.6: "shows the org name and the role. If signed out → sign-up or sign-in with the invited email
prefilled." There is no session at that point, so `auth.api.getInvitation` is not available to me.
`src/server/read-models/invite.ts` therefore reads `invitations` + `organizations` by id directly and returns
only `{ orgName, role, emailMasked, emailPrefill, expiresAt, status }`. The id is the capability (it is the
link), and accepting still goes through Better Auth's own email-equality check, so the link alone still is not
enough. If you would rather this be a route of yours, take it — it is 40 lines and I will delete mine.

## 7. The claim card (SAAS §2.6 R1) — what I built against

`claimOffer(orgId, visitorId)` from WP19·2 is exactly what the card needed; thank you. `/app` calls it and
renders the dismissible card with the counts. The **button** calls `POST /api/app/claim-device` (§4 above) and
**Not mine** calls the same route with `{ decline: true }` — that is the one place I extended your shape rather
than reusing it, because `declineDeviceClaim` has no route yet and a second endpoint for one boolean seemed
worse than a flag. Change it to `DELETE /api/app/claim-device` if you prefer; one line in `app-api.ts`.

## 8. FYI, not a request

`src/server/read-models/tenant.ts` is the one place WP20 turns an `orgId` into a SQL predicate on `cases`. The
rule it encodes:

| org id | `cases.org_id` exists | predicate |
|---|---|---|
| `ws_<vid>` | no | `visitor_id = vid` |
| `ws_<vid>` | yes | `org_id = :org OR (org_id IS NULL AND visitor_id = vid)` |
| `org_…` | no | nothing matches |
| `org_…` | yes | `org_id = :org` |

**A real org never falls back to the device**, so a shared browser cannot leak one person's guest work into
another person's org. `tests/unit/server/read-models/tenant.test.ts` pins that.

---

# WP20·2 addenda (D2 evening, after building the pages against a live database)

## 9. `githubProvider()` is not on the `src/server/identity` barrel

`/sign-in` and `/sign-up` need one boolean — whether to render "Continue with GitHub" (§3.2) — and it lives in
`src/server/identity/config.ts` beside `authConfigured`, `appUrl` and `guestLimits`, all three of which *are*
exported from `index.ts`. I import the deep path today. One line on the barrel and I will switch to it; no
rush, and nothing breaks either way.

## 10. The `AuditWriter` port has no implementation yet, so the audit viewer is empty by construction

Verified on `baton_wp20`: a guest start, a sign-up and a carry-over produced **zero rows in `audit_log`**.
`writeAudit` is called (`guest-start.ts:230`) and swallows the failure by design, and `getAuditWriter()` has no
registered writer until WP19·3 lands `src/server/audit/**`. So this is expected, not a bug — recording it so
nobody spends the G3 hour debugging my page. `/app/settings/audit` renders §8.5's empty state and the retention
note correctly; the moment a writer is registered it will have rows to show, with no change on my side.

What I depend on when it lands: `audit_log.actor_label` **frozen at write time** (§9) — the viewer renders it
verbatim and never resolves `actor_id` to a current name — and `metadata` limited to the §9-safe keys. My
viewer also allow-lists metadata *keys* on the way out (`SAFE_METADATA_KEYS` in `read-models/audit.ts`), so a
key you add later that is not on that list is silently dropped rather than rendered. Tell me the key and I will
add it; that is cheaper than the alternative failure.

## 11. `BETTER_AUTH_URL` was the missing input behind WP20·1's "degraded on my box"

WP20·1 note 5 reported `POST /api/guest/start` answering `{degraded: true, reason: "accounts_unavailable"}`
with `BETTER_AUTH_SECRET` set. The cause is `authConfigured()` needing **three** inputs, and `betterAuthUrl()`
falling back to `APP_URL`, neither of which is in the worktree `.env`. With
`APP_URL=http://localhost:3200 BETTER_AUTH_URL=http://localhost:3200` on the command line, everything works:
guest start returns a real `{orgId, relayIds}`, sign-up carries the org over, and the switcher lists three
workspaces. **No code change is needed** — this is an env note for §15 and for the G3 checklist. It is also the
one-line answer to "is the SaaS demo alive on this deployment".

## 12. What I verified of yours, end to end, so you do not have to re-verify it

On `baton_wp20` with `TENANCY_MODE=orgs`, from the real pages:

- **§3.4 sign-up carry-over:** same org id before and after, `Guest workspace` → `Asha Rao's workspace`,
  `org_meta.kind` `guest` → `personal`, entitlement `guest` → `free` (`source: default`), the anonymous user
  row gone, exactly one membership. Nothing orphaned.
- **§3.4 sign-in carry-over:** signing in from a *second* guest browser added the guest org as
  `Guest workspace (claimed 2026-09-26)` alongside the existing two. The switcher then listed three.
- **§3.5 `setActive` + `router.refresh()`:** switching changed the server-rendered data, not just the label —
  the Members page went from `1 of 10 seats on Pro` to `2 of 3 seats on Free` with the other org's pending
  invite. That is WP20 acceptance 3, and it passes on your plumbing.

## 13. The routes I call that do not exist yet (`/api/app/**`)

Every one of them answers 404 with no error envelope today, and `app-api.ts` turns that into the inline line
"This action is not available in this build yet." rather than an error — confirmed in the browser on Members.
The shapes are §§1–5 above and they have not changed. When your routes land, nothing on my side needs editing;
if a shape *did* change, `src/client/app/app-api.ts` is the whole of my side of the fix.
