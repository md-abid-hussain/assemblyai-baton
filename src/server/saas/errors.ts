import "server-only";

/**
 * `SaasError` and `saasErrorResponse` (SAAS §14, §6.3). WP19.
 *
 * Every v3 route maps a thrown `SaasError` to the §6.3 envelope:
 *   `{ "error": { "code": "E_…", "message": "…", "docs_url": "<APP_URL>/docs/api#errors" } }`
 * with the status from `V3_ERROR_STATUS`. `extra` carries the few documented top-level companions, e.g. the
 * `{ start: "/start?next=…" }` of a 401 (§2.3), which the UI uses to begin a guest session.
 *
 * This sits beside (not on top of) the v1 `BatonError` / `batonErrorResponse` in `src/server/auth/http.ts`: v2
 * routes keep their `ApiError` envelope untouched, so no v2 behaviour or test changes.
 */
import { V3_ERROR_STATUS, type V3ErrorCode } from "../../core/contracts/v3/errors";

export interface SaasErrorOptions {
  /** Seconds; sets `Retry-After` and is echoed in the body. */
  retryAfterSec?: number;
  /** Extra top-level body fields (never secret values). */
  extra?: Record<string, unknown>;
  /** Validation detail: zod issue paths only, never the offending values. */
  issues?: { path: (string | number)[]; message: string }[];
  /** Codec / lint diagnostics (SAAS §5.3). */
  diagnostics?: unknown[];
  cause?: unknown;
}

export class SaasError extends Error {
  readonly code: V3ErrorCode;
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  readonly extra: Record<string, unknown> | undefined;
  readonly issues: { path: (string | number)[]; message: string }[] | undefined;
  readonly diagnostics: unknown[] | undefined;

  constructor(code: V3ErrorCode, message: string, opts: SaasErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SaasError";
    this.code = code;
    this.status = V3_ERROR_STATUS[code];
    this.retryAfterSec = opts.retryAfterSec;
    this.extra = opts.extra;
    this.issues = opts.issues;
    this.diagnostics = opts.diagnostics;
  }
}

export const isSaasError = (e: unknown): e is SaasError => e instanceof SaasError;

/** `<APP_URL>/docs/api#errors`, or the relative path when `APP_URL` is unset (local dev, tests). */
export function errorDocsUrl(appUrl: string | undefined = process.env.APP_URL): string {
  const base = appUrl?.trim().replace(/\/+$/, "");
  return `${base ?? ""}/docs/api#errors`;
}

/** The §6.3 error body. Exported so route tests and the OpenAPI examples can build it without a Response. */
export function saasErrorBody(e: SaasError, appUrl?: string): Record<string, unknown> {
  return {
    ...(e.extra ?? {}),
    error: {
      code: e.code,
      message: e.message,
      docs_url: errorDocsUrl(appUrl),
      ...(e.issues ? { issues: e.issues } : {}),
      ...(e.diagnostics ? { diagnostics: e.diagnostics } : {}),
    },
  };
}

export function saasErrorResponse(e: SaasError, init: { headers?: HeadersInit; appUrl?: string } = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  if (e.retryAfterSec !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(e.retryAfterSec))));
  return new Response(JSON.stringify(saasErrorBody(e, init.appUrl)), { status: e.status, headers });
}
