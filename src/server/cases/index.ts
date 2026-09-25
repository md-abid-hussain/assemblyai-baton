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
import { buildPrefill } from "./prefill";
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
  engine: CaseEngine;
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
  const platform = o.platform ?? defaultPlatform();
  const data = o.data ?? getCaseDataSource();
  const defer = o.defer ?? ((fn) => void fn().catch((err) => depsLog.warn("deferred task failed", { err })));
  const repo = new PgCaseRepository({
    db,
    engine,
    policyOf: (id) => data.getPolicy(id),
    prefillPlan: async (i) => {
      const plan = await buildPrefill(data, { ...i, extractorVersion: engine.extractor.version });
      if (plan?.uncovered.length) depsLog.warn("prefill turns without cached events", { callId: i.callId, n: plan.uncovered.length });
      return plan;
    },
  });
  const client = openaiFactory();
  const extractor = o.extractor ?? new OpenAIExtractor({ client, engine });
  const verifier = o.verifier ?? new OpenAIVerifier({ client });
  const verifierRunner = new VerifierRunner({
    repo, engine, verifier,
    ledger: () => platform.ledger(),
    deployId: () => platform.deployId(),
    ...(o.now ? { now: o.now } : {}),
    enabled: o.verifierEnabled ?? (() => !!env().OPENAI_API_KEY),
  });
  const extract = new ExtractService({
    repo, engine, extractor, data, defer,
    maybeRunVerifier: (caseId) => verifierRunner.maybeRun(caseId),
    recordSpend: async ({ caseId, usd, action }) => {
      const ledger = platform.ledger();
      if (!ledger) return;
      const r = await ledger.reserve({ provider: "openai", action, refId: caseId, estUsd: usd, env: platform.deployId() });
      if (r.ok) await ledger.settle(r.id, usd);
    },
    ...(o.now ? { now: o.now } : {}),
  });
  if (engine.impl !== "wp1") depsLog.warn("case engine is the pre-G1 stub (bind WP1 in src/server/cases/defaults.ts)");
  return { db, engine, platform, data, repo, extractor, verifier, verifierRunner, extract, defer };
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
