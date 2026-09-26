import "server-only";

/**
 * Settings → Organization (SAAS §8.4, §3.5). WP20·2.
 *
 * Name, slug, kind, created, and the four dangerous actions with their preconditions already resolved:
 * rename (admin+), transfer (owner, and only to an existing admin), leave (anyone but the last owner), delete
 * (owner, typed confirmation).
 *
 * **The preconditions are computed here, not in the component.** The server owns the decision either way —
 * WP19·3's routes re-check all of it — but a disabled button that says *why* is the difference between a
 * product and a 409. The rule the page must never break: it may only ever **hide or disable**; it may never
 * enable something `can()` said no to.
 */
import { and, eq, ne } from "drizzle-orm";

import type { OrgSettingsView, TransferTargetView } from "../../core/contracts/ext/wp20-app";
import { ROLES, type OrgKind, type Principal, type Role } from "../../core/contracts/v3/identity";
import { can } from "../../core/contracts/v3/permissions";
import { getDb, type Db } from "../db";
import { members, organizations, users } from "../db/schema-auth";
import { orgMeta } from "../db/schema-saas";

const asRole = (v: string | null | undefined): Role =>
  (ROLES as readonly string[]).includes(v ?? "") ? (v as Role) : "viewer";

const iso = (d: Date | string | null | undefined): string | null => {
  if (d === null || d === undefined) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

export async function loadOrgSettings(p: Principal, db: Db = getDb()): Promise<OrgSettingsView> {
  const orgId = p.orgId ?? "";
  const accountRequired = p.kind === "visitor" || p.isAnonymous || p.userId === null;

  const base: OrgSettingsView = {
    id: orgId,
    // The legacy device workspace has no `organizations` row at all; it is still a real workspace and the page
    // still renders, read-only, rather than 404ing on a visitor who has simply not signed up yet.
    name: accountRequired ? "Guest workspace" : "Your workspace",
    slug: orgId,
    kind: (p.orgKind ?? "guest") as OrgKind,
    plan: p.plan,
    createdAt: null,
    memberCount: 1,
    ownerCount: 1,
    canUpdate: false,
    canDelete: false,
    canTransfer: false,
    canLeave: false,
    transferTargets: [],
    accountRequired,
  };
  if (!orgId) return base;

  const [org] = await db
    .select({
      name: organizations.name,
      slug: organizations.slug,
      createdAt: organizations.createdAt,
      kind: orgMeta.kind,
    })
    .from(organizations)
    .leftJoin(orgMeta, eq(orgMeta.orgId, organizations.id))
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return base;

  const roster = await db
    .select({ userId: members.userId, role: members.role, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.organizationId, orgId));

  const ownerCount = roster.filter((r) => asRole(r.role) === "owner").length;
  const viewerIsOwner = p.role === "owner";
  const viewerIsLastOwner = viewerIsOwner && ownerCount <= 1;

  // §3.5: ownership transfers to "an existing admin". Offering a member or a viewer would be offering a
  // promotion the spec does not describe, and the route would refuse it after the click.
  const transferTargets: TransferTargetView[] = roster
    .filter((r) => asRole(r.role) === "admin" && r.userId !== p.userId)
    .map((r) => ({ userId: r.userId, name: r.name, email: r.email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: orgId,
    name: org.name,
    slug: org.slug,
    kind: (org.kind ?? p.orgKind ?? "team") as OrgKind,
    plan: p.plan,
    createdAt: iso(org.createdAt),
    memberCount: roster.length,
    ownerCount,
    canUpdate: !accountRequired && can(p, "org:update"),
    canDelete: !accountRequired && can(p, "org:delete"),
    canTransfer: !accountRequired && can(p, "org:delete") && transferTargets.length > 0,
    // The last owner may not leave: it would strand the org. Transfer first, or delete it.
    canLeave: !accountRequired && !viewerIsLastOwner && roster.some((r) => r.userId === p.userId),
    transferTargets,
    accountRequired,
  };
}

/** Everyone else's orgs, for "New organization" — the §2.2 cap of 3 owned orgs, checked before the form shows. */
export async function ownedOrgCount(p: Principal, db: Db = getDb()): Promise<number> {
  if (!p.userId) return 0;
  const rows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(and(eq(members.userId, p.userId), eq(members.role, "owner"), ne(members.organizationId, "")));
  return rows.length;
}
