/**
 * The org-route manifest (SAAS §10.1). WP19·3 core; WP19·4 extends it to billing, API keys, `/api/v1/**`,
 * webhooks, connector hosts and dry runs.
 *
 * > "A table-driven manifest (`tests/tenancy/manifest.ts`) lists every org route with its method, its permission
 * > and a fixture id per org."
 *
 * A table rather than a test per route, for one reason: a route added without a row here is a route nobody
 * checked for cross-tenant reads, and `coverage.test.ts` fails the build when `src/app/api/app/**` grows a
 * `route.ts` the manifest does not mention. That is the property worth having — not the assertions themselves,
 * which any one of them could have been written by hand, but the guarantee that the list is complete.
 *
 * `idFor` returns the resource id to put in the path for a given org, so the same row drives both "A's principal
 * on A's id succeeds" and "B's principal on A's id is a 404".
 */
import type { Permission } from "@/core/contracts/v3/permissions";
import type { World } from "./helpers/world";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteRow {
  /** A stable name for the test title. */
  name: string;
  method: Method;
  /** The path, with `:id` / `:userId` filled in by `idFor`. */
  path: (id: string) => string;
  /** The §3.7 permission the route requires, or `null` for "any principal with an org". */
  perm: Permission | null;
  /**
   * The resource id to address, per org. `null` means the route addresses no resource (a collection), in which
   * case tenancy is proved by *what comes back*, not by a 404 — the cross-org rows are asserted in the suite.
   */
  idFor: ((w: World, org: "A" | "B") => string) | null;
  /** True when the route changes state: the viewer-403 and the CSRF checks apply. */
  mutates: boolean;
  /** The route file this row stands for, relative to `src/app`. `coverage.test.ts` reads these. */
  file: string;
  /**
   * A body valid enough to reach the tenancy check and never valid enough to do damage across orgs. It is a
   * function because some of them have to name a real fixture id, which only exists once the world is built.
   */
  body?: (w: World, org: "A" | "B") => unknown;
}

const orgOf = (w: World, org: "A" | "B") => (org === "A" ? w.orgA : w.orgB);
const ownerOf = (w: World, org: "A" | "B") => (org === "A" ? w.aOwner.userId : w.bOwner.userId);

