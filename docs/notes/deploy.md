# Deploy notes: Zerops (T-D1-8, T-D1-10)

Status (2026-09-25 00:00 IST): **G0 is live on Zerops.** `/api/health` → `200 {"ok":true,"db":true}` on the public subdomain,
the production CSP is served, and the blob-URL AudioWorklet probe passes in headless Chromium. Migrations ran on the Zerops
Postgres. **App secrets are not set yet**: setting them from the CLI was blocked (see "Secrets"), so the user adds them
in the GUI. G0 has no route that needs them. No AssemblyAI, OpenAI, Polar or Twilio call was made ($0 live spend).

## What exists

| Item | Value |
|---|---|
| Public URL (`APP_URL`) | **https://app-2b25-3000.prg1.zerops.app** (region prg1, Prague) |
| Zerops org | `md-abid-hussain` (`sAo1iU4oQ7WMZuExHD5bPQ`) |
| Project | `baton`, id `KZNwFJZjSFAVRky0p94BQA`, core plan LIGHT (free) |
| Service `app` | id `vUDumVp2Sg25qXBRHKmyxA`, `nodejs@22` (Alpine, Node v22.22.3), 1 container min/max, shared CPU 1–2, RAM 1–2 GB, disk 2–6 GB, subdomain on |
| Service `db` | id `SBOY16iyTEatOhbsM8i1BA`, `postgresql:single@17` (non-HA, the cheapest mode), default resources |
| Deployed commit | `893e31e` (wp/deploy) = G0 main + the deploy fixes below. The later test-only commit `ef31f62` does not change the bundle |
| Other project in the org | `trueforge` (`KiTyAGTfQXGOXAgOaW8tFg`): **not touched** |

## Acceptance (WP0b §3 / DESIGN §10.1)

| Check | Result | Evidence |
|---|---|---|
| T-D1-8: `zcli push` deploys, `/api/health` green on `*.zerops.app` | **PASS** | `curl https://app-2b25-3000.prg1.zerops.app/api/health` → `200 {"ok":true,"db":true,"version":"0.1.0"}`, 5/5 |
| Server binds `0.0.0.0:3000` (DESIGN §10.1 Day-1 test) | **PASS** | Runtime log: `Network: http://0.0.0.0:3000`, `✓ Ready`. Reached through the Zerops L7 balancer |
| Migrations ran | **PASS** | First start: `{"component":"migrate","msg":"migrations applied","applied":1,"publicTables":17,"ms":297}`. Every later start: `schema up to date (no-op)`, 58–99 ms |
| T-D1-10: CSP header present | **PASS** | Production policy, 509 chars, with no `'unsafe-eval'` and no `ws:`. Also `Permissions-Policy: microphone=(self), camera=()`, `Referrer-Policy`, `X-Content-Type-Options`; no `X-Powered-By` |
| T-D1-10: blob-URL AudioWorklet loads with no violations (`/dev/csp`) | **PASS** | Playwright headless Chromium 153.0.8010.12: `data-ok=true`; worklet `sampleRate 48000 Hz, state running`; blob Worker `answer 42`; `fetch /api/health` 200; 0 violations; 0 console errors; page done in 6.4 s |
| Readiness and health checks | **PASS** | `deploy.readinessCheck` and `run.healthCheck` on `/api/health`. The deploy only turns ACTIVE once it passes |
| App secrets set on Zerops | **NOT DONE: needs the user** | The CLI write was denied by the permission system. GUI steps are below |

## Measured numbers

- **Push → live:** 122 s for a clean build and deploy (upload ≈3 s, `npm ci` 29–34 s, `next build` compile 13–20 s,
  bundle 1211 files / 17.9 MiB, compressed artefact 3.5 MiB, deploy and readiness ≈60 s). The run that included the
  APP_URL echo took 182 s.
- **Latency from this laptop (India) to prg1:** TCP connect ≈0.31 s (≈1 RTT). A cold HTTPS request to `/api/health`
  takes 0.94–0.99 s (TLS 0.63–0.65 s). A **warm keep-alive request takes 0.31–0.33 s**. So every remote limits-authority
  call from a laptop costs ≥1 RTT. Remote clients must keep the connection alive (undici `fetch` does by default).
