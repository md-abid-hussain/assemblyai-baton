/**
 * The Monaco glue that has no Monaco in it: marker mapping and JSON-Schema registration
 * (SAAS §5.5.1; `docs/notes/requests/wp23-to-wp15.md` §2 and §3).
 *
 * `monaco.ts` type-imports `monaco-editor` and nothing else, so everything here runs against a tiny fake API. The
 * two things worth pinning down are the ones a browser check found the hard way:
 *
 *  1. **The column convention.** The codec's `Range` is 1-based line / **0-based** column; Monaco is 1-based on
 *     both. An off-by-one here puts every squiggle one character to the left, which reads as "the editor is
 *     slightly wrong" rather than as a bug, and so survives review.
 *  2. **Which uris the schema is registered under.** `getSchemaForResource` honours a document's own `$schema`
 *     FIRST and returns; `fileMatch` is only consulted when there is no `$schema` at all. Our documents all carry
 *     `"$schema": "/schemas/blueprint-2.0.json"`, and Monaco resolves that against the MODEL's uri
 *     (`inmemory://model/1`), so unless the resolved id is registered too there is no completion and no schema
 *     validation in JSON mode — while `fileMatch: ["*"]` sits there looking correct.
 */
import { describe, expect, it } from "vitest";

import {
  configureJsonSchema, jsonDefaultsOf, MARKER_OWNER, monacoLanguage, schemaUris, toMarker, toMarkers,
  type JsonDiagnosticsOptions, type MonacoApi,
} from "@/client/studio/monaco";
import type { CodeDiagnostic } from "@/core/relay-code";

const MODEL_URI = "inmemory://model/1";
const SCHEMA_PATH = "/schemas/blueprint-2.0.json";
const ORIGIN = "https://app.example.test";

/** Just enough of the Monaco API for the pure helpers, plus a record of what was configured. */
function fakeMonaco(opts: { json?: boolean; legacy?: boolean } = {}) {
  const calls: JsonDiagnosticsOptions[] = [];
  const jsonDefaults = { setDiagnosticsOptions: (o: JsonDiagnosticsOptions) => void calls.push(o) };
  const api = {
    MarkerSeverity: { Error: 8, Warning: 4 },
    ...(opts.json === false ? {} : opts.legacy ? { languages: { json: { jsonDefaults } } } : { json: { jsonDefaults } }),
  };
  return { api: api as unknown as MonacoApi, calls };
}

const diag = (over: Partial<CodeDiagnostic> = {}): CodeDiagnostic =>
  ({
    code: "SCHEMA_INVALID_VALUE",
    message: 'Invalid input: expected "en-US"',
    severity: "error",
    range: { startLine: 8, startCol: 10, endLine: 8, endCol: 15 },
    ...over,
  }) as CodeDiagnostic;

describe("toMarker", () => {
  it("adds one to every column and keeps the line as it is", () => {
    const { api } = fakeMonaco();
    expect(toMarker(api, diag())).toEqual({
      startLineNumber: 8,
      startColumn: 11,
      endLineNumber: 8,
      endColumn: 16,
      severity: 8,
      message: 'SCHEMA_INVALID_VALUE: Invalid input: expected "en-US"',
      source: MARKER_OWNER,
    });
  });

  it("a warning keeps its severity, and the code is prefixed onto the message", () => {
    const { api } = fakeMonaco();
    const m = toMarker(api, diag({ severity: "warn", code: "W2_UNUSED_SECRET", message: "nothing uses sec_1" }));
    expect(m?.severity).toBe(4);
    expect(m?.message).toBe("W2_UNUSED_SECRET: nothing uses sec_1");
  });

  it("a diagnostic with no range belongs in the list under the editor, not on a line", () => {
    const { api } = fakeMonaco();
    expect(toMarker(api, diag({ range: null }))).toBeNull();
    expect(toMarkers(api, [diag(), diag({ range: null }), diag()])).toHaveLength(2);
  });
});

describe("monacoLanguage", () => {
  it("maps the two source formats onto Monaco's language ids", () => {
    expect(monacoLanguage("json")).toBe("json");
    expect(monacoLanguage("yaml")).toBe("yaml");
  });
});

describe("jsonDefaultsOf", () => {
  it("prefers the 0.57 namespace, falls back to the deprecated one, and reports neither", () => {
    expect(jsonDefaultsOf(fakeMonaco().api)).not.toBeNull();
    expect(jsonDefaultsOf(fakeMonaco({ legacy: true }).api)).not.toBeNull();
    expect(jsonDefaultsOf(fakeMonaco({ json: false }).api)).toBeNull();
  });
});

describe("schemaUris", () => {
  it("registers the relative path AND what it resolves to against the model uri", () => {
    // Without the second entry the editor looks up `inmemory://model/schemas/blueprint-2.0.json`, finds nothing,
    // and silently offers no completion at all. This is the whole bug in one assertion.
    expect(schemaUris(SCHEMA_PATH, MODEL_URI, ORIGIN)).toEqual([
      SCHEMA_PATH,
      "inmemory://model/schemas/blueprint-2.0.json",
      `${ORIGIN}/schemas/blueprint-2.0.json`,
    ]);
  });

  it("de-duplicates, so an already-absolute schema url is registered once", () => {
    const absolute = `${ORIGIN}/schemas/blueprint-2.0.json`;
    expect(schemaUris(absolute, MODEL_URI, ORIGIN)).toEqual([absolute]);
  });

  it("an unparseable base contributes no alias instead of throwing", () => {
    expect(schemaUris(SCHEMA_PATH, "not a uri")).toEqual([SCHEMA_PATH]);
    expect(schemaUris(SCHEMA_PATH)).toEqual([SCHEMA_PATH]);
  });
});

describe("configureJsonSchema", () => {
  it("keeps the editor off the network, silences resolve failures, and binds every alias", () => {
    const { api, calls } = fakeMonaco();
    const schema = { type: "object" };
    expect(configureJsonSchema(api, schema, SCHEMA_PATH, MODEL_URI, ORIGIN)).toBe(true);
    expect(calls).toHaveLength(1);
    const o = calls[0]!;
    expect(o.validate).toBe(true);
    expect(o.enableSchemaRequest).toBe(false);
    expect(o.schemaRequest).toBe("ignore");
    // `schemaValidation` is deliberately NOT set: real schema problems must still surface.
    expect(o.schemaValidation).toBeUndefined();
    expect(o.schemas?.map((s) => s.uri)).toEqual(schemaUris(SCHEMA_PATH, MODEL_URI, ORIGIN));
    expect(o.schemas?.every((s) => s.schema === schema)).toBe(true);
  });

  it("only the first registration carries fileMatch — that is the no-$schema path", () => {
    const { api, calls } = fakeMonaco();
    configureJsonSchema(api, {}, SCHEMA_PATH, MODEL_URI, ORIGIN);
    const schemas = calls[0]!.schemas ?? [];
    expect(schemas[0]?.fileMatch).toEqual(["*"]);
    expect(schemas.slice(1).every((s) => s.fileMatch === undefined)).toBe(true);
  });

  it("a Monaco build with no JSON language service is reported, not thrown at", () => {
    const { api, calls } = fakeMonaco({ json: false });
    expect(configureJsonSchema(api, {}, SCHEMA_PATH, MODEL_URI)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
