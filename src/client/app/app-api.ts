import "client-only";

/**
 * The one place WP20's pages call WP19·3's server-mediated routes (SAAS §3.5–§3.8). WP20·2.
 *
 * **Why every mutation funnels through this file.** §3.8 blocks the Better Auth client paths for
 * `organization/{create,update,delete,invite-member,…}`, so renaming an org, inviting a member or changing a
 * role is an `/api/app/**` call that runs `requirePrincipal` + `can()` + the entitlement check and writes the
 * audit row. Those routes are WP19's files and land in the same slot as these pages, so the shapes are pinned in
 * `docs/notes/requests/wp20-to-wp19.md` and implemented here once: if a shape changes, this module is the whole
 * of WP20's side of the fix.
 *
 * **CSRF** (§3.9) needs no work here. `fetch` from our own page sends `Origin: <APP_URL>` and
 * `Sec-Fetch-Site: same-origin`, which is exactly what `assertSameOrigin` inside `requirePrincipal` checks.
 * `credentials: "same-origin"` is the default for same-origin requests and is stated anyway, because a later
 * reader should not have to know that.
 *
 * **No route here takes an org id.** §10.1 rule 3: the org comes from the principal, never from a body. The org
 * id in a path segment (`/api/app/orgs/<id>`) is the *target* of the operation and the route re-checks
 * membership; it is not how the server learns which tenant is calling.
 */
import type { InvitationView, MemberView, OrgSummary, Role } from "@/core/contracts/v3/identity";

/** The §6.3 error envelope, as much of it as a page needs. */
export interface AppApiFailure {
  ok: false;
  /** A `V3ErrorCode` when the route answered, `E_UNAVAILABLE` when it could not be reached. */
  code: string;
  /** Safe to render: §6.3 messages are written for a person. */
  message: string;
  status: number;
  /**
   * The route answered 404 with no error envelope, which in this build means WP19·3 has not merged yet. Pages
   * show a quiet inline line rather than an error. Once WP19·3 is on `main` this is simply never true — it is a
   * build-order accommodation, not a permanent fallback.
   */
  notImplemented: boolean;
}

export type AppApiResult<T> = ({ ok: true } & T) | AppApiFailure;

export const isFailure = <T>(r: AppApiResult<T>): r is AppApiFailure => r.ok === false;

const GENERIC = "Something went wrong. Please try again.";

/** One request, one envelope. Never throws: every caller is a click handler and a throw there is a blank screen. */
async function call<T>(
  path: string,
  init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
): Promise<AppApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method,
      credentials: "same-origin",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return {
      ok: false,
      code: "E_UNAVAILABLE",
      message: "Could not reach the server. Check your connection and try again.",
      status: 0,
      notImplemented: false,
    };
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (res.ok) return { ...(body as object), ok: true } as AppApiResult<T>;

  const envelope = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : "E_UNKNOWN";
  const message = typeof envelope?.message === "string" && envelope.message ? envelope.message : GENERIC;

  return {
    ok: false,
    code,
    message: res.status === 404 && !envelope ? "This action is not available in this build yet." : message,
    status: res.status,
    notImplemented: res.status === 404 && !envelope,
  };
}

// ------------------------------------------------------------------------------------------- organizations

/**
 * G3: WP19·3's routes answer with the contracts-v3 view **flat**, not wrapped in `{ org }` / `{ member }` /
 * `{ invitation }` as `docs/notes/requests/wp20-to-wp19.md` §4 proposed. They do it consistently across every
 * route, the tenancy suite pins them that way, and `call()` spreads the body — so the wrappers are this
 * file's to drop. `res.org.id` was a runtime TypeError on the first click, invisible to `tsc` because the
 * generic only asserts a shape.
 */
export const createOrg = (name: string) => call<OrgSummary>("/api/app/orgs", { method: "POST", body: { name } });

export const updateOrg = (orgId: string, patch: { name?: string; slug?: string }) =>
  call<OrgSummary>(`/api/app/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: patch });

/**
 * `confirm` is the typed org name (SAAS §3.5). The server re-checks it; the dialog is not the safeguard.
 *
 * Both of these answer **204 with no body**, so `nextOrgId` is always absent — which is the `null` leg the
 * proposal's note 1 already said this side handles: the caller sends the user to `/app` and the guard sorts
 * the active org out.
 */
export const deleteOrg = (orgId: string, confirm: string) =>
  call<{ nextOrgId?: string | null }>(`/api/app/orgs/${encodeURIComponent(orgId)}`, {
    method: "DELETE",
    body: { confirm },
  });

export const leaveOrg = (orgId: string) =>
  call<{ nextOrgId?: string | null }>(`/api/app/orgs/${encodeURIComponent(orgId)}/leave`, { method: "POST", body: {} });

export const transferOrg = (orgId: string, userId: string) =>
  call<Record<string, never>>(`/api/app/orgs/${encodeURIComponent(orgId)}/transfer`, {
    method: "POST",
    body: { userId },
  });

// ------------------------------------------------------------------------------------- members + invitations

export const inviteMember = (email: string, role: Role) =>
  call<InvitationView>("/api/app/invitations", { method: "POST", body: { email, role } });

export const revokeInvitation = (id: string) =>
  call<Record<string, never>>(`/api/app/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const changeMemberRole = (userId: string, role: Role) =>
  call<Pick<MemberView, "userId" | "role">>(`/api/app/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: { role },
  });

export const removeMember = (userId: string) =>
  call<Record<string, never>>(`/api/app/members/${encodeURIComponent(userId)}`, { method: "DELETE" });

// ------------------------------------------------------------------------------------- the device claim (§2.6)

/**
 * **The body carries no visitor id.** The route re-derives it from the signed `bvid` cookie, because a body
 * field would let one device ask to claim another's data (SAAS §2.6 R1). `decline` is the "Not mine" path.
 */
export const claimDevice = () =>
  call<{ claimed: Record<string, number> }>("/api/app/claim-device", { method: "POST", body: {} });

export const declineClaim = () =>
  call<Record<string, never>>("/api/app/claim-device", { method: "POST", body: { decline: true } });
