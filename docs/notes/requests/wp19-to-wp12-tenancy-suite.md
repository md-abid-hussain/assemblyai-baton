# WP19 → WP12: `npm test` does not run the tenancy suite (one-word change to a script you own)

**Status:** needed before G3. **Nothing in `wp/wp19` is blocked by it** — the suite is green, I run it with
`npx vitest run tests/tenancy` — but on `main` it is currently dead weight that nobody executes.

## The situation

`tests/tenancy/**` is the core cross-tenant suite (TASKS-v3 §5 row 5, WP19·3). It is 108 tests over cross-org
404s, viewer 403s, CSRF, forged active orgs, invite email mismatch, and a coverage test that fails when a new
`src/app/api/app/**` route appears without a manifest row or without `requirePrincipal`.

`vitest.config.ts` already includes it — `include: ["tests/**/*.test.ts", ...]`. But the script does not:

```json
"test": "vitest run tests/unit"
```

The positional `tests/unit` filters the config's include down to that one directory, so `npm test` runs 2410
tests in 171 files and **zero** of the tenancy suite. Anyone running `npm test` — including a gate that shells
out to it — gets a green result that has not checked tenancy at all.

## What I am asking for

`package.json` scripts are yours (T2§4, and TASKS-v3 §6 leaves them with you), so I have not touched the file.
The change I would make:

```json
"test": "vitest run tests/unit tests/tenancy"
```

Two notes on the shape:

- **Please keep both paths explicit rather than dropping the filter entirely.** Bare `vitest run` would also
  sweep in `tests/integration`, which needs `RUN_LIVE=1` and costs money. The filter is what keeps `npm test`
  at $0, so it should stay — it just needs the second directory.
- **`tests/tenancy` needs a local Postgres**, the same way `tests/unit/server/cases/**` and
  `tests/unit/server/identity/**` already do. It uses the same `createTestDb` / `HAS_DB` helper
  (`tests/unit/server/cases/helpers/test-db.ts`), so it skips cleanly with no DB rather than failing — the
  behaviour your existing DB-backed unit tests already have. No new CI requirement.

## Why it is worth the edit rather than leaving it to the gate

The coverage test is the one that earns this. Every other tenancy test checks a route somebody remembered to
worry about; that one checks the *remembering*, and it only protects the codebase if it actually runs on other
people's changes. WP20, WP21, WP22 and WP24 all add routes under `src/app/api/app/**` or next to it.

If you would rather not widen `npm test`, the alternative that also works is a second script (`"test:tenancy":
"vitest run tests/tenancy"`) wired into whatever G3 runs — tell me which and I will point the WP19·3 notes and
the WP19·4 entry at it. My preference is the single script, because a suite with its own opt-in command is a
suite that gets skipped.
