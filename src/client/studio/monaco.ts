"use client";
/**
 * client/studio/monaco.ts - self-hosted Monaco, configured for blueprint files (SAAS §5.5.1).
 *
 * **Nothing here imports `monaco-editor`.** The package is a 25 MB tree; a static import would put it in the shell
 * bundle and break acceptance 7 ("Monaco is not loaded on any page other than Code and Versions"). `monaco-editor`
 * is a **type-only** import (erased at compile time), and the runtime object arrives from `@monaco-editor/loader`,
 * which injects `/vendor/monaco/vs/loader.js` - a same-origin AMD loader, copied out of `node_modules` at build time
 * by `scripts/devtools/copy-monaco.mjs`. That is what keeps the CSP unchanged: no `cdn.jsdelivr.net`, no new origin,
 * workers same-origin (`worker-src 'self' blob:` already exists).
 *
 * If any of that fails - the vendor tree was never copied, the loader 404s, a CSP rule we did not anticipate - the
 * Code tab does not break: `loadMonaco` rejects and the tab renders the `CODE_EDITOR=textarea` fallback with a note.
 * K-MONACO is the deliberate version of that decision; this is the accidental one.
 */
import "client-only";

import type * as Monaco from "monaco-editor";

import type { CodeDiagnostic, SourceFormat } from "@/core/relay-code";

import { MONACO_VS_PATH } from "./capabilities";

/** Where `copy-monaco.mjs` puts the AMD tree. It is served statically by Next from `public/`. */
export { MONACO_VS_PATH };

/** The owner string our diagnostics are set under, so Monaco's own JSON markers are never clobbered. */
export const MARKER_OWNER = "changeover";

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;

/**
 * Load Monaco once per page, from `public/vendor/monaco`. Rejects when the vendor tree is missing, which the Code
 * tab treats as "fall back to the textarea".
 */
