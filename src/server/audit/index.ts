import "server-only";

/** The audit module's public surface (SAAS §9). WP19·3. */
export { actorOf, auditContext, keyLabel, SYSTEM_ACTOR, type ActorType, type AuditActorFields } from "./actor";
export {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  countAuditRows,
  decodeAuditCursor,
  encodeAuditCursor,
  readAuditPage,
  type AuditPage,
  type AuditQuery,
  type AuditRowView,
} from "./read";
export {
  AUDIT_PURGE_SETTING,
  auditRetentionStep,
  ORPHAN_RETENTION_DAYS,
  purgeAuditRetention,
  retentionDaysFor,
  type AuditPurgeResult,
} from "./retention";
export { AUDIT_ID_PREFIX, createDbAuditWriter, type DbAuditWriterOptions } from "./writer";
