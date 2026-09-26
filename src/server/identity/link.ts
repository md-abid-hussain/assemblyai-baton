import "server-only";

/**
 * `onLinkAccount` — the guest → account carry-over (SAAS §3.4). WP19.
 *
 * `[VERIFY d]` PASS: the hook runs **before** Better Auth deletes the anonymous user, for sign-up *and* for sign-in
 * to an existing account, and the argument is `{ anonymousUser: { user, session }, newUser: { user, session } }`.
 *
 * The whole point is that **nothing gets a new id**: the org id, the relay ids, the run ids and the secret ids are
 * unchanged, so open tabs, share links, API resources and `changeover.lock.json` files keep working. We move the
 * *owner*, not the data.
 *
 * **This is not the shared-device claim.** It moves only what the current anonymous session owns — the person
 * signing in demonstrably *is* the guest who did the work, in the same browser session. Unclaimed `ws_<vid>` data
 * with no live anonymous session behind it is governed by §2.6 rule R1 and needs the confirmation card;
 * `claimVisitorData` is never called from here.
 */
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

import type { OrgKind } from "../../core/contracts/v3/identity";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { cases, relays } from "../db/schema";
import { members, organizations, users } from "../db/schema-auth";
import { orgEntitlements, orgMeta } from "../db/schema-saas";
import { log } from "../log";
import { writeAudit } from "./audit-hook";
import { workspaceName } from "./org-store";

const linkLog = log.child({ component: "identity" });

/** The name `createOrg` gives a guest org (§3.3 step 4), and the only name §3.4 step 2 replaces. */
export const GUEST_ORG_NAME = "Guest workspace";

export interface LinkAccountInput {
  anonymousUser: { user: { id: string; name?: string | null; email?: string | null } };
  newUser: { user: { id: string; name?: string | null; email?: string | null } };
}

export interface LinkResult {
  movedOrgIds: string[];
  /** Orgs whose `kind` became `personal` (the new user had none) or `team` (they already had one). */
  kindAfter: Record<string, OrgKind>;
  casesMoved: number;
  relaysMoved: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The §3.4 transaction. Steps 1–5 in order, all or nothing.
 *
 * Step 3 of the spec lists `cases`, `relays` and `webhook_endpoints`; a guest cannot own a webhook endpoint
 * (§3.3: webhooks need an account), and `webhook_endpoints.created_by_user_id` is WP24's column to fill, so the
 * two tables that can actually hold a guest's authorship are the ones moved here.
 */
export async function linkAnonymousAccount(input: LinkAccountInput, db: Db = getDb()): Promise<LinkResult> {
  const anonId = input.anonymousUser.user.id;
  const newId = input.newUser.user.id;
  const empty: LinkResult = { movedOrgIds: [], kindAfter: {}, casesMoved: 0, relaysMoved: 0 };
  if (!anonId || !newId || anonId === newId) return empty;

  return db.transaction(async (tx) => {
    // Serialize against a second tab linking the same anonymous user.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`link:${anonId}`}))`);

    // 1. The guest org is now owned by the real user.
    const moved = await tx
      .update(members)
      .set({ userId: newId })
      .where(eq(members.userId, anonId))
      .returning({ orgId: members.organizationId });
    const movedOrgIds = moved.map((m) => m.orgId);

    // Did the new user already have an org of their own, not counting the ones we just moved?
    const preexisting = await tx
      .select({ orgId: members.organizationId })
      .from(members)
      .where(
        movedOrgIds.length
          ? and(eq(members.userId, newId), notInArray(members.organizationId, movedOrgIds))
          : eq(members.userId, newId),
      );
    const hadOtherOrgs = preexisting.length > 0;

    const [newUserRow] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, newId))
      .limit(1);
    const display = newUserRow?.name?.trim() || newUserRow?.email || input.newUser.user.email || null;

    // 2. Guest orgs become personal or team, get a human name, and stop being on the guest plan.
    const kindAfter: Record<string, OrgKind> = {};
    if (movedOrgIds.length > 0) {
      const guestOrgs = await tx
        .select({ orgId: orgMeta.orgId })
        .from(orgMeta)
        .where(and(inArray(orgMeta.orgId, movedOrgIds), eq(orgMeta.kind, "guest")));
      const newName = hadOtherOrgs ? `Guest workspace (claimed ${today()})` : workspaceName(display);
      for (const { orgId } of guestOrgs) {
        const kind: OrgKind = hadOtherOrgs ? "team" : "personal";
        kindAfter[orgId] = kind;
        await tx
          .update(orgMeta)
          // step 5: `last_active_at` now, so `pickActiveOrg` makes the claimed org active in the new session
          .set({ kind, lastActiveAt: new Date() })
          .where(eq(orgMeta.orgId, orgId));
        // Only the default "Guest workspace" name is replaced; a name the guest chose is theirs and is kept.
        await tx
          .update(organizations)
          .set({ name: newName })
          .where(and(eq(organizations.id, orgId), eq(organizations.name, GUEST_ORG_NAME)));
        await tx
          .update(orgEntitlements)
          .set({ plan: "free", source: "default", updatedAt: new Date() })
          .where(and(eq(orgEntitlements.orgId, orgId), eq(orgEntitlements.plan, "guest")));
      }
      // An org the guest somehow owned that was not `kind: guest` keeps its kind; only its recency is touched.
      await tx
        .update(orgMeta)
        .set({ lastActiveAt: new Date() })
        .where(and(inArray(orgMeta.orgId, movedOrgIds), ne(orgMeta.kind, "guest")));
    }

    // 3. Re-attribute the rows that name the author.
    const movedCases = await tx
      .update(cases)
      .set({ createdByUserId: newId })
      .where(eq(cases.createdByUserId, anonId))
      .returning({ id: cases.id });
    const movedRelays = await tx
      .update(relays)
      .set({ createdByUserId: newId })
      .where(eq(relays.createdByUserId, anonId))
      .returning({ id: relays.id });

    // 4. One audit row per moved org. The log itself is never rewritten: older rows keep the guest actor label.
    for (const orgId of movedOrgIds) {
      await writeAudit(
        {
          orgId,
          actorType: "user",
          actorId: newId,
          actorLabel: display ?? newId,
          action: "guest.claimed",
          targetType: "org",
          targetId: orgId,
          metadata: { fromUserId: anonId, toUserId: newId, orgId },
        },
        tx,
      );
    }

    return { movedOrgIds, kindAfter, casesMoved: movedCases.length, relaysMoved: movedRelays.length };
  });
}

/**
 * The Better Auth hook. It never throws into the sign-up/sign-in path: a failed carry-over must not cost the user
 * their new account. The data stays where it is and §2.6's confirmation card can still claim it later.
 */
export async function onLinkAccount(data: LinkAccountInput): Promise<void> {
  try {
    const r = await linkAnonymousAccount(data);
    linkLog.info("guest linked to an account", {
      orgs: r.movedOrgIds.length,
      cases: r.casesMoved,
      relays: r.relaysMoved,
    });
  } catch (err) {
    linkLog.error("guest carry-over failed; the account was still created", { err });
  }
}
