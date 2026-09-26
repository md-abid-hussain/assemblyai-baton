import "server-only";

/**
 * The session / API-key `PrincipalResolver` (SAAS §2.3). WP19·2.
 *
 * `src/server/saas/principal.ts` holds `requirePrincipal` and `applyNeed`; this file only answers **who is
 * calling**, and then hands the answer to the same `applyNeed` the legacy resolver uses, so the 401/403/CSRF
 * semantics are written once. Registering it is a single call — `registerSessionPrincipal()` — and **no route file
 * changes**, which is the payoff of WP19·1 decision 2.
 *
 * Resolution order, exactly §2.3:
 *
 * 1. `Authorization: Bearer cko_…` or `x-api-key: cko_…`, **on `/api/v1/**` only** → an API-key principal, judged
 *    on scopes alone. The key belongs to the org, never to its creator (§6.1: "a key keeps working after its
 *    creator is removed"), so `userId` stays null and no membership is consulted.
 * 2. A Better Auth session → a session principal. `orgId` is `session.activeOrganizationId` **if it is still a
 *    membership**; otherwise the most recent membership; otherwise null. A stale or forged active org therefore
 *    grants nothing.
 * 3. Otherwise → a visitor principal: `ws_<visitorId>` under `TENANCY_MODE=legacy`, no org under `orgs`.
 *
 * **It never throws for an infrastructure reason.** If Better Auth is unconfigured or unhealthy, resolution falls
 * through to step 3 and the v2 device path keeps working — that is what makes K-AUTH (§2.8) a matter of removing
 * one environment variable rather than a code change.
 */
import type { OrgKind, PlanId, Principal, Role } from "../../core/contracts/v3/identity";
import { API_SCOPES, type ApiScope } from "../../core/contracts/v3/permissions";
import { log } from "../log";
import {
  applyNeed,
  legacyVisitorPrincipal,
  orglessVisitorPrincipal,
  requestIdOf,
  tenancyMode,
  type PrincipalNeed,
} from "../saas/principal";
import { setPrincipalResolver } from "../saas/ports";
import { requireVisitor } from "../auth/visitor";
import { listMembershipsByRecency } from "./active-org";
import { getAuth } from "./auth";
import { planOf, principalFactsFor } from "./org-store";

const principalLog = log.child({ component: "identity" });

/** The API-key prefix (§6.1). WP22's plugin mints them; we only recognise the shape. */
export const API_KEY_PREFIX = "cko_";
/** API keys are accepted on `/api/v1/**` and nowhere else (§2.3 step 1, §2.5). */
export const API_KEY_PATH_PREFIX = "/api/v1/";

/** The bearer or `x-api-key` value, when the request carries one **and** the path allows it. */
export function apiKeyOf(req: Request): string | null {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(API_KEY_PATH_PREFIX)) return null;
  const bearer = req.headers.get("authorization");
  const fromBearer = bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : null;
  const raw = fromBearer || req.headers.get("x-api-key")?.trim() || null;
  return raw && raw.startsWith(API_KEY_PREFIX) ? raw : null;
}

const isScope = (s: unknown): s is ApiScope => typeof s === "string" && (API_SCOPES as readonly string[]).includes(s);

/** Normalise whatever shape the key plugin stores into our `ApiScope[]`. Unknown entries are dropped, not guessed. */
export function scopesOf(permissions: unknown): ApiScope[] {
  if (Array.isArray(permissions)) return permissions.filter(isScope);
  if (permissions && typeof permissions === "object") {
    // The plugin's `{ resource: [actions] }` shape: `{ relays: ["read","write"] }` → `relays:read`, `relays:write`.
    const out: ApiScope[] = [];
    for (const [resource, actions] of Object.entries(permissions as Record<string, unknown>)) {
      if (!Array.isArray(actions)) continue;
      for (const a of actions) {
        const candidate = `${resource}:${String(a)}`;
        if (isScope(candidate)) out.push(candidate);
      }
    }
    return out;
  }
  return [];
}

interface VerifiedKey {
  orgId: string | null;
  keyId: string | null;
  scopes: ApiScope[];
}

/**
 * `auth.api.verifyApiKey` comes from WP22's `@better-auth/api-key` plugin, which is a `[]` stub until WP22·1. The
 * feature test is what lets WP19·2 ship the branch now: before the plugin exists the branch is inert, and after it
 * lands nothing here changes.
 */
async function verifyApiKey(key: string): Promise<VerifiedKey | null> {
  const auth = getAuth();
  const api = auth?.api as unknown as { verifyApiKey?: (a: { body: { key: string } }) => Promise<unknown> } | undefined;
  if (typeof api?.verifyApiKey !== "function") return null;
  try {
    const r = (await api.verifyApiKey({ body: { key } })) as {
      valid?: boolean;
      key?: { id?: string; permissions?: unknown; metadata?: Record<string, unknown> | null } | null;
    } | null;
    if (!r?.valid || !r.key) return null;
    const orgId =
      (r.key as { organizationId?: string | null }).organizationId ??
      (typeof r.key.metadata?.orgId === "string" ? r.key.metadata.orgId : null);
    return { orgId: orgId ?? null, keyId: r.key.id ?? null, scopes: scopesOf(r.key.permissions) };
  } catch (err) {
    principalLog.warn("api key verification failed", { err });
    return null;
  }
}

