/**
 * contracts/v3/errors.ts - the SaaS-layer error codes and their HTTP statuses (SAAS §14, §6.3, §6.4, §10.4).
 * WP19; frozen at C3. The v1 `ERROR_CODES` (`src/core/contracts/errors.ts`) are untouched and still cover the
 * runtime; these codes cover identity, tenancy, plans and the public API.
 */

export const V3_ERROR_STATUS = {
  E_AUTH_REQUIRED: 401,
  E_ACCOUNT_REQUIRED: 403,
  E_FORBIDDEN: 403,
  E_SCOPE: 403,
  E_CSRF: 403,
  E_USE_APP_API: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_VALIDATION: 400,
  E_UNPROCESSABLE: 422,
  E_PLAN_LIMIT: 402,
  E_RATE_LIMITED: 429,
  /**
   * Load shedding, not throttling: the global compile bucket in front of `POST /blueprints/validate` and
   * `POST /relays/:id/compile` (§10.4, §6.4, Threat Table "CPU exhaustion"). Answered with `Retry-After: 1`;
   * the CLI retries it once automatically. WP22 owns the bucket and throws this.
   *
   * §14's own code block predates the v3.1 review (§17 item I3) and omits it; §6.4/§10.4 are the current spec.
   */
  E_BUSY: 503,
  E_BILLING_UNAVAILABLE: 503,
} as const;
export type V3ErrorCode = keyof typeof V3_ERROR_STATUS;

export const V3_ERROR_CODES = Object.keys(V3_ERROR_STATUS) as readonly V3ErrorCode[];

export const isV3ErrorCode = (v: unknown): v is V3ErrorCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(V3_ERROR_STATUS, v);
