import "server-only";

import { buildFirstUpdate, compileTakeover, validateFirstUpdate } from "../../core/compiler";
import { issueCaseToken, requireCase } from "../auth";
import { getCaseRepository } from "../cases";
import { getDb } from "../db";
import { enqueueVerification } from "../jobs/verify-takeover";
import { getLimitsAuthority, getRateLimiter, vaSessionIdFor } from "../limits";
import type { TakeoverRouteDeps } from "./routes";
import { buildTakeoverRouteDeps, setDefaultTakeoverRouteDeps, takeoverRouteDeps } from "./wiring";

/**
 * The production dependency graph of the takeover routes (#9, #11–#13): the composition root, and the only WP5 module
 * that names the collaborators' implementations. Everything WP5 does with them goes through the contract seams, so a
 * compiler driven by a relay blueprint plugs in here without touching the service, the machine or the controller.
 *
 *   WP1  compileTakeover, buildFirstUpdate, validateFirstUpdate   (src/core/compiler)
 *   WP2  requireCase, issueCaseToken                               (src/server/auth)
 *        getLimitsAuthority, getRateLimiter, vaSessionIdFor        (src/server/limits)
 *   WP3  CaseRepository.freezeSnapshot                             (src/server/cases)
 *   WP8  enqueueVerification                                       (src/server/jobs/verify-takeover)
 *
 * Nothing is built at import time: the factory runs on the first request (env and DB are read then).
 */
export function defaultTakeoverRouteDeps(): TakeoverRouteDeps {
  return buildTakeoverRouteDeps({
    getDb,
    requireCase: (req, want) => requireCase(req, { ...want, scope: "case" }),
    issueCaseToken: (i) => issueCaseToken(i),
    getLimitsAuthority,
    getRateLimiter,
    vaSessionIdFor,
    caseRepository: getCaseRepository,
    compileTakeover,
    buildFirstUpdate,
    validateFirstUpdate,
    enqueueVerification,
  });
}

setDefaultTakeoverRouteDeps(defaultTakeoverRouteDeps);

export { takeoverRouteDeps };
