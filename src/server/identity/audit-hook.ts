import "server-only";

/**
 * A flat `writeAudit(...)` over the `AuditWriter` port (SAAS §9, §14).
 *
 * The identity module writes three audit rows in WP19·2 — `org.created`, `guest.claimed` and
 * `guest.claimed_device` — from inside transactions that already exist. Going through the port (rather than
 * `INSERT`ing here) is what lets **WP19·3** register the real `src/server/audit/**` writer without touching a
 * single call site, and lets a test register an in-memory writer and assert on rows.
 *
 * The flat shape exists because the callers naturally have `actorType`/`actorId`/`actorLabel` as separate values;
 * `AuditEntry` nests them, and doing that assembly once here keeps the call sites short.
 *
 * **An audit failure never fails the action it describes.** Losing the row is bad; losing a user's workspace
 * because the log was briefly unavailable is worse. Failures are logged and swallowed, except when the caller's
 * transaction is already poisoned, in which case the surrounding transaction reports it anyway.
 */
import type { AuditAction, AuditEntry } from "../../core/contracts/v3/audit";
import { getAuditWriter } from "../saas/ports";
import { log } from "../log";

const auditLog = log.child({ component: "identity" });

export interface FlatAuditEntry {
  orgId: string | null;
  actorType: AuditEntry["actor"]["type"];
  actorId: string | null;
  actorLabel: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export function toAuditEntry(e: FlatAuditEntry): AuditEntry {
  return {
    orgId: e.orgId,
    actor: { type: e.actorType, id: e.actorId, label: e.actorLabel },
    action: e.action,
    ...(e.targetType && e.targetId ? { target: { type: e.targetType, id: e.targetId } } : {}),
    ...(e.metadata ? { metadata: e.metadata } : {}),
  };
}

export async function writeAudit(e: FlatAuditEntry, tx?: unknown): Promise<void> {
  try {
    await getAuditWriter().write(toAuditEntry(e), tx);
  } catch (err) {
    auditLog.warn("audit write failed", { action: e.action, err });
  }
}
