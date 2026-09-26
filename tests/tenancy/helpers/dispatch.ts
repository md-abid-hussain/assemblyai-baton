/**
 * Manifest row → route handler (SAAS §10.1). WP19·3.
 *
 * The handlers are called directly with a `Request` and a `RouteCtx`, exactly as Next calls them, so the suite
 * exercises the real `appRoute` wrapper — `requirePrincipal`, the same-origin check, the §6.3 envelope — without
 * a server, a port or a fetch. `src/app/api/app/**` is a one-line re-export of each of these, and
 * `coverage.test.ts` proves the manifest names every one of those files.
 */
import { ctx, req, type Modules, type Who, type World } from "./world";
import type { RouteRow } from "../manifest";

type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** The handler for one row, plus the name of the dynamic segment it takes (if any). */
function handlerFor(m: Modules, row: RouteRow): { fn: Handler; param: "id" | "userId" | null } {
  const k = `${row.method} ${row.file}`;
  switch (k) {
    case "GET api/app/orgs/route.ts":
      return { fn: m.appOrgs.listOrgs as Handler, param: null };
    case "POST api/app/orgs/route.ts":
      return { fn: m.appOrgs.createOrgRoute as Handler, param: null };
    case "PATCH api/app/orgs/[id]/route.ts":
      return { fn: m.appOrgs.patchOrg as Handler, param: "id" };
    case "DELETE api/app/orgs/[id]/route.ts":
      return { fn: m.appOrgs.deleteOrg as Handler, param: "id" };
    case "POST api/app/orgs/[id]/leave/route.ts":
      return { fn: m.appOrgs.leaveOrg as Handler, param: "id" };
    case "POST api/app/orgs/[id]/transfer/route.ts":
      return { fn: m.appOrgs.transferOrg as Handler, param: "id" };
    case "GET api/app/members/route.ts":
      return { fn: m.appMembers.listMembersRoute as Handler, param: null };
    case "PATCH api/app/members/[userId]/route.ts":
      return { fn: m.appMembers.patchMember as Handler, param: "userId" };
    case "DELETE api/app/members/[userId]/route.ts":
      return { fn: m.appMembers.deleteMember as Handler, param: "userId" };
    case "GET api/app/invitations/route.ts":
      return { fn: m.appInvitations.listInvitationsRoute as Handler, param: null };
    case "POST api/app/invitations/route.ts":
      return { fn: m.appInvitations.createInvitation as Handler, param: null };
    case "DELETE api/app/invitations/[id]/route.ts":
      return { fn: m.appInvitations.revokeInvitation as Handler, param: "id" };
    case "GET api/app/audit/route.ts":
      return { fn: m.appAudit.listAudit as Handler, param: null };
    case "GET api/app/claim-device/route.ts":
      return { fn: m.appClaim.getClaimOffer as Handler, param: null };
    case "POST api/app/claim-device/route.ts":
      return { fn: m.appClaim.postClaimDevice as Handler, param: null };
    case "DELETE api/app/claim-device/route.ts":
      return { fn: m.appClaim.declineClaimDevice as Handler, param: null };
    // WP21 billing (G3).
    case "GET api/app/billing/route.ts":
      return { fn: m.billingRoutes.getBillingState as Handler, param: null };
    case "POST api/app/billing/checkout/route.ts":
      return { fn: m.billingRoutes.postCheckout as Handler, param: null };
    case "POST api/app/billing/simulated/route.ts":
      return { fn: m.billingRoutes.postSimulatedConfirm as Handler, param: null };
    // WP16 connector hosts (G3).
    case "GET api/app/connector-hosts/route.ts":
      return { fn: m.connectorRoutes.listConnectorHosts as Handler, param: null };
    case "POST api/app/connector-hosts/route.ts":
      return { fn: m.connectorRoutes.addConnectorHost as Handler, param: null };
    case "DELETE api/app/connector-hosts/route.ts":
      return { fn: m.connectorRoutes.removeConnectorHost as Handler, param: null };
    default:
      throw new Error(`no handler wired for ${k} — add it to tests/tenancy/helpers/dispatch.ts`);
  }
}

export interface CallOptions {
  /** Override the body the manifest row carries. */
  body?: unknown;
  /** Which org's fixture ids the row's body should name. Defaults to A. */
  org?: "A" | "B";
  /** `null` sends neither `Origin` nor `Sec-Fetch-Site` (the CSRF case); a string sends that `Origin`. */
  origin?: string | null;
  headers?: Record<string, string>;
}

/** Call one manifest row as `who`, addressing `id`. */
export async function call(
  w: World,
  row: RouteRow,
  who: Pick<Who, "cookie"> | null,
  id: string,
  opts: CallOptions = {},
): Promise<Response> {
  const m = w.m;
  const { fn, param } = handlerFor(m, row);
  const body = "body" in opts ? opts.body : row.body?.(w, opts.org ?? "A");
  const request = req(m, who, row.method, row.path(id), body, {
    ...(opts.origin === undefined ? {} : { origin: opts.origin }),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
  return fn(request, ctx(param ? { [param]: id } : {}));
}

export { handlerFor };
