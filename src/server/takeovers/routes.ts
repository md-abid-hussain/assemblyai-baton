import "server-only";

import type { z } from "zod";

import {
  ArmRequestSchema,
  CompileRequestSchema,
  EndTakeoverRequestSchema,
  TakeoverEventsRequestSchema,
  type ArmResponse,
  type EndTakeoverResponse,
} from "../../core/contracts/api";
import { apiError, BatonError, ERROR_HTTP_STATUS, isBatonError, type ErrorCode } from "../../core/contracts/errors";
import type { RateLimiter, TakeoverService } from "../../core/contracts/services";

/**
 * Route handlers #9, #11, #12, #13 (DESIGN §4.4), as factories over injected dependencies, so they are unit-testable
 * with a fake auth and a fake service, and so the Next route files stay one line each.
 *
 * Auth (DESIGN §4.3, §8.2): #9 takes the case token (`sub` = body.caseId, the caller's visitor); #11–#13 take the
 * takeover token re-issued by #9 (`tko` = the path id). #13 is also sent on pagehide with a keepalive fetch (G0).
 *
 * Rate limits (§4.4): #11 3/takeover, #12 30/min, #13 2/takeover. #9's "3/case" is enforced by the service
 * (MAX_TAKEOVERS_PER_CASE, counted in the DB inside the arm transaction, so refused arms do not use it up); the
 * limiter adds an abuse ceiling of 10 arm requests per case per hour. A limiter error fails OPEN (logged): a
 * heartbeat or an /end must never be lost to a rate-limit table hiccup.
 */

export interface TakeoverAuth {
  caseId: string;
  visitorId: string;
  ipKey: string;
  takeoverId: string | null;
}

export interface TakeoverRouteDeps {
  service: TakeoverService;
  /** WP2 `requireCase(req, {caseId?, takeoverId?})`: 401 E_CASE_TOKEN / 403 E_FORBIDDEN on mismatch. */
  requireCase(req: Request, want: { caseId?: string; takeoverId?: string }): Promise<TakeoverAuth>;
  /** WP2 `getRateLimiter()`; null = no rate limiting (tests, or before G1). */
  rateLimiter: RateLimiter | null;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export const TAKEOVER_RATE = {
  arm: { bucket: "takeover_arm", limit: 10, windowSec: 3600 },
  compile: { bucket: "takeover_compile", limit: 3, windowSec: 3600 },
  events: { bucket: "takeover_events", limit: 30, windowSec: 60 },
  end: { bucket: "takeover_end", limit: 2, windowSec: 3600 },
} as const;

type RouteCtx = { params: Promise<Record<string, string>> };

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(e: BatonError): Response {
  const headers = new Headers();
  if (e.retryAfterMs !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
  return jsonResponse(
    apiError(e.code, e.message, {
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(e.fallback !== undefined ? { fallback: e.fallback } : {}),
    }),
    { status: ERROR_HTTP_STATUS[e.code], headers },
  );
}

async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
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

async function takeoverIdOf(ctx: RouteCtx | undefined): Promise<string> {
  const id = ctx ? (await ctx.params)?.id : undefined;
  if (!id) throw new BatonError("E_NOT_FOUND", "Unknown takeover.");
  return id;
}

async function limit(d: TakeoverRouteDeps, spec: { bucket: string; limit: number; windowSec: number }, key: string, message: string): Promise<void> {
  if (!d.rateLimiter) return;
  let r: { ok: boolean; retryAfterSec: number };
  try {
    r = await d.rateLimiter.hit(spec.bucket, key, spec.limit, spec.windowSec);
  } catch (err) {
    d.log?.("warn", "rate limiter unavailable (fail open)", { bucket: spec.bucket, err: String(err) });
    return;
  }
  if (!r.ok) throw new BatonError("E_RATE_LIMITED", message, { retryAfterMs: Math.max(1, r.retryAfterSec) * 1000 });
}

function wrap(name: string, deps: () => TakeoverRouteDeps, fn: (req: Request, ctx: RouteCtx | undefined, d: TakeoverRouteDeps) => Promise<Response>) {
  return async (req: Request, ctx?: RouteCtx): Promise<Response> => {
    let d: TakeoverRouteDeps | null = null;
    try {
      d = deps();
      return await fn(req, ctx, d);
    } catch (e) {
      if (isBatonError(e)) return errorResponse(e);
      d?.log?.("error", "takeover route failed", { route: name, err: e instanceof Error ? e.message : String(e) });
      return errorResponse(new BatonError("E_INTERNAL", "Something went wrong on our side."));
    }
  };
}

/** #9 POST /api/takeovers. */
export function armHandler(deps: () => TakeoverRouteDeps) {
  return wrap("takeovers.arm", deps, async (req, _ctx, d) => {
    const body = await readBody(req, ArmRequestSchema);
    const auth = await d.requireCase(req, { caseId: body.caseId });
    await limit(d, TAKEOVER_RATE.arm, body.caseId, "Too many passes of the baton on this call; wait a moment.");
    const res: ArmResponse = await d.service.arm({ ...body, visitorId: auth.visitorId });
    return jsonResponse(res);
  });
}

/** #11 POST /api/takeovers/[id]/compile → CompiledTakeover (validated by validateFirstUpdate). */
export function compileHandler(deps: () => TakeoverRouteDeps) {
  return wrap("takeovers.compile", deps, async (req, ctx, d) => {
    const id = await takeoverIdOf(ctx);
    const body = await readBody(req, CompileRequestSchema);
    await d.requireCase(req, { takeoverId: id });
    await limit(d, TAKEOVER_RATE.compile, id, "This pass was already compiled.");
    return jsonResponse(await d.service.compile(id, body.drain));
  });
}

/** #12 POST /api/takeovers/[id]/events → {ok:true}. */
export function eventsHandler(deps: () => TakeoverRouteDeps) {
  return wrap("takeovers.events", deps, async (req, ctx, d) => {
    const id = await takeoverIdOf(ctx);
    const body = await readBody(req, TakeoverEventsRequestSchema);
    await d.requireCase(req, { takeoverId: id });
    await limit(d, TAKEOVER_RATE.events, id, "Too many takeover events.");
    await d.service.recordEvents(id, body);
    return jsonResponse({ ok: true });
  });
}

/** #13 POST /api/takeovers/[id]/end → {ok:true, verificationJobId}. */
export function endHandler(deps: () => TakeoverRouteDeps) {
  return wrap("takeovers.end", deps, async (req, ctx, d) => {
    const id = await takeoverIdOf(ctx);
    const body = await readBody(req, EndTakeoverRequestSchema);
    await d.requireCase(req, { takeoverId: id });
    await limit(d, TAKEOVER_RATE.end, id, "This takeover has already ended.");
    const r = await d.service.end(id, body);
    const res: EndTakeoverResponse = { ok: true, verificationJobId: r.verificationJobId };
    return jsonResponse(res);
  });
}

/** Status for a code (exported for tests and the client's error mapping). */
export const statusOf = (code: ErrorCode): number => ERROR_HTTP_STATUS[code];
