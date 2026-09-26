import "server-only";

/**
 * `pickActiveOrg(userId)` (SAAS §3.1): the membership with the latest `org_meta.last_active_at`.
 *
 * It runs inside Better Auth's `databaseHooks.session.create.before`, i.e. on every sign-in and every anonymous
 * start, so it must be cheap and must never throw: a failure here would turn a working sign-in into a 500. A user
 * with no membership yet (the instant before `ensurePersonalOrg` or the guest-start transaction runs) gets `null`,
 * which Better Auth stores as no active organization.
 *
 * No `better-auth` import: this is a plain query, which keeps it usable from `/api/app/**` too.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { members, organizations } from "../db/schema-auth";
import { orgMeta } from "../db/schema-saas";
import { log } from "../log";

const orgLog = log.child({ component: "identity" });

/** The user's memberships, most recently active first. Orgs without an `org_meta` row sort last, by org id. */
export async function listMembershipsByRecency(
  userId: string,
  db: Db = getDb(),
): Promise<{ orgId: string; role: string }[]> {
  const rows = await db
    .select({ orgId: members.organizationId, role: members.role, lastActiveAt: orgMeta.lastActiveAt })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .leftJoin(orgMeta, eq(orgMeta.orgId, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(desc(sql`coalesce(${orgMeta.lastActiveAt}, 'epoch'::timestamptz)`), desc(members.organizationId));
  return rows.map((r) => ({ orgId: r.orgId, role: r.role }));
}

/** The org id to make active, or `null` when the user has none yet. Never throws. */
export async function pickActiveOrg(userId: string, db: Db = getDb()): Promise<string | null> {
  try {
    const [first] = await listMembershipsByRecency(userId, db);
    return first?.orgId ?? null;
  } catch (err) {
    // A sign-in must not fail because the switcher could not pick a default.
    orgLog.warn("pickActiveOrg failed; the session starts with no active org", { err });
    return null;
  }
}

/** Is `userId` a member of `orgId`, and with which role? `null` when there is no membership. */
export async function membershipOf(userId: string, orgId: string, db: Db = getDb()): Promise<{ role: string } | null> {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * `org_meta.last_active_at = now()` (SAAS §3.4 step 5, §3.5). Best-effort: it only reorders the switcher, so a
 * failure is logged and swallowed rather than failing the request that triggered it.
 */
export async function touchOrg(orgId: string, db: Db = getDb()): Promise<void> {
  try {
    await db.update(orgMeta).set({ lastActiveAt: new Date() }).where(eq(orgMeta.orgId, orgId));
  } catch (err) {
    orgLog.warn("touchOrg failed", { err });
  }
}

/** Orgs whose `org_meta` row is missing entirely — a repair hook for WP19·3's `/api/app/orgs`. */
export async function orgsWithoutMeta(db: Db = getDb()): Promise<string[]> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .leftJoin(orgMeta, eq(orgMeta.orgId, organizations.id))
    .where(isNull(orgMeta.orgId));
  return rows.map((r) => r.id);
}
