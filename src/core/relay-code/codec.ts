/**
 * relay-code/codec.ts - the isomorphic YAML/JSON codec for blueprints (SAAS §5.2-5.3). WP23.
 *
 * One module for three callers: the Studio's Code tab (browser), the server on save (authoritative) and the CLI
 * (bundled). A relay file is exactly one `Blueprint` written as YAML 1.2 or JSON; JSON is parsed by the same YAML
 * parser (JSON is valid YAML), so ranges come from one CST for both formats - and JSON mode additionally runs
 * `JSON.parse`, so text that is valid YAML but invalid JSON is an error in JSON mode.
 *
 * A stranger's file is untrusted input, so the parser is locked down (SAAS §5.3, §10.4):
 *   ≤ 256 KiB · `schema: "core"` (no `!!timestamp`, no octal surprises) · `uniqueKeys: true` · `merge: false`
 *   · `maxAliasCount: 50` · `customTags: []` · one document only.
 * The codes are the frozen `CODEC_CODES` of contracts/v3/relay-code.ts.
 *
 * `validateSource` takes the linter as an option so this module stays free of the kernel; `./index.ts` exports the
 * version with `lintBlueprint` already wired.
 *
 * Pure and isomorphic: no node, DOM or server imports (the boundaries test).
 */
import { LineCounter, isMap, isPair, parseDocument, stringify, visit, type Document, type Node } from "yaml";

import { BlueprintSchema, type Blueprint } from "../contracts/v2/blueprint";
import type { CodeDiagnostic, Range, SourceFormat } from "../contracts/v3/relay-code";
import { MAX_SOURCE_BYTES } from "../contracts/v3/relay-code";
import type { LintIssue } from "../contracts/v2/relay";
import { blueprintHash } from "../relay/migrate";
import {
  credentialDiagnostics, diagnostic, hasBlockingErrors, lintDiagnostics, unknownKeyDiagnostics, zodDiagnostics,
  type Locate, type Path,
} from "./diagnostics";
import { orderValue } from "./order";

export interface ParsedSource {
  value: unknown | null;
  format: SourceFormat;
  diagnostics: CodeDiagnostic[];
  locate: Locate;
}

export interface ValidatedSource {
  blueprint: Blueprint | null;
  hash: string | null;
  diagnostics: CodeDiagnostic[];
}

/** The linter, injected (`lintBlueprint` from the kernel; see ./index.ts). */
export type LintFn = (blueprint: Blueprint) => readonly LintIssue[];
export interface ValidateOptions {
  lint?: LintFn;
}

