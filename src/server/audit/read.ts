import "server-only";

/**
 * Reading the audit log for one org (SAAS §9 "Read API", §8.4). WP19·3.
 *
 * `GET /api/app/audit?cursor&actor&action&from&to`. Two rules the shape exists to keep:
 *
 * - **`orgId` is a parameter, never a filter the caller can widen** (SAAS §10.1 rule 2). It comes from the
 *   principal; the query string cannot name an org.
 * - **The cursor is opaque and total.** `(occurred_at, id)` descending, so two rows written in the same
 *   millisecond cannot hide each other across a page boundary. It is base64url of `<iso>|<id>`; an unparsable
 *   cursor is a 400, not a silent first page (a silently reset cursor is how a paging loop becomes infinite).
 */
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema-saas";
import { SaasError } from "../saas/errors";

/** One row as the Audit page and the read API render it. */
export interface AuditRowView {
  id: string;
  occurredAt: string;
  actor: { type: string; id: string | null; label: string | null };
  action: string;
  target: { type: string; id: string } | null;
  metadata: Record<string, unknown>;
}

export interface AuditPage {
  rows: AuditRowView[];
  /** The cursor to pass as `?cursor=` for the next page, or `null` at the end. */
  nextCursor: string | null;
}

export interface AuditQuery {
  cursor?: string | undefined;
  /** An actor id (a user id or an api key row id), not a label. */
  actor?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

const b64url = {
  encode: (s: string) => Buffer.from(s, "utf8").toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url").toString("utf8"),
};

export const encodeAuditCursor = (occurredAt: Date, id: string): string =>
  b64url.encode(`${occurredAt.toISOString()}|${id}`);

export function decodeAuditCursor(raw: string): { occurredAt: Date; id: string } {
  const [iso, id] = b64url.decode(raw).split("|");
  const at = iso ? new Date(iso) : new Date(Number.NaN);
  if (!id || Number.isNaN(at.getTime())) {
    throw new SaasError("E_VALIDATION", "That audit cursor is not one we issued. Start from the first page.");
  }
  return { occurredAt: at, id };
}

/** An ISO date that the caller supplied, or `undefined`. A malformed one is a 400, never a silently ignored filter. */
function isoOrThrow(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new SaasError("E_VALIDATION", `\`${field}\` must be an ISO timestamp.`, {
      issues: [{ path: [field], message: "not an ISO timestamp" }],
    });
  }
  return d;
}

/** One page of an org's audit log, newest first. */
export async function readAuditPage(orgId: string, q: AuditQuery = {}, db: Db = getDb()): Promise<AuditPage> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? AUDIT_PAGE_DEFAULT)), AUDIT_PAGE_MAX);
  const where: SQL[] = [eq(auditLog.orgId, orgId)];

  if (q.actor) where.push(eq(auditLog.actorId, q.actor));
  // An action name outside `AUDIT_ACTIONS` matches nothing rather than erroring: the filter is a convenience, and
  // an action added additively after this deployment shipped should read as "no rows yet", not as a 400.
  if (q.action) where.push(eq(auditLog.action, q.action));
  const from = isoOrThrow(q.from, "from");
  const to = isoOrThrow(q.to, "to");
  if (from) where.push(gte(auditLog.occurredAt, from));
  if (to) where.push(lte(auditLog.occurredAt, to));

  if (q.cursor) {
    const c = decodeAuditCursor(q.cursor);
    // The total order: strictly older, or the same instant with a smaller id.
    const after = or(
      lt(auditLog.occurredAt, c.occurredAt),
      and(eq(auditLog.occurredAt, c.occurredAt), lt(auditLog.id, c.id)),
    );
    if (after) where.push(after);
  }

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id,
      occurredAt: new Date(r.occurredAt).toISOString(),
      actor: { type: r.actorType, id: r.actorId, label: r.actorLabel },
      action: r.action,
      target: r.targetType && r.targetId ? { type: r.targetType, id: r.targetId } : null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    })),
    nextCursor: rows.length > limit && last ? encodeAuditCursor(new Date(last.occurredAt), last.id) : null,
  };
}

/** How many audit rows one org has. The Audit page uses it for its empty state; the tenancy suite asserts on it. */
export async function countAuditRows(orgId: string, db: Db = getDb()): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`count(*)` })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId));
  return Number(r?.n ?? 0);
}