- **Cold start of the container:** `server.js` is ready in <1 s after `migrate.mjs` (≈60–100 ms when the schema is
  current).
- **Costs:** zcli cannot read billing, so check the GUI → Billing for actuals. These are estimates from the list prices
  (research/16 §11.2):
  - `app` at its minimum (1 shared core, 1 GB, 2 GB disk): ≈$3.80 per 30 days;
  - `db` at its defaults: ≈$1–2 per 30 days;
  - **total ≈$5–6 per 30 days (≈$0.18/day)**, which is ≈$5 until JUDGING_END_DATE (2026-10-21). That fits inside the $15
    signup credit.
  - Build time: 5 builds of ≈2–3 min each ≈15 min, out of the LIGHT plan's 15 h/month.

## Fixes the first real pushes needed (all on `wp/deploy`; the integrator must merge them)

A local or same-container Docker build could not reveal any of these. `tests/unit/platform/deploy-config.test.ts` now
guards each one.

1. **`zerops.yml` readiness timings are Go durations.** `failureTimeout: 120` was rejected (`cannot unmarshal !!int
   into time.Duration`), so it is now `120s`. `retryPeriod` must be in `[10s, 1h]`, so `5` became `10s`.
2. **`HOSTNAME` is a reserved Zerops key** (`userDataUseOfSystemKey`), so it cannot be in `run.envVariables`. Next's
   standalone server binds to `$HOSTNAME`, which Zerops sets to the container hostname. The start command now overrides
   it for node only: `start: env HOSTNAME=0.0.0.0 node bundle/server.js` (`env` execs node, so signals still reach it).
3. **`.deployignore` directory patterns must be anchored.** zcli applies `.deployignore` twice: to the uploaded source,
   and to the `deployFiles` artefact. The unanchored `node_modules/` also matched `bundle/node_modules`, so the first
   artefact was 0.6 MiB and `server.js` failed with `Cannot find module 'next'`. Every directory pattern is now
   `/…`-anchored. `.env` / `.env.*` stay unanchored, so no env file ships at any depth.
4. **No `.next/cache` in `build.cache`.** On the second build, the restored cache left `.next/` unwritable for the build
   user: `EACCES: open '/build/source/.next/trace'`. Only `node_modules` is cached now. Note that `npm ci` deletes
   `node_modules` anyway, so that cache barely helps either.
5. **`scripts/assemble-bundle.mjs` now materializes symlinks.**
   - *Cause:* Turbopack loads `serverExternalPackages` (`pg`, later `ws`) through hashed aliases,
     `.next/node_modules/pg-587764f78a6c7a9c`, which are symlinks. On Linux, Node 22's `cpSync(…, {dereference:true})`
     dereferences only the top-level source. It copies nested links as **absolute** paths into the build container
     (`/build/source/.next/standalone/node_modules/pg`). I verified this in `node:22-bookworm-slim`, for both absolute
     and relative source links.
   - *Effect:* on Zerops, where build and runtime run in separate containers, every DB route failed with
     `ERR_MODULE_NOT_FOUND: Cannot find package 'pg-<hash>'`, and `/api/health` returned 503.
   - *Fix:* after the copy, every symlink in `bundle/` is replaced by a real copy of its target. The script then asserts
     that no symlink is left and that each `.next/node_modules/*` entry has a `package.json`. The build log prints
     `materialized .next/node_modules/pg-… (was a symlink to …)`.
   - *Why earlier checks missed it:* the WP0b/integrator checks (Windows, and a Docker run that built and served in the
     same container) resolved the dangling path by accident.
6. **The public URL is logged at boot.** `run.initCommands` echoes `APP_URL` (= `${zeropsSubdomain}`, a system variable
   of the app service), because zcli prints no URL anywhere. Read it with `zcli service log … | grep "public URL"`.

