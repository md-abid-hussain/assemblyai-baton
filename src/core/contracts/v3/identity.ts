/**
 * contracts/v3/identity.ts - roles, org kinds, plan ids and the request `Principal` (SAAS §14, §2.1–§2.3).
 * WP19; frozen at C3 (D1 18:30), additive only afterwards. Pure data and types: no runtime dependencies.
 *
 * The principal is the ONLY place a route learns which org it is acting in (SAAS §10.1 rule 3). Nothing reads
 * `orgId` from a body, query string, header or blueprint file.
 */
import type { ApiScope } from "./permissions";

/** The four org roles, most to least privileged (SAAS §3.7). */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * - `guest`: the org created by `POST /api/guest/start` for an anonymous user (SAAS §3.3), and the legacy
 *   `ws_<visitorId>` workspace before Better Auth lands;
 * - `personal`: the org created automatically with an account;
 * - `team`: any org created by hand or through an invite.
 */
export type OrgKind = "guest" | "personal" | "team";

export type PlanId = "guest" | "free" | "pro" | "business";

/**
 * Resolved by `requirePrincipal` (`src/server/saas/principal.ts`, SAAS §2.3).
 *
 * - `kind: "api_key"` → `role` is null and `scopes` govern (`/api/v1/**` only);
 * - `kind: "session"` → `role` governs and `scopes` is empty;
 * - `kind: "visitor"` → no account. Under `TENANCY_MODE=legacy` (and at C3) the visitor still gets
 *   `orgId = "ws_" + visitorId`, `role = "owner"` and `plan = "guest"`, which is exactly the v2 behaviour.
 *
 * `visitorId` and `ipKey` are always present, so the v2 device limits keep working unchanged (SAAS §2.6).
 */
export interface Principal {
  kind: "session" | "api_key" | "visitor";
  userId: string | null;
  /** An anonymous *account* (the Better Auth anonymous plugin), not "no account at all" — see `kind`. */
  isAnonymous: boolean;
  orgId: string | null;
  orgKind: OrgKind | null;
  role: Role | null;
  scopes: readonly ApiScope[];
  apiKeyId: string | null;
  plan: PlanId;
  visitorId: string;
  ipKey: string;
  requestId: string;
}

/** One row of the org switcher (SAAS §3.5). */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  kind: OrgKind;
  role: Role;
  plan: PlanId;
}

/** Settings → Members (SAAS §8.4). */
export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

/**
 * A pending invitation.
 *
 * `link` is the copyable accept URL (SAAS §3.6). It is **optional because it is a credential**: the API returns
 * it only to a caller holding `member:invite`. Everyone with `member:read` — down to a viewer — still sees that
 * the invitation exists, for whom and in what role, but cannot copy the thing that joins the org. See
 * `listInvitations` in `src/server/identity/member-store.ts` for why that separation matters while no email
 * address is verifiable (§3.2).
 *
 * Narrowed from `link: string` after C3 (WP19·3). This is the one non-additive edit to a frozen v3 contract;
 * `docs/notes/requests/wp19-to-wp20-invitation-link.md` records it, and no consumer existed at the time.
 */
export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  link?: string;
  expiresAt: string;
  invitedBy: string;
}
