import "server-only";

/**
 * Members and invitations at the row level (SAAS §3.5–§3.7). WP19·3.
 *
 * Like `org-store.ts` this is plain Drizzle with **no `better-auth` import**, so `/api/app/**` can call it
 * directly and the boundary test stays green. Better Auth's own membership endpoints are blocked for clients
 * (§3.8) exactly so that every membership change lands here, audited, in one place.
 *
 * Two invariants live in this file rather than in the routes, because a route is easy to add and an invariant is
 * easy to forget:
 *
 * - **An org always has an owner.** `removeMember` and `setMemberRole` refuse the last one (`E_CONFLICT`), and
 *   `transferOwnership` swaps the two roles in one transaction rather than demoting first and hoping.
 * - **An admin never acts on an owner** (§3.7: "role change, remove; never an owner by an admin").
 */
import { and, asc, count, eq, gt, ne } from "drizzle-orm";

import type { InvitationView, MemberView, Role } from "../../core/contracts/v3/identity";
import { ROLES } from "../../core/contracts/v3/identity";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { invitations, members, users } from "../db/schema-auth";
import { SaasError } from "../saas/errors";
import type { Runner } from "./org-store";

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/** A stored role we do not recognise reads as the least privileged one, never as something unexpected. */
const roleOf = (raw: string | null | undefined): Role => (isRole(raw) ? raw : "viewer");

/** The Members page (SAAS §8.4), oldest member first so the owner is normally at the top. */
export async function listMembers(orgId: string, run: Runner = getDb()): Promise<MemberView[]> {
  const rows = await run
    .select({
      userId: members.userId,
      role: members.role,
      joinedAt: members.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.organizationId, orgId))
    .orderBy(asc(members.createdAt));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: roleOf(r.role),
    joinedAt: new Date(r.joinedAt).toISOString(),
  }));
}

/** One membership, or `null`. The 404 for a foreign user id is the caller's to raise. */
export async function memberRow(
  orgId: string,
  userId: string,
  run: Runner = getDb(),
): Promise<{ role: Role; email: string; name: string } | null> {
  const [row] = await run
    .select({ role: members.role, email: users.email, name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)))
    .limit(1);
  return row ? { role: roleOf(row.role), email: row.email, name: row.name } : null;
}

export async function countOwners(orgId: string, run: Runner = getDb()): Promise<number> {
  const [row] = await run
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.role, "owner")));
  return Number(row?.n ?? 0);
}

/** "Never an owner by an admin" (§3.7). The actor's own role decides; `can()` has already said they may manage. */
export function assertMayActOn(actorRole: Role, targetRole: Role): void {
  if (targetRole === "owner" && actorRole !== "owner") {
    throw new SaasError("E_FORBIDDEN", "Only an owner can change another owner.");
  }
}

/** Change a member's role. Refuses the demotion that would leave the org ownerless. */
export async function setMemberRole(
  orgId: string,
  userId: string,
  role: Role,
  db: Db = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await memberRow(orgId, userId, tx);
    if (!current) throw new SaasError("E_NOT_FOUND", "No such member.");
    if (current.role === "owner" && role !== "owner" && (await countOwners(orgId, tx)) <= 1) {
      throw new SaasError("E_CONFLICT", "An organization needs an owner. Transfer ownership first.");
    }
    await tx
      .update(members)
      .set({ role })
      .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)));
  });
}

/** Remove a member (or, with the same call, let one leave). Refuses the last owner. */
export async function removeMember(orgId: string, userId: string, db: Db = getDb()): Promise<Role> {
  return db.transaction(async (tx) => {
    const current = await memberRow(orgId, userId, tx);
    if (!current) throw new SaasError("E_NOT_FOUND", "No such member.");
    if (current.role === "owner" && (await countOwners(orgId, tx)) <= 1) {
      throw new SaasError(
        "E_CONFLICT",
        "You are the last owner. Transfer ownership first, or delete the organization.",
      );
    }
    await tx.delete(members).where(and(eq(members.organizationId, orgId), eq(members.userId, userId)));
    return current.role;
  });
}

/**
 * Owner → an existing admin (§3.5). Both writes are in one transaction, so there is no instant with two owners
 * and no instant with none.
 */
