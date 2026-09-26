import "server-only";

/**
 * Turning a `Principal` into the audit row's actor (SAAS §9). WP19·3.
 *
 * The label is **frozen at write time** — a user's email, a key's `cko_…a1b2`, the literal "guest" — so a rename,
 * a removal or an org deletion never rewrites what the log says happened. That is the whole reason `actor_label`
 * is a column rather than a join.
 *
 * `ipKey` and `requestId` ride along in `metadata`; `src/server/audit/writer.ts` hoists them into their own
 * columns (see its header). Nothing here ever puts a raw IP anywhere (§10.5).
 */
import type { AuditEntry } from "../../core/contracts/v3/audit";
import type { Principal } from "../../core/contracts/v3/identity";

export type ActorType = AuditEntry["actor"]["type"];

export interface AuditActorFields {
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string;
}

/** The last four characters of a key id, in the `cko_…a1b2` shape §9 asks for. */
export const keyLabel = (apiKeyId: string): string => `key cko_…${apiKeyId.slice(-4)}`;

/**
 * The actor fields for a principal. `label` prefers the caller's own display value (an email we already loaded)
 * and otherwise falls back to something stable and non-identifying.
 */
export function actorOf(p: Principal, label?: string | null): AuditActorFields {
  if (p.kind === "api_key") {
    return {
      actorType: "api_key",
      actorId: p.apiKeyId,
      actorLabel: label?.trim() || (p.apiKeyId ? keyLabel(p.apiKeyId) : "api key"),
    };
  }
  if (p.kind === "session" && p.userId) {
    return {
      actorType: p.isAnonymous ? "guest" : "user",
      actorId: p.userId,
      actorLabel: label?.trim() || (p.isAnonymous ? "Guest" : p.userId),
    };
  }
  // A visitor has no account at all: the device is the actor, and the visitor id is not a person.
  return { actorType: "guest", actorId: null, actorLabel: label?.trim() || "Guest (no account)" };
}

/** The two request fields every audit row should carry. Merged into `metadata` by the callers. */
export const auditContext = (p: Principal): { ipKey: string; requestId: string } => ({
  ipKey: p.ipKey,
  requestId: p.requestId,
});

/** The system actor: jobs, the retention purge, the Polar sync. */
export const SYSTEM_ACTOR: AuditActorFields = Object.freeze({
  actorType: "system",
  actorId: null,
  actorLabel: "system",
});
