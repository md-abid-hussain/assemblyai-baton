/**
 * contracts/v3/permissions.ts - the permission matrix and API scopes (SAAS §14, §3.7, §6.1).
 * WP19; frozen at C3. Pure data: `can()` is the single authority the server and the UI both call.
 *
 * "Members build, admins ship": publishing, secrets, allowed hosts and API/webhook configuration are admin+.
 * Plan limits (§4.1) apply on top, so a guest owner still cannot invite, create keys or add webhooks.
 */
import { ROLES, type Principal, type Role } from "./identity";

export const PERMISSIONS = [
  "relay:read", "relay:write", "relay:delete_any", "relay:publish", "run:read", "run:start",
  "connector:test", "secret:read", "secret:write", "member:read", "member:invite", "member:manage", "org:update",
  "org:delete", "billing:read", "billing:manage", "usage:read", "apikey:manage", "webhook:read", "webhook:manage",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Everything an owner may do: the whole list. */
const OWNER: readonly Permission[] = PERMISSIONS;
/** An admin is an owner minus `org:delete` (incl. ownership transfer) and `billing:manage` (SAAS §3.7). */
const ADMIN: readonly Permission[] = PERMISSIONS.filter((p) => p !== "org:delete" && p !== "billing:manage");
/** A member builds and runs, but does not ship: no publish, no secret writes, no org/billing/key/webhook config. */
const MEMBER: readonly Permission[] = [
  "relay:read", "relay:write", "run:read", "run:start", "connector:test", "secret:read", "member:read", "usage:read",
];
/** A viewer reads. */
const VIEWER: readonly Permission[] = ["relay:read", "run:read", "member:read", "usage:read"];

/** Exactly the SAAS §3.7 table. The order inside each list follows `PERMISSIONS`. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...OWNER]),
  admin: Object.freeze([...ADMIN]),
  member: Object.freeze(PERMISSIONS.filter((p) => MEMBER.includes(p))),
  viewer: Object.freeze(PERMISSIONS.filter((p) => VIEWER.includes(p))),
}) as Readonly<Record<Role, readonly Permission[]>>;

export const API_SCOPES = [
  "relays:read", "relays:write", "relays:publish", "runs:read", "usage:read", "webhooks:read", "webhooks:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * **Build** is what the CLI and the SDK need; the Free plan allows Build only (SAAS §4.1, §6.1).
 * **Full access** is every scope.
 */
export const SCOPE_PRESETS: { build: readonly ApiScope[]; full: readonly ApiScope[] } = Object.freeze({
  build: Object.freeze<ApiScope[]>(["relays:read", "relays:write", "runs:read", "usage:read"]),
  full: Object.freeze<ApiScope[]>([...API_SCOPES]),
});

/** The "API scope" column of SAAS §3.7, inverted: what each scope grants. */
export const SCOPE_PERMISSIONS: Readonly<Record<ApiScope, readonly Permission[]>> = Object.freeze({
  "relays:read": Object.freeze<Permission[]>(["relay:read"]),
  // `run:start` over a key means dry runs only; the live-voice routes are browser-only (SAAS §6.2).
  "relays:write": Object.freeze<Permission[]>(["relay:write", "relay:delete_any", "run:start"]),
  "relays:publish": Object.freeze<Permission[]>(["relay:publish"]),
  "runs:read": Object.freeze<Permission[]>(["run:read"]),
  "usage:read": Object.freeze<Permission[]>(["usage:read"]),
  "webhooks:read": Object.freeze<Permission[]>(["webhook:read"]),
  "webhooks:write": Object.freeze<Permission[]>(["webhook:manage"]),
}) as Readonly<Record<ApiScope, readonly Permission[]>>;

/**
 * The one authority. An API key carries no role, so its scopes decide; every other principal carries no scopes,
 * so its role decides. A principal with neither (a visitor with `role = null`) can do nothing.
 */
export function can(p: Pick<Principal, "kind" | "role" | "scopes">, perm: Permission): boolean {
  if (p.kind === "api_key") return p.scopes.some((s) => SCOPE_PERMISSIONS[s]?.includes(perm) ?? false);
  return p.role !== null && (ROLE_PERMISSIONS[p.role]?.includes(perm) ?? false);
}

/** The roles a holder of `role` may hand out: up to their own (SAAS §3.7 "member:invite … up to one's own role"). */
export function assignableRoles(role: Role): readonly Role[] {
  const i = ROLES.indexOf(role);
  return i < 0 ? [] : ROLES.slice(i);
}