/** Thrown by `applyEdit` / `convert` when the text they are given does not parse. */
export class CodecError extends Error {
  readonly code: string;
  readonly diagnostics: CodeDiagnostic[];
  constructor(code: string, message: string, diagnostics: CodeDiagnostic[] = []) {
    super(message);
    this.name = "CodecError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** The YAML 1.2 parser options every entry point uses (SAAS §5.3). */
const YAML_OPTIONS = {
  schema: "core" as const,
  uniqueKeys: true,
  merge: false,
  maxAliasCount: 50,
  customTags: [] as [],
  prettyErrors: false,
  keepSourceTokens: true,
};

const STRINGIFY_OPTIONS = { indent: 2, lineWidth: 0, minContentWidth: 0 } as const;

/**
 * The seven tags of the YAML 1.2 core schema. An unknown tag is already a parser warning, but a KNOWN non-core tag
 * is not: `!!timestamp 2026-09-25` resolves to a `Date`, and `!!binary` to a byte array. A blueprint is plain
 * JSON data, so every explicit tag outside this set is refused rather than silently changing a value's type.
 */
const CORE_TAGS = new Set([
  "tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool", "tag:yaml.org,2002:null", "tag:yaml.org,2002:seq", "tag:yaml.org,2002:map",
]);

const NO_RANGE: Locate = () => null;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** `"{"` or `"["` first (after whitespace and a BOM) → JSON; everything else is YAML. */
export function sniffFormat(text: string): SourceFormat {
  const first = text.replace(/^﻿/, "").trimStart()[0];
  return first === "{" || first === "[" ? "json" : "yaml";
}

// ------------------------------------------------------------------------------------------------------- parsing

/** A `yaml` offset → a contract `Range`: 1-based line, 0-based column (contracts/v3/relay-code.ts). */
function rangeOf(lineCounter: LineCounter, start: number, end: number): Range {
  const from = lineCounter.linePos(start);
  const to = lineCounter.linePos(Math.max(start, end));
  return { startLine: from.line, startCol: from.col - 1, endLine: to.line, endCol: to.col - 1 };
}

const nodeRange = (lineCounter: LineCounter, node: unknown): Range | null => {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? rangeOf(lineCounter, range[0], range[1]) : null;
};

/** `locate(path)`: the value's range, or `locate(path, "key")`: the key token of the last step. */
function makeLocate(doc: Document, lineCounter: LineCounter): Locate {
  return (path: Path, which: "value" | "key" = "value"): Range | null => {
    if (which === "key" && path.length > 0) {
      const parent = path.length === 1 ? doc.contents : (doc.getIn(path.slice(0, -1), true) as Node | undefined);
      const last = path[path.length - 1];
      if (isMap(parent)) {
        const pair = parent.items.find((item) => isPair(item) && (item.key as { value?: unknown } | null)?.value === last);
        if (pair && isPair(pair)) {
          const keyRange = nodeRange(lineCounter, pair.key);
          if (keyRange) return keyRange;
        }
      }
    }
    for (let i = path.length; i >= 0; i--) {
      const node = i === 0 ? doc.contents : (doc.getIn(path.slice(0, i), true) as Node | undefined);
      const range = nodeRange(lineCounter, node);
      if (range) return range;
    }
    return null;
  };
}

/**
 * Parse one blueprint file. Never throws: everything that went wrong is a diagnostic, and `value` is null when the
 * text could not be turned into a document.
 */
export function parseSource(text: string, format?: SourceFormat): ParsedSource {
  const resolved = format ?? sniffFormat(text);
  const diagnostics: CodeDiagnostic[] = [];
  const bytes = utf8Bytes(text);
  if (bytes > MAX_SOURCE_BYTES) {
    diagnostics.push(diagnostic("syntax", "CODEC_TOO_LARGE", "error", [],
      `the file is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes (256 KiB)`, null));
    return { value: null, format: resolved, diagnostics, locate: NO_RANGE };
  }

  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, { ...YAML_OPTIONS, lineCounter });
  } catch (error) {
    diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [], (error as Error).message, null));
    return { value: null, format: resolved, diagnostics, locate: NO_RANGE };
  }

  for (const error of doc.errors) {
    diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [], `${error.message} (${error.code})`,
      rangeOf(lineCounter, error.pos[0], error.pos[1])));
  }
  for (const warning of doc.warnings) {
    // An unresolved tag means a custom or non-core tag: refused, rather than silently read as a string.
    const isTag = warning.code === "TAG_RESOLVE_FAILED";
    diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", isTag ? "error" : "warn", [],
      isTag ? `${warning.message} - only the YAML core schema is allowed` : warning.message,
      rangeOf(lineCounter, warning.pos[0], warning.pos[1])));
  }

  visit(doc, (_key, node) => {
    const tag = (node as { tag?: unknown } | null)?.tag;
    if (typeof tag === "string" && !CORE_TAGS.has(tag)) {
      diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [],
        `the tag ${tag} is not part of the YAML core schema`, nodeRange(lineCounter, node)));
    }
  });

  const locate = makeLocate(doc, lineCounter);
  if (diagnostics.some((d) => d.severity === "error")) return { value: null, format: resolved, diagnostics, locate };

  if (doc.contents === null) {
    diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [], "the file is empty", null));
    return { value: null, format: resolved, diagnostics, locate };
  }

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: YAML_OPTIONS.maxAliasCount });
  } catch (error) {
    const message = (error as Error).message;
    const alias = /alias/i.test(message);
    diagnostics.push(diagnostic("syntax", alias ? "CODEC_ALIAS_LIMIT" : "CODEC_SYNTAX", "error", [], message, null));
    return { value: null, format: resolved, diagnostics, locate };
  }

  if (resolved === "json") {
    try {
      JSON.parse(text);
    } catch (error) {
      const message = (error as Error).message;
      const at = /position (\d+)/.exec(message);
      diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [], `invalid JSON: ${message}`,
        at ? rangeOf(lineCounter, Number(at[1]), Number(at[1])) : null));
      return { value: null, format: resolved, diagnostics, locate };
    }
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(diagnostic("syntax", "CODEC_SYNTAX", "error", [], "a blueprint file must be a mapping of the blueprint's sections", locate([])));
    return { value: null, format: resolved, diagnostics, locate };
  }
  return { value, format: resolved, diagnostics, locate };
}

// ---------------------------------------------------------------------------------------------------- validation

/**
 * syntax → zod → lint → codec (SAAS §5.3). `blueprint` and `hash` are null when anything but a LINT error was
 * found: lint errors block Test and Publish, never Save, so a save path still gets the parsed blueprint back.
 * Pass `{ lint }` to run the kernel's linter (`./index.ts` does it for you).
 */
export function validateSource(text: string, format?: SourceFormat, options: ValidateOptions = {}): ValidatedSource {
  const parsed = parseSource(text, format);
  const diagnostics = [...parsed.diagnostics];
  if (parsed.value === null) return { blueprint: null, hash: null, diagnostics };

  const result = BlueprintSchema.safeParse(parsed.value);
  if (!result.success) diagnostics.push(...zodDiagnostics(result.error.issues, parsed.locate));
  else if (options.lint) diagnostics.push(...lintDiagnostics(options.lint(result.data), parsed.locate));

  diagnostics.push(...unknownKeyDiagnostics(parsed.value, parsed.locate));
  diagnostics.push(...credentialDiagnostics(parsed.value, parsed.locate));

  if (!result.success || hasBlockingErrors(diagnostics)) return { blueprint: null, hash: null, diagnostics };
  return { blueprint: result.data, hash: blueprintHash(result.data), diagnostics };
}

