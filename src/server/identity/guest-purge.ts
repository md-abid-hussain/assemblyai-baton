import "server-only";

/**
 * `purgeIdleGuests()` — the 14-day guest lifetime (SAAS §3.3, §10.4). WP19·3; called by WP12's purge job.
 *
 * > "Guest users idle for 14 days are purged together with their guest org and its data: relays soft-deleted,
 * > publications unpublished and their agents deleted, secrets and drafts deleted (a guest has no webhook data).
 * > Runs follow the v2 case retention."
 *
 * ### What counts as idle
 *
 * `org_meta.last_active_at`, which `touchOrg()` bumps on every app request that resolves that org, **and** the
 * newest session row for the org's owner. Both, because a guest who signs in on a second device without opening
 * the app would otherwise look idle. A guest org with neither is aged from its own `created_at`.
 *
 * ### What this function does *not* do
 *
 * It does not call AssemblyAI. A guest plan's publications expire after 24 hours (`PLANS.guest.publicationIdleHours`)
 * and WP18's purge pass unpublishes them and deletes the agents — thirteen days before this step can run. Any
 * publication still standing at day 14 is left for that pass rather than deleted behind its back, and the count
 * is returned so a surprise is visible in the job details instead of silent. That keeps this step **$0** and keeps
 * one owner for the agent lifecycle.
 *
 * ### Order
 *
 * Data first, org last. If the run dies halfway, the org is still there and the next pass finishes the job; the
 * reverse would strand rows whose `workspace_id` points at nothing.
 */
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { connectorSecrets, drafts, relayPublications, relays } from "../db/schema";
import { members, organizations, sessions, users } from "../db/schema-auth";
import { orgMeta } from "../db/schema-saas";
import { log } from "../log";

const purgeLog = log.child({ component: "identity" });

const DAY_MS = 86_400_000;

/** SAAS §3.3: guests idle this long are purged. */
export const GUEST_IDLE_DAYS = 14;

export interface GuestPurgeResult {
  orgs: number;
  relays: number;
  drafts: number;
  secrets: number;
  users: number;
  /** Publications still standing at day 14, handed to WP18's `deleting` queue. Normally 0. */
  publicationsLeftToWp18: number;
}

const EMPTY: GuestPurgeResult = Object.freeze({
  orgs: 0, relays: 0, drafts: 0, secrets: 0, users: 0, publicationsLeftToWp18: 0,
});

/**
 * The guest orgs whose owner has been idle for `days`. One query: the org's own activity and the owner's newest
 * session are both compared against the cutoff, and an org with no session row at all falls back to `created_at`.
 */
async function idleGuestOrgs(
  db: Db,
  cutoff: Date,
  limit: number,
): Promise<{ orgId: string; ownerUserId: string }[]> {
  const lastSession = db
    .select({
      userId: sessions.userId,
      at: sql<Date>`max(${sessions.updatedAt})`.as("last_session_at"),
    })
    .from(sessions)
    .groupBy(sessions.userId)
    .as("last_session");

  const rows = await db
    .select({ orgId: organizations.id, ownerUserId: members.userId })
    .from(organizations)
    .innerJoin(orgMeta, eq(orgMeta.orgId, organizations.id))
    .innerJoin(members, and(eq(members.organizationId, organizations.id), eq(members.role, "owner")))
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(lastSession, eq(lastSession.userId, members.userId))
    .where(
      and(
        eq(orgMeta.kind, "guest"),
        // Only an anonymous account's org is a guest org. A claimed one belongs to a real user and never expires.
        eq(users.isAnonymous, true),
        lt(orgMeta.lastActiveAt, cutoff),
        lt(organizations.createdAt, cutoff),
        or(isNull(lastSession.at), lt(lastSession.at, cutoff)),
      ),
    )
    .orderBy(desc(organizations.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Purge idle guests. `now` and `db` are injectable for the tests; `limit` bounds one pass so a backlog is worked
 * off over several nights rather than in one transaction.
 */
export async function purgeIdleGuests(
  db: Db = getDb(),
  now: number = Date.now(),
  opts: { days?: number; limit?: number } = {},
): Promise<GuestPurgeResult> {
  const cutoff = new Date(now - (opts.days ?? GUEST_IDLE_DAYS) * DAY_MS);
  const victims = await idleGuestOrgs(db, cutoff, opts.limit ?? 200);
  if (victims.length === 0) return { ...EMPTY };

  const orgIds = victims.map((v) => v.orgId);
  const userIds = victims.map((v) => v.ownerUserId);
  const out: GuestPurgeResult = { ...EMPTY, orgs: orgIds.length };

  // 1. Relays: soft-deleted, so a case that still references one can still be read back.
  out.relays = (
    await db
      .update(relays)
      .set({ deletedAt: new Date(now) })
      .where(and(inArray(relays.workspaceId, orgIds), isNull(relays.deletedAt)))
      .returning({ id: relays.id })
  ).length;

  // 2. Drafts and secrets: deleted outright. Neither survives its workspace in any useful sense.
  out.drafts = (
    await db.delete(drafts).where(inArray(drafts.workspaceId, orgIds)).returning({ id: drafts.id })
  ).length;
  out.secrets = (
    await db
      .delete(connectorSecrets)
      .where(inArray(connectorSecrets.workspaceId, orgIds))
      .returning({ id: connectorSecrets.id })
  ).length;

  // 3. Publications: handed to WP18's own state machine rather than deleted behind its back (see the header).
  //    `deleting` is the state its purge pass already retries, so the agent goes with the next pass and the share
  //    link stops answering now. Doing it here rather than there also matters because step 4 removes the org, and
  //    WP18's idle pass resolves a plan from the org it can no longer find.
  const handed = await db
    .update(relayPublications)
    .set({ status: "deleting" })
    .where(and(inArray(relayPublications.orgId, orgIds), inArray(relayPublications.status, ["live", "creating"])))
    .returning({ id: relayPublications.id });
  out.publicationsLeftToWp18 = handed.length;

  // 4. The org itself. `org_meta` and `org_entitlements` cascade (0002), as do `members` and `invitations`.
  await db.delete(organizations).where(inArray(organizations.id, orgIds));

  // 5. The anonymous user rows. `sessions` and `accounts` cascade from `users`.
  out.users = (
    await db
      .delete(users)
      .where(and(inArray(users.id, userIds), eq(users.isAnonymous, true)))
      .returning({ id: users.id })
  ).length;

  purgeLog.info("purged idle guests", { ...out });
  return out;
}

/** The step WP12's `registerPurgeStep("guests", …)` mounts. */
export const idleGuestStep = async (ctx: { db: Db; now: number }): Promise<Record<string, number>> => {
  const r = await purgeIdleGuests(ctx.db, ctx.now);
  return { guestOrgs: r.orgs, guestRelays: r.relays, guestDrafts: r.drafts, guestSecrets: r.secrets };
};
