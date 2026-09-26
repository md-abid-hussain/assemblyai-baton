# C3b notes: Better Auth, tenancy, 0002/0003 (WP19·2, D2 Sat Sep 26, ≈17:55–18:20 IST)

**Status: merged and green on `main` at `5462465`.** Typecheck clean; the full unit suite is **2359 passed,
0 skipped (168 files)**; the parity suite is green (22 files, 458 tests); `npm run build` is OK and both auth
routes appear in the route table; all four migrations apply on a throwaway database and re-run as a no-op.
Nothing live was called: **$0 AssemblyAI, $0 OpenAI, $0 Polar, $0 Zerops** — WP19·2 adds no external call, and
`/api/guest/start` is $0 by design. **Not pushed and not deployed** (the orchestrator owns both).

## 1. Merge

| Commit | Merge | Branch tip | Conflicts | What it brings |
|---|---|---|---|---|
| `5462465` | `wp/wp19` (`--no-ff`, "C3b: merge wp/wp19") | `2cd6473` | **none** | Better Auth 1.7.6 mounted, the identity layer, `0002_saas` + `0003_audit_guard`, `schema-auth`/`schema-saas`, the guest start route, the session/API-key principal resolver |

No conflict, so no ownership ruling (TASKS-v3 §6 / TASKS-v2 §4) had to be applied. `wp/wp19` had already merged
`main` (its merge-base was `99c1f2b`, `main`'s tip), which is why the merge is a clean add.

The branch carried 11 commits; the last is this integrator's review-fix commit (§2).

### `package.json` / `package-lock.json`

`wp/wp19` adds `better-auth@1.7.6` and `@better-auth/drizzle-adapter@1.7.6` to `dependencies`. No other branch
was touching those lines, so git merged them without a conflict.

`npm install` in `C:/Users/abid1/Desktop/assembly-ai` added 20 packages and removed 7. **The lockfile came back
unmodified this time** — the npm-10.9.8 `libc` rewrite that `docs/notes/g2b.md` §1 had to revert by hand did not
recur, so no `git checkout -- package-lock.json` was needed. Verified on disk afterwards:

| Package | Installed |
|---|---|
| `better-auth` | 1.7.6 |
| `@better-auth/drizzle-adapter` | 1.7.6 |
| `ipaddr.js` | **2.5.0** (the G2b trap — still correct, not reverted to 1.9.1) |
| `yaml` / `ajv` / `drizzle-orm` | 2.9.1 / 8.20.0 / 0.45.3 |

## 2. Review decisions (`2cd6473`, "wp19: C3b review fixes", on `wp/wp19` before the merge)

A Sonnet adversarial review read the whole `main..HEAD` diff against SAAS §§2, 3, 10, 16, 17 and
`research/17-saas-stack.md`. Verdict: **not clean — one blocking defect**, plus one important and two minor.
Its "not flagged" list is long and was spot-checked rather than taken on trust; nothing in it needed reopening.
Findings 1–3 are fixed; finding 4 is accepted as designed and documented.

### 2.1 [blocking, accepted and fixed] `POST /api/guest/start` could silently swap a real user's identity

`src/server/identity/guest-start.ts`. SAAS §3.3 step 1 is unconditional — "If a session exists →
`200 { orgId, reused: true }`" — but the code only short-circuited when the session already had an
`activeOrganizationId`:

```ts
if (existing?.session) {
  const orgId = existing.session.activeOrganizationId;
  if (orgId) return { status: 200, body: { orgId, reused: true } };   // …else fall through to step 3
}
```

**The premise was verified first-hand before anything was changed**, because the whole finding rests on what
Better Auth's anonymous plugin does over a *real* session, and that is worth measuring rather than reading. A
throwaway test signed up a real user and then called `auth.api.signInAnonymous` with that user's cookie:
status **200**, a **different** user id, **two** `Set-Cookie` headers, and the swapped cookie resolves to an
`isAnonymous: true` user with a different email. The plugin's own guard only refuses to re-anonymize a session
that is *already* anonymous; it never looks at a real one. So the fall-through was a genuine silent logout:
the victim's session row survives in the database, but their browser is left holding a throwaway guest.

It was reachable in ordinary use, not only in a contrived race. `activeOrganizationId` is null for every
brand-new account — `databaseHooks.session.create.before` calls `pickActiveOrg`, which returns null for a user
with zero memberships, and `ensurePersonalOrg()` is only *called* from WP20's `/app` layout, which is not wired
up yet. And `/api/guest/start` takes no session and runs no same-origin check by design (§3.3: the landing CTA
fires it with `keepalive` before any session exists), so a cross-site POST could drive it.

**Fix:** step 1 now returns **unconditionally**, so step 3 is unreachable with a session in hand. A session
with no active org is *reported*, never re-minted: `pickActiveOrg` covers the case where the user does have a
membership and only the session row is older than it (it swallows its own errors and returns null), otherwise
`orgId` is null and `/app` creates the personal org, which is its job (§3.1). `GuestStartResult`'s reuse leg
is `orgId: string | null` accordingly — the honest answer, and the only type change.

**Regression test** (`flow.test.ts`, "never re-anonymizes a real session that has no active org yet"): sign up
a real user, assert the precondition (signed in, `activeOrganizationId` null, not anonymous), POST
`/api/guest/start` on that session, then assert the body is `{ orgId: null, reused: true }`, that **no
`Set-Cookie` is emitted at all**, that the cookie still resolves to the same real non-anonymous account, and
that the organization count did not change. It then calls `ensurePersonalOrg` and repeats, asserting the
`pickActiveOrg` leg names that real membership rather than minting anything.

### 2.2 [important, accepted and fixed] the append-only trigger did not block `TRUNCATE`

`drizzle/0003_audit_guard.sql`. The guard was `BEFORE UPDATE OR DELETE … FOR EACH ROW`, and a **row-level
trigger never fires for `TRUNCATE`**. Since `0003` deliberately does no `REVOKE`/ownership hardening
(`research/17-saas-stack.md` §7, "no DB-grant hardening needed at hackathon scope"), the application's own role
— which owns the table — could have run `TRUNCATE audit_log` and erased the entire log in one statement with no
exception raised. That directly contradicted §10.6's threat table ("Audit tampering → the append-only trigger")
and the file's own claim that a compromised app process "structurally cannot rewrite history".

**Fix:** a second, statement-level `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger. It has **no purge escape
hatch, on purpose**: the §3.5 retention purge is age-scoped and deletes rows, so nothing legitimate truncates
this table, and a purge transaction that reaches for `TRUNCATE` by mistake is exactly the accident worth
refusing. Chosen over `REVOKE TRUNCATE` because a trigger holds regardless of which role connects, and because
the migration stays a plain `--custom` file with no assumption about the deployment's role names. `DROP TABLE`
is still possible, but that is a schema change rather than a write, and it leaves evidence.

`docs/SAAS.md` §2.7's code block was synced in the same commit — the C3 precedent (`docs/notes/c3.md` §2.1):
if the spec and the shipped SQL disagree, fix both or they drift again.

**Test** (`migrations.test.ts`, "0003 refuses TRUNCATE too, purge transaction or not") asserts the refusal both
outside and *inside* a `SET LOCAL changeover.audit_purge = 'on'` transaction, and that the row survives both.

### 2.3 [minor, accepted and fixed] the FK docstring overstated cascade coverage

`src/server/db/schema-saas.ts`'s header claimed org-scoped tables "reference `organizations(id) ON DELETE
CASCADE`, so deleting an org takes its metadata, entitlements, usage, outbox and webhook rows with it". Only
`org_meta` and `org_entitlements` use `orgRef()`; `usage_events`, `domain_events`, `webhook_endpoints`,
`webhook_deliveries` and `audit_log` carry `org_id` as a bare `text` column with no constraint (confirmed
against `drizzle/0002_saas.sql`, which adds none).

Corrected the comment rather than adding the FKs, because **no FK is the right design here**: those tables are
history and ledger, and §3.5 keeps them for a retention window *after* the org is deleted, purged by age. The
comment now says so explicitly, and says that a dangling `org_id` is the intended state rather than an orphan
to repair — which is the thing a future reader actually needs to know before "fixing" it.

### 2.4 [minor, accepted — documented, not changed] the rate-limit check-then-hit is not atomic

`checkLimits` reads all four buckets first and hits them only if every one has room, so a burst from one device
can overshoot the caps by roughly the concurrency. Left as it is, with the reasoning written on the function:

- it is not a spend hole. This endpoint is **$0 and makes no external call** (§3.3), so these are anti-junk-row
  limits; the spend guard is downstream on paid actions (§4.2), where `enforceRates` hits its buckets directly.
- the obvious "fix" is worse. Hit-then-compare would consume from the earlier buckets on every request the
  later ones reject, turning a per-ipKey rejection into per-device budget the visitor never spent.
- tightening it properly means one atomic multi-bucket operation, which is a rate-limiter change (WP12's
  `DbRateLimiter`), not a reordering here.

So the documented guarantee is now: exact ceilings under sequential use, approximate under a burst.

### 2.5 Pre-commit guard: three fixtures rewritten

The shared hook (`scripts/ci/staged-key-scan.mjs`) blocks credential-shaped literals, real or fake, and has no
`allow-fake` marker (that marker only exists in the pre-push `secret-scan.mjs`). The hook was never bypassed.
Rewritten to build the same bytes at run time:

| File | Was | Now |
|---|---|---|
| `tests/unit/core/relay-code/codec.test.ts` | four stripe/whsec/polar-shaped header and URL fixtures | a local `cred(...parts) => parts.join("_")` helper and a `STRIPE_ISH` constant |
| `tests/unit/platform/env-log-secrets.test.ts` | an openai-shaped `secretish` literal | `["sk", "live", "THIS-MUST-NOT-APPEAR"].join("-")` |

Every value is byte-identical after assembly, so each test asserts exactly what it asserted before — and in
`codec.test.ts` the credential *shape* is the thing under test, so it had to stay intact.

Two notes on the brief's "known offenders": `tests/unit/server/secrets/secret-store.test.ts` was **already
clean** (`99c1f2b` fixed it), and `env-log-secrets.test.ts` was **not** on the list but was a third offender.
A scan of all 1061 tracked text files with the hook's own ten patterns now reports **zero** hits anywhere in
the tree, so the next integrator does not inherit this.

## 3. C3b exit criteria (TASKS-v3 §4)

| Criterion | Result |
|---|---|
| Better Auth mounted | **yes** — `npm run build`'s route table lists `ƒ /api/auth/[...all]` and `ƒ /api/guest/start` |
| `0002` + `0003` applied on a **fresh** DB | **yes** — throwaway DB on docker `baton-pg`: `applied: 4, publicTables: 40`; second run `applied: 0` (no-op); all 14 §2.7 tables present; database dropped |
| …and on a **populated** DB | **yes** — `migrations.test.ts` "applies on top of a populated 0001 database: rows survive and the org columns arrive null" |
| `drizzle-kit generate` diff-free | **yes** — `migrations.test.ts` "(VERIFY d)" generates into a throwaway folder seeded with the real journal and asserts no new `.sql` |
| `TENANCY_MODE=legacy` by default, every v2 test green | **yes** — `tenancyMode()` reads anything unrecognised as `legacy`, `.env` does not set it, and the full **2359-test** suite ran with it unset |
| orgs mode: guest start → session + guest org | **yes** — `flow.test.ts` (real Postgres, real Better Auth): anonymous session, `Set-Cookie` with the §3.9 flags, org + `org_meta{kind:"guest"}` + `org_entitlements{plan:"guest"}` + owner membership + the `org.created` audit row, inside the 400 ms p50 budget |
| …+ Baton pinned | **yes**, checked separately — see §4 |
| …+ **Dental copy** | **NOT YET — WP14b·4.** See §4 |
| sign-up carries it over (same org id) | **yes** — `flow.test.ts` "keeps the SAME org id", plus the rename to a personal org, the plan move to `free`, the `guest.claimed` audit row, and the anonymous user row gone |
| the principal matrix tests pass | **yes** — "the principal (§2.3) and the catch-all (§3.8)" (4) + "the principal matrix (§2.3) × TENANCY_MODE (§2.8)" (4) + "the CSRF check (§3.9) over a real session" (6) |

## 4. The one criterion not met, and why it is not a C3b gap

**"guest start → … + Dental copy" does not happen yet.** `getGuestSeeder()`'s default is the no-op returning
`{ relayIds: [] }`, and `grep` confirms **nothing in `src/` calls `setGuestSeeder`** — the only `GuestSeeder`
implementation in the tree would be WP14b's, and it does not exist (`src/server/relays/seed.ts` is
`seedGallery`, the `ws_gallery` upsert, not a per-org clone).

This is scheduled, not dropped, and it is not WP19's to write. TASKS-v3 §6 assigns "the `RelaySourceStore` and
`GuestSeeder` implementations in `src/server/relays/**`" to **WP14b**; §7's WP19·2 acceptance 2 says in so many
words "*the default no-op seeder is OK until WP14b·4*"; and the slot plan puts WP14b·4 at **D2 13:00–17:00**,
alongside and just after this gate. §4's own gate row for feature 3 names WP14b·4 as a co-owner of it.

So the wiring is the deliverable here, and the wiring is real and tested: `flow.test.ts` "seeds through the
`GuestSeeder` port and survives a seeder that throws" registers a seeder, sees `seed(orgId)` called with the new
org, gets its relay ids back in the response body, and then proves a throwing seeder still leaves a usable
workspace. **The moment WP14b·4 calls `setGuestSeeder`, the Dental copy appears with no change to WP19's code.**
That call is the integration step to make when WP14b·4 merges — the same shape as G2b's sim/publication
bindings.

**Baton pinned was verified separately**, because `flow.test.ts` runs on a fresh database where the gallery was
never seeded, so `flagshipRelayIds()` legitimately returns `[]` there and that half of the gate line was
untested. A throwaway check inserted one `relays` row with `flagship: true` and ran a real guest start:
`relayIds` came back `["rel_baton_flagship"]` and `org_meta.pinned_relay_ids` was `["rel_baton_flagship"]` with
`kind: "guest"`. Pinned, not cloned, as §3.3 step 5 requires. The check was deleted afterwards; it belongs in
WP14b·4's suite, next to the seeder it will finally exercise together with.

## 5. Checks on `main` at `5462465`

| Check | Result |
|---|---|
| `npm run typecheck` | clean (also clean on `wp/wp19` before the merge) |
| `npm test` | **2359 passed, 0 skipped (168 files)** — up from G2b's 2306, the 53 identity tests being the difference |
| parity suite (`tests/unit/core/relay`) | **green: 22 files, 458 tests** |
| tenancy suite (`tests/tenancy/**`) | **does not exist yet** — WP19·3/WP19·4 scope per TASKS-v3 §7 and `docs/notes/wp19.md`; the reviewer reached the same conclusion. Nothing to run, and nothing here blocks it |
| `npm run build` | OK. `next build`, `bundle:scripts`, `[assemble-bundle] bundle/ ready: 2013 files, 61.4 MiB, 0 symlink(s) materialized`. `/api/auth/[...all]` and `/api/guest/start` both in the route table |
| migrations on a throwaway DB | OK — see §3. Both triggers present (`audit_log_append_only`, `audit_log_no_truncate`); `UPDATE`, `DELETE` and `TRUNCATE` all refused with "audit_log is append-only"; database dropped |
| conflict markers in the tree | none |
| credential-shaped literals in the tree | none (1061 tracked text files, the hook's own patterns) |

No test was weakened, skipped or relaxed, and no existing test needed changing: the two new tests are additions,
and the three fixture rewrites keep their values byte-identical.

## 6. Worktree sync

`git merge --no-edit main` ran in **23** of the 27 worktrees. Every one was clean beforehand
(`git status --porcelain` empty) and **every merge succeeded — no conflicts, nothing aborted.**

| Worktrees | Result |
|---|---|
| `deploy`, `wp1`, `wp2`, `wp3`, `wp4`, `wp5`, `wp5b`, `wp6`, `wp7b`, `wp8`, `wp9`, `wp12`, `wp13`, `wp17`, `wp18`, `wp19`, `wp21`, `wp22`, `wp23`, `wp24` | fast-forward to `5462465` (20) |
| `wp14a` → `f99d7e2`, `wp16` → `624c263`, `wp7` → `7498385` | merge commit; their own work is ahead of `main`; no conflicts (3) |

**Four were skipped, and why** (the brief's rule: clean, and no unmerged commits being worked on right now):

| Worktree | Why |
|---|---|
| `wp15` | **dirty** — WP15·2 committed 17 seconds before the survey, mid-slot |
| `wp20` | **dirty** — WP20·1, committed 18 minutes before |
| `wp11` | clean but **5 commits ahead and committed 12 minutes before**; WP11·1 opens in the D2 17:00 block |
| `wp14b` | clean but **13 commits ahead and committed 26 minutes before**; WP14b·4 is the live D2 13:00–17:00 slot |

`wp14b` is the one that most wants this merge — WP14b·4's seeder and source store need `0002`'s
`draft_source` / `relay_versions.source` columns, which only exist on `main` as of this gate. It was left alone
because it is being worked in right now; **it should merge `main` itself before continuing**, the same way
`docs/notes/g2.md` §12 handled the branches that owned their own merges. Same for `wp11`, `wp15` and `wp20`.

`wp16` and `wp7` were merged despite being ahead: both are clean and neither has committed in ~8 hours.

## 7. Still open after C3b

1. **`setGuestSeeder` is not called** — §4. The one C3b gate line not met, owned by WP14b·4, and a one-line
   binding once it lands.
2. **`ensurePersonalOrg()` has no caller.** It is exported and tested, but `/app`'s layout is WP20's and is not
   wired up, so a real sign-up still lands with `activeOrganizationId = null`. That is now *safe* (§2.1) rather
   than dangerous, but it is still a gap: until WP20·2, a signed-up user has no org unless they came through
   the guest path. Worth re-checking at G3.
3. **`scripts/ci/staged-key-scan.mjs` is untracked** on `main` while `.git/hooks/pre-commit` points at it by
   absolute path. The guard therefore exists only on this laptop: a fresh clone gets no hook, and CI does not
   run it. It is WP12's path to commit (`scripts/**`), so it was left alone here rather than claimed — but it
   should be committed and given a CI step before RC, or the "no credential-shaped literal ever reaches the
   history" rule is enforced by one machine's local state.
4. **`tests/tenancy/**` (the `requirePrincipal` route-coverage scan, §10.1 rule 1)** is WP19·3/WP19·4's, and G3
   needs it green.
5. The push and the deploy are the orchestrator's, by instruction.
