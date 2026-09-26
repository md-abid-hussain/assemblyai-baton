import "server-only";

/**
 * The database `AuditWriter` (SAAS §9, §14). WP19·3.
 *
 * `getAuditWriter().write(entry, tx?)` is the only way an audit row is born. Until this file was registered the
 * port's default was the in-memory writer from `src/server/saas/ports.ts`, so **no call site changes here**:
 * WP19·2's three writers (`org.created`, `guest.claimed`, `guest.claimed_device`) and everything WP19·3 adds go
 * through the same seam.
 *
 * ### Three properties worth naming
 *
 * 1. **In the caller's transaction when there is one.** `tx` is the Drizzle transaction handle; passing it means
 *    the row is committed with the change it describes, or not at all (S13).
 * 2. **Append-only at the database level.** `0003_audit_guard` refuses `UPDATE`, `DELETE` (outside the retention
 *    purge) and `TRUNCATE`, so a bug here cannot rewrite history — only fail to add to it.
 * 3. **`ipKey` and `requestId` are hoisted out of `metadata` into their own columns.** `AuditEntry` froze at C3
 *    without them and the table has had the columns since `0002`; hoisting keeps the contract frozen and keeps
 *    §10.5 true (only the hashed device key is ever stored, never a raw IP). A caller that sets neither gets
 *    nulls, which is what a system actor should have.
 */
import { and, desc, eq } from "drizzle-orm";

import {
  AUDIT_SOURCE_SAVED_COALESCE_MS,
  type AuditEntry,
} from "../../core/contracts/v3/audit";
import type { AuditWriter } from "../../core/contracts/v3/services";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema-saas";
import { saasId } from "../identity/ids";
import { log } from "../log";

const auditLogger = log.child({ component: "audit" });

/** The id prefix of an audit row (SAAS §2.7). */
export const AUDIT_ID_PREFIX = "aud_";

/** Anything that can run our writes: the pool or an open transaction. */
type Runner = Pick<Db, "select" | "insert">;

const runnerOf = (tx: unknown): Runner => (tx && typeof tx === "object" ? (tx as Runner) : getDb());

/** `metadata` minus the two hoisted keys, plus the values for their columns. */
function splitMetadata(metadata: Record<string, unknown> | undefined): {
  rest: Record<string, unknown>;
  ipKey: string | null;
  requestId: string | null;
} {
  const { ipKey, requestId, ...rest } = metadata ?? {};
  return {
    rest,
    ipKey: typeof ipKey === "string" && ipKey ? ipKey : null,
    requestId: typeof requestId === "string" && requestId ? requestId : null,
  };
}

/** The `rev` a `relay.source_saved` row carries (SAAS §9), or `null` when the caller did not supply one. */
const revOf = (metadata: Record<string, unknown> | undefined): number | null => {
  const rev = metadata?.rev;
  return typeof rev === "number" && Number.isFinite(rev) ? rev : null;
};

/**
 * Should this `relay.source_saved` row be dropped (SAAS §9)?
 *
 * The rule is "at most once per rev, and Studio autosaves coalesce to one row per 10 minutes per user and relay".
 * Both halves are decided against the **latest** existing row for the same (org, actor, relay) triple, which is
 * one indexed read rather than a scan: a repeated rev is always the latest one in practice (a save loop repeats
 * the rev it just wrote), and the time window only ever compares against the newest row anyway.
 *
 * A row with no target or no actor id is never coalesced — there is nothing to key the window on, and silently
 * merging unrelated saves would be worse than an extra row.
 */
async function shouldCoalesceSourceSaved(
  run: Runner,
  e: AuditEntry,
  now: number,
  windowMs: number,
): Promise<boolean> {
  if (!e.orgId || !e.actor.id || !e.target) return false;
  const [latest] = await run
    .select({ occurredAt: auditLog.occurredAt, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, e.orgId),
        eq(auditLog.action, "relay.source_saved"),
        eq(auditLog.actorId, e.actor.id),
        eq(auditLog.targetId, e.target.id),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(1);
  if (!latest) return false;

  const incoming = revOf(e.metadata);
  const previous = revOf(latest.metadata as Record<string, unknown> | null ?? undefined);
  // "At most once per rev": the same rev is never written twice, whatever the window says.
  if (incoming !== null && previous !== null && incoming === previous) return true;

  const age = now - new Date(latest.occurredAt).getTime();
  return age >= 0 && age < windowMs;
}

export interface DbAuditWriterOptions {
  db?: Db;
  now?: () => number;
  /** Overridable so a test does not have to wait ten minutes to prove the window closes. */
  coalesceMs?: number;
}

/**
 * The real writer. `write` resolves its runner per call (never at module load), so a test that repoints
 * `DATABASE_URL` before importing still writes to its own database.
 */
export function createDbAuditWriter(opts: DbAuditWriterOptions = {}): AuditWriter {
  const now = opts.now ?? Date.now;
  const windowMs = opts.coalesceMs ?? AUDIT_SOURCE_SAVED_COALESCE_MS;
  return {
    async write(e: AuditEntry, tx?: unknown): Promise<void> {
      const run: Runner = tx && typeof tx === "object" ? (tx as Runner) : (opts.db ?? getDb());
      if (e.action === "relay.source_saved" && (await shouldCoalesceSourceSaved(run, e, now(), windowMs))) {
        auditLogger.debug("coalesced relay.source_saved", { orgId: e.orgId, target: e.target?.id });
        return;
      }
      const { rest, ipKey, requestId } = splitMetadata(e.metadata);
      await run.insert(auditLog).values({
        id: saasId(AUDIT_ID_PREFIX),
        orgId: e.orgId,
        occurredAt: new Date(now()),
        actorType: e.actor.type,
        actorId: e.actor.id,
        actorLabel: e.actor.label,
        action: e.action,
        targetType: e.target?.type ?? null,
        targetId: e.target?.id ?? null,
        metadata: rest,
        ipKey,
        requestId,
      });
    },
  };
}

/** The runner a caller's `tx` resolves to. Exported for the retention purge, which needs the same rule. */
export { runnerOf };
