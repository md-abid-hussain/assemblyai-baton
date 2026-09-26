import "server-only";

/**
 * `/api/app/invitations/**` — invitations as copyable links (SAAS §3.6). WP19·3.
 *
 *   GET    /api/app/invitations      → { invitations }   — `member:read`
 *   POST   /api/app/invitations      → InvitationView    — `member:invite`, role ≤ the inviter's, seats checked
 *   DELETE /api/app/invitations/:id  → 204               — `member:invite`
 *
 * **The link alone is not enough.** The row is created through `auth.api.createInvitation`, so accepting goes
 * through Better Auth's own `accept-invitation`, which requires the session user's email to equal the
 * invitation's. That is why the create path calls the plugin server-side (§3.8) instead of inserting a row: an
 * invitation this code invented would be accepted by whoever held the URL.
 *
 * `sendInvitationEmail` is a no-op (`EMAIL_MODE=off`), so the response **is** the delivery mechanism: the
 * Members page shows Copy link.
 *
 * Seats (§4.1) are a plan count limit: `assertCount("seats")` counts members plus pending invitations, which is
 * why inviting five people into a three-seat plan fails on the fourth invitation rather than on the fourth
 * accept — the honest place to fail.
 */
import { z } from "zod";

import { ROLES, type InvitationView, type Role } from "../../core/contracts/v3/identity";
import { assignableRoles, can } from "../../core/contracts/v3/permissions";
import { actorOf, auditContext } from "../audit/actor";
import { SaasError } from "../saas/errors";
import { getEntitlements } from "../saas/ports";
import { appPrincipal, appRoute, json, paramOf, readAppJson, spendMutation, type AppPrincipal, type RouteCtx } from "./app-http";
import { writeAudit } from "./audit-hook";
import { getAuth } from "./auth";
import {
  cancelInvitation,
  inviteConflict,
  invitationLink,
  listInvitations,
  pendingInvitation,
} from "./member-store";
import { userLabel } from "./user-label";

const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ROLES).default("member"),
});

type IdCtx = RouteCtx<{ id: string }>;

async function auditFields(p: AppPrincipal) {
  return { ...actorOf(p, await userLabel(p.userId)), metadata: auditContext(p) };
}

/** GET /api/app/invitations — pending, unexpired invitations with their copyable links. */
export const listInvitationsRoute = appRoute("app.invitations.list", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "member:read" });
  // The link is only for callers who could have issued the invitation themselves (see `listInvitations`).
  const withLink = can(p, "member:invite");
  return json({ invitations: await listInvitations(p.orgId, undefined, { withLink }) });
});

/** POST /api/app/invitations — create one. */
export const createInvitation = appRoute("app.invitations.create", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "member:invite", account: true });
  await spendMutation(p);
  const body = await readAppJson(req, InviteBody);
  const actorRole = p.role as Role;

  if (!assignableRoles(actorRole).includes(body.role)) {
    throw new SaasError("E_FORBIDDEN", "You can only invite up to your own role.");
  }
  const clash = await inviteConflict(p.orgId, body.email);
  if (clash === "member") throw new SaasError("E_CONFLICT", "That person is already in this organization.");
  if (clash === "invited") throw new SaasError("E_CONFLICT", "That person already has a pending invitation.");

  // §4.2: the plan check runs before the write, and `E_PLAN_LIMIT` is a 402 that names the limit.
  await getEntitlements().assertCount(p.orgId, "seats");

  const auth = getAuth();
  if (!auth) throw new SaasError("E_AUTH_UNAVAILABLE", "Accounts are temporarily unavailable.");

  // Server-mediated (§3.8): the caller's headers go with the call, so the plugin's own role checks apply too.
  const created = (await auth.api.createInvitation({
    body: { email: body.email, role: body.role, organizationId: p.orgId, resend: false },
    headers: req.headers,
  })) as { id: string; email: string; role: string; expiresAt: Date | string } | null;
  if (!created?.id) throw new SaasError("E_UNPROCESSABLE", "The invitation could not be created.");

  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "member.invited",
    targetType: "invitation",
    targetId: created.id,
    // The address is the point of the row; §9's "never in metadata" list is about secrets, not about who was
    // invited — and the Members page shows the same address to the same admins.
    metadata: { ...a.metadata, email: body.email, role: body.role },
  });

  return json(
    {
      id: created.id,
      email: created.email ?? body.email,
      role: body.role,
      link: invitationLink(created.id),
      expiresAt: new Date(created.expiresAt).toISOString(),
      invitedBy: (await userLabel(p.userId)) ?? p.userId ?? "",
    } satisfies InvitationView,
    { status: 201 },
  );
});

/** DELETE /api/app/invitations/:id — revoke. Another org's id is a 404, like any other foreign resource. */
export const revokeInvitation = appRoute("app.invitations.revoke", async (req: Request, ctx: IdCtx) => {
  const p = await appPrincipal(req, { perm: "member:invite" });
  const id = await paramOf(ctx, "id");
  await spendMutation(p);
  const invite = await pendingInvitation(p.orgId, id);
  if (!invite) throw new SaasError("E_NOT_FOUND", "No such invitation.");
  await cancelInvitation(p.orgId, id);
  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "member.invite_revoked",
    targetType: "invitation",
    targetId: id,
    metadata: { ...a.metadata, email: invite.email, role: invite.role },
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
