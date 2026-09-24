/**
 * contracts/eval.ts - eval caches, the takeover sweep and the files that move between the data packages
 * (DESIGN §4.1, §5.1.10, §6). Frozen at G0.
 */
import { z } from "zod";
import { ChannelSchema, FieldIdSchema, FieldStatusSchema, NewFactEventSchema } from "./case";
import { VerifierResultSchema } from "./extract";

export const PIPELINE_VERSIONS = ["v1", "v2", "v3"] as const;
export const PipelineVersionSchema = z.enum(PIPELINE_VERSIONS);
export type PipelineVersion = z.infer<typeof PipelineVersionSchema>;

export const STT_VARIANTS = ["pc_ctx", "pc_noctx", "mono_diar", "pc_ctx_8k"] as const;
export const SttVariantSchema = z.enum(STT_VARIANTS);
export type SttVariant = z.infer<typeof SttVariantSchema>;

/** `agent_context` carryover knob (§5.2): v3 default is last_rep_turn. */
export const CTX_CARRY = ["none", "last_rep_turn"] as const;
export type CtxCarry = (typeof CTX_CARRY)[number];

/** Provenance badge on every number shown in the UI (§6). */
export const PROVENANCE = ["LIVE", "CACHED-STT SWEEP", "PROJECTED"] as const;
export const ProvenanceSchema = z.enum(PROVENANCE);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** One line of data/cache/stt/<callId>/<variant>.jsonl. */
export const SttCacheRecordSchema = z.object({
  callId: z.string(),
  variant: SttVariantSchema,
  channel: z.union([ChannelSchema, z.literal("mono")]),
  recvMs: z.number(),
  /** Raw server message (Turn/Begin/Termination…). */
  message: z.record(z.string(), z.unknown()),
});
export type SttCacheRecord = z.infer<typeof SttCacheRecordSchema>;

export const SweepMetricsSchema = z.object({
  entityAcc: z.number().nullable(),
  verifiedPrecision: z.number().nullable(),
  wrongAsserted: z.number().int().nonnegative(),
  wrongPending: z.number().int().nonnegative(),
  reaskProjected: z.number().int().nonnegative(),
  pendingN: z.number().int().nonnegative(),
  missingN: z.number().int().nonnegative(),
  ready: z.boolean(),
  statusAgreementAtPlanned: z.number().nullable(),
});
export type SweepMetrics = z.infer<typeof SweepMetricsSchema>;

export const SweepSnapshotEntrySchema = z.object({ status: FieldStatusSchema, value: z.string().nullable(), display: z.string().nullable() });

/**
 * G0: ablations that are neither a PipelineVersion nor an SttVariant (§6.4 "verifier off" at v3). The other §6.4
 * ablations are variants (`pc_noctx`, `mono_diar`, `pc_ctx_8k`).
 */
export const SWEEP_ABLATIONS = ["none", "verifier_off"] as const;
export const SweepAblationSchema = z.enum(SWEEP_ABLATIONS);
export type SweepAblation = z.infer<typeof SweepAblationSchema>;

export const SweepPointSchema = z.object({
  callId: z.string(),
  version: PipelineVersionSchema,
  variant: SttVariantSchema,
  /** G0: "none" for the plain version × variant curves. */
  ablation: SweepAblationSchema,
  tMs: z.number(),
  midUtterance: z.boolean(),
  tCutMs: z.number(),
  capHit: z.boolean(),
  protocolMs: z.number(),
  /** Exhaustive over FieldId. */
  snapshot: z.record(FieldIdSchema, SweepSnapshotEntrySchema),
  greeting: z.string(),
  metrics: SweepMetricsSchema,
});
export type SweepPoint = z.infer<typeof SweepPointSchema>;

/** The sweep configuration key: `v3.pc_ctx`, `v3.pc_ctx.verifier_off`, … (file names, summary curve keys). */
export const sweepKeyOf = (version: PipelineVersion, variant: SttVariant, ablation: SweepAblation = "none"): string =>
  `${version}.${variant}${ablation === "none" ? "" : `.${ablation}`}`;

/** `public/data/explorer/<callId>/<sweepKey>.json` (§6.5 outputs): every SweepPoint of one call × configuration. */
export const explorerDataPath = (callId: string, version: PipelineVersion, variant: SttVariant, ablation: SweepAblation = "none"): string =>
  `/data/explorer/${encodeURIComponent(callId)}/${sweepKeyOf(version, variant, ablation)}.json`;

// ================================================================================================ data files (G0)

/**
 * `public/data/cached-turns/<callId>.json` (WP9 writes, WP4's cached replay reads; §5.1.10). The raw Streaming
 * `Turn` messages (partials and finals) of the call's per-channel `pc_ctx` session, each stamped with `recvMs`
 * (call clock; the cached session started at call ms 0). The client feeds them through the same TurnTracker as
 * live and emits them at `recvMs`; finals become TurnInputs with `cachedTurnIdOf(ch, turn_order)` and
 * `source:"stt_cache"`. Begin/Termination are omitted.
 */
