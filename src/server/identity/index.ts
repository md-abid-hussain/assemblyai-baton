import "server-only";

/**
 * The identity layer's public surface and its one bootstrap call (SAAS §2.3, §3).
 *
 * `installIdentity()` swaps the C3 legacy `PrincipalResolver` for the session/API-key one. Every entry point that
 * can be the first to touch the identity layer calls it — the Better Auth catch-all, `/api/guest/start` and (from
 * WP20) the `/app` layout — and it is idempotent, so calling it from all of them is the point rather than a smell.
 * **No route file changes:** routes keep calling `requirePrincipal`, which reads the registry.
 *
 * Under `TENANCY_MODE=legacy` the resolver is still installed. Installing it changes nothing for a request with no
 * session — it falls through to the same `ws_<visitorId>` principal the C3 resolver returned — and it is what makes
 * the v3 pages testable before the G3 flip. The real kill switch is coarser and lives one level down: with no
 * `BETTER_AUTH_SECRET` there is no Better Auth instance at all, so every request is a device request (§2.8 K-AUTH).
 */
export { ac, roles, statementsFor, STATEMENTS } from "./access";
export { listMembershipsByRecency, membershipOf, pickActiveOrg, touchOrg } from "./active-org";
export { writeAudit, type FlatAuditEntry } from "./audit-hook";
export { COOKIE_PREFIX, GUEST_EMAIL_DOMAIN, getAuth, requireAuth, resetAuth, SESSION, type Auth } from "./auth";
export {
  AUTH_BASE_PATH,
  BLOCKED_CLIENT_AUTH_PATHS,
  authPathOf,
  isBlockedClientAuthPath,
} from "./blocked-paths";
export {
  claimOffer,
  claimVisitorData,
  countClaimableDevice,
  declineDeviceClaim,
  hasDeclinedDeviceClaim,
  type ClaimCounts,
} from "./claim";
export { appUrl, authConfigured, authMissing, guestLimits, isProd, trustedOrigins } from "./config";
export { GUEST_BUCKETS, GUEST_FALLBACK, safeNext, startGuest, type GuestStartResult } from "./guest-start";
export { prefixedId, saasId, ID_PREFIXES } from "./ids";
export { GUEST_ORG_NAME, linkAnonymousAccount, onLinkAccount } from "./link";
export { GUEST_IDLE_DAYS, idleGuestStep, purgeIdleGuests, type GuestPurgeResult } from "./guest-purge";
export {
  assertMayActOn,
  cancelInvitation,
  countOwners,
  hasOtherMembers,
  invitationLink,
  inviteConflict,
  listInvitations,
  listMembers,
  memberRow,
  pendingInvitation,
  removeMember,
  setMemberRole,
  transferOwnership,
} from "./member-store";
export {
  countOwnedOrgs,
  countSeats,
  createOrg,
  deleteOrgRow,
  getOrg,
  guestSlug,
  listOrgSummaries,
  MAX_OWNED_ORGS,
  personalSlug,
  planOf,
  principalFactsFor,
  renameOrg,
  slugify,
  workspaceName,
  type OrgRow,
} from "./org-store";
export { userLabel } from "./user-label";
export { ensurePersonalOrg } from "./personal-org";
export {
  apiKeyOf,
  orgForSession,
  registerSessionPrincipal,
  resolvePrincipal,
  resolveSessionPrincipal,
  scopesOf,
} from "./principal";

import { registerSessionPrincipal } from "./principal";
import { installWriters, resetWritersInstall } from "../saas/writers";

let installed = false;

/**
 * Idempotent. Safe to call from every entry point, and from a test's `beforeEach`.
 *
 * WP19·3 adds `installWriters()` here rather than at a second entry point: the database `AuditWriter`,
 * `DomainEvents` and `UsageMeter` have to be registered before the first route writes anything, and every path
 * that can be first already calls this.
 */
export function installIdentity(): void {
  if (installed) return;
  installed = true;
  registerSessionPrincipal();
  installWriters();
}

/** Tests only: forget that `installIdentity()` ran. */
export function resetIdentityInstall(): void {
  installed = false;
  resetWritersInstall();
}
