import "server-only";

/**
 * `claimVisitorData(visitorId, orgId)` — moving a device's legacy `ws_<visitorId>` work into an organization
 * (SAAS §2.6), plus the §2.6 rule R1 machinery that decides **when** it may run.
 *
 * ### The shared-device rule (R1), the v3.1 review fix
 *
 * The `bvid` HMAC binds the cookie to the **device**, not to a person. An automatic claim on every sign-in would
 * therefore move the previous person's unclaimed guest work into the next person's org on a library PC, a demo
 * laptop, a kiosk or a judge's borrowed browser. So there are exactly three callers:
 *
 * | Trigger | Automatic? | Why |
 * |---|---|---|
 * | `POST /api/guest/start` (§3.3 step 6) | yes | the device is claiming its own data into the org it just created, in the same request |
 * | `onLinkAccount` (§3.4) | **does not call this at all** | the org id does not change, so there is nothing to move |
 * | `POST /api/app/claim-device` (WP19·3) | only on the button | the user confirmed the card that `countClaimableDevice` triggered |
 *
 * A plain sign-in claims **nothing**. That is a removal, and it is the P1 half of the v3.1 item.
 *
 * The transaction is idempotent by construction: every statement is a `WHERE`-guarded `UPDATE` off the old
 * workspace id, so running it twice moves nothing the second time. A device whose `ws_<vid>` data another org has
 * already claimed finds nothing to move.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { workspaceOf } from "../../core/contracts/v2/api";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { cases, drafts, relayPublications, relays } from "../db/schema";
import { orgMeta } from "../db/schema-saas";
import { log } from "../log";
import { getSecretRebinder } from "../saas/ports";
import { writeAudit } from "./audit-hook";

const claimLog = log.child({ component: "identity" });

/** §2.6 step 1: only runs from the last 7 days are claimed. Older device runs stay on the v2 retention schedule. */
export const CLAIM_CASE_WINDOW_DAYS = 7;

export interface ClaimCounts {
  cases: number;
  relays: number;
  drafts: number;
  secrets: number;
  publications: number;
}

export const NOTHING_CLAIMED: ClaimCounts = Object.freeze({
  cases: 0,
  relays: 0,
  drafts: 0,
  secrets: 0,
  publications: 0,
});

const sinceDate = (): Date => new Date(Date.now() - CLAIM_CASE_WINDOW_DAYS * 86_400_000);

/**
 * The §2.6 transaction, steps 1–6. `visitorId` must come from the **signed cookie**, re-derived server-side by the
 * caller — never from a request body (that is what makes the WP19·3 route un-forgeable).
 */
export async function claimVisitorData(
  visitorId: string,
  orgId: string,
  opts: { via?: "guest_start" | "confirmed"; actorId?: string | null; actorLabel?: string } = {},
  db: Db = getDb(),
): Promise<ClaimCounts> {
  const ws = workspaceOf(visitorId);
  if (!visitorId || !orgId || ws === orgId) return { ...NOTHING_CLAIMED };

  const counts = await db.transaction(async (tx) => {
    // Two tabs claiming the same device at once would both read "claimable" and both try to move it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`claim:${visitorId}`}))`);

    // 1. Runs of this device that belong to no org yet, within the window.
    const movedCases = await tx
      .update(cases)
      .set({ orgId })
      .where(and(eq(cases.visitorId, visitorId), isNull(cases.orgId), gt(cases.createdAt, sinceDate())))
      .returning({ id: cases.id });

    // 2. Relays still sitting in the legacy workspace.
    const movedRelays = await tx
      .update(relays)
      .set({ workspaceId: orgId })
      .where(and(eq(relays.workspaceId, ws), isNull(relays.deletedAt)))
      .returning({ id: relays.id });

    // 3. Drafts.
    const movedDrafts = await tx
      .update(drafts)
      .set({ workspaceId: orgId })
      .where(eq(drafts.workspaceId, ws))
      .returning({ id: drafts.id });

    // 4. Secrets: opened with the old AAD and re-sealed with the new one, same row ids (a WP16 port).
    const secrets = await getSecretRebinder().rebind(ws, orgId, tx);

    // 5. `relay_publications.org_id` for the relays we just moved.
    let publications = 0;
    if (movedRelays.length > 0) {
      const ids = movedRelays.map((r) => r.id);
      const moved = await tx
        .update(relayPublications)
        .set({ orgId })
        .where(sql`${relayPublications.relayId} in ${ids}`)
        .returning({ id: relayPublications.id });
      publications = moved.length;
    }

    const result: ClaimCounts = {
      cases: movedCases.length,
      relays: movedRelays.length,
      drafts: movedDrafts.length,
      secrets,
      publications,
    };

    // 6. One audit row — but only when something actually moved, so a repeated claim does not spam the log.
    if (result.cases + result.relays + result.drafts + result.secrets > 0) {
      await writeAudit(
        {
          orgId,
          actorType: opts.actorId ? "user" : "guest",
          actorId: opts.actorId ?? null,
          actorLabel: opts.actorLabel ?? "guest device",
          action: "guest.claimed_device",
          targetType: "org",
          targetId: orgId,
          metadata: { ...result, ...(opts.via ? { via: opts.via } : {}) },
        },
        tx,
      );
    }
    return result;
  });

  claimLog.info("device data claimed", { orgId, ...counts });
  return counts;
}