// --------------------------------------------------------------------------------------------------- serializing

const SCHEMA_HEADER = /\$schema\s*=\s*(\S+)/;
/** The IDE header of SAAS §5.2, for `serialize(bp, fmt, { header })`. */
export const yamlSchemaHeader = (schemaUrl: string): string[] => [`yaml-language-server: $schema=${schemaUrl}`];

/**
 * The blueprint as text. Keys follow the DECLARATION order of the zod shapes (./order.ts), the indent is 2, YAML
 * strings are quoted only when they have to be and multi-line strings become `|-` block scalars.
 * `opts.header` is written as `#` comments in YAML; in JSON a `$schema=<url>` header becomes the `$schema` key.
 */
export function serialize(blueprint: Blueprint, format: SourceFormat, opts: { header?: string[] } = {}): string {
  const ordered = orderValue(BlueprintSchema, blueprint) as Record<string, unknown>;
  const header = opts.header ?? [];
  if (format === "json") {
    const url = header.map((line) => SCHEMA_HEADER.exec(line)?.[1]).find(Boolean);
    const body = url ? { $schema: url, ...ordered } : ordered;
    return `${JSON.stringify(body, null, 2)}\n`;
  }
  const comments = header.map((line) => (line.startsWith("#") ? line : `# ${line}`)).join("\n");
  const body = stringify(ordered, STRINGIFY_OPTIONS);
  return comments ? `${comments}\n${body}` : body;
}

// ------------------------------------------------------------------------------------------------------- editing

const parseForEdit = (text: string, format: SourceFormat): Document => {
  const parsed = parseSource(text, format);
  if (parsed.value === null) {
    const first = parsed.diagnostics.find((d) => d.severity === "error");
    throw new CodecError(first?.code ?? "CODEC_SYNTAX", first?.message ?? "the source does not parse", parsed.diagnostics);
  }
  return parseDocument(text, { ...YAML_OPTIONS });
};

/**
 * Set (or, with `value === undefined`, delete) one path in the SOURCE TEXT. In YAML the document's CST is edited
 * and printed again, so comments and the formatting of every untouched node survive - which is how a form edit in
 * the Studio keeps a YAML author's comments (SAAS §5.3). In JSON the document is re-serialized.
 */
export function applyEdit(text: string, format: SourceFormat, path: Path, value: unknown): string {
  if (path.length === 0) throw new CodecError("CODEC_SYNTAX", "applyEdit needs a path into the blueprint");
  if (format === "json") {
    const parsed = parseForEdit(text, "json").toJS() as Record<string, unknown>;
    setInPlain(parsed, path, value);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const doc = parseForEdit(text, "yaml");
  if (value === undefined) doc.deleteIn(path);
  else doc.setIn(path, value);
  return doc.toString(STRINGIFY_OPTIONS);
}

/** `setIn`/`deleteIn` for a plain JSON value. Missing containers are created as objects (or arrays for an index). */
function setInPlain(root: Record<string, unknown>, path: Path, value: unknown): void {
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const container = node as Record<string | number, unknown>;
    if (container[key] === null || typeof container[key] !== "object") container[key] = typeof path[i + 1] === "number" ? [] : {};
    node = container[key];
  }
  const last = path[path.length - 1]!;
  const container = node as Record<string | number, unknown>;
  if (value === undefined) {
    if (Array.isArray(container) && typeof last === "number") container.splice(last, 1);
    else delete container[last];
    return;
  }
  container[last] = value;
}

/**
 * YAML ⇄ JSON for the Code tab's toggle. Comments are lost going to JSON, so the `# yaml-language-server` header
 * is carried over as the `$schema` key and back (SAAS §5.2). Key order is the author's, not the schema's.
 */
export function convert(text: string, to: SourceFormat): string {
  const from = sniffFormat(text);
  const parsed = parseSource(text, from);
  if (parsed.value === null) {
    const first = parsed.diagnostics.find((d) => d.severity === "error");
    throw new CodecError(first?.code ?? "CODEC_SYNTAX", first?.message ?? "the source does not parse", parsed.diagnostics);
  }
  const value = { ...(parsed.value as Record<string, unknown>) };
  if (from === to) return text;
  if (to === "json") {
    const header = /^#\s*yaml-language-server:\s*\$schema\s*=\s*(\S+)\s*$/m.exec(text)?.[1];
    const body = header ? { $schema: header, ...value } : value;
    return `${JSON.stringify(body, null, 2)}\n`;
  }
  const schemaUrl = typeof value.$schema === "string" ? value.$schema : null;
  if (schemaUrl !== null) delete value.$schema;
  const body = stringify(value, STRINGIFY_OPTIONS);
  return schemaUrl ? `# ${yamlSchemaHeader(schemaUrl)[0]}\n${body}` : body;
}
