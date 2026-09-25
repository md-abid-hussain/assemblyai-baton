/**
 * contracts/ext/wp14b-relays.ts - additive WP14b types (TASKS-v2 §2 rule 3): the gallery presets file format that
 * `seedGallery()` reads (`data/relays/<slug>.presets.json`, written by WP17; PLATFORM §7.5.3), the RFC 6902 JSON-patch
 * subset it applies, the `relay_versions.preset` and `.moderation` column shapes, and the relay quota numbers
 * (PLATFORM §10.2). Pure: zod only.
 */
import { z } from "zod";

// ============================================================================================ JSON patch (RFC 6902)

/** A JSON pointer (RFC 6901): "" (the whole document) or "/a/b/0". "-" appends to an array (add only). */
export const JsonPointerSchema = z.string().max(300).regex(/^(\/[^/]*)*$/);

export const JsonPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: JsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: JsonPointerSchema }),
  z.object({ op: z.literal("replace"), path: JsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal("move"), from: JsonPointerSchema, path: JsonPointerSchema }),
  z.object({ op: z.literal("copy"), from: JsonPointerSchema, path: JsonPointerSchema }),
  z.object({ op: z.literal("test"), path: JsonPointerSchema, value: z.unknown() }),
]);
export type JsonPatchOp = z.infer<typeof JsonPatchOpSchema>;

// ============================================================================================ presets file

/** snake_case or kebab-case preset id, e.g. "deposit_75". */
export const PresetIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);

/** One "Try an edit" preset: a JSON patch over the gallery relay's blueprint (PLATFORM §7.5.3). */
export const RelayPresetDefSchema = z.object({
  id: PresetIdSchema,
  label: z.string().min(1).max(80),
  patch: z.array(JsonPatchOpSchema).min(1).max(40),
});
export type RelayPresetDef = z.infer<typeof RelayPresetDefSchema>;

/**
 * `data/relays/<base>.presets.json`: either a bare array of presets or `{ presets: [...] }`. `<base>` is the file name
 * of the gallery blueprint it patches (`dental-deposit.presets.json` → `dental-deposit.json`).
 */
export const RelayPresetsFileSchema = z.union([
  z.array(RelayPresetDefSchema).max(6),
  z.object({ presets: z.array(RelayPresetDefSchema).max(6) }).transform((f) => f.presets),
]);

// ============================================================================================ column shapes

/** `relay_versions.preset`: set on seeded preset versions only. They never become `relays.current_version_id`. */
export const VersionPresetSchema = z.object({
  id: PresetIdSchema,
  label: z.string(),
  /** The gallery version the patch was applied to; only presets of the current version are listed. */
  baseVersionId: z.string(),
});
export type VersionPreset = z.infer<typeof VersionPresetSchema>;

/** `relay_versions.moderation` (PLATFORM §2.4, §7.4). `source: "seed"` = our own gallery text, not sent to OpenAI. */
export const VersionModerationSchema = z.object({
  flagged: z.boolean(),
  categories: z.array(z.string()),
  checkedAt: z.string(),
  source: z.enum(["openai", "seed"]).optional(),
});
export type VersionModeration = z.infer<typeof VersionModerationSchema>;

// ============================================================================================ quotas (PLATFORM §10.2)

/**
 * The relay buckets' numbers. Bucket NAMES are `QUOTA_BUCKETS` (contracts/v2/api.ts); per-ipKey buckets use the
 * suffix `:ip`. The global cap never blocks a create: it archives an idle relay instead (`RELAY_GLOBAL_CAPS`).
 */
export const RELAY_QUOTAS = {
  /** Live (not archived, not deleted) relays per visitor workspace. Clone-from-gallery is exempt. */
  liveRelaysPerVisitor: 5,
  createPerVisitorPerDay: 10,
  createPerIpPerDay: 20,
  savePerVisitorPerHour: 120,
} as const;

export const RELAY_GLOBAL_CAPS = {
  /** Above this many live non-gallery relays, the LRU non-gallery, unpublished relay idle > `idleMs` is archived. */
  softLive: 400,
  /** Above this many, the LRU such relay is archived regardless of idle time. */
  hardLive: 2000,
  idleMs: 3_600_000,
} as const;
export type RelayGlobalCaps = { softLive: number; hardLive: number; idleMs: number };
