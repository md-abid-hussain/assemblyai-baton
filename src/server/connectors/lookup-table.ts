import "server-only";

/**
 * The `lookup_table` parser (PLATFORM §6.1) — the canonical implementation now lives in
 * `src/core/relay/lookup-table.ts` (WP14a, isomorphic), and this module is the re-export WP16·1 promised in
 * `docs/notes/requests/wp16-to-wp14a.md` §2.
 *
 * One parser for the runtime connector, the lint's view of a pasted table and any kernel `lookup`, so a table that
 * lints clean cannot fail to parse at run time.
 */
export {
  LOOKUP_LIMITS, lookupRow, normalizeLookupKey, parseCsv, parseLookupTable, utf8Bytes,
  type LookupResult, type LookupTable, type ParseLookupTableInput, type ParseLookupTableResult,
} from "../../core/relay/lookup-table";