export const ROUTES: readonly RouteRow[] = [
  {
    name: "GET /api/app/orgs",
    method: "GET",
    path: () => "/api/app/orgs",
    perm: null,
    idFor: null,
    mutates: false,
    file: "api/app/orgs/route.ts",
  },
  {
    name: "POST /api/app/orgs",
    method: "POST",
    path: () => "/api/app/orgs",
    perm: null,
    idFor: null,
    mutates: true,
    file: "api/app/orgs/route.ts",
    body: () => ({ name: "A second workspace" }),
  },
  {
    name: "PATCH /api/app/orgs/:id",
    method: "PATCH",
    path: (id) => `/api/app/orgs/${id}`,
    perm: "org:update",
    idFor: orgOf,
    mutates: true,
    file: "api/app/orgs/[id]/route.ts",
    body: () => ({ name: "Renamed by the suite" }),
  },
  {
    name: "DELETE /api/app/orgs/:id",
    method: "DELETE",
    path: (id) => `/api/app/orgs/${id}`,
    perm: "org:delete",
    idFor: orgOf,
    mutates: true,
    file: "api/app/orgs/[id]/route.ts",
    // Deliberately the wrong confirmation: the tenancy assertions must not depend on actually deleting an org.
    body: () => ({ confirm: "not-the-slug" }),
  },
  {
    name: "POST /api/app/orgs/:id/leave",
    method: "POST",
    path: (id) => `/api/app/orgs/${id}/leave`,
    perm: null,
    idFor: orgOf,
    mutates: true,
    file: "api/app/orgs/[id]/leave/route.ts",
  },
  {
    name: "POST /api/app/orgs/:id/transfer",
    method: "POST",
    path: (id) => `/api/app/orgs/${id}/transfer`,
    perm: "org:delete",
    idFor: orgOf,
    mutates: true,
    file: "api/app/orgs/[id]/transfer/route.ts",
    body: (w, org) => ({ userId: org === "A" ? w.aAdmin.userId : w.bOwner.userId }),
  },
  {
    name: "GET /api/app/members",
    method: "GET",
    path: () => "/api/app/members",
    perm: "member:read",
    idFor: null,
    mutates: false,
    file: "api/app/members/route.ts",
  },
  {
    name: "PATCH /api/app/members/:userId",
    method: "PATCH",
    path: (id) => `/api/app/members/${id}`,
    perm: "member:manage",
    idFor: ownerOf,
    mutates: true,
    file: "api/app/members/[userId]/route.ts",
    body: () => ({ role: "viewer" }),
  },
  {
    name: "DELETE /api/app/members/:userId",
    method: "DELETE",
    path: (id) => `/api/app/members/${id}`,
    perm: "member:manage",
    idFor: ownerOf,
    mutates: true,
    file: "api/app/members/[userId]/route.ts",
  },
  {
    name: "GET /api/app/invitations",
    method: "GET",
    path: () => "/api/app/invitations",
    perm: "member:read",
    idFor: null,
    mutates: false,
    file: "api/app/invitations/route.ts",
  },
  {
    name: "POST /api/app/invitations",
    method: "POST",
    path: () => "/api/app/invitations",
    perm: "member:invite",
    idFor: null,
    mutates: true,
    file: "api/app/invitations/route.ts",
    body: () => ({ email: "invited@tenancy.test", role: "member" }),
  },
  {
    name: "DELETE /api/app/invitations/:id",
    method: "DELETE",
    path: (id) => `/api/app/invitations/${id}`,
    perm: "member:invite",
    idFor: (w, org) => w.ids[`invite${org}`] ?? "inv_absent",
    mutates: true,
    file: "api/app/invitations/[id]/route.ts",
  },
  {
    name: "GET /api/app/audit",
    method: "GET",
    path: () => "/api/app/audit",
    perm: "audit:read",
    idFor: null,
    mutates: false,
    file: "api/app/audit/route.ts",
  },
  {
    name: "GET /api/app/claim-device",
    method: "GET",
    path: () => "/api/app/claim-device",
    perm: "relay:read",
    idFor: null,
    mutates: false,
    file: "api/app/claim-device/route.ts",
  },
  {
    name: "POST /api/app/claim-device",
    method: "POST",
    path: () => "/api/app/claim-device",
    perm: "relay:write",
    idFor: null,
    mutates: true,
    file: "api/app/claim-device/route.ts",
  },
  {
    name: "DELETE /api/app/claim-device",
    method: "DELETE",
    path: () => "/api/app/claim-device",
    perm: "relay:read",
    idFor: null,
    mutates: true,
    file: "api/app/claim-device/route.ts",
  },

  // ---------------------------------------------------------------- WP21 billing (added at G3, WP19·4 scope)
  // Permissions read off the handlers in `src/server/billing/routes.ts`, not off §3.7 by eye.
  {
    name: "GET /api/app/billing",
    method: "GET",
    path: () => "/api/app/billing",
    perm: "billing:read",
    idFor: null,
    mutates: false,
    file: "api/app/billing/route.ts",
  },
  {
    name: "POST /api/app/billing/checkout",
    method: "POST",
    path: () => "/api/app/billing/checkout",
    perm: "billing:manage",
    idFor: null,
    mutates: true,
    file: "api/app/billing/checkout/route.ts",
    body: () => ({ plan: "pro" }),
  },
  {
    name: "POST /api/app/billing/simulated",
    method: "POST",
    path: () => "/api/app/billing/simulated",
    perm: "billing:manage",
    idFor: null,
    mutates: true,
    file: "api/app/billing/simulated/route.ts",
    body: () => ({ plan: "pro" }),
  },

  // -------------------------------------------------------- WP16 connector hosts (added at G3, WP19·4 scope)
  {
    name: "GET /api/app/connector-hosts",
    method: "GET",
    path: () => "/api/app/connector-hosts",
    perm: "secret:read",
    idFor: null,
    mutates: false,
    file: "api/app/connector-hosts/route.ts",
  },
  {
    name: "POST /api/app/connector-hosts",
    method: "POST",
    path: () => "/api/app/connector-hosts",
    perm: "secret:write",
    idFor: null,
    mutates: true,
    file: "api/app/connector-hosts/route.ts",
    // A host that is syntactically fine and resolves nowhere useful: enough to reach the tenancy and
    // permission checks, never enough to add something another org could be pointed at.
    body: () => ({ host: "tenancy-suite.invalid" }),
  },
  {
    name: "DELETE /api/app/connector-hosts",
    method: "DELETE",
    path: () => "/api/app/connector-hosts?host=tenancy-suite.invalid",
    perm: "secret:write",
    idFor: null,
    mutates: true,
    file: "api/app/connector-hosts/route.ts",
  },
] as const;

/** Every `src/app/api/app/**` route file the manifest claims to cover. */
export const MANIFEST_FILES: readonly string[] = [...new Set(ROUTES.map((r) => r.file))].sort();