/**
 * What the §2.6 card would offer: how much unclaimed `ws_<vid>` work this device is carrying. Read-only and cheap,
 * because `/app` calls it on every load for a signed-in user.
 */
export async function countClaimableDevice(
  visitorId: string,
  db: Db = getDb(),
): Promise<{ cases: number; relays: number; drafts: number; total: number }> {
  const ws = workspaceOf(visitorId);
  const [row] = await db
    .select({
      cases: sql<string>`(select count(*) from ${cases} where ${cases.visitorId} = ${visitorId}
                            and ${cases.orgId} is null and ${cases.createdAt} > ${sinceDate()})`,
      relays: sql<string>`(select count(*) from ${relays} where ${relays.workspaceId} = ${ws}
                            and ${relays.deletedAt} is null)`,
      drafts: sql<string>`(select count(*) from ${drafts} where ${drafts.workspaceId} = ${ws})`,
    })
    .from(sql`(select 1) as _`);
  const c = Number(row?.cases ?? 0);
  const r = Number(row?.relays ?? 0);
  const d = Number(row?.drafts ?? 0);
  return { cases: c, relays: r, drafts: d, total: c + r + d };
}

// --------------------------------------------------------------------------------------- the decline record (R1)

/** Where a decline lives: `org_meta.onboarding.claimDeclined[visitorId] = <iso>`. */
const DECLINED_KEY = "claimDeclined";

/**
 * "Not mine": the card never returns for this `(orgId, visitorId)` pair. Permanent and idempotent.
 *
 * **Why this is a merge and not `jsonb_set`.** `jsonb_set(target, '{claimDeclined,<vid>}', …, true)` creates only
 * the *last* element of the path: when `onboarding` has no `claimDeclined` key yet — which is every org, since
 * nothing else writes it — the parent is missing and Postgres returns the document **unchanged, without error**.
 * The decline was silently dropped and the card came back on the next load. Building both levels with
 * `||` has no such hole and is still one idempotent statement.
 *
 * The visitor id is a bound parameter rather than part of a `'{a,b}'::text[]` path literal, so an id containing a
 * comma, brace or quote cannot change the path being written.
 */
export async function declineDeviceClaim(orgId: string, visitorId: string, db: Db = getDb()): Promise<void> {
  if (!orgId || !visitorId) return;
  await db
    .update(orgMeta)
    .set({
      onboarding: sql`coalesce(${orgMeta.onboarding}, '{}'::jsonb) || jsonb_build_object(
                        ${DECLINED_KEY}::text,
                        coalesce(${orgMeta.onboarding} -> ${DECLINED_KEY}::text, '{}'::jsonb)
                          || jsonb_build_object(${visitorId}::text, ${new Date().toISOString()}::text))`,
    })
    .where(eq(orgMeta.orgId, orgId));
}

export async function hasDeclinedDeviceClaim(orgId: string, visitorId: string, db: Db = getDb()): Promise<boolean> {
  const [row] = await db
    .select({
      declined: sql<boolean>`((${orgMeta.onboarding} -> ${DECLINED_KEY}::text) -> ${visitorId}::text) is not null`,
    })
    .from(orgMeta)
    .where(eq(orgMeta.orgId, orgId))
    .limit(1);
  return Boolean(row?.declined);
}

/**
 * The one question `/app` asks (WP19·3 serves it, WP20 renders the card): should we offer the claim for this
 * (org, device) pair? It is a *suggestion*, never an action.
 */
export async function claimOffer(
  orgId: string,
  visitorId: string,
  db: Db = getDb(),
): Promise<{ offer: boolean; cases: number; relays: number; drafts: number }> {
  if (await hasDeclinedDeviceClaim(orgId, visitorId, db)) return { offer: false, cases: 0, relays: 0, drafts: 0 };
  const c = await countClaimableDevice(visitorId, db);
  return { offer: c.total > 0, cases: c.cases, relays: c.relays, drafts: c.drafts };
}
