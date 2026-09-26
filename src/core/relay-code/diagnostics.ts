/**
 * relay-code/diagnostics.ts - building `CodeDiagnostic`s (SAAS §5.3, contracts/v3/relay-code.ts). WP23.
 *
 * Four sources, in the order `validateSource` produces them:
 *   syntax  - the YAML/JSON parser (`CODEC_SYNTAX`, `CODEC_TOO_LARGE`, `CODEC_ALIAS_LIMIT`)
 *   schema  - `BlueprintSchema` issues, mapped from the zod path to a text range
 *   lint    - `lintBlueprint` issues (PLATFORM §3.4), same mapping
 *   codec   - what zod cannot see: keys it strips silently (`CODEC_UNKNOWN_KEY`, a warning) and credentials pasted
 *             into an `http_action` (`CODEC_CREDENTIAL`, an error; SAAS §5.2)
 *
 * Pure and isomorphic: no node, DOM or server imports.
 */
import type { ZodError } from "zod";

import type { CodeDiagnostic, Range } from "../contracts/v3/relay-code";
import type { LintIssue } from "../contracts/v2/relay";
import { BlueprintSchema } from "../contracts/v2/blueprint";
import { childSchema, declaredKeys, schemaAtPath } from "./order";

export type Path = (string | number)[];
/** How a diagnostic finds its place in the text. `which: "key"` asks for the key token, not the value. */
export type Locate = (path: Path, which?: "value" | "key") => Range | null;

export const diagnostic = (
  source: CodeDiagnostic["source"],
  code: string,
  severity: CodeDiagnostic["severity"],
  path: Path,
  message: string,
  range: Range | null,
): CodeDiagnostic => ({ source, code, severity, path, message, range });

/** True when anything in the list blocks (an error, whatever its source). */
export const hasErrors = (diagnostics: readonly CodeDiagnostic[]): boolean => diagnostics.some((d) => d.severity === "error");

/**
 * Errors that must stop a blueprint being accepted at all: bad syntax, a zod failure, or a credential in the file.
 * Lint errors are NOT in this set - they block Test and Publish, never Save (SAAS §5.2, PLATFORM §3.4).
 */
export const hasBlockingErrors = (diagnostics: readonly CodeDiagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error" && d.source !== "lint");

// ------------------------------------------------------------------------------------------------ zod and lint

/** zod issue paths use `string | number | symbol`; the codec's paths never contain symbols. */
const toPath = (path: readonly PropertyKey[]): Path => path.map((k) => (typeof k === "number" ? k : String(k)));

export type ZodIssues = ZodError["issues"];

export function zodDiagnostics(issues: ZodIssues, locate: Locate): CodeDiagnostic[] {
  return issues.map((issue) => {
    const path = toPath(issue.path ?? []);
    return diagnostic("schema", `SCHEMA_${issue.code ?? "invalid"}`.toUpperCase(), "error", path, issue.message, locate(path));
  });
}

export function lintDiagnostics(issues: readonly LintIssue[], locate: Locate): CodeDiagnostic[] {
  return issues.map((issue) =>
    diagnostic("lint", issue.code, issue.severity, [...issue.path], issue.message, locate([...issue.path])),
  );
}

// ------------------------------------------------------------------------------------------------ unknown keys

/**
 * Keys allowed at the root although the zod schema strips them (SAAS §5.2): the JSON `$schema` header that gives
 * an editor completion offline.
 */
export const ROOT_EXTRA_KEYS = new Set(["$schema"]);

/**
 * Keys that zod would strip silently, reported as warnings at the key's own range, so a typo like `requried:` is
 * visible instead of disappearing. Walks the raw parsed value against the blueprint shapes; positions the walker
 * cannot describe (inside a `z.record`, or under a branch whose union option is unclear) are skipped rather than
 * guessed at.
 */
export function unknownKeyDiagnostics(value: unknown, locate: Locate): CodeDiagnostic[] {
  const out: CodeDiagnostic[] = [];
  const walk = (node: unknown, path: Path): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    const object = node as Record<string, unknown>;
    const schema = schemaAtPath(BlueprintSchema, path, value);
    const declared = schema ? declaredKeys(schema, object) : null;
    for (const key of Object.keys(object)) {
      const childPath = [...path, key];
      if (declared && !declared.includes(key)) {
        if (path.length === 0 && ROOT_EXTRA_KEYS.has(key)) continue;
        out.push(diagnostic("codec", "CODEC_UNKNOWN_KEY", "warn", childPath, `unknown key "${key}" - it is ignored`, locate(childPath, "key")));
        continue;
      }
      if (schema && childSchema(schema, key, object)) walk(object[key], childPath);
    }
  };
  walk(value, []);
  return out;
}

