import "server-only";

import { buildFirstUpdate, compileTakeover, validateFirstUpdate } from "../../core/compiler";
import { issueCaseToken, requireCase } from "../auth";
import { getCaseRepository } from "../cases";
import { getDb } from "../db";
import { relayTakeoverCompile } from "../engine/takeover-compile";
import { enqueueVerification } from "../jobs/verify-takeover";
import { getLimitsAuthority, getRateLimiter, vaSessionIdFor } from "../limits";
import { getRelaysDeps } from "../relays";
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
 *  WP14b relayTakeoverCompile                                      (src/server/engine/takeover-compile)
 *
 * v2: `relayCompile` is the compile port. A case that names a relay version compiles through the engine factory; a
 * Baton case, and any server with no kernel bound, still compiles through WP1 — so binding it changes nothing until
 * WP14a's kernel lands. `getRelaysDeps()` is read per call, never at import time (it opens the DB pool).
 *
 * Nothing is built at import time: the factory runs on the first request (env and DB are read then).
 */
export function defaultTakeoverRouteDeps(): TakeoverRouteDeps {
  return buildTakeoverRouteDeps({
    relayCompile: relayTakeoverCompile(() => getRelaysDeps()),
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