/** §2.3 step 2's org rule, as one function: the active org must still be a membership. */
export async function orgForSession(
  userId: string,
  activeOrganizationId: string | null | undefined,
): Promise<{ orgId: string; role: Role; orgKind: OrgKind; plan: PlanId } | null> {
  // `principalFactsFor` names the org kind `kind` (it is `org_meta.kind`); the principal calls it `orgKind`, since
  // `kind` there is already the principal's own kind (`session` / `api_key` / `visitor`). Mapped, not spread.
  const asOrg = (orgId: string, f: { role: Role; kind: OrgKind; plan: PlanId }) => ({
    orgId,
    role: f.role,
    orgKind: f.kind,
    plan: f.plan,
  });

  if (activeOrganizationId) {
    const facts = await principalFactsFor(userId, activeOrganizationId);
    if (facts) return asOrg(activeOrganizationId, facts);
  }
  // A stale, deleted or forged active org falls back to the most recent real membership — never to "trust it".
  const [recent] = await listMembershipsByRecency(userId);
  if (!recent) return null;
  const facts = await principalFactsFor(userId, recent.orgId);
  return facts ? asOrg(recent.orgId, facts) : null;
}

/** The visitor principal for this deployment's tenancy mode. */
function visitorPrincipal(req: Request): Principal {
  return tenancyMode() === "legacy" ? legacyVisitorPrincipal(req) : orglessVisitorPrincipal(req);
}

/** Resolution only: no `need` checks, so it is directly testable and `applyNeed` stays the one gate. */
export async function resolvePrincipal(req: Request): Promise<Principal> {
  const device = requireVisitor(req);
  const base = { visitorId: device.visitorId, ipKey: device.ipKey, requestId: requestIdOf(req) };

  // 1. An API key, on `/api/v1/**` only.
  const key = apiKeyOf(req);
  if (key) {
    const verified = await verifyApiKey(key);
    if (verified?.orgId) {
      return {
        kind: "api_key",
        userId: null,
        isAnonymous: false,
        orgId: verified.orgId,
        orgKind: null,
        role: null,
        scopes: verified.scopes,
        apiKeyId: verified.keyId,
        // The plan gates what the key may do (§4.1 `apiKeyScopes`); WP21's entitlements read it from the org.
        plan: (await planOfSafely(verified.orgId)) ?? "free",
        ...base,
      };
    }
    // An unrecognised key is not a reason to fall back to cookies: `/api/v1` callers send no cookies anyway, and
    // silently downgrading a bad key to "visitor" would turn a 401 into a confusing 404 later.
    return { kind: "api_key", userId: null, isAnonymous: false, orgId: null, orgKind: null, role: null,
             scopes: [], apiKeyId: null, plan: "free", ...base };
  }

  // 2. A Better Auth session.
  const auth = getAuth();
  if (auth) {
    try {
      const s = await auth.api.getSession({ headers: req.headers });
      if (s?.user) {
        const org = await orgForSession(s.user.id, s.session?.activeOrganizationId);
        return {
          kind: "session",
          userId: s.user.id,
          isAnonymous: Boolean((s.user as { isAnonymous?: boolean | null }).isAnonymous),
          orgId: org?.orgId ?? null,
          orgKind: org?.orgKind ?? null,
          role: org?.role ?? null,
          scopes: [],
          apiKeyId: null,
          plan: org?.plan ?? "free",
          ...base,
        };
      }
    } catch (err) {
      // Better Auth being unhealthy must not take the v2 device path down with it (K-AUTH, §2.8).
      principalLog.warn("session resolution failed; falling back to the device principal", { err });
    }
  }

  // 3. A visitor.
  return visitorPrincipal(req);
}

/** The org's plan, or `null` if the row cannot be read: a key must not stop working over a read hiccup. */
async function planOfSafely(orgId: string): Promise<PlanId | null> {
  try {
    return await planOf(orgId);
  } catch (err) {
    principalLog.warn("plan lookup failed for an API key principal", { err });
    return null;
  }
}

/** The registered resolver: resolution, then the shared `applyNeed`. */
export async function resolveSessionPrincipal(req: Request, need?: PrincipalNeed): Promise<Principal> {
  return applyNeed(await resolvePrincipal(req), need, req);
}

/**
 * Register it. Called once from `src/server/identity/index.ts`'s `installIdentity()`, which the catch-all route and
 * the app layout import. Idempotent.
 */
export function registerSessionPrincipal(): void {
  setPrincipalResolver({ resolve: resolveSessionPrincipal });
}
