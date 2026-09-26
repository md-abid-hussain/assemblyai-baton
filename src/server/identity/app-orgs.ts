import "server-only";

/**
 * `/api/app/orgs/**` (SAAS §3.5). WP19·3.
 *
 *   GET    /api/app/orgs               → { orgs, activeOrgId }         — the switcher
 *   POST   /api/app/orgs               → OrgSummary                    — account required, ≤ 3 owned
 *   PATCH  /api/app/orgs/:id           → OrgSummary                    — `org:update` (admin+)
 *   DELETE /api/app/orgs/:id           → 204                           — `org:delete` (owner), typed confirmation
 *   POST   /api/app/orgs/:id/leave     → 204                           — any member except the last owner
 *   POST   /api/app/orgs/:id/transfer  → 204                           — owner → an existing admin
 *
 * **`:id` must be the active org.** The principal decides which tenant a request acts in (§10.1 rule 3); the path
 * segment is checked against it and anything else is a 404 (§2.3: never a 403 — a 403 would confirm the org
 * exists). The switcher sets the active org through Better Auth's own `set-active`, which validates membership,
 * so "act on the org you are in" costs the UI one extra call and costs an attacker the whole surface.
 */
import { z } from "zod";

import type { OrgSummary } from "../../core/contracts/v3/identity";
import { actorOf, auditContext } from "../audit/actor";
import { touchOrg } from "./active-org";
import { appPrincipal, appRoute, json, paramOf, readAppJson, sameOrgOr404, spendMutation, type AppPrincipal, type RouteCtx } from "./app-http";
import { writeAudit } from "./audit-hook";
import { SaasError } from "../saas/errors";
import { connectorSecrets, drafts, relayPublications, relays } from "../db/schema";
import { webhookEndpoints } from "../db/schema-saas";
import { getDb } from "../db/client";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { removeMember, transferOwnership } from "./member-store";
import {
  countOwnedOrgs,
  createOrg,
  deleteOrgRow,
  getOrg,
  isSlugTaken,
  listOrgSummaries,
  MAX_OWNED_ORGS,
  renameOrg,
  slugify,
} from "./org-store";
import { userLabel } from "./user-label";

const NameSchema = z.string().trim().min(1, "required").max(80);
const SlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "lowercase letters, digits and dashes");

const CreateOrgBody = z.object({ name: NameSchema, slug: SlugSchema.optional() });
const PatchOrgBody = z.object({ name: NameSchema.optional(), slug: SlugSchema.optional() });
const DeleteOrgBody = z.object({ confirm: z.string().trim().min(1) });
const TransferBody = z.object({ userId: z.string().trim().min(1) });

type IdCtx = RouteCtx<{ id: string }>;

/** The audit fields every route here shares: who, from which device, in which request. */
async function auditFields(p: AppPrincipal) {
  return { ...actorOf(p, await userLabel(p.userId)), metadata: auditContext(p) };
}

// ------------------------------------------------------------------------------------------------------ read

/** GET /api/app/orgs — every org the caller belongs to, most recently active first. */
export const listOrgs = appRoute("app.orgs.list", async (req: Request) => {
  const p = await appPrincipal(req, { allowVisitor: true });
  // A visitor with a legacy `ws_<vid>` workspace has no membership rows at all; saying so honestly beats a 401
  // on the switcher, which the app shell renders on every page.
  const orgs = p.userId ? await listOrgSummaries(p.userId) : [];
  return json({ orgs, activeOrgId: p.orgId });
});

// ---------------------------------------------------------------------------------------------------- create

/**
 * POST /api/app/orgs — a new team org.
 *
 * `account: true` is what refuses a guest (§2.2: "Guests own exactly 1 and cannot create more"); the plugin's own
 * `allowUserToCreateOrganization` says the same thing one layer down, but its endpoint is blocked for clients
 * (§3.8) and never runs, so this check is the one that fires.
 */
export const createOrgRoute = appRoute("app.orgs.create", async (req: Request) => {
  const p = await appPrincipal(req, { account: true });
  await spendMutation(p);
  const body = await readAppJson(req, CreateOrgBody);

  const owned = await countOwnedOrgs(p.userId!);
  if (owned >= MAX_OWNED_ORGS) {
    throw new SaasError(
      "E_PLAN_LIMIT",
      `You already own ${MAX_OWNED_ORGS} organizations. Leave or delete one to create another.`,
      { extra: { limit: { key: "orgsPerUser", used: owned, limit: MAX_OWNED_ORGS } } },
    );
  }

  let org;
  try {
    org = await createOrg({
      name: body.name,
      slug: body.slug ?? slugify(body.name),
      kind: "team",
      createdVia: "switcher",
      ownerUserId: p.userId!,
      plan: "free",
    });
  } catch (err) {
    if (isSlugTaken(err)) throw new SaasError("E_CONFLICT", "That address is taken. Try another.");
    throw err;
  }

  const a = await auditFields(p);
  await writeAudit({
    orgId: org.id,
    ...a,
    action: "org.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { ...a.metadata, via: "switcher", kind: "team" },
  });
  await touchOrg(org.id);
  return json(
    { id: org.id, name: org.name, slug: org.slug, kind: org.kind, role: "owner", plan: org.plan } satisfies OrgSummary,
    { status: 201 },
  );
});

