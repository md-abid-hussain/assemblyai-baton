import "server-only";

/**
 * Route plumbing for `/api/app/**` (SAAS §3.5–§3.9, §6.3). WP19·3.
 *
 * Every handler in `app-orgs.ts`, `app-members.ts`, `app-invitations.ts`, `app-audit.ts` and `app-claim.ts` is
 * built with `appRoute()`, so five things are true of all of them without any of them saying so:
 *
 * 1. **`requirePrincipal` first** (§10.1 rule 1, TASKS-v3 §2 rule 13), with the permission the matrix names. The
 *    same-origin check and the 401/403 semantics come free with it.
 * 2. **The org is the principal's.** `appPrincipal` refuses a principal with no org and returns `orgId` as a
 *    non-null string, so no handler can read a tenant from a body, a query string or a path (§10.1 rule 3).
 *    A path segment naming *another* org is a 404, decided in `sameOrgOr404`, never a 403 — no existence leak.
 * 3. **API keys never reach `/api/app/**`** (§2.5): a key principal is refused with `E_SCOPE` before anything
 *    else runs. These routes are the browser's; the key surface is `/api/v1/**`.
 * 4. **Mutations are rate-limited** to §3.9's 120 per hour per user, counted on the user (or the visitor, for a
 *    guest with no account) rather than on the IP, so one office behind one egress address is not one bucket.
 * 5. **Errors leave as the §6.3 envelope.** A `SaasError` keeps its code and status; anything unexpected is a
 *    logged 500 that says nothing about the internals.
 */
import type { z } from "zod";

import type { Principal } from "../../core/contracts/v3/identity";
import type { Permission } from "../../core/contracts/v3/permissions";
import { errorResponse, json, paramsOf, type RouteCtx } from "../auth/http";
import { EnvError } from "../env";
import { getRateLimiter } from "../limits";
import { log } from "../log";
import { isSaasError, SaasError, saasErrorResponse } from "../saas/errors";
import { requirePrincipal, startPathFor, type PrincipalNeed } from "../saas/principal";
import { installIdentity } from "./index";

const appLog = log.child({ component: "app-api" });

/** §3.9: 120 mutations an hour per user on `/api/app/**`. Named here; WP12's `RATE` table is not WP19's to edit. */
export const APP_MUTATION_RATE = { bucket: "app-mut", limit: 120, windowSec: 3600 } as const;

/** A principal that is definitely acting inside an organization. */
export interface AppPrincipal extends Principal {
  orgId: string;
}

/**
 * Resolve the caller, refuse an API key, and guarantee an org.
 *
 * `need.perm` is checked by `requirePrincipal` itself (through `can()`), so the permission named at the call site
 * is the permission the §3.7 matrix enforces — there is no second, hand-rolled check to drift from the table.
 */
export async function appPrincipal(req: Request, need: PrincipalNeed = {}): Promise<AppPrincipal> {
  const p = await requirePrincipal(req, need);
  if (p.kind === "api_key") {
    throw new SaasError("E_SCOPE", "API keys work on /api/v1, not on the app API. Use a signed-in session.");
  }
  if (!p.orgId) {
    // The same 401 `applyNeed` raises, `start` path and all: a route that opted into `allowVisitor` to read a
    // device principal still owes the UI the path that turns a visitor into a guest (§2.3, §3.3).
    throw new SaasError("E_AUTH_REQUIRED", "Sign in or start a free workspace to continue.", {
      extra: { start: startPathFor(req) },
    });
  }
  return p as AppPrincipal;
}

/**
 * Spend one mutation from the caller's hourly budget. Called by every non-GET handler **after** the permission
 * check, so a forbidden request never costs the caller budget it was never going to use.
 */
export async function spendMutation(p: AppPrincipal): Promise<void> {
  const key = p.userId ?? p.visitorId;
  const r = await getRateLimiter().hit(
    APP_MUTATION_RATE.bucket,
    key,
    APP_MUTATION_RATE.limit,
    APP_MUTATION_RATE.windowSec,
  );
  if (!r.ok) {
    throw new SaasError("E_RATE_LIMITED", "That is a lot of changes in one hour. Try again shortly.", {
      retryAfterSec: r.retryAfterSec,
    });
  }
}

/** The target org of a path like `/api/app/orgs/:id` must be the acting org, or it does not exist for us. */
export function sameOrgOr404(p: AppPrincipal, orgId: string): void {
  if (orgId !== p.orgId) throw new SaasError("E_NOT_FOUND", "No such organization.");
}

/**
 * Parse a JSON body against a zod schema. The 400 carries **issue paths only** — never the offending values,
 * which is how a validation error stays safe to log and safe to show (§6.3, §10.5).
 */
export async function readAppJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SaasError("E_VALIDATION", "The request body is not valid JSON.");
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new SaasError("E_VALIDATION", "Some fields are not valid.", {
      issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path as (string | number)[], message: i.message })),
    });
  }
  return r.data;
}

/** A required path parameter, decoded. */
export async function paramOf<P extends Record<string, string>>(ctx: RouteCtx<P>, key: keyof P): Promise<string> {
  const params = await paramsOf(ctx);
  const v = params[key];
  if (!v) throw new SaasError("E_NOT_FOUND", "No such resource.");
  return decodeURIComponent(v);
}

/** A trimmed query-string value, or `undefined`. */
export function queryOf(req: Request, key: string): string | undefined {
  try {
    const v = new URL(req.url).searchParams.get(key)?.trim();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wrapper. `installIdentity()` runs first on every call: `/api/app/**` can legitimately be the first route a
 * process serves (a deep link into Settings), and the session resolver has to be registered before
 * `requirePrincipal` reads the registry.
 */
export function appRoute<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    installIdentity();
    try {
      return await fn(req, ctx);
    } catch (e) {
      // QA-FIX: predicate, not `instanceof` — see `isSaasError`.
      if (isSaasError(e)) return saasErrorResponse(e);
      if (e instanceof EnvError) {
        appLog.error("route misconfigured", { route: name, err: e });
        return errorResponse("E_INTERNAL", "The server is missing configuration.", { status: 503 });
      }
      appLog.error("route failed", { route: name, err: e });
      return errorResponse("E_INTERNAL", "Something went wrong on our side.");
    }
  };
}

export { json };
export type { RouteCtx };
