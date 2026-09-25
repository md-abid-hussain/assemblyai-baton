/**
 * contracts/v3/audit.ts - the audit log vocabulary (SAAS §14, §9). WP19; frozen at C3, additive afterwards.
 *
 * The log is append-only (the `0003_audit_guard` trigger) and purged per plan retention.
 * **Never** in `metadata`: secret values, API key material, webhook secrets, passwords, raw IPs (only `ip_key`),
 * case field values, blueprint source text.
 */

/**
 * Exactly the SAAS §9 list. (§14 sketches the type as `string & {}`; a closed union is the same list with the
 * compiler checking it, and adding an action later is additive. WP19·1 decision, recorded in docs/notes/wp19.md.)
 */
export const AUDIT_ACTIONS = [
  "org.created", "org.renamed", "org.deleted", "org.ownership_transferred",
  "member.invited", "member.invite_revoked", "member.joined", "member.role_changed", "member.removed", "member.left",
  "guest.claimed", "guest.claimed_device",
  "relay.created", "relay.cloned", "relay.imported", "relay.source_saved", "relay.deleted", "relay.version_created",
  "relay.restored", "relay.published", "relay.unpublished",
  "secret.created", "secret.deleted",
  "connector.tested", "connector.host_added", "connector.host_removed",
  "apikey.created", "apikey.revoked", "apikey.disabled",
  "webhook.endpoint_created", "webhook.endpoint_updated", "webhook.endpoint_deleted", "webhook.endpoint_disabled",
  "webhook.redelivered", "webhook.test_sent",
  "billing.checkout_started", "billing.plan_changed", "billing.canceled", "billing.resumed",
  "entitlement.override_set",
  "session.signed_in",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** `label` is frozen at write time (a user's email, a key's `cko_…a1b2`), so it survives the actor's deletion. */
export interface AuditActor {
  type: "user" | "guest" | "api_key" | "system";
  id: string | null;
  label: string;
}

export interface AuditEntry {
  /** `null` only for actions that happen outside any org. */
  orgId: string | null;
  actor: AuditActor;
  action: AuditAction;
  target?: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

/**
 * Studio autosaves are coalesced to one `relay.source_saved` row per this window, per user and relay (SAAS §9);
 * the row is also written at most once per rev.
 */
export const AUDIT_SOURCE_SAVED_COALESCE_MS = 10 * 60 * 1000;
