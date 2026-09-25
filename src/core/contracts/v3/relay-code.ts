/**
 * contracts/v3/relay-code.ts - the relay-as-code types (SAAS §14, §5.3). WP19; frozen at C3.
 * The codec implementation is WP23's `src/core/relay-code/**`; only the shapes live here, so the Studio, the
 * source store, the CLI and the public API all speak one vocabulary.
 */

export type SourceFormat = "yaml" | "json";

export interface RelaySource {
  format: SourceFormat;
  text: string;
}

/** 1-based line, 0-based column, as editors and the `yaml` LineCounter report them. */
export interface Range {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface CodeDiagnostic {
  source: "syntax" | "schema" | "lint" | "codec";
  code: string;
  severity: "error" | "warn";
  /** The JSON path into the blueprint, e.g. `["stages", 0, "greeting"]`. */
  path: (string | number)[];
  message: string;
  /** `null` when the diagnostic cannot be located in the text (e.g. it came from the compiled form). */
  range: Range | null;
}

/** What `RelaySourceStore.get` returns: the source plus where it sits in the relay's history. */
export interface RelaySourceView extends RelaySource {
  relayId: string;
  /** `null` for the draft; a version number for a snapshot. */
  version: number | null;
  rev: number;
  hash: string;
  /** `false` when the text was regenerated from the canonical blueprint rather than stored verbatim. */
  stored: boolean;
}

/** 256 KiB: the cap on any source body (`POST /api/v1/blueprints/validate`, `PUT …/source`). */
export const MAX_SOURCE_BYTES = 262_144;

export const CODEC_CODES = [
  "CODEC_SYNTAX", "CODEC_UNKNOWN_KEY", "CODEC_CREDENTIAL", "CODEC_TOO_LARGE", "CODEC_ALIAS_LIMIT",
] as const;
export type CodecCode = (typeof CODEC_CODES)[number];