export async function transferOwnership(
  orgId: string,
  fromUserId: string,
  toUserId: string,
  db: Db = getDb(),
): Promise<void> {
  if (fromUserId === toUserId) throw new SaasError("E_VALIDATION", "That is already the owner.");
  await db.transaction(async (tx) => {
    const target = await memberRow(orgId, toUserId, tx);
    if (!target) throw new SaasError("E_NOT_FOUND", "No such member.");
    if (target.role !== "admin") {
      throw new SaasError("E_CONFLICT", "Ownership transfers to an admin. Make them an admin first.");
    }
    await tx
      .update(members)
      .set({ role: "owner" })
      .where(and(eq(members.organizationId, orgId), eq(members.userId, toUserId)));
    await tx
      .update(members)
      .set({ role: "admin" })
      .where(and(eq(members.organizationId, orgId), eq(members.userId, fromUserId)));
  });
}

// ------------------------------------------------------------------------------------------------ invitations

/** The accept URL for an invitation id (SAAS §3.6). Relative when `APP_URL` is unset (local dev, tests). */
export function invitationLink(id: string, appUrl: string | undefined = process.env.APP_URL): string {
  const base = appUrl?.trim().replace(/\/+$/, "") ?? "";
  return `${base}/accept-invite/${encodeURIComponent(id)}`;
}

/**
 * Pending, unexpired invitations for the Members page.
 *
 * **`withLink` is an authorization decision, not a formatting one.** The link is the whole of the credential in
 * §3.6 — holding it plus the invited address is what joins an org — and `member:read` reaches down to viewers.
 * A viewer who could read a pending *admin* invitation's link, in a build where no email is verifiable (§3.2),
 * could register that address and accept it: a role escalation with no audit trail until after the fact. So the
 * link goes only to callers who hold `member:invite`, who could have issued the same invitation themselves.
 * Everyone with `member:read` still sees that the invitation exists, for whom, and in what role.
 */
export async function listInvitations(
  orgId: string,
  run: Runner = getDb(),
  opts: { withLink?: boolean } = {},
): Promise<InvitationView[]> {
  const rows = await run
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      inviterEmail: users.email,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(
      and(
        eq(invitations.organizationId, orgId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: roleOf(r.role),
    ...(opts.withLink ? { link: invitationLink(r.id) } : {}),
    expiresAt: new Date(r.expiresAt).toISOString(),
    invitedBy: r.inviterEmail,
  }));
}

/** One pending invitation of this org, or `null` — the 404 for another org's id. */
export async function pendingInvitation(
  orgId: string,
  id: string,
  run: Runner = getDb(),
): Promise<{ id: string; email: string; role: Role } | null> {
  const [row] = await run
    .select({ id: invitations.id, email: invitations.email, role: invitations.role, status: invitations.status })
    .from(invitations)
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.id, id)))
    .limit(1);
  if (!row || row.status !== "pending") return null;
  return { id: row.id, email: row.email, role: roleOf(row.role) };
}

/** Is this address already a member, or already invited? Both are `E_CONFLICT` rather than a second row. */
export async function inviteConflict(
  orgId: string,
  email: string,
  run: Runner = getDb(),
): Promise<"member" | "invited" | null> {
  const address = email.trim().toLowerCase();
  const [m] = await run
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(users.email, address)))
    .limit(1);
  if (m) return "member";
  const [i] = await run
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, orgId),
        eq(invitations.email, address),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return i ? "invited" : null;
}

/** Mark a pending invitation cancelled. Returns false when it was not pending (already accepted, or expired). */
export async function cancelInvitation(orgId: string, id: string, run: Runner = getDb()): Promise<boolean> {
  const rows = await run
    .update(invitations)
    .set({ status: "canceled" })
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.id, id), eq(invitations.status, "pending")))
    .returning({ id: invitations.id });
  return rows.length > 0;
}

/** Members of an org other than one user. Used when deciding whether an account may be deleted (§3.10). */
export async function hasOtherMembers(orgId: string, userId: string, run: Runner = getDb()): Promise<boolean> {
  const [row] = await run
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.organizationId, orgId), ne(members.userId, userId)));
  return Number(row?.n ?? 0) > 0;
}
