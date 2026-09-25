import "server-only";

import { BatonError } from "../../core/contracts/errors";
import type { CaseRepository, EnqueueVerification, LimitsAuthority, RateLimiter, ValidateFirstUpdate } from "../../core/contracts/services";
import type { Db } from "../db/client";
import { env } from "../env";
import { log } from "../log";
import type { TakeoverAuth, TakeoverRouteDeps } from "./routes";
import { TakeoverServiceImpl, type BuildFirstUpdateFn, type CompileTakeoverFn, type RelayCompileFn, type TakeoverCompileConfig } from "./service";
import { DrizzleTakeoverStore } from "./store";

/**
 * Dependency wiring of the takeover routes. Round 1 (before G1) builds against the frozen contracts only; the
 * collaborators live in other packages:
 *
 *   WP1  compileTakeover, buildFirstUpdate, validateFirstUpdate   (src/core/compiler)
 *   WP2  requireCase, issueCaseToken                               (src/server/auth)
 *        getLimitsAuthority, getRateLimiter, vaSessionIdFor        (src/server/limits)
 *   WP3  CaseRepository.freezeSnapshot                             (src/server/cases)
 *   WP8  enqueueVerification                                       (src/server/jobs/verify-takeover.ts; stub → null)
 *
 * The production graph is `default-deps.ts`: the route files import it, and on import it installs a factory that builds
 * the deps lazily on the first request (so env and DB are read at request time, not at build time). Tests import this
 * module only and inject fakes with `setTakeoverRouteDeps`. With neither, every takeover route answers 500 E_INTERNAL
 * "not wired", never a crash.
 */

const takeoverLog = log.child({ component: "takeovers" });
const logFn = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => takeoverLog[level](msg, data);

export interface TakeoverWiringParts {
  getDb: () => Db;
  requireCase: (req: Request, want: { caseId?: string; takeoverId?: string }) => Promise<TakeoverAuth>;
  issueCaseToken: (i: { caseId: string; visitorId: string; takeoverId: string }) => Promise<string>;
  getLimitsAuthority: () => Pick<LimitsAuthority, "heartbeat" | "release">;
  getRateLimiter: (() => RateLimiter) | null;
  vaSessionIdFor: (takeoverId: string, attempt: 0 | 1) => string;
  caseRepository: () => Pick<CaseRepository, "freezeSnapshot">;
  compileTakeover: CompileTakeoverFn;
  /** WP14b's compile port; omitted → every pass compiles through WP1 (the Baton path). */
  relayCompile?: RelayCompileFn;
  buildFirstUpdate: BuildFirstUpdateFn;
  validateFirstUpdate: ValidateFirstUpdate;
  /** WP8; omitted → no verification job (null). */
  enqueueVerification?: EnqueueVerification;
  /** Overrides for tests; default from env(). */
  config?: TakeoverCompileConfig;
}

/** The compile configuration from the environment (DESIGN §3.4). */
export function takeoverConfigFromEnv(): TakeoverCompileConfig {
  const e = env();
  return {
    deployId: e.BATON_DEPLOY_ID,
    voice: e.VA_VOICE,
    keytermsEnabled: e.VA_KEYTERMS,
    payToolMode: e.PAY_TOOL_MODE,
    capEnv: { baseMs: e.VA_SESSION_CAP_BASE_MS, perFieldMs: e.VA_SESSION_CAP_PER_FIELD_MS, maxMs: e.VA_SESSION_CAP_MAX_MS },
  };
}

export const noVerification: EnqueueVerification = async () => null;

export function buildTakeoverRouteDeps(p: TakeoverWiringParts): TakeoverRouteDeps {
  const store = new DrizzleTakeoverStore(p.getDb);
  const service = new TakeoverServiceImpl({
    store,
    cases: { freezeSnapshot: (caseId, takeoverId, drain) => p.caseRepository().freezeSnapshot(caseId, takeoverId, drain) },
    compileTakeover: p.compileTakeover,
    ...(p.relayCompile ? { relayCompile: p.relayCompile } : {}),
    buildFirstUpdate: p.buildFirstUpdate,
    validateFirstUpdate: p.validateFirstUpdate,
    issueTakeoverToken: p.issueCaseToken,
    limits: { heartbeat: (id) => p.getLimitsAuthority().heartbeat(id), release: (id, reason) => p.getLimitsAuthority().release(id, reason) },
    liveSessionIdFor: p.vaSessionIdFor,
    enqueueVerification: p.enqueueVerification ?? noVerification,
    config: p.config ?? takeoverConfigFromEnv(),
    log: logFn,
  });
  return {
    service,
    requireCase: p.requireCase,
    rateLimiter: p.getRateLimiter ? p.getRateLimiter() : null,
    log: logFn,
  };
}

const notWired = (): never => {
  throw new BatonError("E_INTERNAL", "The takeover routes are not wired yet (G1: setTakeoverRouteDeps).");
};

function unwiredDeps(): TakeoverRouteDeps {
  return {
    service: { arm: notWired, compile: notWired, recordEvents: notWired, end: notWired },
    requireCase: async () => notWired(),
    rateLimiter: null,
    log: logFn,
  };
}

type Holder = { deps: TakeoverRouteDeps | null; factory?: (() => TakeoverRouteDeps) | null };
// Survive `next dev` hot reloads.
const g = globalThis as typeof globalThis & { __batonTakeoverDeps?: Holder };
const holder: Holder = (g.__batonTakeoverDeps ??= { deps: null, factory: null });

/** Install the route dependencies (a test, or an explicit override). `null` resets to the default factory, if any. */
export function setTakeoverRouteDeps(d: TakeoverRouteDeps | null): void {
  holder.deps = d;
}

/**
 * Install the lazy production factory (`default-deps.ts` does this on import). It runs on the first request that finds
 * no deps; if it throws (a missing env var), the request answers E_INTERNAL and the next request tries again.
 */
export function setDefaultTakeoverRouteDeps(factory: (() => TakeoverRouteDeps) | null): void {
  holder.factory = factory;
}

export function takeoverRouteDeps(): TakeoverRouteDeps {
  if (holder.deps) return holder.deps;
  if (holder.factory) return (holder.deps = holder.factory());
  return unwiredDeps();
}