export async function loadMonaco(vsPath: string = MONACO_VS_PATH, timeoutMs = 10_000): Promise<MonacoApi> {
  if (loading) return loading;
  loading = (async () => {
    const { loader } = await import("@monaco-editor/react");
    loader.config({ paths: { vs: vsPath } });
    // `loader.init()` never rejects when the AMD loader script simply never fires (a 404 on `loader.js` resolves as
    // a load event in some browsers), so the timeout is the real failure detector, not a belt-and-braces extra.
    return (await Promise.race([
      loader.init(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Monaco did not load from ${vsPath} within ${timeoutMs} ms`)), timeoutMs)),
    ])) as unknown as MonacoApi;
  })().catch((e: unknown) => {
    loading = null;
    throw e instanceof Error ? e : new Error(String(e));
  });
  return loading;
}

/** Test seam: forget a previous load so a new `vsPath` is honoured. */
export function resetMonacoForTests(): void {
  loading = null;
}

/**
 * The codec's `Range` is **1-based line, 0-based column** (`contracts/v3/relay-code.ts`, and
 * `requests/wp23-to-wp15.md` §3 spells out why). Monaco is 1-based on both, so every column gains one.
 */
export function toMarker(monaco: MonacoApi, d: CodeDiagnostic): Monaco.editor.IMarkerData | null {
  if (!d.range) return null;
  return {
    startLineNumber: d.range.startLine,
    startColumn: d.range.startCol + 1,
    endLineNumber: d.range.endLine,
    endColumn: d.range.endCol + 1,
    severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    message: `${d.code}: ${d.message}`,
    source: MARKER_OWNER,
  };
}

/** Every diagnostic that can be placed on a line. The rest belong in the list under the editor. */
export const toMarkers = (monaco: MonacoApi, diagnostics: readonly CodeDiagnostic[]): Monaco.editor.IMarkerData[] =>
  diagnostics.map((d) => toMarker(monaco, d)).filter((m): m is Monaco.editor.IMarkerData => m !== null);

export const monacoLanguage = (format: SourceFormat): string => (format === "json" ? "json" : "yaml");

/**
 * Point Monaco's JSON language service at our published schema (SAAS §5.5.1): completion, hover docs and schema
 * diagnostics with **no network request of its own** (`enableSchemaRequest: false` - we hand it the parsed schema,
 * so the editor never fetches, and the CSP's `connect-src` is not involved).
 *
 * YAML gets highlighting and our own markers only; `monaco-yaml` (its own worker build) is P5.
 */
export interface JsonDiagnosticsOptions {
  validate?: boolean;
  allowComments?: boolean;
  enableSchemaRequest?: boolean;
  /** `"ignore"` silences "Unable to load schema …"; see `configureJsonSchema`. */
  schemaRequest?: "error" | "warning" | "ignore";
  /** Left unset on purpose, so schema problems keep their default severity. */
  schemaValidation?: "error" | "warning" | "ignore";
  schemas?: { uri: string; fileMatch?: string[]; schema?: unknown }[];
}

interface JsonDefaults {
  setDiagnosticsOptions(options: JsonDiagnosticsOptions): void;
}

/**
 * **monaco-editor 0.57 moved the JSON language service.** `monaco.languages.json` is now typed as
 * `{ deprecated: true }` and the supported entry point is the top-level `json` namespace. The AMD build we load
 * still assigns *both* at runtime (`editor.main` does `languages.json = json.register`), so the old path works —
 * but the types no longer say so, and a future minor could drop it. Hence: prefer the new namespace, fall back to
 * the old one, and tell the caller when neither exists instead of throwing inside `onMount`.
 */
export function jsonDefaultsOf(monaco: MonacoApi): JsonDefaults | null {
  const m = monaco as unknown as {
    json?: { jsonDefaults?: JsonDefaults };
    languages?: { json?: { jsonDefaults?: JsonDefaults } };
  };
  return m.json?.jsonDefaults ?? m.languages?.json?.jsonDefaults ?? null;
}

/**
 * Every id the JSON language service might look our schema up under, given a document whose `$schema` is the
 * relative `/schemas/blueprint-2.0.json` and a model living at `inmemory://model/1`.
 *
 * **Why this is not one uri.** `getSchemaForResource` checks the document's own `$schema` **first and returns**;
 * the `fileMatch` associations are only consulted when there is no `$schema` at all. So on a JSON document the
 * `fileMatch: ["*"]` registration is dead code, and everything depends on the id the `$schema` string resolves to.
 * Monaco resolves it against the MODEL's uri, so `/schemas/blueprint-2.0.json` on `inmemory://model/1` becomes
 * `inmemory://model/schemas/blueprint-2.0.json` — an id we had not registered and, with `enableSchemaRequest:
 * false`, one that cannot be fetched either. The visible symptoms were a warning squiggle on the `$schema` line
 * ("Unable to load schema … No schema request service available") and, less visibly and much worse, **no
 * completion and no schema validation at all** in JSON mode.
 *
 * Registering the same schema object under each plausible id fixes the cause rather than the squiggle: the
 * relative path as written, its resolution against the model, and the absolute same-origin URL (what a file
 * exported from a real deployment carries, and what the committed example's `$id` looks like).
 */
export function schemaUris(schemaUri: string, modelUri?: string, origin?: string): string[] {
  const out = [schemaUri];
  for (const base of [modelUri, origin]) {
    if (!base) continue;
    try {
      const resolved = new URL(schemaUri, base).toString();
      if (!out.includes(resolved)) out.push(resolved);
    } catch {
      // A base we cannot parse simply contributes no alias.
    }
  }
  return out;
}

/**
 * Point the JSON language service at our published schema. Returns false when this Monaco build exposes no JSON
 * language service at all; our own `validateSource` markers are unaffected either way.
 *
 * `enableSchemaRequest: false` keeps the editor off the network (the schema is handed over parsed), and
 * `schemaRequest: "ignore"` keeps a document that references some *other* schema from drawing a squiggle it cannot
 * act on. `schemaValidation` is left at its default, so real schema problems still surface.
 */
export function configureJsonSchema(monaco: MonacoApi, schema: unknown, schemaUri: string, modelUri?: string, origin?: string): boolean {
  const defaults = jsonDefaultsOf(monaco);
  if (!defaults) return false;
  const uris = schemaUris(schemaUri, modelUri, origin);
  defaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemaRequest: "ignore",
    // The first also carries `fileMatch`, which is what binds the schema to a document with no `$schema` line.
    schemas: uris.map((uri, i) => (i === 0 ? { uri, fileMatch: ["*"], schema } : { uri, schema })),
  });
  return true;
}

/** Fetch the published JSON Schema. A failure is not fatal: the editor keeps our own diagnostics. */
export async function fetchBlueprintSchema(url: string, f: typeof fetch = fetch): Promise<unknown | null> {
  try {
    const res = await f(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The editor options both the Code tab and the Versions diff use. */
export function editorOptions(readOnly: boolean): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly,
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: "selection",
    wordWrap: "off",
    fixedOverflowWidgets: true,
    // Monaco turns its accessibility mode on for screen readers by default; the forms stay the accessible
    // primary editing path (SAAS §5.5.1).
    accessibilitySupport: "auto",
  };
}
