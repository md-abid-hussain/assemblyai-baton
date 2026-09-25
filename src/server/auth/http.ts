import "server-only";

import type { z } from "zod";

import { apiError, BatonError, ERROR_HTTP_STATUS, type ErrorCode, type FallbackKind } from "../../core/contracts/errors";
import { EnvError } from "../env";
import { log } from "../log";

/**
 * Route plumbing shared by WP2's handlers (and usable by others): JSON responses, `ApiError` bodies with the
 * DESIGN §4.4 status mapping, body parsing with the contract zod schemas (400 `E_BAD_REQUEST`), and a wrapper that
 * turns thrown `BatonError`s into responses and anything else into a logged 500 (never leaking internals).
 */

const httpLog = log.child({ component: "http" });

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  opts: { status?: number; retryAfterSec?: number; fallback?: FallbackKind; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(opts.headers);
  if (opts.retryAfterSec !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(opts.retryAfterSec))));
  return json(
    apiError(code, message, {
      ...(opts.retryAfterSec !== undefined ? { retryAfterMs: Math.max(0, opts.retryAfterSec * 1000) } : {}),
      ...(opts.fallback !== undefined ? { fallback: opts.fallback } : {}),
    }),
    { status: opts.status ?? ERROR_HTTP_STATUS[code], headers },
  );
}

export function batonErrorResponse(e: BatonError): Response {
  return errorResponse(e.code, e.message, {
    ...(e.retryAfterMs !== undefined ? { retryAfterSec: e.retryAfterMs / 1000 } : {}),
    ...(e.fallback !== undefined ? { fallback: e.fallback } : {}),
  });
}

/** Parse a JSON body with a contract schema. Empty body → `{}`. Throws 400 `E_BAD_REQUEST`. */
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

export type RouteCtx<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

/** Wrap a route handler: BatonError → ApiError response; EnvError → 503 (names only); anything else → 500. */
export function handler<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
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

/** Route params (Next 16 passes them as a Promise). */
export async function paramsOf<P extends Record<string, string>>(ctx: RouteCtx<P> | undefined): Promise<Partial<P>> {
  if (!ctx) return {};
  return (await ctx.params) ?? {};
}
