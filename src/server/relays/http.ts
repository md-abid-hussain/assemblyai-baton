import "server-only";

import { isBatonError } from "../../core/contracts/errors";
import { V2_ERROR_STATUS, type LintIssue, type V2ErrorCode } from "../../core/contracts/v2";
import { batonErrorResponse, errorResponse, json, type RouteCtx } from "../auth/http";
import { EnvError } from "../env";
import { log } from "../log";
import { isSaasError, saasErrorResponse } from "../saas/errors";

/**
 * Route plumbing for WP14b's `/api/relays/**`: WP12's `src/server/auth/http.ts` conventions (JSON + no-store,
 * `ApiError` bodies, Retry-After, BatonError → its status, EnvError → 503, anything else → a logged 500), plus the v2
 * error codes (`V2_ERROR_CODES`, `ApiErrorV2`), which `BatonError` cannot carry: `RelayError`.
 */
export class RelayError extends Error {
  constructor(
    readonly code: V2ErrorCode,
    message: string,
    readonly extra: { lint?: LintIssue[]; body?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/**
 * Recognised by **name + code, not by `instanceof` alone** — see `isBatonError`
 * (`src/core/contracts/errors.ts`) for why one process can hold two copies of this class. QA-FIX.
 */
export const isRelayError = (e: unknown): e is RelayError => {
  if (e instanceof RelayError) return true;
  if (typeof e !== "object" || e === null) return false;
  const { name, code, message } = e as { name?: unknown; code?: unknown; message?: unknown };
  return name === "RelayError" && typeof message === "string" && typeof code === "string" && Object.hasOwn(V2_ERROR_STATUS, code);
};

export function relayErrorResponse(e: RelayError): Response {
  const extra = e.extra ?? {};
  return json(
    { ...(extra.body ?? {}), error: { code: e.code, message: e.message, ...(extra.lint ? { lint: extra.lint } : {}) } },
    { status: V2_ERROR_STATUS[e.code] },
  );
}

const httpLog = log.child({ component: "relays-http" });

export function relayRoute<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      // WP14b·4: `requirePrincipal` and the plan checks raise `SaasError`, which keeps its own §6.3 envelope
      // (`{error:{code,message,docs_url}}` + the 401's `{start}`). The v2 codes below are untouched, so a v2 client
      // that never authenticates sees byte-identical responses.
      //
      // QA-FIX: these three are the `is*Error` **predicates**, never a bare `instanceof`. `registry.ownRow()` and
      // `engine/run.ts`'s `resolveRun` throw `BatonError("E_NOT_FOUND")` from their own chunks, and a cross-tenant
      // `PUT`/`DELETE /api/relays/:id` answered 500 `E_INTERNAL` instead of the 404 they had correctly raised.
      if (isSaasError(e)) return saasErrorResponse(e);
      if (isRelayError(e)) return relayErrorResponse(e);
      if (isBatonError(e)) return batonErrorResponse(e);
      if (e instanceof EnvError) {
        httpLog.error("route misconfigured", { route: name, err: e });
        return errorResponse("E_INTERNAL", "The server is missing configuration.", { status: 503 });
      }
      httpLog.error("route failed", { route: name, err: e });
      return errorResponse("E_INTERNAL", "Something went wrong on our side.");
    }
  };
}

export { json, readJson, paramsOf, type RouteCtx } from "../auth/http";
