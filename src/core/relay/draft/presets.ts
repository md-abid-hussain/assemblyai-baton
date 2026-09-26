/**
 * relay/draft/presets.ts - "Try an edit" presets (PLATFORM §7.5.3), WP17.
 *
 * A preset is a named, reviewable EDIT to a gallery relay: `data/relays/<slug>.presets.json` holds an id, a label,
 * a one-line summary and an RFC 6902 JSON patch. Applying one produces a new blueprint, which `seedGallery()`
 * (WP14b) snapshots as a content-addressed version of the same gallery relay - nothing is cloned - and which WP15's
 * card shows as a diff before it runs. `sim.answers` are the extra AI-half clips the preset needs, pre-voiced by
 * `scripts/sim/build-gallery.ts` onto the SAME pre-generated simulated call (the human half never changes), so a
 * preset run costs no TTS.
 *
 * Pure and isomorphic (the Studio applies presets in the browser): zod + relative contract imports only, no node
 * built-ins. It lives under `draft/` because that is WP17's directory inside `src/core/relay/**` (TASKS-v2 §4).
 *
 * The patch subset is deliberately small - `add`, `replace`, `remove` - and every path is a literal JSON Pointer
 * (RFC 6901, with the array-append token `-` for `add`). No `move`, `copy` or `test`: a preset must read as one
 * sentence in a diff, and anything more expressive belongs in the editor.
 */
import { z } from "zod";

export const RELAY_PRESETS_SCHEMA = "changeover.presets/1" as const;

/** A JSON Pointer (RFC 6901): "" or "/seg" repeated; `~0` = `~`, `~1` = `/`. */
export const JsonPointerSchema = z.string().max(200).regex(/^(\/([^/~]|~[01])*)*$/, "not a JSON Pointer");

export const JsonPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: JsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal("replace"), path: JsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: JsonPointerSchema }),
]);
export type JsonPatchOp = z.infer<typeof JsonPatchOpSchema>;

export const RelayPresetSchema = z.object({
  /** snake_case, stable: it keys the preset's version snapshot and its sim clips. */
  id: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/),
  /** The card's title, e.g. "Add a required field". */
  label: z.string().min(3).max(60),
  /** One sentence, shown under the label and in the diff header. */
  summary: z.string().min(10).max(200),
  patch: z.array(JsonPatchOpSchema).min(1).max(12),
  /** Extra AI-half clips this preset needs (a new field the AI will ask about). */
  sim: z.object({
    answers: z.array(z.object({ field: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), spoken: z.string().min(1).max(200) })).max(3),
  }),
});
export type RelayPreset = z.infer<typeof RelayPresetSchema>;

export const RelayPresetsFileSchema = z.object({
  schema: z.literal(RELAY_PRESETS_SCHEMA),
  /** The gallery relay these presets edit (`meta.slug`). */
  relay: z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/),
  presets: z.array(RelayPresetSchema).min(1).max(3),
});
export type RelayPresetsFile = z.infer<typeof RelayPresetsFileSchema>;

export class PresetPatchError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at "${path}")`);
    this.name = "PresetPatchError";
  }
}

const unescape = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

/** The reference tokens of a pointer ("" → []). */
export function pointerTokens(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map(unescape);
}

const isIndex = (t: string): boolean => /^(0|[1-9][0-9]*)$/.test(t);

type Json = unknown;
const clone = (v: Json): Json => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Json));

function parentOf(doc: Json, tokens: readonly string[], pointer: string): Json {
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(cur)) {
      if (!isIndex(t)) throw new PresetPatchError(`"${t}" is not an array index`, pointer);
      cur = cur[Number(t)];
    } else if (cur !== null && typeof cur === "object") {
      cur = (cur as Record<string, Json>)[t];
    } else {
      throw new PresetPatchError(`"${t}" has no container`, pointer);
    }
    if (cur === undefined) throw new PresetPatchError(`"${t}" does not exist`, pointer);
  }
  return cur;
}

/**
 * Apply one patch to a deep copy of `doc` (the input is never mutated). The result is plain JSON: the caller
 * re-parses it with `BlueprintSchema` before using it, so a preset can never smuggle an invalid relay through.
 */
export function applyJsonPatch(doc: Json, patch: readonly JsonPatchOp[]): Json {
  let out = clone(doc);
  for (const op of patch) {
    const tokens = pointerTokens(op.path);
    if (tokens.length === 0) {
      if (op.op === "remove") throw new PresetPatchError("cannot remove the whole document", op.path);
      out = clone((op as { value: Json }).value);
      continue;
    }
    const parent = parentOf(out, tokens, op.path);
    const last = tokens[tokens.length - 1]!;
    if (Array.isArray(parent)) {
      const append = last === "-";
      if (!append && !isIndex(last)) throw new PresetPatchError(`"${last}" is not an array index`, op.path);
      const i = append ? parent.length : Number(last);
      if (op.op === "add") {
        if (i > parent.length) throw new PresetPatchError(`index ${i} is past the end`, op.path);
        parent.splice(i, 0, clone(op.value));
      } else {
        if (append || i >= parent.length) throw new PresetPatchError(`index ${last} does not exist`, op.path);
        if (op.op === "remove") parent.splice(i, 1);
        else parent[i] = clone(op.value);
      }
      continue;
    }
    if (parent === null || typeof parent !== "object") throw new PresetPatchError(`"${last}" has no container`, op.path);
    const rec = parent as Record<string, Json>;
    if (op.op === "add") rec[last] = clone(op.value);
    else if (!(last in rec)) throw new PresetPatchError(`"${last}" does not exist`, op.path);
    else if (op.op === "remove") delete rec[last];
    else rec[last] = clone(op.value);
  }
  return out;
}

/** `applyJsonPatch(blueprint, preset.patch)`; the result still has to pass `BlueprintSchema` and `lintBlueprint`. */
export const applyRelayPreset = (blueprint: unknown, preset: Pick<RelayPreset, "patch">): unknown =>
  applyJsonPatch(blueprint, preset.patch);

/** Parse a `<slug>.presets.json` and check that it names `slug`. */
export function parsePresetsFile(json: unknown, slug: string): RelayPresetsFile {
  const file = RelayPresetsFileSchema.parse(json);
  if (file.relay !== slug) throw new Error(`presets file is for relay "${file.relay}", not "${slug}"`);
  const ids = new Set<string>();
  for (const p of file.presets) {
    if (ids.has(p.id)) throw new Error(`duplicate preset id "${p.id}"`);
    ids.add(p.id);
  }
  return file;
}
