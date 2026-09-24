/**
 * contracts/takeover.ts - drain report, compiled takeover, input mode (DESIGN §4.1) and the shared protocol
 * timing constants of §5.5.2 (used by WP5's machine and WP9b's sweep, so they cannot drift). Frozen at G0.
 */
import { z } from "zod";
import { CaseStateSchema, FieldIdSchema, StageSchema } from "./case";
import { VaFunctionToolSchema } from "./tools";

export const DrainReportSchema = z.object({
  tArmMs: z.number(),
  tCutMs: z.number(),
  capHit: z.boolean(),
  midUtterance: z.boolean(),
  completedTurnIds: z.array(z.string()),
  pendingTurnIds: z.array(z.string()),
  cutTurnIds: z.array(z.string()),
  waitedMs: z.number(),
  /** ms since arm. */
  timings: z.partialRecord(z.enum(["armed", "sealed", "finals", "drained"]), z.number()),
});
export type DrainReport = z.infer<typeof DrainReportSchema>;

export const TRANSCRIPTION_MODES = ["min_latency", "balanced", "max_accuracy"] as const;
export const TranscriptionModeSchema = z.enum(TRANSCRIPTION_MODES);
export type TranscriptionMode = z.infer<typeof TranscriptionModeSchema>;

export const CompiledTakeoverSchema = z.object({
  greeting: z.string(),
  systemPrompt: z.string(),
  /** [] unless VA_KEYTERMS=1. */
  keyterms: z.array(z.string()),
  tools: z.array(VaFunctionToolSchema),
  stage: StageSchema,
  snapshot: CaseStateSchema,
  voice: z.string(),
  /** Chosen per next step (§5.9.1). */
  transcriptionMode: TranscriptionModeSchema,
  /** Dynamic cap from the snapshot (§5.9.5). */
  vaSessionCapMs: z.number(),
  promptVersion: z.string(),
  /** Embedded in systemPrompt (F6). */
  deployMarker: z.string(),
  compiledBy: z.enum(["server", "client"]),
});
export type CompiledTakeover = z.infer<typeof CompiledTakeoverSchema>;

export const InputModePlanSchema = z.object({
  mode: TranscriptionModeSchema,
  reason: z.enum(["asks_entity", "yes_no", "disclosure", "id_capture"]),
});
export type InputModePlan = z.infer<typeof InputModePlanSchema>;

/** The next step the greeting / agent is about to take (argument of `inputModeFor`). */
export const NextStepSchema = z.object({
  kind: z.enum(["confirm", "ask", "disclosure", "consent", "none"]),
  field: FieldIdSchema.nullable(),
});
export type NextStep = z.infer<typeof NextStepSchema>;

export const TAKEOVER_SOURCES = ["manual", "auto_handoff"] as const;
export type TakeoverSource = (typeof TAKEOVER_SOURCES)[number];

export const TAKEOVER_OUTCOMES = ["completed", "handed_back", "abandoned", "failed"] as const;
export const TakeoverOutcomeSchema = z.enum(TAKEOVER_OUTCOMES);
export type TakeoverOutcome = z.infer<typeof TakeoverOutcomeSchema>;

/** DESIGN §5.5.2 constants (ms). LEAD_MS comes from ArmResponse.leadMs; vaSessionCapMs from CompiledTakeover. */
export const TAKEOVER_TIMING = {
  ARM_TURN_END_MAX_MS: 1500,
  /** Both channels < QUIET_DBFS for this long. */
  QUIET_REQUIRED_MS: 400,
  QUIET_DBFS: -45,
  SEAL_TAIL_MS: 250,
  FINALS_WAIT_MAX_MS: 900,
  DRAIN_MAX_MS: 2000,
  COMPILE_TIMEOUT_MS: 1500,
  VA_TOKEN_TIMEOUT_MS: 3000,
  VA_WS_OPEN_TIMEOUT_MS: 3000,
  SESSION_READY_TIMEOUT_MS: 3000,
  /** Measured from session.ready. */
  FIRST_AUDIBLE_TIMEOUT_MS: 5000,
  CLOSE_GRACE_MS: 2500,
  DEFAULT_LEAD_MS: 900,
  LEAD_MS_MIN: 500,
  LEAD_MS_MAX: 1500,
  /** Gap between the rep's handoff line and the customer's acceptance in a manual-pass clip (§5.5.4 rule 6). */
  HANDOFF_CLIP_GAP_MS: 300,
  /** While a VA session is open (§4.4 #12); the registry marks a slot stale after VA_STALE_MS without one. */
  VA_HEARTBEAT_MS: 10_000,
  VA_STALE_MS: 30_000,
  /** Sweep (§6.5 step 3): a force-endpointed final is available at tCut + this (SEAL_TAIL_MS + ≈270 ms, 10b ST-8). */
  FORCE_ENDPOINT_FINAL_MS: 520,
  /** Takeovers allowed per case (§1.3 step 9). */
  MAX_TAKEOVERS_PER_CASE: 3,

  // ---- G0: hold protocol (§5.8) and session cap (§5.9.5), shared by WP5b's controller, WP6's MockPhone/autopilot
  // ---- countdown and WP11's autopilot, so they cannot drift apart.
  /** Hold deadline measured from the SMS while the phone is still `sms-received`. */
  HOLD_DEADLINE_MS: 60_000,
  /** While the phone is in esign, signed, checkout-loading, checkout-open, processing or simulating, the deadline extends in these steps… */
  HOLD_EXTEND_STEP_MS: 30_000,
  /** …up to this total hold time (also the "+180 s of hold" of the absolute session ceiling). */
  HOLD_MAX_MS: 180_000,
  /** First reassurance at +45 s, then every 45 s (suppressed while the Polar overlay is open or processing). */
  REASSURE_EVERY_MS: 45_000,
  /** Autopilot: phone untouched this long after the SMS → visible countdown… */
  AUTOPILOT_IDLE_MS: 15_000,
  /** …of this length, then POST /simulate. */
  AUTOPILOT_COUNTDOWN_MS: 10_000,
  /** The hold handler polls GET /api/payments/[id] this often. */
  PAYMENT_POLL_MS: 1_500,
  /** Wrap-up reply.create at (effective cap − this), never in paying/closing. */
  WRAP_UP_WARNING_MS: 20_000,
  /** hand_back_to_rep: let the agent finish its one-sentence reply for at most this long after reply.done. */
  HAND_BACK_REPLY_GRACE_MS: 4_000,
  /** CLOSING: wait this long for session.ended after session.end. */
  SESSION_ENDED_WAIT_MS: 2_000,
  /** §5.5.4 rule 2: a DrainReport.pending turn arriving within this window after compile is stored (never alters the snapshot). */
  LATE_PENDING_WINDOW_MS: 3_000,
} as const;

/**
 * The absolute Voice Agent ceiling (§5.9.5): VA_SESSION_CAP_MAX_MS + HOLD_MAX_MS (420 s + 180 s = 600 s by default).
 * Ends the session in any stage. It is also the `capMs` passed to `LimitsAuthority.vaAcquire` (G0), because the VA
 * token is minted at ARMED, before compile knows the dynamic `vaSessionCapMs`, and F5 marks a row stale only after
 * `cap_ms + 60 s`: storing the dynamic cap there would free the slot of a legitimate long hold while it still runs.
 */
export const vaAbsoluteCeilingMs = (vaSessionCapMaxMs: number): number => vaSessionCapMaxMs + TAKEOVER_TIMING.HOLD_MAX_MS;
