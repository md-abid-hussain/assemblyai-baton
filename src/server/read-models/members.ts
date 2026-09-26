import "server-only";

/**
 * Settings → Members & invites (SAAS §8.4, §3.6, §3.7). WP20·2.
 *
 * **Why this is a read model and not a `GET /api/app/members`.** SAAS §6.2 gives the app one read path, and the
 * page is a server component: a fetch to our own origin from inside a render would cost a second HTTP hop, a
 * second cookie round-trip and a second place for the tenant predicate to be forgotten. WP19·3's
 * `/api/app/members` exists for the **mutations** (§3.8 makes them server-mediated); this module answers "what
 * is in this org right now", scoped by `principal.orgId` and nothing else.
 *
 * Read-only by construction: only SELECTs, and the org id only ever comes from the principal (§10.1 rule 3).
 */
import { and, asc, eq } from "drizzle-orm";

import {
  ROLE_LABEL,
  type InviteRowView,
  type MemberRowView,
  type MembersView,
} from "../../core/contracts/ext/wp20-app";
import { ROLES, type Principal, type Role } from "../../core/contracts/v3/identity";
import { assignableRoles, can } from "../../core/contracts/v3/permissions";
import { PLANS } from "../../core/contracts/v3/plans";
import { getDb, type Db } from "../db";
import { invitations, members, organizations, users } from "../db/schema-auth";

/** An unknown string in `members.role` reads as the least privilege, never as the most. */
const asRole = (v: string | null | undefined): Role =>
  (ROLES as readonly string[]).includes(v ?? "") ? (v as Role) : "viewer";

const iso = (d: Date | string | null | undefined): string => {
  if (d === null || d === undefined) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
};

/**
 * The copyable accept link (SAAS §3.6).
 *
 * `APP_URL` is the deployment's own public URL and is the only correct base — an invite link that points at
 * `localhost` is worse than no button. When it is unset (a worktree, a test) the relative path is returned, which
 * the browser resolves against the page it is already on, so Copy link still produces something that works.
 */
export function inviteLink(id: string, appUrl: string | undefined): string {
  const base = appUrl?.trim().replace(/\/+$/, "");
  return `${base ?? ""}/accept-invite/${id}`;
}

/**
 * Members, pending invites, seats and what the viewer may do.
 *
 * A guest is **not** refused: §8.5's rule is "show the real surface, disable the action, offer the 10-second
 * account". `accountRequired` carries that to the page; `canInvite` stays false so no button lies.
 */
export async function loadMembers(p: Principal, db: Db = getDb()): Promise<MembersView> {
  const orgId = p.orgId ?? "";
  const plan = p.plan;
  const accountRequired = p.kind === "visitor" || p.isAnonymous || p.userId === null;

  const base: MembersView = {
    orgId,
    orgName: "This workspace",
    plan,
    members: [],
    invitations: [],
    seatsUsed: 0,
    seatLimit: PLANS[plan].limits.seats,
    canInvite: false,
    canManage: false,
    assignable: [],
    viewerRole: p.role,
    accountRequired,
    viewerUserId: p.userId,
  };
  if (!orgId) return base;

  const { appUrl } = await import("../identity");

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const memberRows = await db
    .select({
      userId: members.userId,
      role: members.role,
      joinedAt: members.createdAt,
      name: users.name,
      email: users.email,
      isAnonymous: users.isAnonymous,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.organizationId, orgId))
    .orderBy(asc(members.createdAt), asc(members.userId));

  const inviteRows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      inviterName: users.name,
      inviterEmail: users.email,
    })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending")))
    .orderBy(asc(invitations.createdAt));

  const ownerCount = memberRows.filter((r) => asRole(r.role) === "owner").length;
  const now = Date.now();

  const memberViews: MemberRowView[] = memberRows.map((r) => {
    const role = asRole(r.role);
    return {
      userId: r.userId,
      // An anonymous account has a generated name and a `@guest.…` address; showing it as "Guest" is the truth.
      name: r.isAnonymous ? "Guest" : r.name,
      email: r.isAnonymous ? "" : r.email,
      role,
      joinedAt: iso(r.joinedAt),
      isSelf: r.userId === p.userId,
      isLastOwner: role === "owner" && ownerCount <= 1,
    };
  });

  // G3 integration: the link IS the credential, so it follows `member:invite`, not `member:read`
  // (`docs/notes/requests/wp19-to-wp20-invitation-link.md`; `InvitationView.link` is optional for the same
  // reason). Without this gate the page would hand a viewer an admin invitation's accept URL, which — with
  // `EMAIL_MODE=off` and no verifiable address — is a role escalation. Existence, recipient, role, inviter
  // and expiry stay visible to everyone who can read the roster.
  const mayCopyLink = !accountRequired && can(p, "member:invite");
  const inviteViews: InviteRowView[] = inviteRows.map((r) => ({
    id: r.id,
    email: r.email,
    role: asRole(r.role),
    ...(mayCopyLink ? { link: inviteLink(r.id, appUrl()) } : {}),
    expiresAt: iso(r.expiresAt),
    invitedBy: r.inviterName || r.inviterEmail,
    expired: r.expiresAt instanceof Date ? r.expiresAt.getTime() < now : new Date(r.expiresAt).getTime() < now,
  }));

  return {
    ...base,
    orgName: org?.name ?? base.orgName,
    members: memberViews,
    invitations: inviteViews,
    // SAAS §4.1 counts a pending invite as a seat: a plan cannot be beaten by inviting and accepting later.
    seatsUsed: memberViews.length + inviteViews.filter((i) => !i.expired).length,
    canInvite: !accountRequired && can(p, "member:invite"),
    canManage: !accountRequired && can(p, "member:manage"),
    assignable: p.role ? assignableRoles(p.role) : [],
    viewerRole: p.role,
  };
}

/** The role select's options, already labelled. Kept here so the page never builds the list by hand. */
export const roleOptions = (assignable: readonly Role[]): { value: Role; label: string }[] =>
  assignable.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
