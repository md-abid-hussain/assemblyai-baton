import "server-only";

/**
 * The CSRF second layer (SAAS §3.9). WP19.
 *
 * Better Auth checks `Origin` on its own endpoints. **Our** session-authenticated non-GET routes
 * (`/api/app/**`, `/api/v1/**` with a session, `/api/relays/**` and the other org routes) additionally require
 * `Origin` equal to `APP_URL`, **or** `Sec-Fetch-Site: same-origin`; otherwise 403 `E_CSRF`. `SameSite=Lax` is the
 * second layer. API-key requests never read cookies, so they are CSRF-immune and are exempt.
 *
 * Zerops terminates TLS at its shared L7 balancer, so `req.url`'s scheme is not trustworthy: the comparison is
 * against the configured `APP_URL` (plus localhost in development), never against the request's own host header.
 */
import { SaasError } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Origin-only form of a URL (`https://host:port`), or null when it does not parse. */
function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || v === "null") return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

const isLocalOrigin = (origin: string): boolean => {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
};

/**
 * The origins a non-GET request may come from: `APP_URL`, normalised to an origin.
 * Passing the `appUrl` key at all overrides the environment — including passing it as `undefined`, which is how a
 * caller (or a test) says "there is no APP_URL" without mutating `process.env`.
 */
export function trustedOrigins(
  opts: { appUrl?: string | undefined; nodeEnv?: string | undefined } = {},
): readonly string[] {
  const appUrl = originOf("appUrl" in opts ? opts.appUrl : process.env.APP_URL);
  return appUrl ? [appUrl] : [];
}

export interface SameOriginResult {
  ok: boolean;
  /** Why it passed or failed; goes into the log line, never into the response body. */
  reason: "safe_method" | "sec_fetch_site" | "origin_match" | "no_app_url" | "dev_localhost" | "origin_mismatch" | "origin_missing";
}

/**
 * Decide the same-origin question without throwing, so `requirePrincipal` can log the reason.
 *
 * Passing conditions, in order:
 *  1. a safe method (GET/HEAD/OPTIONS);
 *  2. `Sec-Fetch-Site: same-origin` (sent by every browser that matters; not forgeable by a page);
 *  3. `Origin` equal to `APP_URL`;
 *  4. development only: `Origin` on localhost, or `APP_URL` unset (so local and test runs are not blocked).
 */
export function checkSameOrigin(
  req: { method?: string; headers: Headers },
  opts: { appUrl?: string | undefined; nodeEnv?: string | undefined } = {},
): SameOriginResult {
  const method = (req.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true, reason: "safe_method" };

  if (req.headers.get("sec-fetch-site") === "same-origin") return { ok: true, reason: "sec_fetch_site" };

  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const allowed = trustedOrigins(opts);
  const origin = originOf(req.headers.get("origin"));

  if (origin && allowed.includes(origin)) return { ok: true, reason: "origin_match" };
  if (nodeEnv !== "production") {
    if (origin && isLocalOrigin(origin)) return { ok: true, reason: "dev_localhost" };
    if (allowed.length === 0) return { ok: true, reason: "no_app_url" };
  }
  return { ok: false, reason: origin ? "origin_mismatch" : "origin_missing" };
}

/** Throws `SaasError("E_CSRF")` when the request fails `checkSameOrigin`. */
export function assertSameOrigin(
  req: { method?: string; headers: Headers },
  opts: { appUrl?: string | undefined; nodeEnv?: string | undefined } = {},
): void {
  if (checkSameOrigin(req, opts).ok) return;
  throw new SaasError("E_CSRF", "This request did not come from the app. Reload the page and try again.");
}
