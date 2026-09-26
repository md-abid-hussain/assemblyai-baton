import "server-only";

/**
 * `ensurePersonalOrg(userId)` (SAAS §3.1).
 *
 * **No user ever lands in an org-less app.** If a real user has no membership — they signed up through a path that
 * did not create one, or they left their last org — the `/app` layout creates "<Name>'s workspace" and makes it
 * active. That is why onboarding (§8.3) is about templates rather than forms.
 *
 * Idempotent through an advisory lock on the user id, so two tabs loading `/app` at the same moment create one org,
 * not two. Anonymous users are refused outright: their org is the guest org, created by `/api/guest/start`, and a
 * second one would break the §2.2 "guests own exactly 1" rule.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { members, users } from "../db/schema-auth";
import { writeAudit } from "./audit-hook";
import { createOrg, personalSlug, withUserLock, workspaceName, type OrgRow } from "./org-store";

export interface EnsurePersonalOrgResult {
  org: OrgRow | null;
  created: boolean;
  /** Why nothing was created, when `org` is null. */
  reason?: "anonymous" | "unknown_user";
}

export async function ensurePersonalOrg(userId: string, db: Db = getDb()): Promise<EnsurePersonalOrgResult> {
  return withUserLock(
    userId,
    async (tx) => {
      const [user] = await tx
        .select({ email: users.email, name: users.name, isAnonymous: users.isAnonymous })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return { org: null, created: false, reason: "unknown_user" as const };
      // §2.2: a guest owns exactly one org, and `/api/guest/start` already made it.
      if (user.isAnonymous) return { org: null, created: false, reason: "anonymous" as const };

      // Re-checked inside the lock: the whole point of the lock is that this read is not stale.
      const existing = await tx
        .select({ orgId: members.organizationId })
        .from(members)
        .where(eq(members.userId, userId))
        .limit(1);
      if (existing.length > 0) return { org: null, created: false };

      const display = user.name?.trim() || user.email;
      const org = await createOrg(
        {
          name: workspaceName(display),
          slug: personalSlug(user.email),
          kind: "personal",
          createdVia: "auto_personal",
          ownerUserId: userId,
          plan: "free",
        },
        tx,
      );
      await writeAudit(
        {
          orgId: org.id,
          actorType: "user",
          actorId: userId,
          actorLabel: user.email,
          action: "org.created",
          targetType: "org",
          targetId: org.id,
          metadata: { via: "auto_personal" },
        },
        tx,
      );
      return { org, created: true };
    },
    db,
  );
}
