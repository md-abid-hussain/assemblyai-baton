# Wave-0 integration notes (G0)

Status: **Wave 0 is green from a clean state**, on Windows and on a Linux container that reproduces the Zerops build.
Nothing was committed, pushed or deployed. There were no live AssemblyAI or OpenAI calls ($0). Every Docker
container I started has been removed.

## What I ran (2026-09-24, Windows 11, Node 22.23.2, npm 10.9.8)

### Clean run, twice

I ran this twice: once before my fixes and once after them. The numbers are from the final run.

| Step | Result |
|---|---|
| `rm -rf node_modules .next bundle dist next-env.d.ts` then `npm ci` | exit 0, 546 packages, 36–47 s |
| `npm run typecheck` (tsc 6.0.3) | exit 0, 6–8 s |
| `npm test` (vitest 5.0.1) | **13 files, 238 tests pass**. The first run had 237; my boundaries fix adds one |
| `npm run build` | exit 0, ≈14 s. Turbopack compile ≈4 s. `bundle/`: 1213 files, 17.9 MiB, `bundle/server.js` present |
| Fresh `postgres:17` (17.11) in Docker, then `node bundle/migrate.mjs` twice | run 1: `applied:1, publicTables:17`, 134–138 ms. Run 2: `schema up to date (no-op)`, 43–47 ms. The 17 tables match DESIGN §4.2 exactly; `app_flags` has 4 seed rows |
| `npm run db:migrate` (tsx path) on the same DB | no-op, exit 0 |
| `drizzle-kit generate` | "No schema changes": `schema.ts` and the snapshot match |
| `bundle/server.js` (`NODE_ENV=production HOSTNAME=0.0.0.0`) → `GET /api/health` | `200 {"ok":true,"db":true,"version":"0.1.0"}`. With the DB stopped: `503 {"ok":false,"db":false}`, and the pool error is logged, not fatal |
| `curl -I /dev/csp` | 200 with CSP, Permissions-Policy, Referrer-Policy and X-Content-Type-Options. The CSP is DESIGN §8.4 plus WP0b's documented additions (`script-src blob:` etc.), with no `'unsafe-eval'`/`ws:` in production |
| `/dev/csp` in the browser pane (fresh tab) | PASS on all 5 checks (blob AudioWorklet running, blob Worker, fetch, 0 violations); empty console |
| `node bundle/cron.mjs light` | 404 from the missing route (WP2's #26), then a clean exit 1. The mechanics work |
| `npm run guard -- status` | works (`~/.baton/limits`, mode live, 0 used) |

### Static and supply-chain checks

- **Boundaries test:** passes.
- **`src/core/**`:** grep and the test both show no `node:*`/built-in imports, `process.*`, DOM globals, or
  `server-only`/`next`/`react`/`@/server` imports. The only bare import besides `zod` is the documented lazy
  `import("ws")`.
- **Secret scan:** I wrote a scratch script that reads `.env` and prints only key names and counts. It found none of
  the 6 secret values in `bundle/`, `src`, `scripts`, `tests`, `docs`, `drizzle`, `.github` or the root configs.
  `bundle/` has no `.env`; `.next/standalone/.env` exists but is gitignored and never deployed.
- **Licences** (`npx license-checker --summary`):
  - MIT 462, ISC 35, Apache-2.0 16, BSD-3 8, BSD-2 5, plus the exceptions WP0b listed.
  - One new exception: `@img/sharp-wasm32` (Apache/LGPL/MIT), an optional sharp dependency that `npm ci` now
    installs. It is excluded from the deploy bundle like the rest of sharp.
  - **The runtime bundle ships 24 packages, all MIT/ISC/Apache/BSD.** It has no sharp, libvips or lightningcss.
- **`npm audit`:** 4 moderate findings, all in drizzle-kit's dev-only `@esbuild-kit` → old `esbuild` dev-server
  advisory. We never run esbuild's serve mode. `npm audit --omit=dev` finds **0**.
- **Environment names:** all 43 DESIGN §3.4 names are in `.env.example` and in `src/server/env.ts`.

### Extra checks (the integrator's own, beyond the listed acceptance)

1. **Clean Linux build, the Zerops equivalent.**
   - Setup: `node:22-bookworm-slim` (already local), fed only the non-ignored files (`git ls-files -co
     --exclude-standard`, no `.env`).
   - Results: `npm ci` 33 s, typecheck ok, 237/237 tests, build ok, migrate twice (applied 1, then a no-op), health
     200 `db:true`, CSP present.
   - The Windows-made lockfile carries the linux-x64 gnu/musl binaries for next-swc, lightningcss, oxide, esbuild and
     rolldown.
2. **WP0a's open gap: core clients inside Next's own bundler.** I tested this in a throwaway container. A temporary
   client page and route imported `@/core/aai/{streaming,voice-agent}`, `@/core/audio`, `@/core/contracts`, the
   intents, `va-node`, `async` and the OpenAI client. None of these files touched the tree.
   - **Build:** clean.
   - **Client chunks:** no `ws` internals and no Node built-ins. The lazy `import("ws")` survives as a runtime
     import.
   - **In Chrome:** `globalThis.Buffer` is undefined. The base64 (btoa path), mu-law, resample, WAV, URL,
     `FrameBatcher` and `tokenUrl` checks, and the zod parse (138 schemas), all work. The factory without headers uses
     the global WebSocket. The factory with headers fails with the intended "browsers must use a temporary token"
     error.
   - **On the server:** the lazy `ws` import loads. `nodeWebSocketFactory` works, and `ws` is traced into
     `bundle/node_modules`.
   - **Conclusion:** the `turbopackIgnore` handling works, so WP0a's fallback (a variable specifier) is not needed.

## Fixes (root causes, not suppressions)

1. **Direct-open scanner loophole** (`tests/unit/boundaries.test.ts`, WP0b file; `tests/unit/core/audio/aai-streaming.test.ts`, WP0a file).
   - *Problem:* WP0a's fake-socket helper called `StreamingSession["connect"](…)` so that WP0b's regex, which matched
     only the dotted form, would not flag it. Anyone could copy that to open a real session past the limits
     authority.
   - *Fix, part 1:* the rules now also catch bracket calls, optional chaining, `.call/.apply/.bind`, `import { x as
     y }` aliases, value assignments (`const f = connectNode;`) and `mintToken` destructuring.
   - *Fix, part 2:* mocks and type positions are deliberately not flagged: `{ mintToken: vi.fn() }`,
     `vi.spyOn(StreamingSession, "connect")`, `vi.mocked(connectNode)`, `typeof StreamingSession.connect`. So
     Wave-1 tests can still stub these.
   - *Fix, part 3:* new explicit allow-list `FAKE_SOCKET_TESTS` (`tests/unit/core/audio/aai-*.test.ts`), plus a
     **guard test** that those files never reference `process.env`, `ASSEMBLYAI_API_KEY`,
     `requireEnv`/`loadEnv`, `nodeWebSocketFactory`, `connectNode`/`connectWithToken`/mint functions, `va-node`,
     `aai-open` or `scripts/lib/`. So they cannot open a billable session.
   - *Fix, part 4:* the helper is back to the plain `StreamingSession.connect(...)`. The detector self-test grew from
     8 to 26 cases.
2. **`connectWithToken` was missing from the ban.** `src/server/aai/va-node.ts` exports `connectWithToken(rest,
   mint, o)`, which calls `rest.mintToken()` and `connectNode()` inside a definer file, so it was a one-call
   mint-and-open that no rule covered. It is now banned like `connectNode(` (with self-test cases).
   DESIGN/TASKS §0.5 list only four names; the intent covers this helper.

## Rulings on open questions from the WPs

- **`docs/notes/requests/wp0b-to-wp2.md`:** accepted and forwarded to WP2. I verified every seam it claims:
  - the instrumentation marker;
  - `registerRemoteAuthorityFactory`;
  - each schema column, nullability and default in a real Postgres;
  - the pool settings.

  I added an "Integrator status" section with the two G1 actions:
  - wire `startInprocWorker()` with a dynamic import in `src/instrumentation.ts`;
  - add integrator-owned `scripts/lib/remote.ts` to register `RemoteLimitsAuthority`.
- **`tests/unit/platform/**`** (WP0b asked, since it is not in TASKS §3.0). Unlisted paths belong to the integrator.
  Ruling: it goes with the modules it tests (`scripts/lib/**`, `src/server/{env,log}.ts`). That is WP0b in Wave 0;
  after G0 it is the integrator, and WP12 once the deploy files move at D2 09:00. WP2 may add
  `tests/unit/platform/limits-*.test.ts` only by request. The planner may fold this into TASKS §3.0.
- **`tests/unit/core/audio/aai-*.test.ts` placement** (WP0a): accepted. It is inside WP0a's
  `tests/unit/core/audio/**`, and it is now the named fake-socket allow-list above. `tests/unit/core/aai/**` stays
  unassigned.
- **WP0a's kit import** (`fields-parity.test.ts` statically imports `tools/recording-kit/src/scenarios.ts`): kept.
  It type-checks cleanly today on Windows and Linux, and the static import is what gives the `FactField` ≡ `FieldId`
  type identity. **Risk:** a recording-kit edit that fails our strict tsconfig breaks `npm run typecheck` for
  everyone. If that happens, the integrator switches the test to a computed dynamic import (losing only the
  type-level check) rather than editing the kit.

## Known gaps / for later gates

- **T-D1-8 / T-D1-10 on Zerops are not done** (no deploy, by instruction). The Linux-container run is the closest
  local proxy. The first `zcli push` should still confirm `HOSTNAME=0.0.0.0` and the CSP probe on `*.zerops.app`.
- **The Zerops runtime base image is not pinned.** If it is Alpine, the musl binaries are in the lockfile, but only a
  Debian build was tried.
- **`chunkLevelDb` returns `-Infinity` for digital silence** (a spike behaviour). `JSON.stringify` turns that into
  `null`, so WP5b's HUD/telemetry should clamp it (e.g. to −120 dB) before sending events.
- **The seed browser-pane tab still holds an old console error.** It came from an earlier no-`blob:` CSP experiment
  on the same origin, not from the current build; a fresh tab is clean.
- **Wiring for G1:** in-proc worker, remote authority (see the request file). At G0 the user still needs to run
  `npm run secrets:init` (TASKS §9 step 5) and `npx playwright install` (WP12).

## Files touched by the integrator

- `tests/unit/boundaries.test.ts`: the scanner hardening, `connectWithToken`, the fake-socket allow-list and guard,
  and the larger self-test.
- `tests/unit/core/audio/aai-streaming.test.ts`: `openFake` uses the dotted `StreamingSession.connect`.
- `docs/notes/requests/wp0b-to-wp2.md`: integrator status appended.
- `docs/notes/integrate.md`: this file.
