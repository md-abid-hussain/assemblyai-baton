/**
 * WP19·1 acceptance: the permission matrix equals SAAS §3.7, and `can()` answers for roles and for scopes.
 *
 * The expected table below is transcribed from the spec, one row per permission, so a diff against §3.7 is a diff
 * against this file. It is the snapshot: a generated `.snap` would only record whatever the code happens to do.
 */
import { describe, expect, it } from "vitest";

import type { Principal } from "@/core/contracts/v3/identity";
import { ROLES } from "@/core/contracts/v3/identity";
import {
  API_SCOPES, assignableRoles, can, PERMISSIONS, ROLE_PERMISSIONS, SCOPE_PERMISSIONS, SCOPE_PRESETS,
  type ApiScope, type Permission,
} from "@/core/contracts/v3/permissions";

/** SAAS §3.7, verbatim: [owner, admin, member, viewer, the API scope or null]. */
const SPEC: Record<Permission, [boolean, boolean, boolean, boolean, ApiScope | null]> = {
  "relay:read":       [true, true, true, true, "relays:read"],
  "relay:write":      [true, true, true, false, "relays:write"],
  "relay:delete_any": [true, true, false, false, "relays:write"],
  "relay:publish":    [true, true, false, false, "relays:publish"],
  "run:read":         [true, true, true, true, "runs:read"],
  "run:start":        [true, true, true, false, "relays:write"],
  "connector:test":   [true, true, true, false, null],
  "secret:read":      [true, true, true, false, null],
  "secret:write":     [true, true, false, false, null],
  "member:read":      [true, true, true, true, null],
  "member:invite":    [true, true, false, false, null],
  "member:manage":    [true, true, false, false, null],
  "org:update":       [true, true, false, false, null],
  "org:delete":       [true, false, false, false, null],
  "billing:read":     [true, true, false, false, null],
  "billing:manage":   [true, false, false, false, null],
  "usage:read":       [true, true, true, true, "usage:read"],
  "apikey:manage":    [true, true, false, false, null],
  "webhook:read":     [true, true, false, false, "webhooks:read"],
  "webhook:manage":   [true, true, false, false, "webhooks:write"],
  "audit:read":       [true, true, false, false, null],
};

const principal = (over: Partial<Principal>): Principal => ({
  kind: "session", userId: "u1", isAnonymous: false, orgId: "org_1", orgKind: "team", role: "member",
  scopes: [], apiKeyId: null, plan: "free", visitorId: "v1", ipKey: "ip1", requestId: "req1", ...over,
});

describe("SAAS §3.7 permission matrix", () => {
  it("lists exactly the §3.7 permissions, with no duplicates", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(SPEC).sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("ROLE_PERMISSIONS is exactly the §3.7 table", () => {
    const expected = Object.fromEntries(
      ROLES.map((role, col) => [role, PERMISSIONS.filter((p) => SPEC[p][col])]),
    );
    expect(Object.fromEntries(ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]]]))).toEqual(expected);
  });

  it("owner has everything; admin is owner minus org:delete and billing:manage", () => {
    expect([...ROLE_PERMISSIONS.owner]).toEqual([...PERMISSIONS]);
    const missing = PERMISSIONS.filter((p) => !ROLE_PERMISSIONS.admin.includes(p));
    expect(missing).toEqual(["org:delete", "billing:manage"]);
  });

  it('"members build, admins ship": publish, secret:write and the config permissions are admin+', () => {
    for (const p of ["relay:publish", "secret:write", "apikey:manage", "webhook:manage", "org:update", "audit:read"] as const) {
      expect(can(principal({ role: "member" }), p)).toBe(false);
      expect(can(principal({ role: "admin" }), p)).toBe(true);
    }
  });

  it("can() answers per role for every permission", () => {
    for (const p of PERMISSIONS) {
      ROLES.forEach((role, col) => expect([role, p, can(principal({ role }), p)]).toEqual([role, p, SPEC[p][col]]));
    }
  });

  it("a principal with no role can do nothing", () => {
    for (const p of PERMISSIONS) expect(can(principal({ kind: "visitor", role: null }), p)).toBe(false);
  });
});

describe("SAAS §6.1 API scopes", () => {
  it("SCOPE_PERMISSIONS is the inverse of the §3.7 API-scope column", () => {
    const expected = Object.fromEntries(
      API_SCOPES.map((s) => [s, PERMISSIONS.filter((p) => SPEC[p][4] === s)]),
    );
    expect(Object.fromEntries(API_SCOPES.map((s) => [s, [...SCOPE_PERMISSIONS[s]]]))).toEqual(expected);
  });

  it("Build is what the CLI needs; Full is every scope", () => {
    expect([...SCOPE_PRESETS.build]).toEqual(["relays:read", "relays:write", "runs:read", "usage:read"]);
    expect([...SCOPE_PRESETS.full]).toEqual([...API_SCOPES]);
  });

  it("an api_key principal is judged on scopes, not on a role", () => {
    const key = (scopes: ApiScope[]) => principal({ kind: "api_key", role: null, userId: null, scopes });
    expect(can(key(["relays:read"]), "relay:read")).toBe(true);
    expect(can(key(["relays:read"]), "relay:write")).toBe(false);
    expect(can(key([...SCOPE_PRESETS.build]), "run:start")).toBe(true);
    // Build deliberately excludes publish and webhooks.
    expect(can(key([...SCOPE_PRESETS.build]), "relay:publish")).toBe(false);
    expect(can(key([...SCOPE_PRESETS.build]), "webhook:manage")).toBe(false);
    expect(can(key([...SCOPE_PRESETS.full]), "webhook:manage")).toBe(true);
    // A role on an api_key principal must not grant anything the scopes do not.
    expect(can({ kind: "api_key", role: "owner", scopes: [] }, "org:delete")).toBe(false);
  });

  it("no scope grants an org-management or billing permission", () => {
    for (const p of ["org:update", "org:delete", "billing:read", "billing:manage", "member:manage", "apikey:manage", "audit:read", "secret:write"] as const) {
      expect(can({ kind: "api_key", role: null, scopes: [...API_SCOPES] }, p)).toBe(false);
    }
  });

  it("assignableRoles caps an inviter at their own role", () => {
    expect([...assignableRoles("owner")]).toEqual(["owner", "admin", "member", "viewer"]);
    expect([...assignableRoles("admin")]).toEqual(["admin", "member", "viewer"]);
    expect([...assignableRoles("viewer")]).toEqual(["viewer"]);
  });
});
