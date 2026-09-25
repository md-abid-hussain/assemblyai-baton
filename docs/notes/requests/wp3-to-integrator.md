# WP3 → integrator: G1 wiring for cases and extraction

Everything below was checked before handing over. I built a scratch tree: wp/wp3 plus WP1's `src/core/case/**`,
`src/core/intents/add-driver.ts` and `src/core/compiler/spoken.ts`, plus WP2's `src/server/{auth,limits}/**`,
`src/server/flags.ts` and `src/server/aai/tokens.ts`. With the `defaults.ts` in step 1, that tree gave:

- `tsc --noEmit` clean;
- `vitest run tests/unit` 299/299;
- all WP3 tests green on WP1's engine (31/31);
- the route tests green on WP2's real auth and DB rate limiter;
- the live luna test at 9/10 and 10/10.

## 1. Bind WP1's engine and WP2's platform (replace one file)

Replace the whole of `src/server/cases/defaults.ts` with the code below. It is WP3's file, so the integrator or WP3
can apply it after the merge.

```ts
import "server-only";

import {
  ADD_DRIVER_PATCH_FORMAT, applyExtraction, buildExtractorInput, deriveCaseState, emptyCaseState, EXTRACT_MAX_NEW_TURNS,
  EXTRACT_RECENT_TURNS, EXTRACTOR_MODEL_ID, EXTRACTOR_PROMPT_V3, EXTRACTOR_REASONING_EFFORT, EXTRACTOR_VERSION_V3,
  verifierDisagreementEvents,
} from "../../core/case";
import { issueCaseToken, issueVisitorToken, requireCase, requireVisitor } from "../auth";
import { env } from "../env";
import { getLimitsAuthority, getRateLimiter } from "../limits";
import { log } from "../log";
import type { CaseEngine } from "./engine";
import type { CasesPlatform } from "./platform";

const wp1Engine: CaseEngine = {
  impl: "wp1",
  emptyCaseState, deriveCaseState, applyExtraction, verifierDisagreementEvents, buildExtractorInput,
  extractor: {
    prompt: EXTRACTOR_PROMPT_V3, format: ADD_DRIVER_PATCH_FORMAT, model: EXTRACTOR_MODEL_ID, effort: EXTRACTOR_REASONING_EFFORT,
    version: EXTRACTOR_VERSION_V3, maxNewTurns: EXTRACT_MAX_NEW_TURNS, recentTurns: EXTRACT_RECENT_TURNS,
  },
};

export function defaultEngine(): CaseEngine {
  return wp1Engine;
}

export function defaultPlatform(): CasesPlatform {
  return {
    requireVisitor: (req) => requireVisitor(req),
    requireCase: (req, want) => requireCase(req, { caseId: want.caseId }),
    issueCaseToken: (i) => issueCaseToken({ caseId: i.caseId, visitorId: i.visitorId }),
    issueVisitorToken: (visitorId) => issueVisitorToken(visitorId),
    rateLimiter: () => getRateLimiter(),
    ledger: () => {
      try { return getLimitsAuthority().ledger; } catch (err) { log.child({ component: "cases" }).warn("no spend ledger", { err }); return null; }
    },
    deployId: () => env().BATON_DEPLOY_ID,
  };
}
```

**Check after binding:** the server logs `case engine is the pre-G1 stub` until this step is done. The stub's
`extractorVersion` is `f03ba7a71306`, the same as WP1's `EXTRACTOR_VERSION_V3`, so the version pin and the cache
keys do not change at the merge.

## 2. Generated data and the call lookup (WP9's `src/generated/*.json`)

DESIGN §3.1 says generated files are imported, never read with fs. A static import of a file that does not exist
yet would break the build, so WP3 exposes a registration function instead.

Once WP9 has written `src/generated/calls.json` (`CallManifestEntry[]`) and `src/generated/scenarios.json` (an array
of `Scenario`, each with `id` and `policy`), add these lines to one module that the server loads at boot, e.g. a new
`src/server/data/generated.ts` (WP3 owns `src/server/data/**`, so WP3 can write it after G1):

```ts
import "server-only";
import calls from "../../generated/calls.json";
import scenarios from "../../generated/scenarios.json";
import { getCaseDataSource, registerGeneratedData } from "./index";
import { registerCallLookup } from "../runs/calls";          // WP2 [WIRE-CALLS]
registerGeneratedData({ calls: calls as unknown[], scenarios: scenarios as unknown[] });
registerCallLookup((id) => getCaseDataSource().getCall(id));
```

Import it once from `src/server/cases/index.ts` (WP3) and from `src/instrumentation.ts` (the integrator).

**Until then:**
- In dev, `FsCaseDataSource` falls back to reading `src/generated/*.json` with fs.
- For policies it falls back to the kit files `data/scenarios/sNN.json`, using the same mapping as WP1's fixtures.
- In the standalone bundle there is no `src/` and no `data/`. So route #3 can only create a case from a
  registered manifest, or with `mode:"live"` (scenario s01).

## 3. Ship the extraction cache in the bundle (`next.config.mjs`, WP0b/WP12)

The Express prefill and the cached events of a cached replay read
`data/cache/extract/<callId>/v3.pc_ctx.json` at run time (server-side fs, WP9 writes it). The `data/` folder is not
traced into `.next/standalone`, so please add:

```js
outputFileTracingIncludes: { "/api/cases": ["./data/cache/extract/**"], "/api/extract": ["./data/cache/extract/**"] },
```

- **Without it:** on Zerops, prefill inserts no events, and cached-replay turns fall back to luna. Both paths still
  work; they just cost more.
- **Nothing extra needed:** `public/data/cached-turns/*.json` is already copied (`public/`).

## 4. Nothing new in env, dependencies or migrations

- **No new env names and no new npm packages.** WP3 uses `OPENAI_API_KEY`, `BATON_DEPLOY_ID`, `DATABASE_URL`, and,
  via WP2, `CASE_TOKEN_SECRET` and `VISITOR_SECRET`.
- **No migration.** WP3 uses the G0 schema as is. It stores the freeze under `takeovers.protocol.freeze` (a jsonb
  merge) and the late verifier flag in `verifier_runs.result.applied`.

## 5. `next build` does not run inside a worktree

Turbopack panics with "Symlink [project]/node_modules is invalid, it points out of the filesystem root". The cause
is the worktree's `node_modules` junction, not the code. Please run `npm run build` on the merged main.

In the worktree, the route handlers are covered by `tests/unit/server/cases/routes.test.ts`, which imports the
`src/app/api/**/route.ts` modules and calls them.

## 6. Cut-list switch: the live sol verifier

TASKS §6 lists "the verifier (sol) in the live path" as the second item to cut.

- **To cut it:** in `buildCasesDeps` (`src/server/cases/index.ts`), make `verifierEnabled` default to `() => false`.
  That is a one-line change.
- **What stays:** stored verifier results and the cached ablation are unaffected.

---

## Integrator status (G1, 2026-09-25)

- §1 `defaults.ts` bound to WP1 + WP2 (your snippet verbatim); §3 `outputFileTracingIncludes` added.
- §2 open until WP9's `src/generated/*.json` exist (then WP3 writes `src/server/data/generated.ts`, the integrator imports it at boot); §5 build confirmed on `main`; §6 noted.
Details: `docs/notes/g1.md` ("Integrator requests: disposition").
