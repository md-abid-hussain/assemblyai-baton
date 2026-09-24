import "server-only";

import { nanoid } from "nanoid";

import { BatonError } from "../../core/contracts/errors";
import { hmacB64url, safeEqual } from "./crypto";

/**
 * Visitor identity (DESIGN §4.3).
 *
 * - Cookie `bvid` = `<id>.<hmac>` (HMAC-SHA256 with VISITOR_SECRET), httpOnly, secure, SameSite=Lax, 30 days. Set by
 *   `src/proxy.ts` on the first request (the proxy also injects it into that request's Cookie header, so the route
 *   handler of the very first request already sees it).
 * - Cookies blocked: `/api/cases` returns `visitorToken` (same signed format) and the client sends it back as
 *   `x-baton-visitor`. A valid header WINS over the cookie, because the proxy mints a fresh cookie on every request
 *   of a cookie-less browser. Never a 401 just because cookies are off.
 * - `ipKey = hmac(VISITOR_SECRET, dayUTC + ":" + firstHop(x-forwarded-for))`. The raw IP is never stored.
 *
 * Framework-free (plain `Request`/`Headers`) so the route handlers and the proxy share it and tests need no Next.
 */

export const VISITOR_COOKIE = "bvid";
export const VISITOR_HEADER = "x-baton-visitor";
export const VISITOR_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface Visitor {
  visitorId: string;
  ipKey: string;
  /** Where the identity came from: the signed header, the cookie, or freshly minted (no proxy ran). */
  via: "header" | "cookie" | "new";
}

function visitorSecret(secret?: string): string {
  const s = secret ?? process.env.VISITOR_SECRET?.trim();
  if (!s) throw new BatonError("E_INTERNAL", "VISITOR_SECRET is not configured (value never printed)");
  return s;
}

/** `<id>.<hmac>`: the cookie value and the `x-baton-visitor` token. */
export function signVisitorId(visitorId: string, secret?: string): string {
  return `${visitorId}.${hmacB64url(visitorSecret(secret), `bvid:${visitorId}`)}`;
}

/** Same format as the cookie; returned by POST /api/cases as `visitorToken` for cookie-less browsers. */
export const issueVisitorToken = (visitorId: string, secret?: string): string => signVisitorId(visitorId, secret);

/** The visitor id of a signed value, or null when the value is missing, malformed or forged. */
export function verifyVisitorValue(value: string | null | undefined, secret?: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  if (!ID_RE.test(id)) return null;
  const expected = signVisitorId(id, secret);
  return safeEqual(expected, value) ? id : null;
}

export function newVisitorId(): string {
  return nanoid();
}

/** Parse one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** The first hop of x-forwarded-for (else x-real-ip, else "unknown"). */
export function firstHop(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** `ipKey = hmac(VISITOR_SECRET, dayUTC + ":" + firstHop)`, truncated to 22 chars (132 bits). */
export function ipKeyOf(req: { headers: Headers }, opts: { now?: number; secret?: string } = {}): string {
  const day = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  return hmacB64url(visitorSecret(opts.secret), `ip:${day}:${firstHop(req.headers)}`).slice(0, 22);
}

/**
 * The request's visitor: a valid `x-baton-visitor` header first, then the `bvid` cookie, else a fresh id (`via:"new"`,
 * only when no proxy ran, e.g. a direct call in tests). Never throws for a missing identity.
 */
export function requireVisitor(req: { headers: Headers }, opts: { now?: number; secret?: string } = {}): Visitor {
  const ipKey = ipKeyOf(req, opts);
  const fromHeader = verifyVisitorValue(req.headers.get(VISITOR_HEADER), opts.secret);
  if (fromHeader) return { visitorId: fromHeader, ipKey, via: "header" };
  const fromCookie = verifyVisitorValue(readCookie(req.headers.get("cookie"), VISITOR_COOKIE), opts.secret);
  if (fromCookie) return { visitorId: fromCookie, ipKey, via: "cookie" };
  return { visitorId: newVisitorId(), ipKey, via: "new" };
}

/** `Set-Cookie` value for a visitor (the proxy uses NextResponse.cookies; routes may use this string). */
export function visitorSetCookie(visitorId: string, opts: { secure?: boolean; secret?: string } = {}): string {
  const secure = opts.secure ?? process.env.NODE_ENV === "production";
  return [
    `${VISITOR_COOKIE}=${encodeURIComponent(signVisitorId(visitorId, opts.secret))}`,
    "Path=/",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_S}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
