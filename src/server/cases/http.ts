import "server-only";

import type { z } from "zod";

import { apiError, BatonError, ERROR_HTTP_STATUS } from "../../core/contracts/errors";
import type { RateLimiter } from "../../core/contracts/services";
import { EnvError } from "../env";
import { log } from "../log";

/**
 * Route plumbing for WP3's handlers (#3, #4, #8): the same conventions as WP2's `src/server/auth/http.ts`
 * (JSON + no-store, ApiError bodies with the DESIGN §4.4 status, Retry-After, 400 on a schema failure, BatonError →
 * its status, anything else → a logged 500 that never leaks internals). Kept local so these routes do not depend on
 * wp/wp2 before G1.
 */

const httpLog = log.child({ component: "cases-http" });

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorOf(e: BatonError): Response {
  const headers = new Headers();
  if (e.retryAfterMs !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
  return json(
    apiError(e.code, e.message, {
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(e.fallback !== undefined ? { fallback: e.fallback } : {}),
    }),
    { status: ERROR_HTTP_STATUS[e.code], headers },
  );
}

export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
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
    const where = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new BatonError("E_BAD_REQUEST", `Invalid request: ${where}`);
  }
  return r.data;
}

/** Hit each bucket in order; the first refusal is a 429 `E_RATE_LIMITED` with Retry-After. */
export async function enforce(limiter: RateLimiter, specs: { bucket: string; limit: number; windowSec: number; key: string; message: string }[]): Promise<void> {
  for (const s of specs) {
    const r = await limiter.hit(s.bucket, s.key, s.limit, s.windowSec);
    if (!r.ok) throw new BatonError("E_RATE_LIMITED", s.message, { retryAfterMs: Math.max(1, r.retryAfterSec) * 1000 });
  }
}

export function route<C>(name: string, fn: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof BatonError) return errorOf(e);
      if (e instanceof EnvError) {
        httpLog.error("route misconfigured", { route: name, err: e });
        return json(apiError("E_INTERNAL", "The server is missing configuration."), { status: 503 });
      }
      httpLog.error("route failed", { route: name, err: e });
      return json(apiError("E_INTERNAL", "Something went wrong on our side."), { status: 500 });
    }
  };
}
