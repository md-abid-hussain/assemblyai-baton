import "server-only";

import type { Extractor, Verifier } from "../../core/contracts/services";
import { BatonError } from "../../core/contracts/errors";
import { getCaseDataSource, type CaseDataSource } from "../data";
import { getDb, type Db } from "../db/client";
import { env } from "../env";
import { log } from "../log";
import { createOpenAI } from "../openai/client";
import { OpenAIExtractor } from "../openai/extractor";
import { OpenAIVerifier } from "../openai/verifier";
import { defaultEngine, defaultPlatform } from "./defaults";
import type { CaseEngine } from "./engine";
import { ExtractService } from "./extract-service";
import type { CasesPlatform } from "./platform";
import { buildPrefill, reextractPrefill } from "./prefill";
import { defaultEngineFor, type CaseEngineFor, type RelayEngineSource } from "./relay-engine";
import { PgCaseRepository } from "./repository";
import { VerifierRunner } from "./verifier-runner";

/**
 * WP3's service graph (one per process): repository, extractor (luna), verifier (sol) + F2 runner, F1 extract service.
 * Routes call `getCasesDeps()`. Tests and scripts inject parts with `setCasesDeps({...})` (anything left out is built
 * from the defaults). Other WPs use `getCaseRepository()` for the `CaseRepository` seam (WP5 `freezeSnapshot`,
 * WP6 `applyEvents` for tool updates, WP2 `setRunPlan`).
 */
export interface CasesDeps {
  db: Db;
  /** The base (flagship) engine. */
  engine: CaseEngine;
  /** WP14b·3: the engine of a case's relay version (`relay-engine.ts`); the base engine for a Baton case. */
  engineFor: CaseEngineFor;
  platform: CasesPlatform;
  data: CaseDataSource;
  repo: PgCaseRepository;
  extractor: Extractor;
  verifier: Verifier;
  verifierRunner: VerifierRunner;
  extract: ExtractService;
  /** Schedules work after the response (Next `after` in routes). */
  defer: (fn: () => Promise<unknown>) => void;
}

export type CasesDepsOverrides = Partial<Omit<CasesDeps, "repo" | "extract" | "verifierRunner">> & {
  /** The relay graph the default `engineFor` compiles through (tests inject a fake instead of `getRelaysDeps()`). */
  relays?: () => Promise<RelayEngineSource>;
  now?: () => number;
  verifierEnabled?: () => boolean;
};

const depsLog = log.child({ component: "cases" });

function openaiFactory() {
  return () => {
    const key = env().OPENAI_API_KEY;
    if (!key) throw new BatonError("E_INTERNAL", "OPENAI_API_KEY is not configured (value never printed)");
    return createOpenAI(key, { maxRetries: 0 });
  };
}

export function buildCasesDeps(o: CasesDepsOverrides = {}): CasesDeps {
  const db = o.db ?? getDb();
  const engine = o.engine ?? defaultEngine();
  // `src/server/relays/index.ts` imports this module's `getCaseRepository`, so the relay graph is reached through a
  // dynamic import (the same shape `relays/index.ts` uses for the sim store): nothing is touched until a case row
  // actually carries a `relay_version_id`.
  const engineFor = o.engineFor ?? defaultEngineFor(engine, o.relays ?? (async () => (await import("../relays")).getRelaysDeps()));
  const platform = o.platform ?? defaultPlatform();
  const data = o.data ?? getCaseDataSource();
  const defer = o.defer ?? ((fn) => void fn().catch((err) => depsLog.warn("deferred task failed", { err })));
  const repo = new PgCaseRepository({
    db,
    engine,
    engineFor,
    policyOf: (id) => data.getPolicy(id),
    prefillPlan: async (i) => {
      // WP14b·3: the pin is the RUN's extractor, not the flagship's, so a relay whose fields differ never receives
      // Baton's cached events (DESIGN §5.3 version pinning).
      const runEngine = i.relayVersionId ? await engineFor(i.relayVersionId) : engine;
      const plan = await buildPrefill(data, { ...i, extractorVersion: runEngine.extractor.version });
      if (!plan) return plan;
      // P§7.5: a relay whose extractor is not the cache's re-extracts the cached turns in ONE batched call, so a
      // preset that adds a field shows that field answered at the pass instead of blank. Baton never gets here (its
      // kernel-compiled extractor id equals EXTRACTOR_VERSION_V3), and neither does a cache-less on-demand sim.
      const done = plan.versionMismatch && i.relayVersionId
        ? await reextractPrefill({ extractor, engine: runEngine, recordSpend }, plan, { caseId: i.caseId, policy: i.policy, callDate: i.policy.callDate })
        : plan;
      if (done.uncovered.length) depsLog.warn("prefill turns without cached events", { callId: i.callId, n: done.uncovered.length });
      return done;
    },
  });
  const client = openaiFactory();
  const extractor = o.extractor ?? new OpenAIExtractor({ client, engine });
  const recordSpend = async ({ caseId, usd, action }: { caseId: string; usd: number; action: string }) => {
    const ledger = platform.ledger();
    if (!ledger) return;
    const r = await ledger.reserve({ provider: "openai", action, refId: caseId, estUsd: usd, env: platform.deployId() });
    if (r.ok) await ledger.settle(r.id, usd);
  };
  const verifier = o.verifier ?? new OpenAIVerifier({ client });
  const verifierRunner = new VerifierRunner({
    repo, engine, engineFor, verifier,
    ledger: () => platform.ledger(),
    deployId: () => platform.deployId(),
    ...(o.now ? { now: o.now } : {}),
    enabled: o.verifierEnabled ?? (() => !!env().OPENAI_API_KEY),
  });
  const extract = new ExtractService({
    repo, engine, engineFor, extractor, data, defer,
    maybeRunVerifier: (caseId) => verifierRunner.maybeRun(caseId),
    recordSpend,
    ...(o.now ? { now: o.now } : {}),
  });
  if (engine.impl !== "wp1") depsLog.warn("case engine is the pre-G1 stub (bind WP1 in src/server/cases/defaults.ts)");
  return { db, engine, engineFor, platform, data, repo, extractor, verifier, verifierRunner, extract, defer };
}

const g = globalThis as typeof globalThis & { __batonCases?: CasesDeps };

export function getCasesDeps(): CasesDeps {
  return (g.__batonCases ??= buildCasesDeps());
}

/** Replace the graph (tests/scripts); `null` resets to the defaults on next use. */
export function setCasesDeps(o: CasesDepsOverrides | null): CasesDeps | null {
  if (!o) {
    delete g.__batonCases;
    return null;
  }
  g.__batonCases = buildCasesDeps(o);
  return g.__batonCases;
}

/** The `CaseRepository` seam for other WPs. */
export const getCaseRepository = (): PgCaseRepository => getCasesDeps().repo;

export { CASE_RATES } from "./platform";
export type { CaseEngine } from "./engine";
export type { CasesPlatform } from "./platform";
