/**
 * contracts/events.ts - the UI event log (D12) and QA result (DESIGN §4.1). Every event has
 * t = ms since page session start. Replay bundles are `BatonEvent[]`. Frozen at G0.
 */
import { z } from "zod";
import {
  CaseStateSchema, ChannelSchema, DisclosureKindSchema, FactEventSchema, FieldIdSchema, PaymentStatusSchema, StageSchema,
} from "./case";
import { ErrorCodeSchema, FallbackKindSchema } from "./errors";
import { RunPlanSchema } from "./run";
import { ToolNameSchema } from "./tools";
import { TurnInputSchema } from "./turns";

export { FALLBACK_KINDS, FallbackKindSchema, type FallbackKind } from "./errors";

export const REPLY_KINDS = ["speech", "tool_preamble", "unspoken_text", "silent_no_output"] as const;
export const ReplyKindSchema = z.enum(REPLY_KINDS);
export type ReplyKind = z.infer<typeof ReplyKindSchema>;

export const TAKEOVER_PHASES = [
  "idle", "armed", "sealing", "draining", "compiling", "connecting", "greeting",
  "active", "paying", "closing", "done", "retrying", "fallback", "failed",
] as const;
export const TakeoverPhaseSchema = z.enum(TAKEOVER_PHASES);
export type TakeoverPhase = z.infer<typeof TakeoverPhaseSchema>;

export const HUD_METRICS = ["click_to_first_audible", "dead_air_after_rep", "turn_audible_latency", "tool_turn_latency"] as const;
export const HudMetricSchema = z.enum(HUD_METRICS);
export type HudMetric = z.infer<typeof HudMetricSchema>;

export const QA_CLASSIFICATIONS = ["reask", "new", "pending_confirm", "verified_reconfirm", "advice", "other"] as const;

export const QaResultSchema = z.object({
  provisional: z.boolean(),
  reAsked: z.number().int().nonnegative(),
  newlyAsked: z.number().int().nonnegative(),
  pendingConfirmed: z.number().int().nonnegative(),
  verifiedReconfirmed: z.number().int().nonnegative(),
  disclosures: z.array(
    z.object({ kind: DisclosureKindSchema, similarity: z.number(), ok: z.boolean(), missingCritical: z.array(z.string()) }),
  ),
  clickToFirstAudibleMs: z.number().nullable(),
  deadAirAfterRepMs: z.number().nullable(),
  turnLatencyP50Ms: z.number().nullable(),
  payment: z.enum(["verified_webhook", "verified_poll", "simulated", "unpaid"]),
  handedBack: z.boolean(),
  aiSeconds: z.number(),
  /** Agent sentences matching the advice lexicon outside disclosures (target 0). */
  adviceFlags: z.number().int().nonnegative(),
  details: z.array(
    z.object({ sentence: z.string(), atMs: z.number(), field: FieldIdSchema.nullable(), classification: z.enum(QA_CLASSIFICATIONS) }),
  ),
});
export type QaResult = z.infer<typeof QaResultSchema>;

const t = z.number();

export const BatonEventSchema = z.discriminatedUnion("type", [
  z.object({ t, type: z.literal("call.loaded"), callId: z.string(), durationMs: z.number() }),
  z.object({ t, type: z.literal("run.plan"), plan: RunPlanSchema }),
  z.object({ t, type: z.literal("paused"), reason: z.enum(["ios_background", "audio_interrupted"]), resumed: z.boolean() }),
  /** MockPhone state (S6), for replays and the narrator strip. */
  z.object({ t, type: z.literal("phone.state"), state: z.string() }),
  z.object({ t, type: z.literal("mode"), mode: z.enum(["live", "cached_replay", "recorded_ai"]), reason: z.string().optional() }),
  z.object({
    t,
    type: z.literal("stt.status"),
    channel: ChannelSchema,
    status: z.enum(["queued", "connecting", "open", "reconnecting", "terminated", "error"]),
    detail: z.string().optional(),
  }),
  z.object({ t, type: z.literal("stt.partial"), channel: ChannelSchema, turnOrder: z.number().int(), text: z.string() }),
  z.object({ t, type: z.literal("stt.final"), turn: TurnInputSchema }),
  z.object({ t, type: z.literal("case.state"), state: CaseStateSchema }),
  z.object({ t, type: z.literal("case.facts"), events: z.array(FactEventSchema) }),
  z.object({ t, type: z.literal("verifier"), agrees: z.boolean(), disagreements: z.array(FieldIdSchema) }),
  z.object({
    t,
    type: z.literal("takeover.phase"),
    phase: TakeoverPhaseSchema,
    atMs: z.number(),
    detail: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  }),
  z.object({
    t,
    type: z.literal("va.status"),
    status: z.enum(["connecting", "ready", "ended", "error"]),
    sessionId: z.string().optional(),
    code: z.string().optional(),
  }),
  z.object({
    t,
    type: z.literal("va.reply"),
    replyId: z.string(),
    phase: z.enum(["started", "first_audible", "done"]),
    kind: ReplyKindSchema.optional(),
    interrupted: z.boolean().optional(),
  }),
  z.object({ t, type: z.literal("va.caption"), replyId: z.string(), words: z.array(z.object({ text: z.string(), atMs: z.number() })) }),
  z.object({ t, type: z.literal("va.user"), text: z.string(), final: z.boolean() }),
  /**
   * Only the six ToolNames (G0). A name the model invents is answered with is_error by ToolDispatcher and logged as
   * `{type:"error", code:"E_VA_CONFIG", message:"unknown tool <name>"}` instead, so recorded bundles always parse.
   */
  z.object({
    t,
    type: z.literal("va.tool"),
    callId: z.string(),
    name: ToolNameSchema,
    phase: z.enum(["call", "result"]),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
  }),
  z.object({ t, type: z.literal("stage"), stage: StageSchema }),
  z.object({ t, type: z.literal("payment"), status: PaymentStatusSchema, source: z.enum(["webhook", "server_poll", "mock"]).optional() }),
  z.object({ t, type: z.literal("phone.sms"), text: z.string(), link: z.string().optional() }),
  z.object({ t, type: z.literal("qa"), qa: QaResultSchema }),
  z.object({ t, type: z.literal("hud"), metric: HudMetricSchema, ms: z.number() }),
  z.object({ t, type: z.literal("fallback"), kind: FallbackKindSchema, label: z.string() }),
  z.object({ t, type: z.literal("error"), code: ErrorCodeSchema, message: z.string() }),
]);
export type BatonEvent = z.infer<typeof BatonEventSchema>;
export type BatonEventType = BatonEvent["type"];
/** The event variant for one `type`, e.g. `BatonEventOf<"stt.final">`. */
export type BatonEventOf<K extends BatonEventType> = Extract<BatonEvent, { type: K }>;

export const BATON_EVENT_TYPES = BatonEventSchema.options.map((o) => o.shape.type.value) as BatonEventType[];
