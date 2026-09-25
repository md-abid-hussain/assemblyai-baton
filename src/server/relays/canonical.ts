import "server-only";

import { createHash } from "node:crypto";

/**
 * `blueprintHash = sha256(canonicalJson(blueprint))`, keys sorted (PLATFORM §3.2 "Versioning").
 *
 * WP14a owns the isomorphic version in `src/core/relay/migrate.ts` (WP14a·2); until it lands the server uses this one.
 * Both MUST produce identical strings (docs/notes/requests/wp14b-to-wp14a.md):
 * - canonicalJson = JSON with every object's keys sorted by `Array.prototype.sort()` (UTF-16 code units), no
 *   whitespace, array order kept, `undefined`-valued keys dropped (as JSON.stringify does), numbers as JSON.stringify
 *   prints them;
 * - the hash = lowercase hex SHA-256 of the UTF-8 bytes of that string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortKeys(x)));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    }
    return out;
  }
  return v;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function blueprintHash(blueprint: unknown): string {
  return sha256Hex(canonicalJson(blueprint));
}