// ---------------------------------------------------------------------------------------------------- update

/** PATCH /api/app/orgs/:id — rename and/or re-slug (admin+). */
export const patchOrg = appRoute("app.orgs.patch", async (req: Request, ctx: IdCtx) => {
  const p = await appPrincipal(req, { perm: "org:update" });
  sameOrgOr404(p, await paramOf(ctx, "id"));
  await spendMutation(p);
  const body = await readAppJson(req, PatchOrgBody);
  const before = await getOrg(p.orgId);
  if (!before) throw new SaasError("E_NOT_FOUND", "No such organization.");

  try {
    await renameOrg(p.orgId, body);
  } catch (err) {
    if (isSlugTaken(err)) throw new SaasError("E_CONFLICT", "That address is taken. Try another.");
    throw err;
  }

  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "org.renamed",
    targetType: "organization",
    targetId: p.orgId,
    // Names are not secrets and the diff is the point of the row; nothing else about the org is included.
    metadata: { ...a.metadata, from: { name: before.name, slug: before.slug }, to: body },
  });
  const after = await getOrg(p.orgId);
  return json({
    id: p.orgId,
    name: after?.name ?? before.name,
    slug: after?.slug ?? before.slug,
    kind: before.kind,
    // `org:update` passed, so the role is one of the four; the principal type just does not know it here.
    role: p.role as OrgSummary["role"],
    plan: before.plan,
  } satisfies OrgSummary);
});

// ---------------------------------------------------------------------------------------------------- delete

/**
 * DELETE /api/app/orgs/:id — owner only, with the typed confirmation in the body.
 *
 * §3.5's order, and why each step is where it is: publications are handed to WP18's `deleting` queue **before**
 * the org row goes, because its purge pass resolves a plan from the org; the audit row is written **before** the
 * delete, so `org.deleted` names an org that still exists; and the audit rows themselves stay (no FK, §2.7) for
 * the 30-day window `purgeAuditRetention` enforces.
 */
export const deleteOrg = appRoute("app.orgs.delete", async (req: Request, ctx: IdCtx) => {
  const p = await appPrincipal(req, { perm: "org:delete" });
  sameOrgOr404(p, await paramOf(ctx, "id"));
  await spendMutation(p);
  const body = await readAppJson(req, DeleteOrgBody);
  const org = await getOrg(p.orgId);
  if (!org) throw new SaasError("E_NOT_FOUND", "No such organization.");
  if (body.confirm !== org.slug && body.confirm !== org.name) {
    throw new SaasError("E_VALIDATION", "Type the organization's name to confirm.");
  }

  const db = getDb();
  const orgId = p.orgId;
  const now = new Date();

  const publications = await db
    .update(relayPublications)
    .set({ status: "deleting" })
    .where(and(eq(relayPublications.orgId, orgId), inArray(relayPublications.status, ["live", "creating"])))
    .returning({ id: relayPublications.id });
  const softDeleted = await db
    .update(relays)
    .set({ deletedAt: now })
    .where(and(eq(relays.workspaceId, orgId), isNull(relays.deletedAt)))
    .returning({ id: relays.id });
  await db.delete(drafts).where(eq(drafts.workspaceId, orgId));
  await db.delete(connectorSecrets).where(eq(connectorSecrets.workspaceId, orgId));
  // WP24 owns the endpoint code; the rows are in `0002` and an org that no longer exists must not keep
  // delivering. Disabling rather than deleting keeps the delivery log readable for its own retention window.
  await db
    .update(webhookEndpoints)
    .set({ enabled: false, disabledReason: "org_deleted" })
    .where(and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.enabled, true)));

  const a = await auditFields(p);
  await writeAudit({
    orgId,
    ...a,
    action: "org.deleted",
    targetType: "organization",
    targetId: orgId,
    metadata: { ...a.metadata, relays: softDeleted.length, publications: publications.length },
  });
  await deleteOrgRow(orgId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

// ----------------------------------------------------------------------------------------------------- leave

/** POST /api/app/orgs/:id/leave — any member except the last owner (§3.5). */
export const leaveOrg = appRoute("app.orgs.leave", async (req: Request, ctx: IdCtx) => {
  const p = await appPrincipal(req, { account: true });
  sameOrgOr404(p, await paramOf(ctx, "id"));
  await spendMutation(p);
  const role = await removeMember(p.orgId, p.userId!);
  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "member.left",
    targetType: "user",
    targetId: p.userId!,
    metadata: { ...a.metadata, role },
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

// -------------------------------------------------------------------------------------------------- transfer

/** POST /api/app/orgs/:id/transfer — owner → an existing admin (§3.5). The old owner becomes an admin. */
export const transferOrg = appRoute("app.orgs.transfer", async (req: Request, ctx: IdCtx) => {
  const p = await appPrincipal(req, { perm: "org:delete", account: true });
  sameOrgOr404(p, await paramOf(ctx, "id"));
  await spendMutation(p);
  const body = await readAppJson(req, TransferBody);
  await transferOwnership(p.orgId, p.userId!, body.userId);
  const a = await auditFields(p);
  await writeAudit({
    orgId: p.orgId,
    ...a,
    action: "org.ownership_transferred",
    targetType: "user",
    targetId: body.userId,
    metadata: { ...a.metadata, from: p.userId },
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