export const CachedTurnRecordSchema = z.object({
  recvMs: z.number(),
  /** Raw `Turn` message: `{type:"Turn", turn_order, end_of_turn, transcript, words, …}`. */
  message: z.record(z.string(), z.unknown()),
});
export type CachedTurnRecord = z.infer<typeof CachedTurnRecordSchema>;

export const CachedTurnsFileSchema = z.object({
  callId: z.string(),
  /** Always `pc_ctx` for the replay (the v3 configuration). */
  variant: SttVariantSchema,
  /** ISO date the call was transcribed live (the badge tooltip: "transcribed live by AssemblyAI on …"). */
  transcribedAt: z.string(),
  channels: z.object({ rep: z.array(CachedTurnRecordSchema), customer: z.array(CachedTurnRecordSchema) }),
});
export type CachedTurnsFile = z.infer<typeof CachedTurnsFileSchema>;

/** A cached fact event: the case-specific `id`, `caseId` and `seq` are assigned when the server serves it. */
export const CachedFactEventSchema = NewFactEventSchema.omit({ id: true, caseId: true });
export type CachedFactEvent = z.infer<typeof CachedFactEventSchema>;

/**
 * `data/cache/extract/<callId>/<version>.<variant>.json` (WP9 writes; WP3 serves it for Express prefill and cached
 * replay "for (callId, turnId, pipelineVersion)"; WP9b's sweep reads it; §6.3). Keyed by cached turn id.
 */
export const ExtractCacheFileSchema = z.object({
  callId: z.string(),
  version: PipelineVersionSchema,
  variant: SttVariantSchema,
  /** §5.3 version pin: the server serves a cache only when this equals its own extractorVersion. */
  extractorVersion: z.string(),
  model: z.string(),
  createdAt: z.string(),
  /** In recvMs order; `turnId` = cachedTurnIdOf(channel, turn_order). */
  turns: z.array(
    z.object({
      turnId: z.string(),
      channel: ChannelSchema,
      recvMs: z.number(),
      endMs: z.number(),
      /** Measured luna latency for this turn (the sweep's step 4). */
      extractMs: z.number().nonnegative(),
      events: z.array(CachedFactEventSchema),
    }),
  ),
  /** Cut-turn extractions on demand (§6.3 step 4), keyed by sha256(text + contextHash). */
  cutTurns: z.record(z.string(), z.object({ extractMs: z.number().nonnegative(), events: z.array(CachedFactEventSchema) })).optional(),
});
export type ExtractCacheFile = z.infer<typeof ExtractCacheFileSchema>;

/**
 * `data/cache/verify/<callId>.<variant>.json` (WP9 writes; WP9b's sweep step 5 reads; §6.3): cached sol runs at a
 * 30 s call-time cadence. A run is usable at `t` when `startMs + ms ≤ t`; runs never overlap (F2).
 */
export const VerifierCacheFileSchema = z.object({
  callId: z.string(),
  variant: SttVariantSchema,
  model: z.string(),
  createdAt: z.string(),
  runs: z.array(z.object({ startMs: z.number(), ms: z.number().nonnegative(), result: VerifierResultSchema })),
});
export type VerifierCacheFile = z.infer<typeof VerifierCacheFileSchema>;

/** One entry of `data/evals/iterations.json` (§6.4; WP9b appends, WP10 renders). */
export const IterationEntrySchema = z.object({
  version: PipelineVersionSchema,
  date: z.string(),
  gitSha: z.string(),
  configHash: z.string(),
  extractorVersion: z.string(),
  promptVersion: z.string(),
  variants: z.array(SttVariantSchema),
  /** Headline numbers of that run (shape owned by WP9b; WP10 renders keys it knows). */
  summary: z.record(z.string(), z.unknown()),
  /** Hand-written: why this change was made. */
  note: z.string().optional(),
});
export type IterationEntry = z.infer<typeof IterationEntrySchema>;

/**
 * `public/data/evals/summary.json` (WP9b writes; WP10 renders; `EvalSummaryResponse.static`). Minimal frozen envelope:
 * the fields the Promote gate (§5.14) and the headline need. WP9b extends the rest (curves, ablation table, K1
 * blocks) in `src/core/contracts/ext/wp9b-summary.ts` by D2 09:00, before WP10 starts; unknown keys pass through.
 */
export const EvalSummaryStaticSchema = z
  .object({
    generatedAt: z.string(),
    gitSha: z.string().nullable(),
    headline: z.object({
      nCalls: z.number().int().nonnegative(),
      nPoints: z.number().int().nonnegative(),
      /** Share (0..1) of v3 points with wrongAsserted = 0 AND reaskProjected = 0 (CACHED-STT SWEEP / PROJECTED). */
      zeroWrongZeroReaskShare: z.number().nullable(),
      /** Promote gate: share of v3 points with reaskProjected = 0, and points with wrongAsserted > 0. */
      sweepReaskZeroShare: z.number().nullable(),
      sweepWrongAssertedPoints: z.number().int().nonnegative().nullable(),
      provenance: z.array(ProvenanceSchema),
    }),
  })
  .loose();
export type EvalSummaryStatic = z.infer<typeof EvalSummaryStaticSchema>;
