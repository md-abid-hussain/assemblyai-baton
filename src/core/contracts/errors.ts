/**
 * contracts/errors.ts - error codes, labelled fallbacks and the API error envelope (DESIGN §4.1, §7.4).
 * Frozen at G0. `FallbackKind` is defined here (not in events.ts) so errors.ts has no imports; events.ts re-exports it.
 */
import { z } from "zod";

export const ERROR_CODES = [
  "E_BUDGET", "E_RATE_LIMITED", "E_QUEUE_TIMEOUT", "E_MODE_REPLAY_ONLY", "E_MAINTENANCE",
  "E_STT_AUTH", "E_STT_RATE", "E_STT_INPUT", "E_STT_TRANSIENT", "E_STT_INACTIVITY", "E_AAI_BALANCE",
  "E_VA_AUTH", "E_VA_CONFIG", "E_VA_CAPACITY", "E_VA_SILENT", "E_VA_TIMEOUT", "E_VA_TRANSIENT",
  "E_OPENAI_TIMEOUT", "E_OPENAI_REFUSAL", "E_OPENAI_RATE", "E_POLAR_API", "E_POLAR_SIG",
  "E_MIC_DENIED", "E_AUDIO_LOCKED", "E_CASE_TOKEN", "E_CASE_STATE", "E_DB", "E_INTERNAL",
  // G0: the §4.4 conventions name 400 validation, 403 scope and 404 responses; these are their codes.
  "E_BAD_REQUEST", "E_FORBIDDEN", "E_NOT_FOUND",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Every labelled fallback of DESIGN §7.5. */
export const FALLBACK_KINDS = ["cached_turn_replay", "recorded_ai_session", "typed_tts", "mock_payment", "hosted_checkout"] as const;
export const FallbackKindSchema = z.enum(FALLBACK_KINDS);
export type FallbackKind = z.infer<typeof FallbackKindSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    retryAfterMs: z.number().nonnegative().optional(),
    fallback: FallbackKindSchema.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Default HTTP status per code (DESIGN §4.4 conventions: 400 validation, 401 auth, 403 scope, 404, 409 state,
 * 429 rate limit / queue, 503 mode/budget, 502 upstream). Routes may override (e.g. 403 for a scope mismatch).
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  E_BUDGET: 503,
  E_RATE_LIMITED: 429,
  E_QUEUE_TIMEOUT: 429,
  E_MODE_REPLAY_ONLY: 503,
  E_MAINTENANCE: 503,
  E_STT_AUTH: 502,
  E_STT_RATE: 429,
  E_STT_INPUT: 400,
  E_STT_TRANSIENT: 502,
  E_STT_INACTIVITY: 502,
  E_AAI_BALANCE: 503,
  E_VA_AUTH: 502,
  E_VA_CONFIG: 500,
  E_VA_CAPACITY: 503,
  E_VA_SILENT: 502,
  E_VA_TIMEOUT: 504,
  E_VA_TRANSIENT: 502,
  E_OPENAI_TIMEOUT: 504,
  E_OPENAI_REFUSAL: 502,
  E_OPENAI_RATE: 429,
  E_POLAR_API: 502,
  E_POLAR_SIG: 403,
  E_MIC_DENIED: 400,
  E_AUDIO_LOCKED: 400,
  E_CASE_TOKEN: 401,
  E_CASE_STATE: 409,
  E_DB: 500,
  E_INTERNAL: 500,
  E_BAD_REQUEST: 400,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
};

/** Build an `ApiError` body (pure; routes wrap it in a Response with ERROR_HTTP_STATUS[code]). */
export function apiError(code: ErrorCode, message: string, extra: { retryAfterMs?: number; fallback?: FallbackKind } = {}): ApiError {
  return {
    error: {
      code,
      message,
      ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
      ...(extra.fallback !== undefined ? { fallback: extra.fallback } : {}),
    },
  };
}

/** A thrown error that carries an ErrorCode (e.g. `validateFirstUpdate` throws `E_VA_CONFIG`). */
export class BatonError extends Error {
  readonly code: ErrorCode;
  readonly fallback: FallbackKind | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(code: ErrorCode, message: string, opts: { fallback?: FallbackKind; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BatonError";
    this.code = code;
    this.fallback = opts.fallback;
    this.retryAfterMs = opts.retryAfterMs;
  }
  toApiError(): ApiError {
    return apiError(this.code, this.message, {
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.fallback !== undefined ? { fallback: this.fallback } : {}),
    });
  }
}

export const isBatonError = (e: unknown): e is BatonError => e instanceof BatonError;
