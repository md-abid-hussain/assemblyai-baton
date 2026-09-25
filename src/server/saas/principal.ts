import "server-only";

/**
 * `requirePrincipal` (SAAS §2.3, §14). WP19.
 *
 * Every org route resolves its `Principal` here and nowhere else: `orgId` never comes from a body, a query string,
 * a header or a blueprint file (SAAS §10.1 rule 3).
 *
 * **At C3 this file ships the LEGACY resolver only, and v2 behaviour is unchanged.** A request with no Better Auth
 * session gets a visitor principal with `orgId = "ws_" + visitorId`, `role = "owner"` and `plan = "guest"` — exactly
 * what `workspaceFor()` computes today. WP19·2 registers the session/API-key resolver through
 * `setPrincipalResolver()`, and `TENANCY_MODE` decides whether the legacy fallback still applies.
 *
 * The `need` checks (`applyNeed`) are deliberately separate from resolution, so the WP19·2 resolver reuses the same
 * 401/403 semantics rather than re-deriving them.
 */
import { nanoid } from "nanoid";

import { workspaceOf } from "../../core/contracts/v2/api";
import type { OrgKind, Principal } from "../../core/contracts/v3/identity";
import { can, type Permission } from "../../core/contracts/v3/permissions";
import { ipKeyOf, requireVisitor } from "../auth/visitor";
import { SaasError } from "./errors";
import { getPrincipalResolver } from "./ports";
import { assertSameOrigin } from "./same-origin";

export interface PrincipalNeed {
  perm?: Permission;
  /** Refuse anonymous accounts and visitors with `E_ACCOUNT_REQUIRED`. */
  account?: boolean;
  /** Allow a principal with no org (only the routes that genuinely work device-only). */
  allowVisitor?: boolean;
}

export const TENANCY_MODES = ["legacy", "orgs"] as const;
export type TenancyMode = (typeof TENANCY_MODES)[number];

/** `legacy` until G3 (SAAS §2.8, §15). Anything unrecognised reads as `legacy`: the safe direction. */
export function tenancyMode(raw: string | undefined = process.env.TENANCY_MODE): TenancyMode {
  return raw?.trim() === "orgs" ? "orgs" : "legacy";
}

/** A stable id for logs and for `Principal.requestId`; honours an upstream `x-request-id`. */
export function requestIdOf(req: { headers: Headers }): string {
  const given = req.headers.get("x-request-id")?.trim();
  return given && given.length <= 200 ? given : nanoid();
}

/**
 * The v2 device principal. `orgId` is the visitor's own workspace and the role is `owner`, because in v2 a visitor
 * owns everything in `ws_<visitorId>`; `plan` is `guest`, so the guest limits of SAAS §4.1 already apply.
 */
export function legacyVisitorPrincipal(req: { headers: Headers }): Principal {
  const visitor = requireVisitor(req);
  const orgId = workspaceOf(visitor.visitorId);
  return {
    kind: "visitor",
    userId: null,
    isAnonymous: false,
    orgId,
    orgKind: "guest" satisfies OrgKind,
    role: "owner",
    scopes: [],
    apiKeyId: null,
    plan: "guest",
    visitorId: visitor.visitorId,
    ipKey: visitor.ipKey,
    requestId: requestIdOf(req),
  };
}

/**
 * A principal with no org at all: used when a route explicitly allows visitors and the deployment has moved past
 * the legacy mapping (`TENANCY_MODE=orgs`), so no new `ws_<vid>` rows are created (SAAS §2.6).
 */
export function orglessVisitorPrincipal(req: { headers: Headers }): Principal {
  const visitor = requireVisitor(req);
  return {
    kind: "visitor",
    userId: null,
    isAnonymous: false,
    orgId: null,
    orgKind: null,
    role: null,
    scopes: [],
    apiKeyId: null,
    plan: "guest",
    visitorId: visitor.visitorId,
    ipKey: visitor.ipKey,
    requestId: requestIdOf(req),
  };
}

/** The path a 401 points the UI at, so it can start a guest session and come back (SAAS §2.3, §3.3). */
export function startPathFor(req: { url?: string }): string {
  let next = "/app";
  if (req.url) {
    try {
      const u = new URL(req.url);
      next = `${u.pathname}${u.search}`;
    } catch {
      /* a relative or malformed url: keep the default */
    }
  }
  return `/start?next=${encodeURIComponent(next)}`;
}

/**
 * The SAAS §2.3 rules, applied to an already-resolved principal:
 *  - no org and no `allowVisitor` → 401 `E_AUTH_REQUIRED` with `{ start: "/start?next=<path>" }`;
 *  - `account: true` with no account (or an anonymous one) → 403 `E_ACCOUNT_REQUIRED`;
 *  - a missing permission → 403 `E_FORBIDDEN`, or `E_SCOPE` for an API key (the key lacks the scope, not the role);
 *  - a session-authenticated non-GET → the same-origin check, else 403 `E_CSRF`. API-key requests are exempt:
 *    they never read cookies.
 *
 * A foreign or unknown **resource id** is a 404 and belongs to the repository, not here (SAAS §10.1 rule 2).
 */
export function applyNeed(
  p: Principal,
  need: PrincipalNeed | undefined,
  req: { method?: string; headers: Headers; url?: string },
): Principal {
  if (!p.orgId && !need?.allowVisitor) {
    throw new SaasError("E_AUTH_REQUIRED", "Sign in or start a free workspace to continue.", {
      extra: { start: startPathFor(req) },
    });
  }
  if (need?.account && (p.userId === null || p.isAnonymous)) {
    throw new SaasError("E_ACCOUNT_REQUIRED", "Create a free account to use this. Your workspace comes with you.");
  }
  if (need?.perm && !can(p, need.perm)) {
    throw p.kind === "api_key"
      ? new SaasError("E_SCOPE", `This API key does not have the scope for ${need.perm}.`)
      : new SaasError("E_FORBIDDEN", `Your role does not allow ${need.perm}.`);
  }
  if (p.kind === "session") assertSameOrigin(req);
  return p;
}

/**
 * The legacy resolver (the C3 default in `ports.ts`). Declared as a function so the lazy `ports.ts` ⇄ `principal.ts`
 * import cycle resolves in either load order.
 */
export async function resolveLegacyPrincipal(req: Request, need?: PrincipalNeed): Promise<Principal> {
  const p = tenancyMode() === "legacy" ? legacyVisitorPrincipal(req) : orglessVisitorPrincipal(req);
  return applyNeed(p, need, req);
}

/**
 * **The one entry point for org routes.** It delegates to the registered `PrincipalResolver`, which is the legacy
 * resolver at C3 and the session/API-key resolver from C3b.
 */
export async function requirePrincipal(req: Request, need?: PrincipalNeed): Promise<Principal> {
  return getPrincipalResolver().resolve(req, need);
}

/** The device fields alone, for the v2 limit helpers that do not need a full principal. */
export function deviceOf(req: { headers: Headers }): { visitorId: string; ipKey: string } {
  const v = requireVisitor(req);
  return { visitorId: v.visitorId, ipKey: v.ipKey };
}

export { ipKeyOf };
