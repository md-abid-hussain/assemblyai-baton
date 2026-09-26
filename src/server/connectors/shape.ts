import "server-only";

import { validateHeaderName, validateHeaderValue } from "node:http";

/**
 * Request/response shaping for `http_action` (PLATFORM §6.2 "Request", "Result to the agent"):
 * the header allowlist, `responsePick` flattening under `data`, and secret redaction.
 */

// ------------------------------------------------------------------------------------------------ headers

/**
 * Declared header names that are dropped at runtime (lint rejects them too): `Host`, `Cookie`, `Content-Length`,
 * `Accept-Encoding`, the hop-by-hop headers, and everything we set ourselves (`Content-Type`, `User-Agent`,
 * `X-Changeover-*`). Compared lower-case.
 */
export const FORBIDDEN_DECLARED_HEADERS: ReadonlySet<string> = new Set([
  "host", "cookie", "cookie2", "content-length", "accept-encoding", "content-encoding", "transfer-encoding", "te",
  "trailer", "connection", "keep-alive", "upgrade", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "expect", "content-type", "user-agent",
]);

export function isForbiddenDeclaredHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return FORBIDDEN_DECLARED_HEADERS.has(n) || n.startsWith("x-changeover-") || n.startsWith("proxy-") || n.startsWith("sec-");
}

export interface DeclaredHeader {
  name: string;
  value: string;
  /** The secret's name when the value came from a secret ref: the value is shown as `‹secret:name›`. */
  secretName?: string | null;
}

/** Keep only the declared headers that are allowed and well-formed. Returns the kept ones and the dropped names. */
export function filterDeclaredHeaders(headers: readonly DeclaredHeader[]): { kept: DeclaredHeader[]; dropped: string[] } {
  const kept: DeclaredHeader[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    const lower = h.name.trim().toLowerCase();
    let ok = !isForbiddenDeclaredHeader(lower) && !seen.has(lower) && /^[A-Za-z0-9-]{1,40}$/.test(h.name.trim());
    if (ok) {
      try {
        validateHeaderName(h.name.trim());
        validateHeaderValue(h.name.trim(), h.value);
      } catch {
        ok = false;
      }
    }
    if (ok && /[\r\n\0]/.test(h.value)) ok = false;
    if (ok) {
      seen.add(lower);
      kept.push({ ...h, name: h.name.trim() });
    } else {
      dropped.push(h.name);
    }
  }
  return { kept, dropped };
}

// ------------------------------------------------------------------------------------------------ responsePick

export const PICK_MAX_STRING = 200;
export type PickedValue = string | number | boolean;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `responsePick` dot paths → a flat record keyed by the path (`"json.amount"`), holding only strings (≤ 200 chars),
 * finite numbers and booleans. Only own properties are walked (no `__proto__`/`constructor` tricks); a numeric
 * segment indexes an array. Missing paths and other value types are skipped.
 */
export function pickResponse(body: unknown, paths: readonly string[]): Record<string, PickedValue> {
  const entries: [string, PickedValue][] = [];
  for (const path of paths) {
    let cur: unknown = body;
    for (const seg of path.split(".")) {
      if (Array.isArray(cur) && /^\d{1,4}$/.test(seg)) cur = Number(seg) < cur.length ? cur[Number(seg)] : undefined;
      else if (isRecord(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
      else cur = undefined;
      if (cur === undefined) break;
    }
    if (typeof cur === "string") entries.push([path, cur.length > PICK_MAX_STRING ? cur.slice(0, PICK_MAX_STRING) : cur]);
    else if (typeof cur === "number" && Number.isFinite(cur)) entries.push([path, cur]);
    else if (typeof cur === "boolean") entries.push([path, cur]);
  }
  // fromEntries defines own data properties, so a "__proto__" key cannot touch the prototype.
  return Object.fromEntries(entries);
}

// ------------------------------------------------------------------------------------------------ redaction

export interface SecretForRedaction {
  name: string;
  value: string;
}

/** Every spelling of a secret that can appear in text: raw, JSON-escaped, URL-encoded. */
function spellings(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(JSON.stringify(value).slice(1, -1));
  try {
    out.add(encodeURIComponent(value));
  } catch {
    /* lone surrogate */
  }
  return [...out].filter((s) => s.length > 0);
}

/** Replace every occurrence of a secret value with `‹secret:name›`. Longest values first. */
export function redactText(text: string, secrets: readonly SecretForRedaction[]): string {
  let out = text;
  const pairs = secrets
    .filter((s) => s.value.length > 0)
    .flatMap((s) => spellings(s.value).map((sp) => [sp, `‹secret:${s.name}›`] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [needle, mark] of pairs) if (out.includes(needle)) out = out.split(needle).join(mark);
  return out;
}

/** Redact secret values inside every string of a JSON-like value (keys included). */
export function redactDeep<T>(value: T, secrets: readonly SecretForRedaction[]): T {
  if (secrets.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, secrets), walk(x)]));
    return v;
  };
  return walk(value) as T;
}