Also in `zerops.yml`: `APP_URL: ${zeropsSubdomain}` and `POLAR_SERVER: sandbox` in `run.envVariables`. The comments
list the secret names. `zerops-project-import.yml` changed only in its comments. `next.config.mjs` is unchanged.

## How to redeploy

- **From the main checkout** (a real `.git` directory), at a gate, with the tree committed:
  `zcli push -P KZNwFJZjSFAVRky0p94BQA -S vUDumVp2Sg25qXBRHKmyxA --setup app --workspace-state clean --version-name g1-<sha>`
  (`clean` = push HEAD exactly, ignoring uncommitted files).
- **From a git worktree** (`.wt/*`), plain `zcli push` fails with `exit status 128`. zcli v1.1.2 writes a temp index under
  `.git/`, which is a *file* in a worktree. Push a clean export instead:
  ```sh
  D="$TEMP/baton-push"; rm -rf "$D"; mkdir -p "$D"; git archive HEAD | tar -x -C "$D"
  zcli push -P KZNwFJZjSFAVRky0p94BQA -S vUDumVp2Sg25qXBRHKmyxA --setup app --no-git --working-dir "$D" --version-name g1-$(git rev-parse --short HEAD)
  rm -rf "$D"
  ```
  (`git archive` contains no `.env` and no `node_modules`.)
- **Logs:**
  - runtime: `zcli service log -P KZNwFJZjSFAVRky0p94BQA -S vUDumVp2Sg25qXBRHKmyxA --format SHORT --limit 200`;
  - build: add `--show-build-logs`;
  - live: add `--follow`.
- **Secret changes** need a service restart/reload in the GUI, not a rebuild. Changes to `zerops.yml` env need a push.

## Secrets (user action; blocks G1 features, not G0)

I generated a throw-away import YAML that took the 10 `envSecrets` values from `.env` without printing them. Running it
was **denied by the permission system ("Secret-Store Writes")**. The project was then imported without secrets; there
is nothing to clean up. zcli v1.1.2 has no command that sets env vars on an existing service. **The user sets them in
the GUI:**

1. app.zerops.io → project **baton** → service **app** → **Environment variables** → **Secret variables** → add, with the
   values from the main checkout's `.env` (this worktree's copy was checked to hold the same values, without printing them):
   - `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, `POLAR_ACCESS_TOKEN`;
   - `CASE_TOKEN_SECRET`, `VISITOR_SECRET`, `ADMIN_KEY`, `CRON_SECRET`, `AAI_WEBHOOK_SECRET`, `AGENT_TOOL_SECRET`;
   - `LIMITS_AUTHORITY_KEY` (it **must** equal the laptops' value).

   Not `TWILIO_*`: those belong to the recording kit only. `POLAR_WEBHOOK_SECRET` comes later (step 3).
2. Restart the `app` service. Then check it:
   - `curl -X POST -H "x-cron-secret: <CRON_SECRET>" https://app-2b25-3000.prg1.zerops.app/api/internal/cron?kind=light`
     should reach WP2's route once it is deployed (404 until then);
   - the hourly crontab logs `CRON_SECRET is not set` until this step is done.
3. Later (WP6/§10.2):
   - Polar sandbox webhook → `https://app-2b25-3000.prg1.zerops.app/api/webhooks/polar`, then set the
     `POLAR_WEBHOOK_SECRET` secret;
   - add `EMBED_ORIGINS=https://app-2b25-3000.prg1.zerops.app` and the Polar Embedding allowlist entry;
   - set `PAYMENTS_MODE=polar`, `POLAR_PRODUCT_ID`, `POLAR_DEMO_CUSTOMERS` and `POLAR_DEMO_CUSTOMER_EMAIL` as
     non-secret variables. Until then `PAYMENTS_MODE` defaults to `mock`.
4. GitHub repository variable `APP_URL=https://app-2b25-3000.prg1.zerops.app` turns on `.github/workflows/monitor.yml`
   (after the user pushes).
5. Recommended: set a daily spend limit in the Zerops GUI (it only sends email; DESIGN §10.1 step 1).

