# WP2 → integrator (G1 wiring; answers `wp0b-to-wp2.md`)

Everything below is on `wp/wp2`. Each item is one small edit in a file WP2 does not own.

## 1. In-process worker (answers wp0b-to-wp2 item 1)

`src/server/jobs/runner.ts` exports `startInprocWorker(): void`. It is idempotent per **process** through a `globalThis`
flag (`__batonInprocWorker`), so the double instrumentation run is harmless, and it does nothing unless
`ENABLE_INPROC_WORKER=1`. In `src/instrumentation.ts`, replace the `[WIRE-INPROC-WORKER]` log line with:

```ts
const { startInprocWorker } = await import("./server/jobs/runner");
startInprocWorker();
```

It starts: the job tick every 2 s, the F5 sweeper every 15 s, the F8 budget guard every 60 s, and the F6 audit hook
every 3 min while `mode=live`. It also registers the `purge` step and the sweeper's fallback `verify_takeover` enqueue.
Expect a single `in-process worker started` log line per process.

## 2. `scripts/lib/remote.ts` (answers wp0b-to-wp2 item 2)

`RemoteLimitsAuthority` is in `src/server/limits/remote-authority.ts`. Suggested file (integrator-owned):

```ts
// scripts/lib/remote.ts: registers WP2's HTTP limits client for Node scripts (LIMITS_AUTHORITY_URL set).
import { RemoteLimitsAuthority } from "../../src/server/limits/remote-authority";
import { registerRemoteAuthorityFactory } from "./limits";
import { LocalOpenGuard } from "./local-open-guard";

registerRemoteAuthorityFactory(
  (url, key) => new RemoteLimitsAuthority(url, key, { fallback: new LocalOpenGuard({ sttOpensPerMin: 2, vaMax: 1 }) }),
);
```

Then `import "./remote"` at the top of `scripts/lib/limits.ts`, or in each script that may run remotely.

**Caveat:** `remote-authority.ts` starts with `import "server-only"`, as the boundaries test requires for all of
`src/server/**`. Scripts that load it must run with `tsx --conditions=react-server`, which every `npm run` script in
`package.json` already does. A bare `npx tsx scripts/day1/x.ts` throws the server-only error.

## 3. Streaming params from WP4 `[WIRE-STT-PARAMS]`

`src/server/limits/stt-params.ts` `sttParamsFor()` serves the DESIGN §5.1.5 golden defaults: U3.5 Pro, the call's
encoding and rate, `min_latency`, `inactivity_timeout 30`, `STT_PROMPT`, and `keytermsFromPolicy`. It has no Hinglish
params and no `TUNING_8K`. Once WP4's `src/core/aai/stt-params.ts` is merged, replace the body with
`return buildSttParams(call, policy, channel);`.

## 4. Call manifest lookup `[WIRE-CALLS]`

Routes #5 (the audio format) and #5a (duration, Express start, handoff line, recorded bundle) read the manifest through
`registerCallLookup()` in `src/server/runs/calls.ts`. A static import of `src/generated/calls.json` would break
`next build` while that file is missing. Once WP9's manifest exists, register it once at boot, e.g. from WP3's data
loader:
`registerCallLookup((id) => calls.find((c) => c.callId === id) ?? null)`.

Until then routes #5 and #5a fall back to a 5-minute µ-law 8 kHz call.

**Important:** a `golden16k` call without the lookup would get the wrong encoding.

## 5. WP8 job steps `[WIRE-WP8-STEPS]`

In `src/server/jobs/runner.ts` `installBuiltinSteps()`, add `await import("./verify-takeover")` and
`await import("./va-audit")` once WP8 ships them. That line is in a WP2 file; I will add it at G1 if you prefer. WP8
registers through:

- `getJobRunner().register("verify_takeover", step)`;
- `registerVaAuditHook(fn)`;
- `registerPurgeStep("va_sessions", fn)`;
- `registerStaleVaHandler((tko, vaSid) => enqueueVerification(tko, vaSid).then(() => {}))`.

## 6. Environment on Zerops (DESIGN §3.4)

Set on the `app` service:

- `LIMITS_ROLE=authority` and `LIMITS_AUTHORITY_KEY` (secret; the same value on every remote);
- `ENABLE_INPROC_WORKER=1`, `BATON_DEPLOY_ID=zp-prod`;
- `LEDGER_EPOCH` and `AAI_JUDGING_BUDGET_USD` at the D6 freeze.

Remotes (local dev, scripts, the mirror) set `LIMITS_ROLE=remote`, `LIMITS_AUTHORITY_URL=<APP_URL>` and the same key.

With neither the role nor the URL set, the server uses the laptop file guard, so a local `next dev` and the scripts
share the account-wide limits before the deploy.

## 7. Verification notes

- `npx next build` (Turbopack) panics in a worktree whose `node_modules` is a junction: "Symlink … points out of the
  filesystem root". `npx next build --webpack` builds cleanly and lists all 11 WP2 routes plus `Proxy (Middleware)`.
  Please confirm the Turbopack build on the real checkout at G1.
- The DB-backed unit tests (8 files) create and drop a throwaway database per file on the server of `DATABASE_URL`
  (or `TEST_DATABASE_URL`), so they need a role with `CREATEDB`. Without a URL they skip; `SKIP_DB_TESTS=1` forces
  the skip.
