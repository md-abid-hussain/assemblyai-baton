import "server-only";

/**
 * Better Auth access control built from `contracts/v3/permissions.ts` (SAAS §3.7).
 *
 * **`can()` stays the single authority.** Every one of our routes checks `can(principal, perm)` through
 * `requirePrincipal`; this `ac`/`roles` pair exists so that Better Auth's own endpoints (the ones we do not block
 * in §3.8 — accept-invitation, set-active, …) enforce the same table rather than the plugin's defaults. If the
 * plugin's statement shape ever changes, the §16 fallback is exactly that: our `can()` is unaffected and every
 * mutation is server-mediated anyway.
 *
 * The mapping is mechanical: our `"<resource>:<action>"` permission ids split on the colon, so `relay:publish`
 * becomes `{ relay: ["publish"] }`. `member` is the one resource we share with the plugin's `defaultStatements`
 * (`create`/`update`/`delete`), so that list is a union, not a replacement — dropping the plugin's actions would
 * silently disarm its own membership endpoints.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

import { ROLES, type Role } from "../../core/contracts/v3/identity";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "../../core/contracts/v3/permissions";

/** `"relay:publish"` → `["relay", "publish"]`. Every `Permission` has exactly one colon. */
export function splitPermission(p: Permission): [resource: string, action: string] {
  const i = p.indexOf(":");
  return [p.slice(0, i), p.slice(i + 1)];
}

/** Our half of the statement table: resource → the actions any role can hold. */
function ourStatements(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of PERMISSIONS) {
    const [resource, action] = splitPermission(p);
    (out[resource] ??= []).push(action);
  }
  return out;
}

/** The plugin's defaults unioned with ours, so both halves of `member` survive. */
function mergeStatements(): Record<string, readonly string[]> {
  const merged: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(defaultStatements)) merged[resource] = [...actions];
  for (const [resource, actions] of Object.entries(ourStatements())) {
    const seen = new Set(merged[resource] ?? []);
    merged[resource] = [...(merged[resource] ?? []), ...actions.filter((a) => !seen.has(a))];
  }
  return merged;
}

export const STATEMENTS = Object.freeze(mergeStatements()) as Record<string, readonly string[]>;

export const ac = createAccessControl(STATEMENTS as Record<string, string[]>);

/** The plugin statements an owner and an admin keep on top of our table (SAAS §3.7's "plus the defaults"). */
const PLUGIN_EXTRA: Readonly<Record<Role, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  owner: defaultStatements,
  admin: Object.freeze({
    organization: ["update"] as const,
    member: defaultStatements.member,
    invitation: defaultStatements.invitation,
    team: defaultStatements.team,
    ac: defaultStatements.ac,
  }),
  member: Object.freeze({ ac: ["read"] as const }),
  viewer: Object.freeze({}),
}) as Readonly<Record<Role, Readonly<Record<string, readonly string[]>>>>;

/** One role's statements: its §3.7 row, plus the plugin defaults it is entitled to. */
export function statementsFor(role: Role): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of ROLE_PERMISSIONS[role]) {
    const [resource, action] = splitPermission(p);
    (out[resource] ??= []).push(action);
  }
  for (const [resource, actions] of Object.entries(PLUGIN_EXTRA[role])) {
    const seen = new Set(out[resource] ?? []);
    out[resource] = [...(out[resource] ?? []), ...actions.filter((a) => !seen.has(a))];
  }
  return out;
}

/**
 * `roles` for the organization plugin. The four keys are exactly `ROLES`, so a role name the plugin does not know
 * cannot appear in `members.role`.
 */
export const roles = Object.fromEntries(ROLES.map((r) => [r, ac.newRole(statementsFor(r) as never)])) as unknown as Record<
  Role,
  ReturnType<typeof ac.newRole>
>;

/** The plugin wants the role names as a comma-free list; kept here so `auth.ts` has no literals. */
export const ROLE_NAMES: readonly Role[] = ROLES;
