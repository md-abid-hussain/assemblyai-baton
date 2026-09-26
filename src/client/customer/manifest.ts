/**
 * client/customer/manifest.ts - the committed chip/autopilot clip pack (DESIGN §5.15 "Audio").
 *
 * `/api/tts` is cut (TASKS-v2 §4.1), so every phrase the autopilot customer or a chip can say for a Baton take is
 * pre-generated once by `scripts/tts/generate-chips.ts` and committed under `public/tts/`. A normal run therefore
 * makes ZERO live TTS calls (WP11 acceptance 1). The manifest also carries the take's scenario truth, because the
 * page never sees `Scenario.truth` (it is not in `CreateCaseResponse`) and the suggested-reply engine needs it.
 *
 * Simulated calls do NOT use this file: their AI-half clips come from `SimCallResolution.aiClips`, keyed by
 * suggestion kind (PLATFORM §7.5 step 5, docs/notes/requests/wp17-to-wp11.md §2).
 *
 * The clip bytes are raw PCM16 LE mono at 24 kHz - the feeder's native rate, fed as-is.
 */
import "client-only";

import { z } from "zod";

/** Where the generator writes, and the page reads. */
export const CHIP_MANIFEST_URL = "/tts/manifest.json";
/** `public/tts/<hash>.pcm`, content-addressed like the sim clips. */
export const chipClipUrl = (hash: string): string => `/tts/${hash}.pcm`;

export const CHIP_HASH_RE = /^[0-9a-f]{64}$/;

export const ChipClipSchema = z.object({
  /** sha256(model|voice|instructions|text), hex - the same key the sim TTS cache uses. */
  hash: z.string().regex(CHIP_HASH_RE),
  text: z.string().min(1),
  durationMs: z.number().nonnegative(),
  /** "recorded" = the customer volunteer's own tail-pack clip (§11.6); "synthetic" = TTS stand-in. */
  voice: z.enum(["recorded", "synthetic"]).default("synthetic"),
});
export type ChipClip = z.infer<typeof ChipClipSchema>;

export const ChipCallSchema = z.object({
  scenarioId: z.string(),
  /** `Scenario.truth`, normalized: what the customer truthfully answers (DESIGN §5.15 steps 2-3). */
  truth: z.record(z.string(), z.string()).default({}),
  /** Hashes of the clips generated for this take (a subset of `clips`). */
  clips: z.array(z.string().regex(CHIP_HASH_RE)).default([]),
});
export type ChipCall = z.infer<typeof ChipCallSchema>;

export const ChipManifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  model: z.string(),
  voice: z.string(),
  clips: z.array(ChipClipSchema),
  /** Keyed by callId (the take), so one scenario's several takes can share clips. */
  calls: z.record(z.string(), ChipCallSchema),
});
export type ChipManifest = z.infer<typeof ChipManifestSchema>;

/**
 * The lookup key for a phrase: case- and punctuation-insensitive, whitespace collapsed. The generator and the page
 * must agree, so both import this. (Typographic apostrophes and quotes normalize to ASCII: the same phrase reaches
 * us from `src/core/compiler/suggest.ts` and from a JSON file that may have been re-encoded.)
 */
export function normalizeChipText(text: string): string {
  return text
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const EMPTY_CHIP_MANIFEST: ChipManifest = {
  version: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  model: "",
  voice: "",
  clips: [],
  calls: {},
};
