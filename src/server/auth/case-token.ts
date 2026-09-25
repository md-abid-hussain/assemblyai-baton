import "server-only";

import { errors as joseErrors, jwtVerify, SignJWT } from "jose";

import { BatonError } from "../../core/contracts/errors";
import { requireVisitor, type Visitor } from "./visitor";

/**
 * Per-case signed tokens (DESIGN §4.3, §8.2): JWT HS256 (`jose`) with CASE_TOKEN_SECRET.
 * Claims `{ sub: caseId, vid: visitorId, scp: ["case","tools"], tko?: takeoverId, exp: now + 45 min }`, sent as
 * `Authorization: Bearer <jwt>`. Every case/takeover/tool/payment route checks `sub` = the case, `vid` = the
 * request's visitor (cookie or `x-baton-visitor`), the scope, and `tko` where a takeover is named.
 *
 * Status mapping: missing/invalid/expired token → 401 `E_CASE_TOKEN`; a valid token for another visitor, case,
 * scope or takeover → 403 `E_FORBIDDEN`.
 */

export const CASE_TOKEN_TTL_S = 45 * 60;
export const CASE_SCOPES = ["case", "tools"] as const;
export type CaseScope = (typeof CASE_SCOPES)[number];
const ISSUER = "baton";

export interface CaseTokenClaims {
  caseId: string;
  visitorId: string;
  scopes: string[];
  takeoverId: string | null;
  expiresAt: number;
}

export interface CaseAuth extends CaseTokenClaims {
  ipKey: string;
  visitor: Visitor;
}

function key(secret?: string): Uint8Array {
  const s = secret ?? process.env.CASE_TOKEN_SECRET?.trim();
  if (!s) throw new BatonError("E_INTERNAL", "CASE_TOKEN_SECRET is not configured (value never printed)");
  return new TextEncoder().encode(s);
}

export async function issueCaseToken(i: {
  caseId: string;
  visitorId: string;
  takeoverId?: string | null;
  scopes?: readonly string[];
  ttlSec?: number;
  now?: number;
  secret?: string;
}): Promise<string> {
  const nowS = Math.floor((i.now ?? Date.now()) / 1000);
  const payload: Record<string, unknown> = { vid: i.visitorId, scp: [...(i.scopes ?? CASE_SCOPES)] };
  if (i.takeoverId) payload.tko = i.takeoverId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(i.caseId)
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + (i.ttlSec ?? CASE_TOKEN_TTL_S))
    .sign(key(i.secret));
}

/** Verify signature, algorithm and expiry. Throws 401 `E_CASE_TOKEN`. */
export async function verifyCaseToken(token: string, opts: { now?: number; secret?: string } = {}): Promise<CaseTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(opts.secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      ...(opts.now !== undefined ? { currentDate: new Date(opts.now) } : {}),
    });
    const vid = payload.vid;
    const scp = payload.scp;
    if (typeof payload.sub !== "string" || typeof vid !== "string" || !Array.isArray(scp) || typeof payload.exp !== "number") {
      throw new BatonError("E_CASE_TOKEN", "The case token is malformed.");
    }
    return {
      caseId: payload.sub,
      visitorId: vid,
      scopes: scp.filter((s): s is string => typeof s === "string"),
      takeoverId: typeof payload.tko === "string" ? payload.tko : null,
      expiresAt: payload.exp * 1000,
    };
  } catch (e) {
    if (e instanceof BatonError) throw e;
    if (e instanceof joseErrors.JWTExpired) throw new BatonError("E_CASE_TOKEN", "The case token has expired: reload the call to continue.");
    throw new BatonError("E_CASE_TOKEN", "The case token is not valid.");
  }
}

export function bearerOf(req: { headers: Headers }): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Authorize a case-scoped request. `caseId` (from the path or body) must equal `sub`; `takeoverId` (when given) must
 * equal `tko`; `scope` must be granted; `vid` must equal the request's visitor.
 */
export async function requireCase(
  req: { headers: Headers },
  want: { caseId?: string; takeoverId?: string; scope?: CaseScope; now?: number; secret?: string; visitorSecret?: string } = {},
): Promise<CaseAuth> {
  const token = bearerOf(req);
  if (!token) throw new BatonError("E_CASE_TOKEN", "Missing case token.");
  const claims = await verifyCaseToken(token, {
    ...(want.now !== undefined ? { now: want.now } : {}),
    ...(want.secret !== undefined ? { secret: want.secret } : {}),
  });
  const visitor = requireVisitor(req, {
    ...(want.now !== undefined ? { now: want.now } : {}),
    ...(want.visitorSecret !== undefined ? { secret: want.visitorSecret } : {}),
  });
  if (claims.visitorId !== visitor.visitorId) throw new BatonError("E_FORBIDDEN", "This case belongs to another visitor.");
  if (want.caseId !== undefined && claims.caseId !== want.caseId) throw new BatonError("E_FORBIDDEN", "The token is for another case.");
  if (!claims.scopes.includes(want.scope ?? "case")) throw new BatonError("E_FORBIDDEN", "The token lacks the required scope.");
  if (want.takeoverId !== undefined && claims.takeoverId !== want.takeoverId) {
    throw new BatonError("E_FORBIDDEN", "The token is not for this takeover.");
  }
  return { ...claims, ipKey: visitor.ipKey, visitor };
}
