/**
 * server/qa/auth.ts - takeover-scoped authorization for WP8's routes #20 and #21 (DESIGN §4.3, §8.2).
 *
 * The default verifies the case token itself (JWT HS256, `CASE_TOKEN_SECRET`, claims `{sub, vid, scp, tko}`) and
 * requires `tko` = the takeover and the `case` scope. WP2's `requireCase()` also checks `vid` against the visitor
 * cookie; the integrator swaps it in at G1 through `configureWp8({ authorizeTakeover })` (docs/notes/requests).
 * Missing/invalid/expired token → 401 `E_CASE_TOKEN`; a valid token for another takeover → 403 `E_FORBIDDEN`.
 */
import "server-only";

import { errors as joseErrors, jwtVerify } from "jose";

import { BatonError } from "../../core/contracts/errors";

export interface TakeoverPrincipal { caseId: string; visitorId: string; takeoverId: string }
export type AuthorizeTakeover = (req: { headers: Headers }, takeoverId: string) => Promise<TakeoverPrincipal>;

export function bearerToken(req: { headers: Headers }): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim() || null;
}

/** Verify a takeover-scoped case token. `secret` defaults to `CASE_TOKEN_SECRET`. */
export function tokenAuthorizer(opts: { secret?: () => string | undefined; now?: () => number } = {}): AuthorizeTakeover {
  return async (req, takeoverId) => {
    const token = bearerToken(req);
    if (!token) throw new BatonError("E_CASE_TOKEN", "Missing case token.");
    const secret = (opts.secret ?? (() => process.env.CASE_TOKEN_SECRET?.trim()))();
    if (!secret) throw new BatonError("E_INTERNAL", "CASE_TOKEN_SECRET is not configured.");
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ["HS256"],
        ...(opts.now ? { currentDate: new Date(opts.now()) } : {}),
      }));
    } catch (e) {
      if (e instanceof joseErrors.JWTExpired) throw new BatonError("E_CASE_TOKEN", "The case token has expired: reload the call to continue.");
      throw new BatonError("E_CASE_TOKEN", "The case token is not valid.");
    }
    const { sub, vid, scp, tko } = payload;
    if (typeof sub !== "string" || typeof vid !== "string" || !Array.isArray(scp)) throw new BatonError("E_CASE_TOKEN", "The case token is malformed.");
    if (!scp.includes("case")) throw new BatonError("E_FORBIDDEN", "The token lacks the required scope.");
    if (tko !== takeoverId) throw new BatonError("E_FORBIDDEN", "The token is not for this takeover.");
    return { caseId: sub, visitorId: vid, takeoverId };
  };
}
