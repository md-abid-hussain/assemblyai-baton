/**
 * contracts/scenario.ts - calls, scenarios and labels (DESIGN §4.1). Frozen at G0.
 *
 * Inputs owned by the recording-kit agent (READ-ONLY for Baton code):
 *   data/scenarios/sNN.json (kit `Scenario`, schema_version 1), data/calls/raw/<base>.{wav,json} (kit `Sidecar`:
 *   channel_map, consent.publishable, review.fact_overrides/status_overrides, audio stats),
 *   data/calls/split/<base>_{rep,customer}.wav (PCM16 mono 8 kHz), data/calls/manifest.json (`kit report`).
 * callId = the sidecar `base` (one take). Baton-derived files live OUTSIDE data/calls (DESIGN §3.1).
 */
import { z } from "zod";
import { HANDOFF_RESPONSES, LANGUAGES } from "../intents/add-driver.fields";
import { ChannelSchema, FieldIdSchema, FieldStatusSchema, PolicyRecordSchema } from "./case";

export const CallAudioFormatSchema = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("pcm_mulaw"), sampleRate: z.literal(8000) }),
  z.object({ encoding: z.literal("pcm_s16le"), sampleRate: z.literal(16000) }),
]);
export type CallAudioFormat = z.infer<typeof CallAudioFormatSchema>;

export const LanguageSchema = z.enum(LANGUAGES);

export const CallHandoffSchema = z.object({
  lineStartMs: z.number(),
  lineEndMs: z.number(),
  acceptStartMs: z.number().nullable(),
  acceptEndMs: z.number().nullable(),
  declined: z.boolean(),
});
export type CallHandoff = z.infer<typeof CallHandoffSchema>;

/**
 * Site-root-relative URLs of a published call's assets (DESIGN §5.1.1), content-hashed so they can be served
 * immutable, e.g. `/calls/<callId>/rep.3f2a9c1d.ulaw`, `/calls/<callId>/customer.9b1c04e2.ulaw`,
 * `/calls/<callId>/peaks.5d6e7f80.json`. `.ulaw` for twilio8k, `.pcm16` for golden16k. Also the `assets` of
 * POST /api/cases (route #3), which copies them from the manifest.
 */
export const CallAssetsSchema = z.object({ rep: z.string(), customer: z.string(), peaks: z.string() });
export type CallAssets = z.infer<typeof CallAssetsSchema>;

/** `peaks.json` (DESIGN §5.1.1): per channel, the 0..1 max-abs over each 20 ms window (ratePerSec = 50). */
export const PeaksSchema = z.object({
  ratePerSec: z.literal(50),
  rep: z.array(z.number().min(0).max(1)),
  customer: z.array(z.number().min(0).max(1)),
});
export type Peaks = z.infer<typeof PeaksSchema>;

/** src/generated/calls.json (built by scripts/calls/build-assets.ts). */
export const CallManifestEntrySchema = z.object({
  callId: z.string(),
  scenarioId: z.string(),
  title: z.string(),
  source: z.enum(["golden16k", "twilio8k"]),
  language: LanguageSchema,
  durationMs: z.number(),
  format: CallAudioFormatSchema,
  /** = sidecar.consent.publishable */
  publishAudio: z.boolean(),
  /** review.status !== "discard" && labels.reviewed && twilio.recording_channels === 2 */
  inEval: z.boolean(),
  /** Exactly one entry: the landing default (the kit's chosen s01 take). */
  featured: z.boolean(),
  /** Curated call picker (§1.3 P1). */
  picker: z.enum(["main", "more", "hidden"]),
  /** Express start (§5.1.6); from labels. */
  decisionPointMs: z.number().nullable(),
  /** From labels. */
  handoff: CallHandoffSchema.nullable(),
  /** public/replays/<bundleId>/ for this call, if recorded (§7.5). */
  recordedAiBundle: z.string().nullable(),
  /** public/tts/voice/<scenarioId>/manifest.json, if recorded (§11.6). */
  customerTailPack: z.string().nullable(),
  /** G0: the content-hashed public asset URLs; null when !publishAudio (no public/ assets, §5.1.1). */
  assets: CallAssetsSchema.nullable(),
});
export type CallManifestEntry = z.infer<typeof CallManifestEntrySchema>;

/** normalizeScenario(kitScenario, sidecar?) with overrides applied. */
export const ScenarioSchema = z.object({
  id: z.string(),
  intent: z.literal("add_driver"),
  title: z.string(),
  language: LanguageSchema,
  callDate: z.string(),
  policy: PolicyRecordSchema,
  /** Normalized values (valueNorm format) after sidecar.review.fact_overrides. */
  truth: z.partialRecord(FieldIdSchema, z.string()),
  /** status_at_handoff after status_overrides. */
  expectedAtHandoff: z.partialRecord(FieldIdSchema, FieldStatusSchema),
  plannedHandoffS: z.number(),
  handoffResponse: z.enum(HANDOFF_RESPONSES),
  /** From facts; dueToday computed if absent. */
  rating: z.object({ newMonthlyUsd: z.number(), changeMonthlyUsd: z.number().nullable(), dueTodayUsd: z.number() }),
  traps: z.array(z.string()),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** data/labels/<callId>.json (auto + human-reviewed; owned by WP9). */
export const CallLabelsSchema = z.object({
  callId: z.string(),
  reviewed: z.boolean(),
  mentions: z.array(
    z.object({
      field: FieldIdSchema,
      valueNorm: z.string(),
      channel: ChannelSchema,
      statedAtMs: z.number(),
      ackedAtMs: z.number().nullable(),
      quote: z.string(),
    }),
  ),
  handoff: z
    .object({
      lineStartMs: z.number(),
      lineEndMs: z.number(),
      acceptStartMs: z.number().nullable(),
      acceptEndMs: z.number().nullable(),
    })
    .nullable(),
  diagnosisEndsMs: z.number().nullable(),
  tailStartsMs: z.number().nullable(),
});
export type CallLabels = z.infer<typeof CallLabelsSchema>;
