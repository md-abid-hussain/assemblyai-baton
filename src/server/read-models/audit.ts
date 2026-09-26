import "server-only";

/**
 * The audit log viewer (SAAS §9, §8.4). WP20·2.
 *
 * A filterable table — actor, action, date range — 50 rows a page, with the plan's retention note. `audit:read`
 * is admin+ (§3.7); the page checks it and this module scopes every query to `principal.orgId`.
 *
 * **Three rules the viewer has to keep, because the log is the one surface that claims to be evidence:**
 *
 * 1. **The actor label is shown exactly as it was written.** §9 freezes it at write time so a rename or a
 *    deletion never rewrites history. Resolving `actor_id` to the user's *current* name here would undo that in
 *    the one place it is visible.
 * 2. **Metadata is allow-listed on the way out, not on the way in.** §9 forbids secret values, key material,
 *    passwords, raw IPs, case field values and blueprint source in `metadata`, and the writers respect that —
 *    but the viewer renders whatever is in the column, including rows written by a future WP. An allow-list of
 *    key *names* means a mistake upstream becomes an invisible row rather than a leak on a judged screen.
 * 3. **`ip_key` is never rendered.** It is a hashed device key, not an IP, and it still identifies a device.
 *
 * Keyset paging on `(occurred_at desc, id desc)`: an append-only log gets new rows at the top while someone is
 * reading page 2, and an OFFSET would show them a row twice.
 */
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";

import {
  AUDIT_PAGE_SIZE,
  auditActionLabel,
  type AuditFilter,
  type AuditPage,
  type AuditRowView,
} from "../../core/contracts/ext/wp20-app";
import type { Principal } from "../../core/contracts/v3/identity";
import { PLANS } from "../../core/contracts/v3/plans";
import { getDb, type Db } from "../db";
import { auditLog } from "../db/schema-saas";

/**
 * The metadata keys the viewer will render. Everything else in the column is dropped silently.
 *
 * They are all counts, ids, enum-ish words and version numbers — the things that make a row readable ("2 relays,
 * 1 run", "via: studio", "role: admin"). Nothing here can hold a secret, a field value or free text a user typed.
 */
const SAFE_METADATA_KEYS: readonly string[] = Object.freeze([
  "via", "role", "fromRole", "toRole", "cases", "relays", "drafts", "secrets", "publications", "count",
  "rev", "version", "plan", "fromPlan", "toPlan", "status", "reason", "name", "slug", "scopes", "events",
  "kind", "source", "hash", "attempt", "eventType", "endpointId", "relayId", "orgId", "userId", "keyId",
]);

/** `{via:"confirmed", relays:2}` → `via=confirmed · relays=2`. Values are stringified and length-capped. */
export function metadataDetail(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parts: string[] = [];
  for (const key of SAFE_METADATA_KEYS) {
    const v = (metadata as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "object") {
      if (!Array.isArray(v)) continue;
      const list = v.filter((x) => typeof x === "string" || typeof x === "number").slice(0, 6).join(", ");
      if (list) parts.push(`${key}=${list.slice(0, 120)}`);
      continue;
    }
    parts.push(`${key}=${String(v).slice(0, 120)}`);
    if (parts.length >= 8) break;
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `<iso>|<id>`: the keyset cursor. Opaque to the page, which only ever hands it back. */
export const encodeAuditCursor = (occurredAt: string, id: string): string => `${occurredAt}|${id}`;

export function decodeAuditCursor(raw: string | undefined): { occurredAt: Date; id: string } | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("|");
  if (at <= 0) return null;
  const d = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  return Number.isNaN(d.getTime()) || id.length === 0 ? null : { occurredAt: d, id };
}

const iso = (d: Date | string | null | undefined): string => {
  if (d === null || d === undefined) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
};

const ACTOR_TYPES = new Set(["user", "guest", "api_key", "system"]);

export async function loadAudit(p: Principal, filter: AuditFilter, db: Db = getDb()): Promise<AuditPage> {
  const retentionDays = PLANS[p.plan].limits.auditRetentionDays;
  const orgId = p.orgId ?? "";
  const empty: AuditPage = { rows: [], nextCursor: null, retentionDays, actions: [], filter };
  if (!orgId) return empty;

  const where = [eq(auditLog.orgId, orgId)];

  // The actor filter matches the frozen label OR the id, because the table shows the label and a URL shared
  // between admins may carry either. `ilike` with the value as a bound parameter, never concatenated.
  if (filter.actor) {
    const like = `%${filter.actor.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const clause = or(sql`${auditLog.actorLabel} ilike ${like}`, sql`${auditLog.actorId} ilike ${like}`);
    if (clause) where.push(clause);
  }
  if (filter.action) where.push(eq(auditLog.action, filter.action));
  if (filter.since) where.push(gte(auditLog.occurredAt, new Date(`${filter.since}T00:00:00.000Z`)));
  // `until` is an inclusive day, so the bound is the end of it.
  if (filter.until) where.push(lte(auditLog.occurredAt, new Date(`${filter.until}T23:59:59.999Z`)));

  const cursor = decodeAuditCursor(filter.cursor);
  if (cursor) {
    const after = or(
      lt(auditLog.occurredAt, cursor.occurredAt),
      and(eq(auditLog.occurredAt, cursor.occurredAt), lt(auditLog.id, cursor.id)),
    );
    if (after) where.push(after);
  }

  const rows = await db
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      actorType: auditLog.actorType,
      actorLabel: auditLog.actorLabel,
      actorId: auditLog.actorId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1);

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor = rows.length > AUDIT_PAGE_SIZE && last ? encodeAuditCursor(iso(last.occurredAt), last.id) : null;

  const views: AuditRowView[] = page.map((r) => ({
    id: r.id,
    occurredAt: iso(r.occurredAt),
    actorType: ACTOR_TYPES.has(r.actorType) ? (r.actorType as AuditRowView["actorType"]) : "system",
    // Never resolved against the current user row: the label is history (§9).
    actorLabel: r.actorLabel?.trim() || (r.actorType === "system" ? "System" : r.actorId || "Unknown"),
    action: r.action,
    actionLabel: auditActionLabel(r.action),
    targetType: r.targetType,
    targetId: r.targetId,
    detail: metadataDetail(r.metadata),
  }));

  return { rows: views, nextCursor, retentionDays, actions: await distinctActions(orgId, db), filter };
}

/**
 * The actions this org has actually produced, for the filter select.
 *
 * Deliberately not the whole `AUDIT_ACTIONS` vocabulary: a select with 40 options, 36 of which return nothing,
 * is a worse filter than one with the 6 that exist. Capped so a long-lived org cannot make the select unusable.
 */
export async function distinctActions(orgId: string, db: Db = getDb()): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .limit(60);
  return rows.map((r) => r.action).sort();
}
