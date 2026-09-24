# WP0b notes: scaffold, DB, file guard, deploy skeleton

Status: done for Wave 0, except T-D1-8 (the Zerops deploy, which happens later with the user). Nothing was committed or pushed. No paid API calls were made ($0 spent). Every AssemblyAI path was tested against local fake WebSocket servers.

## What exists

| Area | Files |
|---|---|
| Root configs | `package.json` (all DESIGN §3.3 deps, exact versions), `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `next.config.mjs`, `postcss.config.mjs`, `components.json`, `drizzle.config.ts`, `.env.example`, `.deployignore`, `.gitignore` (4 lines appended) |
| Server base | `src/server/env.ts` (zod, lazy, names-only errors, `requireEnv`, `missingEnv`), `src/server/log.ts` (JSON lines, redaction, `registerSecrets`, `installProcessErrorLogging`, `logBoot`) |
| DB | `src/server/db/{schema,client,index}.ts`, `drizzle/0000_init.sql` (+ `meta/`): all 17 tables of DESIGN §4.2 in one migration |
| App shell | `src/app/{layout.tsx,globals.css}`, `src/app/api/health/route.ts`, `src/instrumentation.ts`, `src/app/dev/csp/{page,csp-probe}.tsx` |
| UI and lib | `src/components/ui/{button,card,badge,separator,skeleton,progress,tabs,tooltip,dialog,sonner}.tsx` (shadcn new-york, radix-ui monorepo); `src/lib/{utils,ids,version}.ts` |
| Scripts | `scripts/{migrate.ts,cron.ts,gen-secrets.ts,assemble-bundle.mjs}`; `scripts/lib/{local-open-guard,limits,aai-open,load-env,pace,wav-fs,empty-module}.ts`, `scripts/lib/{bundle-scripts,run-with-env}.mjs` |
| Deploy | `zerops.yml`, `zerops-project-import.yml` (verbatim DESIGN §10.1), `vercel.json`, `.github/workflows/monitor.yml` |
| Tests | `tests/unit/boundaries.test.ts`; `tests/unit/platform/{local-open-guard,aai-open,env-log-secrets,scaffold}.test.ts` (new folder, see "Ownership") |

npm scripts: `dev, build, build:vercel, bundle:scripts, start, typecheck, test, test:watch, test:int, e2e, db:generate, db:migrate, migrate, cron, secrets:init, guard, eval:*, calls:build, tts:chips`.

## How other packages use it

- **Opening AssemblyAI sessions from Node** (scripts, live tests): only through `scripts/lib/aai-open.ts`.
  - `withStreaming({ params, label }, async (h) => { h.session.sendAudio(...) })`
  - `withStreamingPair({ rep, customer }, …)` (one n=2 grant)
  - `withVoiceAgentNode({ capMs, label }, async (h) => { await h.session.start(config) … })`
  - The handle forms (`openStreaming` / `openStreamingPair` / `openVoiceAgentNode`) return `close()`. SIGINT/SIGTERM hooks still send `Terminate` / `session.end`.
  - Every open: acquire through `getLimitsAuthority()` (`scripts/lib/limits.ts`) → ledger reserve → connect with the API key header → report `opened` → on close `Terminate`/`session.end` → report `closed` with billed seconds → settle. VA sessions heartbeat every 10 s.
  - STT waits through `queued` and `E_QUEUE_TIMEOUT` for up to `maxWaitMs` (default 120 s; pass `0` to fail fast).
- **Laptop file guard** (`scripts/lib/local-open-guard.ts`): one machine-wide state dir `~/.baton/limits` (override `LOCAL_GUARD_DIR`), shared by every worktree.
  - Enforces 4 STT opens per rolling 60 s (`STT_OPENS_PER_MIN`, clamped to 5), FIFO tickets (10 s TTL), and ETA > 15 s → `E_QUEUE_TIMEOUT`.
  - Enforces 1 VA session held or open (`LOCAL_GUARD_VA_MAX`). A session goes stale with no heartbeat for 30 s, past cap + 60 s, or when its owner PID is dead.
  - Enforces a $5/day local AssemblyAI ledger cap (`LOCAL_GUARD_DAILY_CAP_USD`).
  - Kill switch: `npm run guard -- replay-only` / `live` / `status` / `reset`.
- **Running scripts that import `src/server/**`**: `server-only` throws under plain Node. Use `tsx --conditions=react-server …`; every npm script already does. Vitest aliases `server-only`/`client-only` to `scripts/lib/empty-module.ts`. The esbuild bundle uses the same condition.
- **Env**: `env()` for typed config; `requireEnv("ASSEMBLYAI_API_KEY")` where a secret is needed. Scripts call `loadEnv()` (`scripts/lib/load-env.ts`: Node's parser, shell wins, inline `# comments` and empty values dropped).
- **DB**: `getDb()` / `getPool()` / `pingDb()` / `closeDb()` from `@/server/db`. Jsonb columns are typed loosely (`Record<string, unknown>`); repositories cast to the `src/core/contracts` types.
- **Local Postgres**: `docker run --rm -d --name baton-pg -e POSTGRES_PASSWORD=<pw> -p 5432:5432 postgres:17`, set `DATABASE_URL`, then run `npm run db:migrate`.

## Measured results (2026-09-24, Windows 11, Node 22.23.2)

| Check | Result |
|---|---|
| `npm install` (all §3.3 deps) | 544 packages, 2 min; every version exists on npm as pinned (no substitutions) |
| Clean-room `npm ci && npm run typecheck && npm test && npm run build` (copy without node_modules/.env) | `npm ci` 41 s. Typecheck: clean for WP0b files; at that moment one WP0a mid-edit test (`AI_SETTABLE`) failed and has since been fixed. Build → `bundle/server.js` |
| Main tree after all changes | `npm run typecheck` exit 0; `npm test` 9 files / 192 tests pass (incl. WP0a's) |
| `npm run build` | Turbopack compile ≈4.4 s cold. `bundle/`: 1213 files, 17.9 MiB (server.js, migrate.mjs 365 KB, cron.mjs 3 KB, drizzle/, .next/static/). No sharp/@img |
| `node bundle/migrate.mjs` on a fresh `postgres:17` (17.11) | run 1: `applied:1, publicTables:17`, 132–147 ms. Run 2: `schema up to date (no-op)`, 48–53 ms. `app_flags` seeded (4 rows) |
| `GET /api/health` (bundle server, `HOSTNAME=0.0.0.0`) | `200 {"ok":true,"db":true,"version":"0.1.0"}`. With the DB stopped: `503 {"ok":false,"db":false}` within ≈2.5 s, and the pool's idle error is logged, not fatal |
| `/dev/csp` (production CSP, Chrome 152) | header present, blob-URL AudioWorklet loads, blob Worker OK, 0 violations. Same in `next dev` |
| CSP experiment | **`script-src` needs `blob:`**: without it `audioWorklet.addModule(blobURL)` fails with `AbortError: Unable to load a worklet's module` and Chrome fires **no** `securitypolicyviolation` event. `worker-src blob:` alone is not enough |
| `npx license-checker --summary` | See "Licences" below |

## Decisions and deviations

1. **`engines.node: "22.x"`.** The laptop's nvm shim picks the highest installed Node that satisfies `engines`. With `>=22` it ran Node 24; with `22.x` it runs 22.23.2, which matches Zerops `nodejs@22`.
2. **`bundle:scripts` is `node scripts/lib/bundle-scripts.mjs`** (esbuild JS API) instead of the one-line CLI in §3.3. It adds three things the CLI lacks, all needed for a working bundle:
   - `conditions: ["react-server"]`;
   - a `createRequire` banner (pg is CJS);
   - `external: ["pg-native"]`.
3. **`test:int`** uses `scripts/lib/run-with-env.mjs RUN_LIVE=1 -- vitest …`, because cmd.exe has no inline `VAR=1` syntax.
4. **next.config.mjs** additions to §3.3/§8.4:
   - `script-src blob:` (measured above);
   - `'unsafe-eval'` and `ws:` only in dev;
   - `font-src 'self' data:`, `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'self'`;
   - `outputFileTracingRoot`/`turbopack.root` pinned to the repo.
   - `outputFileTracingExcludes` anchored with `./`. An unanchored `dist/**` also matched `node_modules/pg-protocol/dist` and broke pg at runtime ("Cannot find module pg-protocol/dist/index.js"). Found and fixed on the bundle run.
   - `images.unoptimized` + excluding `sharp`/`@img` from tracing: this keeps the LGPL libvips binary out of the deploy, and the bundle is 1 MiB smaller.
   - **`agentRules: false`**: `next dev` 16.3 otherwise writes `AGENTS.md` + `CLAUDE.md` into the repo root. That happened once during testing; I deleted both files and disabled the behaviour.
5. **Schema additions** (additive to §4.2):
   - `cases.version`;
   - `stream_queue.ip_key`;
   - `live_sessions.source` and `created_at`; `live_sessions.case_id`/`visitor_id` are nullable;
   - `jobs.kind` includes `budget_guard`, per TASKS `JobKind`.
   Enum-like columns are `text` with TS enums, not PG enums, so later changes stay additive. `schema.ts` does **not** import `server-only`, because drizzle-kit loads it outside Next; the boundaries test exempts exactly this file.
6. **`/api/health`** returns liveness only: `DATABASE_URL` present + `select 1` with a 2.5 s cap → 200/503 `{ok, db, version}`. Secrets are deliberately not part of liveness, so a first deploy without every secret still passes the readiness check. Features call `requireEnv`.
7. **Boundaries test** (DESIGN §3.1) additions:
   - it strips comments before matching;
   - it exempts the modules that *define* the primitives (`src/core/aai/{streaming,voice-agent}.ts`, `src/server/aai/va-node.ts`);
   - it bans `window.`/`document.` as globals only (`G.window` in the promoted streaming client is fine);
   - it checks `server-only`/`client-only` headers and the tsconfig excludes;
   - it scans `src/`, `scripts/` and `tests/`;
   - a self-test proves each banned form is caught.
8. **shadcn components are hand-written** in the upstream new-york/Tailwind-v4 shape, not fetched with the CLI. This avoids registry downloads and CLI edits to `globals.css`/`package.json`. `cn()` has no `clsx` dependency (clsx is not in §3.3).
9. **vercel.json cron** runs daily (`0 5 * * *`), because the Hobby plan allows at most one run a day (DESIGN §10.4). It is a placeholder until the mirror is needed.
10. **monitor.yml** is skipped until the repository variable `APP_URL` is set (`if: vars.APP_URL != ''`). It also checks `/api/health`.
11. **`scripts/lib/pace.ts`** re-exports WP0a's isomorphic `src/core/audio/pace.ts`. **`scripts/lib/wav-fs.ts`** adds `readWav`/`writeWav` on top of `src/core/audio/wav-decode.ts`.

## Ownership

`tests/unit/platform/**` is not in the TASKS §3.0 map. It holds only tests of WP0b modules. Please assign it to WP0b and later to WP12, or tell me where to move it.

## Licences (`npx license-checker --summary`)

MIT 461, ISC 35, Apache-2.0 16, BSD-3 8, BSD-2 5, 0BSD 1, MIT AND ISC 1, plus these:
- **MPL-2.0 ×4** (`lightningcss` + win32 binary, two versions): build-time only (Tailwind, vite). File-level copyleft, used unmodified, not in the bundle.
- **Apache-2.0 AND LGPL-3.0-or-later ×1** (`@img/sharp-win32-x64`, Next's optional image optimiser): now excluded from the deploy bundle.
- **BlueOak-1.0.0 ×2** (`minimatch`, `isexe`): permissive.
- **Python-2.0** (`argparse`, dev) and **Unlicense** (`fast-sha256`, via standardwebhooks): permissive.
- **CC-BY-4.0** (`caniuse-lite` data, build-time): attribution only.
- **UNLICENSED ×1** = this private package itself (`baton`, MIT per `LICENSE`).

Verdict: MIT/Apache/BSD/ISC-compatible; nothing copyleft ships in the runtime bundle.

## Known gaps / next steps

- **T-D1-8 not done** (by instruction): `zcli push` plus a green `/api/health` on `*.zerops.app`. Also still to confirm there: `HOSTNAME=0.0.0.0` binding, since `server.js` printed `Network: http://0.0.0.0:3108` locally, and the CSP probe on the subdomain.
- **In-proc worker not wired**: WP2's `startInprocWorker()`; see `docs/notes/requests/wp0b-to-wp2.md`.
- **The remote authority is not wired for scripts**: `registerRemoteAuthorityFactory` in `scripts/lib/limits.ts`. Until then, setting `LIMITS_AUTHORITY_URL` makes script opens throw.
- **The user must run `npm run secrets:init`** (TASKS §9 step 5). I did not run it against the real `.env`; it was verified on a scratch copy, twice (the second run was a no-op).
- **Playwright browsers are not installed** (`npx playwright install chromium webkit` is a download; WP12).
- **`/dev/csp` still needs testing on Safari/Firefox** and on the deployed URL (WP12 matrix).
