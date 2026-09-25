/**
 * contracts/ext/wp18-audit.ts - WP18 additive types for the tightened F6 Voice Agent audit (PLATFORM §8.4, v2.1).
 *
 * v2.0's audit (WP8, `ext/wp8-verify.ts`) looked only at sessions carrying this deploy's marker. v2.1 flags ANY running
 * session on the account that it cannot match to a registered row, whatever its marker. The report widens WP8's
 * `VaAuditReport` (every WP8 field keeps its meaning; `VaAuditReportV21` is assignable to `VaAuditReport` except for
 * the widened anomaly kind). Pure: type-only imports.
 */
import type { VaAuditAnomalyKind, VaAuditReport } from "./wp8-verify";

/**
 * `unregistered_session`: a RUNNING session (any marker, or none) that matches no `live_sessions` row, no takeover,
 * no publication's active run and no open dev VA lease (count-matched), after the grace period.
 */
export type VaAuditAnomalyKindV21 = VaAuditAnomalyKind | "unregistered_session";

export interface VaAuditAnomalyV21 {
  kind: VaAuditAnomalyKindV21;
  sessionId: string;
  detail: string;
}

/** How a listed session was accounted for. */
export type VaAuditMatch = "registry" | "takeover" | "publication" | "dev_lease";

export interface VaAuditReportV21 extends Omit<VaAuditReport, "anomalies"> {
  anomalies: VaAuditAnomalyV21[];
  /** Running sessions on the whole account (all markers), after discounting ones whose row closed within the grace. */
  accountRunning: number;
  /** Running sessions per match route (a session counts once, first route wins in the order of `VaAuditMatch`). */
  matched: Record<VaAuditMatch, number>;
  /** Open dev VA leases available for count-matching (not already bound by provider session id). */
  devLeases: number;
  /** Running sessions younger than the grace that are not matched yet (not flagged this round). */
  inGrace: number;
}

/**
 * A publication's stored agent and its active run, if any (PLATFORM §8.3: `relay_publications.aai_agent_id`,
 * `active_run_id`, `active_until`). Stored-agent sessions show `agent_id` in `GET /v1/sessions`, so while the run is
 * active ONE running session with that agent id is accounted for; an ended session of a known publication agent is
 * never an anomaly (the run is over and was paid through its VA slot).
 */
export interface PublishedAgentRef {
  publicationId: string;
  agentId: string;
  activeRunId: string | null;
  activeUntilMs: number | null;
}