// ------------------------------------------------------------------------------------------------ credentials

/** Credential shapes a blueprint file may never carry (SAAS §5.2). Secret VALUES belong in the secret store. */
const CREDENTIAL_PREFIXES: readonly { label: string; re: RegExp }[] = [
  { label: "a Bearer token", re: /(^|\s)Bearer\s+\S/i },
  { label: "Basic auth", re: /(^|\s)Basic\s+\S/i },
  { label: "an sk_ key", re: /\bsk_[A-Za-z0-9_-]{8,}/ },
  { label: "a cko_ key", re: /\bcko_[A-Za-z0-9_-]{8,}/ },
  { label: "a whsec_ secret", re: /\bwhsec_[A-Za-z0-9_-]{8,}/ },
  { label: "a polar_oat_ token", re: /\bpolar_oat_[A-Za-z0-9_-]{8,}/ },
];
/** 32+ characters of base64 or hex, in a header whose NAME sounds like a credential. */
const LONG_SECRET = /[A-Za-z0-9+/=_-]{32,}/;
const SECRET_HEADER_NAME = /^(authorization|proxy-authorization)$|key|token|secret/i;

const credentialLabel = (text: string): string | null => CREDENTIAL_PREFIXES.find((p) => p.re.test(text))?.label ?? null;

/** A `{ $secret: "sec_…" }` reference: the only way a file may point at a credential. */
const isSecretRef = (value: unknown): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { $secret?: unknown }).$secret === "string";

/**
 * `CODEC_CREDENTIAL` for any `http_action` URL or header value that looks like a credential, and for a
 * `completion_webhook` URL carrying one. `{ $secret: … }` references and `null` pass. Runs on the RAW parsed value
 * (before or without zod), because a file that fails validation must still never be echoed back with a live key.
 */
export function credentialDiagnostics(value: unknown, locate: Locate): CodeDiagnostic[] {
  const out: CodeDiagnostic[] = [];
  const connectors = (value as { connectors?: unknown } | null)?.connectors;
  if (!Array.isArray(connectors)) return out;
  connectors.forEach((connector, index) => {
    if (connector === null || typeof connector !== "object" || Array.isArray(connector)) return;
    const c = connector as Record<string, unknown>;
    const type = c.type;
    if (type !== "http_action" && type !== "completion_webhook") return;
    if (typeof c.url === "string") {
      const label = credentialLabel(c.url);
      if (label) {
        const path: Path = ["connectors", index, "url"];
        out.push(diagnostic("codec", "CODEC_CREDENTIAL", "error", path,
          `the URL looks like it contains ${label}; put it in the secret store and reference it with { $secret: "sec_…" }`, locate(path)));
      }
    }
    if (type !== "http_action" || !Array.isArray(c.headers)) return;
    c.headers.forEach((header, headerIndex) => {
      if (header === null || typeof header !== "object" || Array.isArray(header)) return;
      const h = header as Record<string, unknown>;
      const name = typeof h.name === "string" ? h.name : "";
      const headerValue = h.value;
      if (headerValue === null || isSecretRef(headerValue) || typeof headerValue !== "string") return;
      const label = credentialLabel(headerValue) ?? (SECRET_HEADER_NAME.test(name) && LONG_SECRET.test(headerValue) ? "a credential" : null);
      if (!label) return;
      const path: Path = ["connectors", index, "headers", headerIndex, "value"];
      out.push(diagnostic("codec", "CODEC_CREDENTIAL", "error", path,
        `header "${name}" looks like it carries ${label}; store it as a secret and reference it with { $secret: "sec_…" }`, locate(path)));
    });
  });
  return out;
}
