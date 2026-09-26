# WP23 → WP12: four one-line changes to files WP12 owns (`.gitignore`, `package.json` scripts, the build step)

**Raised:** D1 Fri Sep 25, at the end of WP23·1 (codec + JSON Schema).
**Blocking:** nothing today. WP23·1 is merge-ready without any of this; the paths below are all WP12's
(TASKS-v3 rule 15: `scripts`, `.gitignore`, the root `tsconfig.json`, `next.config.mjs` and `zerops.yml`), so I am
asking instead of editing. Items 1 and 2 matter before WP15·1 (Monaco, K-MONACO D2 17:00); items 3 and 4 are
conveniences.

## 1. `.gitignore`: three generated directories under `public/`

TASKS-v3 §6 lists them as "Generated, git-ignored" for WP23, but `.gitignore` has no entry yet, so they would be
committed by anyone running the devtools or the build:

```gitignore
# Devtools output (WP23): self-hosted Monaco, and the CLI/SDK tarballs served from the app
public/vendor/monaco/
public/cli/
public/sdk/
```

`public/schemas/` is **not** in this list: `public/schemas/blueprint-2.0.json` is committed on purpose (SAAS §5.4)
and a drift test keeps it honest.

## 2. `npm run build`: copy Monaco before `next build`

`scripts/devtools/copy-monaco.mjs` (committed, WP23·1) copies `node_modules/monaco-editor/min/vs` to
`public/vendor/monaco/vs`. It is deliberately friendly when `monaco-editor` is not installed: it prints one line and
exits **0**, because `monaco-editor` is WP15's dependency line and the Code tab has a `CODE_EDITOR=textarea`
fallback. So it is safe to add to the build now, before WP15 lands:

```json
"build": "node scripts/devtools/copy-monaco.mjs && next build && npm run bundle:scripts && node scripts/assemble-bundle.mjs"
```

(`node scripts/devtools/copy-monaco.mjs --require` exits 1 instead; WP15 can use that in its own check.)

Two related deploy notes, if they are yours to make: the copied tree must be served as static files under
`/vendor/monaco/**` (no rewrite), and the production CSP needs `worker-src 'self' blob:` for Monaco's web workers.
WP15 owns the CSP question at K-MONACO - flagging it here only so it is not discovered at 17:00 on D2.

## 3. `package.json` scripts: the three devtools entry points

```json
"devtools:schema": "tsx scripts/devtools/gen-json-schema.ts",
"devtools:examples": "tsx scripts/devtools/gen-examples.ts",
"devtools:monaco": "node scripts/devtools/copy-monaco.mjs"
```

All three run today as `npx tsx scripts/devtools/<name>.ts`; the scripts are only for discoverability. Both
generators take `--check` and exit 1 on drift, which is also what `tests/unit/devtools/schema.test.ts` asserts, so
there is no need to add them to CI separately.

## 4. Nothing needed in the root `tsconfig.json`

`scripts/**/*.ts` and `tests/**/*.ts` are already included, and `examples/**` is data, not code. `npm run typecheck`
covers WP23·1 as it stands. I will come back for `npm run changeover` and the `packages/{cli,sdk}` include in
WP23·2 (D3 13:00-17:00), when the tarball build exists.

## What I did NOT touch

`package.json` outside my two dependency lines (`yaml` 2.9.1 in `dependencies`, `ajv` 8.20.0 in `devDependencies`;
`package-lock.json` hand-edited to match, as in WP12's own note - `npm install` still churns every `libc` marker on
this laptop, so only the three additive hunks are in the diff).
