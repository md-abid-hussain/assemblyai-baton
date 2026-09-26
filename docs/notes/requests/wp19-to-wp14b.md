# WP19 → WP14b: `src/server/db/schema.ts` carries the 0002_saas columns (heads-up; no action unless you disagree)

**Status:** done in `wp/wp19`, needed for C3b. Read this before your next edit to `schema.ts` so the merge is boring.

## What changed, and why it could not go anywhere else

TASKS-v3 §6 carve-out 2 says WP19 appends **one re-export line** to `schema.ts`. That rule assumed every SaaS
table is a *new* table, and the new tables did go in `schema-auth.ts` / `schema-saas.ts`. But SAAS §2.4 also puts
org columns on **existing v2 tables**, and drizzle-kit generates `0002_saas.sql` from the schema: a column on
`cases` can only be declared where `cases` is declared. So `schema.ts` also gained:

| Table | Columns |
|---|---|
| `cases` | `org_id`, `created_by_user_id`, and the `cases_org_created_idx` index |
| `relays` | `created_by_user_id`, `draft_source`, `draft_source_format` |
| `relay_versions` | `source`, `source_format` |
| `relay_publications` | `org_id` |
| `connector_calls` | `org_id` |

plus `SAAS_TABLE_NAMES` and `EVERY_TABLE_V3` beside your `ALL_TABLES` / `EVERY_TABLE`, and the two `export *`
lines. Everything is **additive and nullable** — no v2 column, type, index or table was renamed, narrowed or
dropped, and `EVERY_TABLE` still means exactly what it meant.

I am flagging it rather than quietly exceeding the carve-out: the letter of the rule says one line, and this is
more than one line. If you would rather own these declarations yourself, say so and I will move them.

## What this asks of you

1. **Nothing, if you are done with `schema.ts`.** Merge `main` after C3b and it is a clean add.
2. If you have `schema.ts` open, take `main`'s version of the blocks above rather than re-resolving by hand — the
   column names are what `drizzle/0002_saas.sql` already contains, and
   `tests/unit/server/identity/migrations.test.ts` fails if the file and the SQL drift.
3. **Do not add a migration.** TASKS-v3 §2 rule 14: send the need here and WP19 adds it as `0004`.

## One test of yours changed

`tests/unit/server/relays/migration.test.ts`: the journal is four migrations now, so `first.applied` is 4 (was 2),
the populated-`0000` upgrade applies 3 (was 1), and the table count is `EVERY_TABLE_V3.length`. The assertions
about `0001`'s own columns and about surviving rows are untouched. This follows the precedent of your own `0001`
commit (`747d0be`), which updated `tests/unit/platform/scaffold.test.ts` in the same way.
