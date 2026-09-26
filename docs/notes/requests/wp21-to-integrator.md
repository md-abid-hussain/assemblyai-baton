# Request: WP21·1 → integrator

Details and evidence: `docs/notes/wp21.md`.

## 1. Two configuration values for `zerops.yml`

`scripts/billing/create-plans.ts` has been run once against the Polar **sandbox**. "Changeover Pro" ($49/mo) and
"Changeover Business" ($299/mo) exist, and the script is idempotent — re-running it prints `exists` and creates
nothing. Both ids are already in the local `.env` as `POLAR_PRODUCT_PRO` and `POLAR_PRODUCT_BUSINESS`.

To read them without creating anything:

```
npx tsx scripts/billing/create-plans.ts --json
```

It prints the two `name=id` lines and a JSON object, and nothing else — never the token.

Product ids are configuration rather than secrets (SAAS §4.3), so they belong in `zerops.yml` next to
`POLAR_SERVER`. **They are not written into this file or into `docs/notes/wp21.md` anyway**: the shared
pre-commit hook blocks any value that appears in `.env`, whatever it is, and that blanket rule is worth more than
the convenience of pasting two uuids into a note. `zerops.yml` is not a WP21 path, so I have not touched it.

**Without them the deployment is not broken** — `billingMode()` returns `simulated`, the Billing page renders, and
Upgrade goes to the labelled simulated checkout. That is the §4.7 fallback working, not a failure. But K-BILL
(D3 17:00, "sandbox checkout with 4242 → Pro · Test mode within 20 s") needs the real ids.

Also keep `POLAR_SERVER=sandbox`. Any other value disables billing by design.

## 2. The Polar sandbox token needs no user action — the §11 D2-by-16:00 item is closed

TASKS-v3 §11 reserved a user action in case the existing `POLAR_ACCESS_TOKEN` lacked the §4.3 scopes. It does not.
All ten scopes were probed live against `sandbox-api.polar.sh` (read endpoints returned 200; write endpoints were
probed with an empty body and returned 422 *validation*, not 403 *scope*, so nothing was created). Full table in
`docs/notes/wp21.md`. **No new token, no GUI change, no lead time.** This is the WP21 line for C3b-VERIFY.

## 3. `npm install` in this repo now needs `--legacy-peer-deps`

`@polar-sh/better-auth@1.8.4` (the version SAAS §0 S9 names, and the latest published) declares
`peerDependencies: { "@polar-sh/sdk": "^0.47.0" }`, and this repo pins `@polar-sh/sdk@0.49.0` for the v2 payments
path. For a `0.x` version `^0.47.0` means `>=0.47.0 <0.48.0`, so npm refuses the install outright.

- I installed with `npm install @polar-sh/better-auth@1.8.4 --legacy-peer-deps` and pinned the exact version.
- **It works against 0.49.0**: every SDK path the plugin imports resolves, `npm run typecheck` is clean, and the
  one call that matters (`checkouts.create` with `externalCustomerId` + `metadata`) was verified live against the
  sandbox.
- **What this means for anyone else running a fresh install**: a plain `npm ci` / `npm install` will fail with
  `ERESOLVE`. Either add `legacy-peer-deps=true` to a repo `.npmrc`, or pass the flag. `.npmrc` is not a WP21
  path, so the decision is yours — my recommendation is the `.npmrc` line, because the alternative is every WP
  hitting the same error once.
- Downgrading `@polar-sh/sdk` to 0.47.x would satisfy the peer range but is **not** my call: that line belongs to
  the v2 payments path, and moving it is a change to shipped behaviour to satisfy a metadata string.

## 4. The suite is green here; one timing-sensitive file to know about

`npm test` in `wp/wp21`, after the final merge from `main`: **2426 passed, 0 failed, 173 files** (32.9 s).
`npm run typecheck` is clean.

The one file worth knowing about is `tests/unit/core/relay-code/roundtrip.test.ts` (WP23's). An earlier run on
this branch timed out on its two 200-edit cases; the final run passes them. Those cases sit close to the 20 s
per-test timeout and go red only under full-suite parallelism on a loaded machine, so if CI shows them failing,
re-run the file in isolation before treating it as a regression. WP21 touches no codec, YAML or blueprint code.

## 5. Merge notes

- New paths only, all inside the TASKS-v3 §6 WP21 ownership list, except two: the dependency line in
  `package.json` (rule 15 allows my own), and `docs/notes/requests/**`.
- `src/server/billing/polar-plugin.ts` is the C3 stub replaced in place — the file WP19 handed over at C3. Its
  one importer (`src/server/identity/auth.ts`) is unchanged and needs no change.
- No migration. WP21 adds none; `org_entitlements` and `usage_events` are WP19's `0002_saas`.
- Two one-line requests to WP19 in `docs/notes/requests/wp21-to-wp19.md`; neither blocks a merge.
