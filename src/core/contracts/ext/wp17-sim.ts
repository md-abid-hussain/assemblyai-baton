/**
 * contracts/ext/wp17-sim.ts - additive WP17 types (TASKS-v2 §2 rule 3) for simulated calls (PLATFORM §7.5):
 * the TTS clip cache port, the stored `sim_calls` shapes (script + timeline, `ai_clips`), the gallery sim manifest
 * (`src/generated/sim-calls.json`), and the `SimCallStore` port that WP14b's `CallCatalog` consumes.
 * Pure: zod and relative contract imports only.
 *
 * Naming note: PLATFORM §7.5 calls the handoff times `{repLineStartMs, repLineEndMs, acceptStartMs, acceptEndMs}`;
 * the frozen v1 `CallHandoff` names them `{lineStartMs, lineEndMs, acceptStartMs, acceptEndMs, declined}`. Sims use
 * `CallHandoff` (so `decisionPointMs = handoff.lineStartMs`).
 */
import { z } from "zod";

import { CallHandoffSchema, CallManifestEntrySchema, PeaksSchema } from "../scenario";
import { ID_PREFIXES, SIM_TURN_TAGS, SimCallKindSchema, SimScriptSchema, TextDryRunResultSchema } from "../v2/api";

// ============================================================================================ constants

/** The pinned TTS snapshot (research/10 §3.9). Never the alias. */
export const SIM_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15" as const;
/** Rep = cedar, customer = marin: the only two voices verified live (PLATFORM §7.5 step 2). */
export const SIM_VOICES = { rep: "cedar", customer: "marin" } as const;
export type SimSpeaker = keyof typeof SIM_VOICES;
export type SimTurnTag = (typeof SIM_TURN_TAGS)[number];

/** Assembly timeline (PLATFORM §7.5 step 3). */
export const SIM_TIMELINE = {
  sampleRate: 8000,
  leadInMs: 800,
  gapMinMs: 350,
  gapMaxMs: 650,
  /** Between the rep's handoff line and the customer's acceptance. */
  handoffGapMs: 300,
  /** Silence after the acceptance so the last final can land before the pass. */
  tailMs: 1000,
  /** Hard cap on the whole human half. */
  maxMs: 90_000,
} as const;

/** `sim_<first 16 hex of the content hash>` (PLATFORM §2.4). */
export const SIM_CALL_ID_RE = /^sim_[0-9a-f]{16}$/;
export const TTS_HASH_RE = /^[0-9a-f]{64}$/;

/** A 24 kHz AI-half clip served next to a sim's assets: `/api/sim-calls/<id>/clip.<sha256>.pcm`. */
export const SIM_CLIP_FILE_RE = /^clip\.([0-9a-f]{64})\.pcm$/;
export const simClipFile = (hash: string): string => `clip.${hash}.pcm`;
export const simAssetUrl = (simCallId: string, file: string): string => `/api/sim-calls/${simCallId}/${file}`;

/** Shared customer clips: generated once, globally (same text + voice + instructions → same `tts_cache` row). */
export const SHARED_CUSTOMER_CLIPS = {
  confirm: "Yes, that's right.",
  consentLink: "Yes, please text me the link.",
  consentGoAhead: "Yes, go ahead.",
  close: "No, that's everything, thanks.",
} as const;

// ============================================================================================ TTS

export interface TtsRequest {
  text: string;
  voice: string;
  /** gpt-4o-mini-tts `instructions` (tone). Part of the cache key. */
  instructions: string;
  /** Ledger `refId` (e.g. the sim call id or a script name). */
  refId: string;
}
export interface TtsClip {
  /** sha256(model|voice|instructions|text), hex. */
  hash: string;
  /** PCM16 LE mono, 24 kHz. */
  pcm24k: Uint8Array;
  durationMs: number;
  cached: boolean;
  /** What this call cost (0 when cached). Settled from the character count. */
  usd: number;
}
export interface TtsCacheEntry {
  hash: string;
  model: string;
  voice: string;
  text: string;
  pcm24k: Uint8Array;
  durationMs: number;
}
/** `tts_cache` (PLATFORM §2.4) or a file/memory stand-in. */
export interface TtsCacheStore {
  get(hash: string): Promise<TtsCacheEntry | null>;
  /** Idempotent (content-addressed). */
  put(e: TtsCacheEntry): Promise<void>;
}

// ============================================================================================ stored shapes

/** One placed line of the human half. Times are ms on the call timeline. */
export const SimTimelineTurnSchema = z.object({
  i: z.number().int().nonnegative(),
  speaker: z.enum(["rep", "customer"]),
  tag: z.enum(SIM_TURN_TAGS),
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  /** tts_cache hash of the line (24 kHz source). */
  clipHash: z.string().regex(TTS_HASH_RE),
});
export type SimTimelineTurn = z.infer<typeof SimTimelineTurnSchema>;

/** `ai_clips` jsonb: keys `confirm` | `consent` | `close` | `answer:<field>` (WP11 suggestion kinds). */
export const SimAiClipSchema = z.object({
  hash: z.string().regex(TTS_HASH_RE),
  text: z.string(),
  durationMs: z.number().nonnegative(),
});
export type SimAiClip = z.infer<typeof SimAiClipSchema>;
export const SimAiClipsSchema = z.record(z.string(), SimAiClipSchema);
export type SimAiClips = z.infer<typeof SimAiClipsSchema>;
export type SimAiClipKey = "confirm" | "consent" | "close" | `answer:${string}`;
/** A clip with its playable URL (DB sims: the asset route; gallery sims: a static file). */
export type SimAiClipRef = SimAiClip & { url: string };

