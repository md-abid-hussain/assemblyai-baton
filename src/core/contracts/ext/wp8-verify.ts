/**
 * contracts/ext/wp8-verify.ts - additive WP8 types (TASKS §0.2): the F3 `verify_takeover` job state, the QA-engine
 * seam (a structural mirror of WP1's `QaInput` in `src/core/qa`), the `takeovers.metrics` keys WP8 reads and writes,
 * and the F6 audit report. Pure: zod and relative contract imports only.
 */
import { z } from "zod";

import type { CaseState, DisclosureKind, PolicyRecord } from "../case";
import type { HudMetric, QaResult } from "../events";
import type { ToolName } from "../tools";

// ============================================================================================ F3 job state

/** F3 steps (DESIGN §4.5): S1 await_artifacts → S2 submit → S3 await_transcript → S4 compute. */
export const VERIFY_STEPS = ["await_artifacts", "submit", "await_transcript", "compute"] as const;
export type VerifyStep = (typeof VERIFY_STEPS)[number];

/**
 * `jobs.state` of a `verify_takeover` job. `normalizeVerifyState()` (server) also accepts the bare shape WP2's F5
 * sweeper enqueues: `{ vaSessionId, from: "sweeper" }`, or null.
 */
export const VerifyStateSchema = z.object({
  v: z.literal(1),
  step: z.enum(VERIFY_STEPS),
  takeoverId: z.string(),
  /** AssemblyAI Voice Agent session id (`sess_…`); null until resolved from `takeovers.va_session_id`. */
  vaSessionId: z.string().nullable(),
  from: z.enum(["end", "sweeper"]),
  /** Polls in the current waiting step (S1 ≤ 30; S2 in-flight waits). */
  tries: z.number().int().nonnegative(),
  /** Consecutive failures of the current step (3 → failed). */
  failures: z.number().int().nonnegative(),
  /** Epoch ms when the current step started (S3's 60 s budget). */
  enteredAtMs: z.number(),
  startedAtMs: z.number(),
  /** `GET /v1/sessions/{id}.duration_seconds`. */
  durationSec: z.number().nullable(),
  vaSettled: z.boolean(),
  transcriptId: z.string().nullable(),
  /** `keyterms_prompt` went out with the live submit (false after the one retry without it). */
  keyterms: z.boolean(),
  keytermsDropped: z.boolean(),
  webhook: z.boolean(),
  asyncLedgerId: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Set on the terminal step. */
  reason: z.string().nullable(),
});
export type VerifyState = z.infer<typeof VerifyStateSchema>;

// ============================================================================================ QA seam (WP1)

/**
 * Structural mirror of WP1's `QaInput` (`src/core/qa/index.ts`, DESIGN §5.13). WP1's
 * `computeQa: (input: QaInput) => QaResult` is assignable to `ComputeQa`; the integrator wires it at G1.
 */
export interface Wp8QaWord { text: string; startMs: number; endMs: number }
export interface Wp8QaUtterance { text: string; startMs: number | null; endMs?: number | null; words?: Wp8QaWord[] }
export interface Wp8QaDisclosure { kind: DisclosureKind; text: string; criticalTokens: string[]; atMs: number | null }
export interface Wp8QaInput {
  provisional: boolean;
  snapshot: Pick<CaseState, "fields">;
  policy: PolicyRecord;
  ch2: Wp8QaUtterance[];
  ch1?: Wp8QaUtterance[];
  toolCalls: { name: ToolName; atMs: number | null }[];
  disclosures: Wp8QaDisclosure[];
  greeting: string;
  prependGreeting?: boolean;
  payment: QaResult["payment"];
  handedBack: boolean;
  aiSeconds: number;
  latency?: { clickToFirstAudibleMs?: number | null; deadAirAfterRepMs?: number | null; turnLatencyP50Ms?: number | null };
}
export type ComputeQa = (input: Wp8QaInput) => QaResult;

// ============================================================================================ takeovers.metrics

/**
 * The `takeovers.metrics` keys WP8 READS (written by WP5's events route and WP6's `get_disclosure` handler). All
 * optional and read leniently: a missing key only weakens the QA (null latency, disclosure search over the whole
 * agent channel).
 */
export const TakeoverMetricsReadSchema = z
  .object({
    /** WP5 (route #12 `hud`): the latest browser-measured HUD numbers (ms). */
    hud: z.partialRecord(z.enum(["click_to_first_audible", "dead_air_after_rep", "turn_audible_latency", "tool_turn_latency"]), z.number()).optional(),
    /** WP6 (`get_disclosure`, via WP1 `disclosureText`): what the agent was told to say, verbatim. */
    disclosures: z
      .partialRecord(z.enum(["premium_change", "esign_consent"]), z.object({ text: z.string(), criticalTokens: z.array(z.string()) }).loose())
      .optional(),
  })
  .loose();
export type TakeoverMetricsRead = z.infer<typeof TakeoverMetricsReadSchema>;
export type HudNumbers = Partial<Record<HudMetric, number>>;

/** The key WP8 WRITES into `takeovers.metrics` (a jsonb merge; other keys are never touched). */
export interface TakeoverMetricsVerification {
  verification: {
    status: "completed" | "failed";
    transcriptId: string | null;
    audioDurationSec: number | null;
    reAsked: number | null;
    disclosuresOk: boolean | null;
    reason: string | null;
    at: string;
  };
}

// ============================================================================================ F6 audit

export type VaAuditAnomalyKind = "unknown_session" | "running_but_closed" | "over_concurrency";
export interface VaAuditAnomaly { kind: VaAuditAnomalyKind; sessionId: string; detail: string }
export interface VaAuditReport {
  ok: boolean;
  skipped?: "not_live" | "not_production";
  scanned: number;
  pages: number;
  ours: number;
  running: number;
  anomalies: VaAuditAnomaly[];
  tripped: boolean;
  deleted: string[];
  settled: number;
  ms: number;
}
