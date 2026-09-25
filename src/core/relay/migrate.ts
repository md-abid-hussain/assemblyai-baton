/**
 * relay/migrate.ts - blueprint versioning helpers. WP14a. Pure and isomorphic.
 *
 * - `canonicalJson(x)`: JSON with object keys sorted (arrays keep their order), so equal blueprints hash equally
 *   whatever key order a client sent.
 * - `blueprintHash(bp)`: sha256 of the canonical JSON (hex, 64 chars). Versions are content-addressed by it
 *   (`RelayRegistry.snapshotVersion`), and `IntentSpec.hash` carries it.
 * - `migrateBlueprint(json)`: upgrades an older blueprint document to `changeover.blueprint/2.0`. 2.0 is the only
 *   schema so far, so it only checks the marker; later schema bumps add steps here (never in the zod schema).
 */
import { BLUEPRINT_SCHEMA, type Blueprint } from "../contracts/v2/blueprint";
import { sha256Hex } from "../case/sha256";

export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const blueprintHash = (bp: Blueprint | unknown): string => sha256Hex(canonicalJson(bp));

/** The first 8 hex chars of the hash (`promptVersion = relay:<hash8>`, PLATFORM §4.6). */
export const hash8 = (hash: string): string => hash.slice(0, 8);

export class BlueprintMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintMigrationError";
  }
}

/**
 * Returns a document in the current schema (still unvalidated: run `lintBlueprintJson` / `BlueprintSchema` next).
 * Throws `BlueprintMigrationError` for a non-object or an unknown `meta.schema`.
 */
export function migrateBlueprint(json: unknown): unknown {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new BlueprintMigrationError("a blueprint must be a JSON object");
  const meta = (json as { meta?: unknown }).meta;
  const schema = typeof meta === "object" && meta !== null ? (meta as { schema?: unknown }).schema : undefined;
  if (schema === BLUEPRINT_SCHEMA) return json;
  throw new BlueprintMigrationError(`unknown blueprint schema ${JSON.stringify(schema)} (this build reads ${BLUEPRINT_SCHEMA})`);
}