/** Relay identity carried with a sim (the row only holds `relay_version_id`). */
export const SimRelayRefSchema = z.object({
  /**
   * The relay the sim belongs to. Empty only for a gallery manifest written before WP17·3 - gallery sims are
   * resolved by slug + hash through `CallCatalog`, never by this id.
   */
  relayId: z.string().default(""),
  slug: z.string(),
  title: z.string(),
  /** The blueprint hash the script was written for (gallery: resolves to a version at runtime), if known. */
  blueprintHash: z.string().nullable(),
});
export type SimRelayRef = z.infer<typeof SimRelayRefSchema>;

/**
 * `sim_calls.script` jsonb: the normalized script (the handoff turn holds the EXACT `repLine`; turns after the
 * acceptance dropped) plus, for audio sims, the placed timeline, and the relay identity. The v2 `SimCallView.script`
 * is `SimScriptSchema.parse(stored)` (extra keys stripped).
 */
export const SimScriptStoredSchema = SimScriptSchema.extend({
  timeline: z.array(SimTimelineTurnSchema),
  relay: SimRelayRefSchema,
  /**
   * TEXT DRY RUN only (PLATFORM §7.5.2; WP17·3): the case card at the pass, the compiled greeting and the next ask
   * per stage. It lives inside `script` because a dry run has no audio columns to spare and migration 0001 is
   * WP14b's; `SimCallView.dryRun` reads it back.
   */
  dryRun: TextDryRunResultSchema.nullable().default(null),
});
export type SimScriptStored = z.infer<typeof SimScriptStoredSchema>;

/** What `SimCallStore.insert` writes (one `sim_calls` row). */
export interface SimCallInsert {
  id: string;
  kind: z.infer<typeof SimCallKindSchema>;
  relayVersionId: string;
  sampleIndex: number;
  script: SimScriptStored;
  /** Audio only: raw 8 kHz mu-law. */
  rep: Uint8Array | null;
  customer: Uint8Array | null;
  peaks: z.infer<typeof PeaksSchema> | null;
  durationMs: number;
  handoff: z.infer<typeof CallHandoffSchema>;
  aiClips: SimAiClips;
  usd: number;
  gallery: boolean;
}
/** A row without its audio bytes. */
export type SimCallRecord = Omit<SimCallInsert, "rep" | "customer"> & { hasAudio: boolean; createdAt: string; lastUsedAt: string };

// ============================================================================================ gallery manifest

/**
 * One entry of `src/generated/sim-calls.json` (built by `scripts/sim/build-gallery.ts`, WP17·2). Gallery sims are
 * static files under `public/calls/sim-<slug>/`; version ids are random per database, so an entry names its relay
 * by slug + blueprint hash and `CallCatalog` maps that to a version at runtime.
 */
export const GallerySimCallSchema = z.object({
  id: z.string().regex(SIM_CALL_ID_RE),
  relay: SimRelayRefSchema,
  sampleIndex: z.number().int().nonnegative(),
  entry: CallManifestEntrySchema,
  aiClips: z.record(z.string(), SimAiClipSchema.extend({ url: z.string() })),
  timeline: z.array(SimTimelineTurnSchema),
  /**
   * The "Try an edit" preset versions this same audio also plays for (PLATFORM §7.5.3): the human half never
   * changes, only the blueprint the AI half runs. `aiClips` already carries each preset's extra `answer:<field>`
   * clip, so a preset run costs no TTS.
   */
  variants: z.array(z.object({ presetId: z.string(), blueprintHash: z.string() })).default([]),
});
export type GallerySimCall = z.infer<typeof GallerySimCallSchema>;
export const GallerySimCallsSchema = z.array(GallerySimCallSchema);

// ============================================================================================ the port

/** What `CallCatalog.resolve(callId)` needs from a sim (WP14b adds `account` from the version's samples). */
export interface SimCallResolution {
  /** The synthesized `CallManifestEntry` (PLATFORM §7.5 step 4). */
  entry: z.infer<typeof CallManifestEntrySchema>;
  simulated: true;
  /** DB sims: the row's version. Gallery sims: null (resolve `relay.slug` + `relay.blueprintHash`). */
  relayVersionId: string | null;
  relay: SimRelayRef;
  sampleIndex: number;
  gallery: boolean;
  aiClips: Record<string, SimAiClipRef>;
  timeline: SimTimelineTurn[];
}

export interface SimCallAsset {
  bytes: Uint8Array;
  contentType: string;
}

/** WP17's `sim_calls` store (PLATFORM §7.5 step 4). */
export interface SimCallStore {
  /** Insert once: ids are content-addressed, so an existing id is kept (`created:false`). */
  insert(row: SimCallInsert): Promise<{ id: string; created: boolean }>;
  get(id: string): Promise<SimCallRecord | null>;
  /** `rep.ulaw` | `customer.ulaw` | `peaks.json` | `clip.<sha256>.pcm` (only clips the sim references). */
  asset(id: string, file: string): Promise<SimCallAsset | null>;
  /** DB rows first, then the committed gallery manifest. Touches `last_used_at` (best effort). */
  resolveCall(callId: string): Promise<SimCallResolution | null>;
}

export const simCallIdOf = (hex: string): string => `${ID_PREFIXES.simCall}${hex.slice(0, 16)}`;
