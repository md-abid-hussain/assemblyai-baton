import "server-only";

/**
 * `/api/app/members/**` (SAAS §3.5, §3.7, §8.4). WP19·3.
 *
 *   GET    /api/app/members          → { members }                 — `member:read`
 *   PATCH  /api/app/members/:userId  → { userId, role }            — `member:manage`
 *   DELETE /api/app/members/:userId  → 204                         — `member:manage`
 *
 * Three rules from §3.7, each enforced in exactly one place:
 *
 * - **`can()` decides who may manage at all** — through `requirePrincipal`, against the frozen matrix.
 * - **"up to one's own role"** — `assignableRoles(actor)` is the same helper the invite route uses, so an admin
 *   cannot mint an owner from either direction.
 * - **"never an owner by an admin"** — `assertMayActOn`, in `member-store.ts`, beside the last-owner rule it
 *   belongs with.
 *
 * A user id that is not a member of the acting org is a **404**, whether it is a stranger or a member of another
 * org (§2.3): the answer must not tell an admin of org A who exists in org B.
 */
import { z } from "zod";

import { ROLES, type Role } from "../../core/contracts/v3/identity";
import { assignableRoles, can } from "../../core/contracts/v3/permissions";
import { actorOf, auditContext } from "../audit/actor";
import { SaasError } from "../saas/errors";
import { appPrincipal, appRoute, json, paramOf, readAppJson, spendMutation, type AppPrincipal, type RouteCtx } from "./app-http";
import { writeAudit } from "./audit-hook";
import { assertMayActOn, listMembers, memberRow, removeMember, setMemberRole } from "./member-store";
import { userLabel } from "./user-label";

const RoleSchema = z.enum(ROLES);
const PatchMemberBody = z.object({ role: RoleSchema });

type UserCtx = RouteCtx<{ userId: string }>;

async function auditFields(p: AppPrincipal) {
  return { ...actorOf(p, await userLabel(p.userId)), metadata: auditContext(p) };
}

/** The member this request is about, or a 404. Never a 403: a 403 would confirm the user exists. */
async function targetOr404(orgId: string, userId: string) {
  const row = await memberRow(orgId, userId);
  if (!row) throw new SaasError("E_NOT_FOUND", "No such member.");
  return row;
}

/** GET /api/app/members — the Members page list. */
export const listMembersRoute = appRoute("app.members.list", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "member:read" });
  return json({ members: await listMembers(p.orgId) });
});

/** PATCH /api/app/members/:userId — change a role. */
export const patchMember = appRoute("app.members.patch", async (req: Request, ctx: UserCtx) => {
  const p = await appPrincipal(req, { perm: "member:manage" });
  const userId = await paramOf(ctx, "userId");
  await spendMutation(p);
  const body = await readAppJson(req, PatchMemberBody);
  const target = await targetOr404(p.orgId, userId);
  const actorRole = p.role as Role;

  assertMayActOn(actorRole, target.role);
  if (!assignableRoles(actorRole).includes(body.role)) {
    throw new SaasError("E_FORBIDDEN", "You can only assign roles up to your own.");
  }
  if (target.role === body.role) return json({ userId, role: body.role });

  await setMemberRole(p.orgId, userId, body.role);
  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "member.role_changed",
    targetType: "user",
    targetId: userId,
    metadata: { ...a.metadata, from: target.role, to: body.role },
  });
  return json({ userId, role: body.role });
});

/**
 * DELETE /api/app/members/:userId — remove a member.
 *
 * Removing **yourself** is `member.left`, not `member.removed`, and it does not need `member:manage`: leaving is
 * a right, not a privilege (§3.5). `removeMember` still refuses the last owner either way.
 *
 * Because the permission depends on *who* the target is, the check cannot ride on `requirePrincipal`'s `need`.
 * It calls `can()` — the same single authority `applyNeed` itself calls, not a second copy of the matrix — and
 * raises the same `E_FORBIDDEN`.
 */
export const deleteMember = appRoute("app.members.delete", async (req: Request, ctx: UserCtx) => {
  const userId = await paramOf(ctx, "userId");
  const p = await appPrincipal(req, {});
  const isSelf = p.userId !== null && p.userId === userId;
  if (!isSelf && !can(p, "member:manage")) {
    throw new SaasError("E_FORBIDDEN", "Your role does not allow member:manage.");
  }
  await spendMutation(p);

  const target = await targetOr404(p.orgId, userId);
  if (!isSelf) assertMayActOn(p.role as Role, target.role);

  const role = await removeMember(p.orgId, userId);
  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: isSelf ? "member.left" : "member.removed",
    targetType: "user",
    targetId: userId,
    metadata: { ...a.metadata, role },
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
