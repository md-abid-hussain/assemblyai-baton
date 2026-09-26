import "server-only";

/**
 * `/accept-invite/[id]`'s read (SAAS §3.6). WP20·2.
 *
 * **Why this reads the table instead of calling Better Auth.** §3.6 requires the page to show the org name and
 * the role *to a signed-out visitor* and to prefill the invited email on the sign-up form. Better Auth's
 * `getInvitation` needs a session, and the whole point of the page is that there is not one yet.
 *
 * **What the invite id is and is not.** It is a capability: whoever holds the link sees who invited whom, to
 * which workspace, in which role — which is exactly what §3.6 asks the page to show. It is **not** an
 * authorisation: accepting goes through Better Auth, which requires the session user's email to equal the
 * invitation's, so "the link alone is not enough" still holds. The one thing this module does beyond reading is
 * mask the address for display (`emailMasked`), so a link that leaks into a chat log does not also hand over the
 * invitee's email to whoever finds it; `emailPrefill` still carries it to the form that needs it.
 *
 * It returns `null` for an id that does not exist **and** for a malformed one, so the page renders the same
 * "this invitation is not valid" card either way — an enumerator learns nothing from the difference.
 */
import { eq } from "drizzle-orm";

import { maskEmail, type InviteCardView, type InviteStatus } from "../../core/contracts/ext/wp20-app";
import { ROLES, type Role } from "../../core/contracts/v3/identity";
import { getDb, type Db } from "../db";
import { invitations, organizations, users } from "../db/schema-auth";

const asRole = (v: string | null | undefined): Role =>
  (ROLES as readonly string[]).includes(v ?? "") ? (v as Role) : "member";

/** An id long enough to be a real prefixed id and short enough not to be a payload. */
const isPlausibleId = (id: string): boolean => /^[A-Za-z0-9_-]{8,64}$/.test(id);

export async function loadInvite(id: string, db: Db = getDb()): Promise<InviteCardView | null> {
  if (!isPlausibleId(id)) return null;

  const [row] = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      orgName: organizations.name,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(eq(invitations.id, id))
    .limit(1);

  if (!row) return null;

  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  const expired = Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now();

  let status: InviteStatus = "unknown";
  if (row.status === "pending") status = expired ? "expired" : "pending";
  else if (row.status === "accepted") status = "accepted";
  else if (row.status === "canceled" || row.status === "rejected") status = "canceled";

  return {
    id: row.id,
    orgName: row.orgName,
    role: asRole(row.role),
    emailMasked: maskEmail(row.email),
    emailPrefill: row.email,
    expiresAt: Number.isNaN(expiresAt.getTime()) ? "" : expiresAt.toISOString(),
    status,
  };
}

/**
 * The signed-in user's own email, for the "you are signed in as someone else" warning.
 *
 * Better Auth refuses an accept whose session email differs from the invitation's (§3.6), so without this the
 * page would offer a button whose only possible outcome is an error. One column, the caller's own row, and it
 * is never rendered next to the invitation's address — the page compares them and shows a sentence, so a leaked
 * link still does not reveal who was invited.
 */
export async function emailOfUser(userId: string | null, db: Db = getDb()): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}
