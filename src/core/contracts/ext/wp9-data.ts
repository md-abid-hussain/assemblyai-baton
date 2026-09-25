/**
 * contracts/ext/wp9-data.ts - additive WP9 data shapes (TASKS §0.2: missing types go in ext/, additive only).
 *
 * - `src/generated/call-scenarios.json`: the per-TAKE normalized scenario (truth after THAT take's sidecar overrides).
 *   `src/generated/scenarios.json` holds one Scenario per scenario id (the chosen take's overrides); the eval must use
 *   the per-take truth, because two takes of one scenario can carry different `fact_overrides`.
 * - The trailer record that ends every `data/cache/stt/<callId>/<variant>.jsonl` channel (DESIGN §6.2: "the file
 *   ends with Termination.session_duration_seconds and the params hash").
 * - `data/labels/<callId>.auto.json`: what the auto-labeller saw and why an item is flagged for review (§6.1).
 */
import { z } from "zod";
import { ChannelSchema, FieldIdSchema } from "../case";
import { ScenarioSchema } from "../scenario";

/** `src/generated/call-scenarios.json`: callId → Scenario with that take's overrides applied. */
export const CallScenariosFileSchema = z.record(z.string(), ScenarioSchema);
export type CallScenariosFile = z.infer<typeof CallScenariosFileSchema>;

/** `message.type` of the per-channel trailer record in an STT cache JSONL. */
export const STT_CACHE_META_TYPE = "BatonCacheMeta" as const;

export const SttCacheMetaSchema = z.object({
  type: z.literal(STT_CACHE_META_TYPE),
  /** sha256(JSON of the exact params, keys sorted).slice(0, 16). */
  paramsHash: z.string(),
  /** The exact Streaming params (no credentials: Node auth is the Authorization header). */
  params: z.record(z.string(), z.unknown()),
  /** ISO timestamp the session opened (the cached-replay badge: "transcribed live by AssemblyAI on …"). */
  transcribedAt: z.string(),
  /** Termination.session_duration_seconds (billing); null when no Termination arrived. */
  billedSeconds: z.number().nullable(),
  /** Audio ms sent to this session, including the trailing silence. */
  audioMsSent: z.number(),
  /** Begin.id */
  providerSessionId: z.string().nullable(),
  /** "pc_ctx": number of UpdateConfiguration{agent_context} sent to the customer session. */
  agentContextUpdates: z.number().int().nonnegative(),
  closeCode: z.number().int().nullable(),
  /** Runner version (bump when the runner's behaviour changes). */
  runner: z.string(),
});
export type SttCacheMeta = z.infer<typeof SttCacheMetaSchema>;

export const LABEL_FLAGS = [
  /** The take's sidecar overrides this fact: check the value that was actually said. */
  "override",
  /** The located quote does not contain the expected value (sol found something else). */
  "value_mismatch",
  /** sol's own confidence is low, or the quote could not be matched to word times. */
  "low_confidence",
  /** The fact was expected (VERIFIED/PENDING at hand-off) but not found in the transcript. */
  "not_found",
  /** Found on the other party's channel than the scenario says (`stated_by`). */
  "channel_mismatch",
  /** The hand-off line / acceptance could not be located. */
  "handoff_missing",
] as const;
export const LabelFlagSchema = z.enum(LABEL_FLAGS);
export type LabelFlag = z.infer<typeof LabelFlagSchema>;

/** `data/labels/<callId>.auto.json` (written by label-ground-truth.ts; read by review-labels.ts). */
export const LabelsAutoFileSchema = z.object({
  callId: z.string(),
  scenarioId: z.string(),
  createdAt: z.string(),
  transcriptId: z.string().nullable(),
  model: z.string(),
  /** Per mention/handoff item: flags for the human review. */
  items: z.array(
    z.object({
      key: z.string(),
      field: FieldIdSchema.nullable(),
      channel: ChannelSchema.nullable(),
      flags: z.array(LabelFlagSchema),
      note: z.string(),
    }),
  ),
  /** Utterances the labeller saw (call clock, ms): the review prints quotes against them. */
  utterances: z.array(z.object({ id: z.number().int(), channel: ChannelSchema, startMs: z.number(), endMs: z.number(), text: z.string() })),
  usd: z.object({ aai: z.number(), openai: z.number() }),
});
export type LabelsAutoFile = z.infer<typeof LabelsAutoFileSchema>;
