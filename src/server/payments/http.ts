import "server-only";

import type { z } from "zod";

import { apiError, BatonError, ERROR_HTTP_STATUS, type ErrorCode } from "../../core/contracts/errors";
import { EnvError } from "../env";
import { log } from "../log";

/**
 * Route plumbing for WP6's routes (#14–#18): JSON bodies, `ApiError` responses with the DESIGN §4.4 statuses, zod
 * body parsing (400 `E_BAD_REQUEST`), and a wrapper that maps thrown `BatonError`s and hides internals.
 * (Same behaviour as WP2's `src/server/auth/http.ts`; the integrator may switch these routes to it after G1.)
 */

const httpLog = log.child({ component: "http", wp: "wp6" });

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(code: ErrorCode, message: string, opts: { status?: number; retryAfterSec?: number } = {}): Response {
  const headers = new Headers();
  if (opts.retryAfterSec !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(opts.retryAfterSec))));
  const extra = opts.retryAfterSec !== undefined ? { retryAfterMs: Math.max(0, opts.retryAfterSec * 1000) } : {};
  return json(apiError(code, message, extra), { status: opts.status ?? ERROR_HTTP_STATUS[code], headers });
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BatonError("E_BAD_REQUEST", "The request body is not valid JSON.");
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
      .join("; ");
    throw new BatonError("E_BAD_REQUEST", `Invalid request: ${where}`);
  }
  return r.data;
}

export type Params<P extends Record<string, string>> = { params: Promise<P> };

export function route<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: Params<P>) => Promise<Response>,
): (req: Request, ctx: Params<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof BatonError) {
        const retry = e.retryAfterMs !== undefined ? { retryAfterSec: e.retryAfterMs / 1000 } : {};
        return errorResponse(e.code, e.message, retry);
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

/** 429 with Retry-After when the limiter says no. */
export function rateLimited(retryAfterSec: number): never {
  throw new BatonError("E_RATE_LIMITED", "Too many requests: slow down.", { retryAfterMs: Math.max(1, retryAfterSec) * 1000 });
}
