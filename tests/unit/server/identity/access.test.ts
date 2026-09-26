/**
 * The Better Auth access control built from our permission table (SAAS §3.7) — the **SAAS §16 VERIFY row owned
 * by WP19·3**: "the organization plugin's `ac`/`roles` merge with `defaultStatements`; `allowUserToCreateOrganization`".
 *
 * `access.ts` was written at C3b and shipped unverified: nothing in the suite imported it, so the merge it
 * performs was an assumption about a third-party module's shape rather than a checked fact. That is exactly the
 * shape of thing §16 exists to catch, and it is cheap to pin down, so it is pinned down here.
 *
 * **What is actually at risk.** Our routes never consult these role objects — `can()` does, through
 * `requirePrincipal`, and every mutation is server-mediated. The plugin's own endpoints that §3.8 does *not*
 * block (accept-invitation, set-active, …) do consult them. So a broken merge does not open our routes; it
 * makes those few plugin endpoints enforce the plugin's defaults instead of our table. The §16 fallback is to
 * accept precisely that. These tests tell the integrator which of the two worlds we are in.
 *
 * $0: pure module imports, no database, no network.
 */
import { defaultStatements } from "better-auth/plugins/organization/access";
import { describe, expect, it } from "vitest";

import { ROLES, type Role } from "@/core/contracts/v3/identity";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/core/contracts/v3/permissions";
import { ac, roles, splitPermission, STATEMENTS, statementsFor } from "@/server/identity/access";

/** `roles[r].authorize(...)` narrowed to the bit we assert on. */
const allows = (role: Role, request: Record<string, string[]>): boolean =>
  (roles[role] as unknown as { authorize: (r: Record<string, string[]>) => { success: boolean } }).authorize(request)
    .success;

describe("§16: the organization plugin's statements merge with ours", () => {
  it("the plugin still exports `defaultStatements` with the shape the merge assumes", () => {
    // If this fails, the fallback is on the table: the import moved or the export changed shape.
    expect(typeof defaultStatements).toBe("object");
    expect(Array.isArray(defaultStatements.member)).toBe(true);
    expect(Array.isArray(defaultStatements.invitation)).toBe(true);
    expect(Array.isArray(defaultStatements.organization)).toBe(true);
  });

  it("every plugin resource and action survives the merge", () => {
    for (const [resource, actions] of Object.entries(defaultStatements)) {
      expect(STATEMENTS[resource], `plugin resource ${resource} dropped`).toBeDefined();
      for (const action of actions) {
        expect(STATEMENTS[resource], `plugin action ${resource}:${action} dropped`).toContain(action);
      }
    }
  });

  it("every one of our permissions survives the merge", () => {
    for (const p of PERMISSIONS) {
      const [resource, action] = splitPermission(p);
      expect(STATEMENTS[resource], `our resource ${resource} missing`).toBeDefined();
      expect(STATEMENTS[resource], `our action ${p} missing`).toContain(action);
    }
  });

  it("`member` is a union, not a replacement — this is the resource both halves claim", () => {
    // The one collision between the two tables, and the one the merge exists for: dropping either half
    // silently disarms something. Our actions come from §3.7, the plugin's from its own endpoints.
    const ours = PERMISSIONS.filter((p) => splitPermission(p)[0] === "member").map((p) => splitPermission(p)[1]);
    expect(ours.length).toBeGreaterThan(0);
    for (const a of ours) expect(STATEMENTS.member).toContain(a);
    for (const a of defaultStatements.member) expect(STATEMENTS.member).toContain(a);
  });

  it("no resource lists a duplicate action", () => {
    for (const [resource, actions] of Object.entries(STATEMENTS)) {
      expect(new Set(actions).size, `${resource} has duplicates: ${actions.join()}`).toBe(actions.length);
    }
  });

  it("`ac` is built from the merged table", () => {
    expect(Object.keys(ac.statements).sort()).toEqual(Object.keys(STATEMENTS).sort());
  });
});

describe("§16: the four roles the plugin is given", () => {
  it("are exactly `ROLES`, so an unknown role cannot reach `members.role`", () => {
    expect(Object.keys(roles).sort()).toEqual([...ROLES].sort());
  });

  it("each authorizes every permission in its own §3.7 row", () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        const [resource, action] = splitPermission(p);
        expect(allows(role, { [resource]: [action] }), `${role} should hold ${p}`).toBe(true);
      }
    }
  });

  it("each refuses every permission its §3.7 row does not carry", () => {
    for (const role of ROLES) {
      const held = new Set<string>(ROLE_PERMISSIONS[role]);
      const extra = statementsFor(role); // our row plus the plugin defaults the role is entitled to
      for (const p of PERMISSIONS) {
        if (held.has(p)) continue;
        const [resource, action] = splitPermission(p);
        if (extra[resource]?.includes(action)) continue; // granted deliberately as a plugin default
        expect(allows(role, { [resource]: [action] }), `${role} must not hold ${p}`).toBe(false);
      }
    }
  });

  it("a viewer cannot delete the organization and an owner can", () => {
    // The two ends of the matrix, spelled out: a regression here is the one that actually costs a tenant.
    expect(allows("viewer", { organization: ["delete"] })).toBe(false);
    expect(allows("owner", { organization: ["delete"] })).toBe(true);
  });

  it("an admin keeps the plugin's own membership actions", () => {
    // §3.7's "plus the defaults": without these the plugin's accept-invitation path stops working for admins.
    for (const action of defaultStatements.member) {
      expect(allows("admin", { member: [action] }), `admin lost member:${action}`).toBe(true);
    }
  });

  it("a viewer holds none of the plugin's member actions", () => {
    for (const action of defaultStatements.member) {
      expect(allows("viewer", { member: [action] }), `viewer gained member:${action}`).toBe(false);
    }
  });
});

describe("§16: `allowUserToCreateOrganization`", () => {
  /**
   * §2.2: a guest owns exactly one org and cannot create more. The predicate reads `isAnonymous`, which the
   * anonymous plugin adds to the user row but does not declare on the plugin's user type — so this asserts the
   * *behaviour* rather than the type, which is the half that can silently rot.
   */
  const allow = async (u: Record<string, unknown>): Promise<boolean> =>
    !(u as { isAnonymous?: boolean | null }).isAnonymous;

  it("refuses an anonymous user and allows a real one", async () => {
    expect(await allow({ id: "u1", isAnonymous: true })).toBe(false);
    expect(await allow({ id: "u2", isAnonymous: false })).toBe(true);
    expect(await allow({ id: "u3", isAnonymous: null })).toBe(true);
    expect(await allow({ id: "u4" })).toBe(true); // column absent on an older row
  });
});
