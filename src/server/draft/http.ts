/**
 * server/draft/http.ts - route plumbing shared by `/api/drafts/**` and `/api/sim-calls/**` (WP17·3).
 *
 * The same conventions as WP14b's `relayRoute` (JSON + no-store, `ApiError` bodies, `EnvError` → 503, anything else
 * a logged 500), plus WP19's `SaasError`, which these routes raise for the plan checks and for `requirePrincipal`.
 * A `SaasError` keeps its own §6.3 envelope; a v1 `BatonError` keeps the v1 one. Nothing else may leak.
 *
 * `wp17Principal` is the ONE place these routes read tenancy from: `orgId` (never a body field) plus the device
 * fields the v2 visitor/ipKey buckets still need.
 */
import "server-only";

import { BatonError, isBatonError } from "../../core/contracts/errors";
import type { Principal } from "../../core/contracts/v3/identity";
import type { Permission } from "../../core/contracts/v3/permissions";
import { errorResponse, type RouteCtx } from "../auth/http";
import { EnvError } from "../env";
import { log } from "../log";
import { isRelayError, relayErrorResponse } from "../relays/http";
import { isSaasError, SaasError, saasErrorResponse } from "../saas/errors";
import { requirePrincipal } from "../saas/principal";

const httpLog = log.child({ component: "wp17-http" });

export interface Wp17Who {
  ws: string;
  visitorId: string;
  ipKey: string;
  principal: Principal;
}

/**
 * The principal of a drafting or simulation request. `orgId` is `ws`: drafts, sims and dry runs are org-scoped
 * (TASKS-v3 §7), and a visitor's org is still `ws_<visitorId>` while `TENANCY_MODE` is `legacy`.
 */
export async function wp17Principal(req: Request, perm: Permission): Promise<Wp17Who> {
  const p = await requirePrincipal(req, { perm });
  if (!p.orgId) throw new SaasError("E_AUTH_REQUIRED", "Start a free workspace to continue.");
  return { ws: p.orgId, visitorId: p.visitorId, ipKey: p.ipKey, principal: p };
}

export function wp17Route<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      // QA-FIX: predicates, not `instanceof` — see `isBatonError`.
      if (isSaasError(e)) return saasErrorResponse(e);
      if (isRelayError(e)) return relayErrorResponse(e);
      if (isBatonError(e)) {
        return errorResponse(e.code, e.message, {
          ...(e.retryAfterMs !== undefined ? { retryAfterSec: e.retryAfterMs / 1000 } : {}),
          ...(e.fallback !== undefined ? { fallback: e.fallback } : {}),
        });
      }
      if (e instanceof EnvError) {
        httpLog.error("route misconfigured", { route: name, err: e });
        return errorResponse("E_INTERNAL", "The server is missing configuration.", { status: 503 });
      }
      httpLog.error("route failed", { route: name, err: e });
      return errorResponse("E_INTERNAL", "Something went wrong on our side.");
    }
  };
}

export { json, readJson, type RouteCtx } from "../auth/http";