## Guidance for local agents: `APP_URL`, `LIMITS_AUTHORITY_URL`

- **Now (G0 → G1): change nothing.** Keep `LIMITS_AUTHORITY_URL` **unset**, so the laptop file guard
  (`~/.baton/limits`) stays the authority.
  - The deployed G0 has no `/api/internal/limits/*` routes yet (WP2).
  - `scripts/lib/limits.ts` **throws** when `LIMITS_AUTHORITY_URL` is set but no `RemoteLimitsAuthority` factory is
    registered, which is still the case at G0.
- **After G1**, once all three conditions hold:
  1. WP2's authority routes are deployed here;
  2. the user has set `LIMITS_AUTHORITY_KEY` on Zerops (step 1 above);
  3. the integrator has registered `RemoteLimitsAuthority` (`scripts/lib/remote.ts`).

  Then each laptop `.env` (the user's, and each worktree's; agents do not edit other worktrees' `.env`) gets:
  ```
  LIMITS_ROLE=remote
  LIMITS_AUTHORITY_URL=https://app-2b25-3000.prg1.zerops.app
  LIMITS_AUTHORITY_KEY=<unchanged: already identical to the value to put on Zerops>
  BATON_DEPLOY_ID=dev-<wp>
  ```
- **`APP_URL` on a laptop stays the local origin** (e.g. `http://localhost:3120` for `next dev` on port 3120), never the
  Zerops URL. `APP_URL` builds webhook and tool callback URLs for the process that runs.
  - AssemblyAI async webhooks and promoted-agent HTTP tools therefore cannot reach a laptop. Tests of those paths poll
    instead, or run against the deployed URL.
- Expect ≈0.3 s per warm authority call from India (≈1 s on a cold connection). Budget queue polling and heartbeats
  accordingly.

## What the integrator must wire

**At G1:**
1. **Merge `wp/deploy`:**
   - `zerops.yml`, `.deployignore` (a WP0b root config; the change was strictly needed), `scripts/assemble-bundle.mjs`,
     `zerops-project-import.yml` (comments only);
   - the new `tests/unit/platform/deploy-config.test.ts` (integrator-owned per the `tests/unit/platform/**` ruling).
2. Redeploy from main after the G1 merge with the command above, then check it:
   - `/api/health` returns 200;
   - the `/dev/csp` probe passes (script: headless Chromium, wait for `[data-testid=csp-probe][data-done=true]`, then
     `data-ok`);
   - the build log line `materialized .next/node_modules/…` appears. Once a route imports `ws`, expect a second line for
     `ws-<hash>`.
3. Wire `startInprocWorker()` in `src/instrumentation.ts` (`[WIRE-INPROC-WORKER]`): `ENABLE_INPROC_WORKER=1` is already
   set on Zerops.
4. Register `RemoteLimitsAuthority` for scripts. After the user has set the secrets and G1 is deployed, tell agents to
   switch their `.env` (section above).

**At G2:**
- If a WP adds a new `serverExternalPackages` entry, nothing else is needed: the materializer handles any symlink.
- Polar webhook and embed origins as described under "Secrets", step 3.
- Set `LEDGER_EPOCH` at the D6 freeze.

## Known gaps

- **App secrets are not set on Zerops** (user action; see above). G0 needs none of them.
- `/` returns 404 (no landing page until WP7b); `/status` and `/api/internal/*` do not exist yet (WP2/WP7b).
- The crontab runs `node bundle/cron.mjs light|full|purge`. It logs `CRON_SECRET is not set` until the secret exists,
  and gets 404 until WP2's cron route ships. Both are harmless.
- The subdomain goes through Zerops' shared balancer: 50 MB upload cap, HTTP/1.1 at the edge, and it adds its own
  `X-Content-Type-Options` (the header appears twice, which is harmless). A custom domain is optional (DESIGN §10.1
  step 5).
- **Not tested:** Safari and Firefox against `/dev/csp` on the deployed URL (WP12 browser matrix). Only Chromium 153 was
  checked here.
