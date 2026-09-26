# WP19 → WP12: two platform tests moved with 0002_saas / 0003_audit_guard, and one trigger you must know about

**Status:** changed in `wp/wp19` (C3b), following the precedent of WP14b's `0001` commit (`747d0be`), which updated
`tests/unit/platform/scaffold.test.ts` in the same commit that added the migration.

## 1. `tests/unit/platform/scaffold.test.ts`

"is ONE migration that creates every table" asserted the journal was `["0000_init", "0001_relays"]`. It is now
`["0000_init", "0001_relays", "0002_saas", "0003_audit_guard"]`. The rest of the test — every `ALL_TABLES` entry
has a `CREATE TABLE` in `0000_init`, and the count matches — is untouched. Per TASKS-v3 §2 rule 14 no other WP adds
a migration, so this list is the whole journal, and a fork in it now fails here.

## 2. `tests/unit/boundaries.test.ts`

The `server-only` rule gained three exemptions beside the existing `schema.ts`:

- `src/server/db/schema-auth.ts` and `src/server/db/schema-saas.ts` — drizzle-kit loads them outside Next's
  bundler, exactly like `schema.ts`;
- `src/server/identity/auth.schema-gen.ts` — the `npx auth@1.7.6 generate` entry point. The CLI **refuses** a
  config file containing `import "server-only"`, which is the reason that file exists at all; nothing imports it at
  runtime.

The test title now reads "the schema files and the auth CLI config are exempt" and the reason sits next to the set,
so the exemption is not later read as a loophole. The "browser code never imports `src/server`" rule above still
covers all three files.

## 3. `0003_audit_guard` constrains your purge step

`0003` installs a `BEFORE UPDATE OR DELETE` trigger on `audit_log`. `UPDATE` is **never** allowed. `DELETE` is
allowed only inside a transaction that has run:

```sql
SET LOCAL changeover.audit_purge = 'on';
```

`SET LOCAL` dies with the transaction, so the escape hatch cannot leak. WP19·3 provides the audit retention purge
function that your purge job calls — this note is only so the trigger's contract is not a surprise when you wire
it. Covered by `tests/unit/server/identity/migrations.test.ts` ("0003 makes audit_log append-only").

## 4. No action needed, but worth knowing

- `npm run migrate` on a populated database now applies `0002` + `0003` in one start. Fresh **and** populated are
  covered by `tests/unit/server/identity/migrations.test.ts`, together with a diff-free `drizzle-kit generate`
  assertion, so the journal cannot silently drift from the schema files.
- Two new environment names are read by the identity layer, both with safe defaults and neither in your
  `EnvSchema`: `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` (absent → the app boots and serves the v2 legacy path,
  §2.8 K-AUTH) and `TENANCY_MODE` (default `legacy`). If you would rather they lived in `EnvSchema`,
  `src/server/identity/config.ts` becomes a one-line delegation and nothing else changes.
