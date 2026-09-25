import "server-only";

import { BatonError } from "../../core/contracts/errors";
import { V2_ERROR_STATUS, type LintIssue, type V2ErrorCode } from "../../core/contracts/v2";
import { batonErrorResponse, errorResponse, json, type RouteCtx } from "../auth/http";
import { EnvError } from "../env";
import { log } from "../log";

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

export const isRelayError = (e: unknown): e is RelayError => e instanceof RelayError;

export function relayErrorResponse(e: RelayError): Response {
  return json(
    { ...(e.extra.body ?? {}), error: { code: e.code, message: e.message, ...(e.extra.lint ? { lint: e.extra.lint } : {}) } },
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
      if (e instanceof RelayError) return relayErrorResponse(e);
      if (e instanceof BatonError) return batonErrorResponse(e);
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
