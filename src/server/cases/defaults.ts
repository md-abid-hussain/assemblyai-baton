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

/**
 * Bound at G1 (docs/notes/requests/wp3-to-integrator.md §1):
 * - `defaultEngine()` → WP1's `src/core/case` functions (`impl: "wp1"`);
 * - `defaultPlatform()` → WP2's `src/server/auth` + `src/server/limits` (DB rate limiter, spend ledger).
 * WP3's stand-ins (`engine-stub.ts`, `platform-stub.ts`) stay for the WP3 unit tests that inject them.
 */
const wp1Engine: CaseEngine = {
  impl: "wp1",
  // WP14b·3: the optional trailing `spec` of each core function (WP14a·3 spec injection) is part of the port now, so
  // these are still the plain WP1 functions — `relayCaseEngine` is the only caller that passes a spec.
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
