import "server-only";

import type { SpendLedger, Verifier } from "../../core/contracts/services";
import { log } from "../log";
import type { CaseEngine } from "./engine";
import type { CaseEngineFor } from "./relay-engine";
import { plainTurn, type PgCaseRepository } from "./repository";

/**
 * F2 `maybeRunVerifier` (DESIGN §4.5): background sol runs, never awaited by takeover code.
 *
 * Runs only when ALL hold: the case is `shadowing`; ≥15 s since the last run started; ≥1 new final since the last
 * run; fewer than 8 runs; NO run in flight for the case (sol/low ≈ 25.9 s, so runs would otherwise overlap); the
 * OpenAI daily budget allows it (ledger reserve). Steps: verifyCase(all finals, policy) → store `verifier_runs` →
 * insert `kind:"verifier"` events for disagreements only → re-derive (the repository does 2-4 in one short tx).
 * A result that arrives after the freeze is stored with `applied:false` and never touches the state. The derivation
 * never adopts verifier events, so a run can only downgrade (§5.4.3).
 */

export const VERIFIER_MIN_INTERVAL_MS = 15_000;
export const VERIFIER_MAX_RUNS = 8;
/** Reservation per run before settling the actual (§7.1: ≈$0.016 per run). */
export const VERIFIER_EST_USD = 0.03;

export type VerifierSkip = "disabled" | "in_flight" | "not_shadowing" | "too_soon" | "no_new_turns" | "max_runs" | "budget" | "no_case";

export interface VerifierRunnerDeps {
  repo: PgCaseRepository;
  engine: CaseEngine;
  /** WP14b·3: the engine of a case's relay version, so sol's disagreements are applied under that relay's spec. */
  engineFor?: CaseEngineFor;
  verifier: Verifier;
  ledger?: () => SpendLedger | null;
  deployId?: () => string;
  now?: () => number;
  minIntervalMs?: number;
  maxRuns?: number;
  enabled?: () => boolean;
}

const vLog = log.child({ component: "verifier" });

export class VerifierRunner {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();
  /** Runs started (tests and notes). */
  started = 0;
  /** Max concurrent runs observed for one case (must stay ≤ 1). */
  maxConcurrentPerCase = 0;

  constructor(private readonly d: VerifierRunnerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The in-flight run of a case, if any (tests). */
  running(caseId: string): Promise<unknown> | null {
    return this.inFlight.get(caseId) ?? null;
  }

  async maybeRun(caseId: string): Promise<{ ran: true; applied: boolean; disagreements: number } | { ran: false; reason: VerifierSkip }> {
    if (this.d.enabled && !this.d.enabled()) return { ran: false, reason: "disabled" };
    if (this.inFlight.has(caseId)) return { ran: false, reason: "in_flight" };
    // Claim synchronously (before any await) so two callers in the same tick cannot both start.
    let release!: () => void;
    const claim = new Promise<void>((r) => (release = r));
    this.inFlight.set(caseId, claim);
    try {
      const gate = await this.gate(caseId);
      if (gate) return { ran: false, reason: gate };
      return await this.run(caseId);
    } finally {
      this.inFlight.delete(caseId);
      release();
    }
  }

  private async gate(caseId: string): Promise<VerifierSkip | null> {
    const { repo } = this.d;
    const row = await repo.loadRow(caseId);
    if (!row) return "no_case";
    if (row.status !== "shadowing") return "not_shadowing";
    const stats = await repo.verifierStats(caseId);
    if (stats.runs >= (this.d.maxRuns ?? VERIFIER_MAX_RUNS)) return "max_runs";
    const last = this.lastStart.get(caseId) ?? (stats.lastCreatedAt ? stats.lastCreatedAt.getTime() - (stats.lastMs ?? 0) : null);
    if (last !== null && this.now() - last < (this.d.minIntervalMs ?? VERIFIER_MIN_INTERVAL_MS)) return "too_soon";
    const maxRecv = await repo.maxRecvMs(caseId);
    if (maxRecv === null || (stats.lastUptoRecvMs !== null && maxRecv <= stats.lastUptoRecvMs)) return "no_new_turns";
    return null;
  }

  private async run(caseId: string): Promise<{ ran: true; applied: boolean; disagreements: number } | { ran: false; reason: VerifierSkip }> {
    const { repo, verifier } = this.d;
    const ledger = this.d.ledger?.() ?? null;
    let reservation: string | null = null;
    if (ledger) {
      const r = await ledger.reserve({ provider: "openai", action: "verifier", refId: caseId, estUsd: VERIFIER_EST_USD, env: this.d.deployId?.() ?? "dev-local" });
      if (!r.ok) return { ran: false, reason: "budget" };
      reservation = r.id;
    }
    this.lastStart.set(caseId, this.now());
    this.started++;
    this.maxConcurrentPerCase = Math.max(this.maxConcurrentPerCase, 1);
    let usd = 0;
    try {
      const row = await repo.loadRow(caseId);
      if (!row) return { ran: false, reason: "no_case" };
      const turns = (await repo.listTurns(caseId)).filter((t) => t.extractStatus !== "skipped").map(plainTurn);
      const engine = row.relayVersionId && this.d.engineFor ? await this.d.engineFor(row.relayVersionId) : this.d.engine;
      const res = await verifier.verifyCase({ caseId, policy: row.policy, callDate: row.policy.callDate, turns });
      usd = res.usd;
      const { ms, usd: _u, ...result } = res;
      void _u;
      const out = await repo.commitVerifierRun(
        caseId,
        { result, ms, usd },
        (state, seen) => engine.verifierDisagreementEvents(result, state, seen, { caseId, policy: row.policy, callDate: row.policy.callDate }),
        turns,
      );
      vLog.info("verifier run", { caseId, ms: Math.round(ms), applied: out.applied, disagreements: out.inserted.length, fields: result.fields.length });
      return { ran: true, applied: out.applied, disagreements: out.inserted.length };
    } catch (err) {
      vLog.warn("verifier run failed", { caseId, err });
      throw err;
    } finally {
      if (ledger && reservation) {
        await (usd > 0 ? ledger.settle(reservation, usd) : ledger.release(reservation)).catch((err) => vLog.warn("ledger settle failed", { err }));
      }
    }
  }
}
