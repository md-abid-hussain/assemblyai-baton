import "server-only";

/**
 * The org switcher's data and the viewer summary (SAAS §3.5, §8.2). WP20·1.
 *
 * **Why this is a seam and not a query.** The `organization` / `members` tables arrive with WP19's `0002_saas`
 * (SAAS §2.7), which is not on `main` until C3b. Writing a speculative query against columns that do not exist
 * yet would either break the build now or bake in a guess at someone else's schema. So the shell asks *this*
 * module, and this module answers from the principal alone until WP19·3 registers the real directory through
 * `setOrgDirectory()`.
 *
 * Under the legacy principal a visitor owns exactly one workspace (`ws_<visitorId>`, SAAS §2.6), so the
 * switcher correctly shows one entry and no "switch" affordance. That is not a placeholder pretending to be a
 * product: it is the truth of the legacy tenancy mode, and the same component renders the real list unchanged.
 *
 * From C3b, a principal with a `userId` is served by `dbOrgDirectory` over WP19's tables. `setOrgDirectory()`
 * remains, so a test can substitute a directory without a database.
 */
import { ROLES, type OrgSummary, type Principal, type Role } from "../../core/contracts/v3/identity";
import { PLANS } from "../../core/contracts/v3/plans";
import type { ViewerSummary } from "../../core/contracts/ext/wp20-app";
import { log } from "../log";

/**
 * What WP19·3 registers at start-up. It returns every org the principal's user belongs to, newest-active first;
 * the active org is `principal.orgId`.
 */
export interface OrgDirectory {
  listForPrincipal(p: Principal): Promise<OrgSummary[]>;
}

type Holder = { directory?: OrgDirectory };
const g = globalThis as typeof globalThis & { __wp20Orgs?: Holder };
const holder: Holder = (g.__wp20Orgs ??= {});

export function setOrgDirectory(d: OrgDirectory | null): void {
  if (d) holder.directory = d;
  else delete holder.directory;
}

export const hasOrgDirectory = (): boolean => holder.directory !== undefined;

/** The single legacy workspace a device owns. Named for what it is, so no screen invents a friendlier lie. */
export function legacyOrgSummary(p: Principal): OrgSummary | null {
  if (!p.orgId) return null;
  return {
    id: p.orgId,
    name: p.isAnonymous || p.kind === "visitor" ? "Guest workspace" : "Your workspace",
    slug: p.orgId,
    kind: p.orgKind ?? "guest",
    role: p.role ?? "owner",
    plan: p.plan,
  };
}

/**
 * The default directory, over WP19's tables (available from C3b).
 *
 * `listMembershipsByRecency` already orders by `org_meta.last_active_at`, which is the order the switcher wants
 * — the workspace you were last in sits at the top. It returns ids and roles only, so each org's name, slug,
 * kind and plan come from `getOrg`; an org that has vanished between the two reads is skipped rather than
 * rendered as a blank row.
 *
 * A `kind` or `plan` that `getOrg` defaults (no `org_meta` / `org_entitlements` row) is used as given. Guessing
 * a *better* plan here would put a wrong badge next to a workspace name, which is worse than `Free`.
 */
export const dbOrgDirectory: OrgDirectory = {
  async listForPrincipal(p) {
    if (!p.userId) return [];
    const { listMembershipsByRecency, getOrg } = await import("../identity");
    const memberships = await listMembershipsByRecency(p.userId);
    const rows = await Promise.all(memberships.map((m) => getOrg(m.orgId).catch(() => null)));
    const out: OrgSummary[] = [];
    for (const [i, org] of rows.entries()) {
      const m = memberships[i];
      if (!org || !m) continue;
      out.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        kind: org.kind,
        role: (ROLES as readonly string[]).includes(m.role) ? (m.role as Role) : "member",
        plan: org.plan,
      });
    }
    return out;
  },
};

/**
 * The switcher's rows. Never throws: a failing directory degrades to the active org alone, because an app shell
 * that 500s over a dropdown is worse than a shell with one entry in it.
 *
 * A **visitor** (no account, `TENANCY_MODE=legacy`) has no membership rows at all, so it keeps the derived
 * single-workspace summary. Anything with a `userId` goes to the directory.
 */
export async function orgSummariesFor(p: Principal): Promise<OrgSummary[]> {
  const fallback = legacyOrgSummary(p);
  const dir = holder.directory ?? (p.userId ? dbOrgDirectory : null);
  if (!dir) return fallback ? [fallback] : [];
  const rows = await dir.listForPrincipal(p).catch((err: unknown) => {
    log.warn("org_directory_failed", { err: err instanceof Error ? err.message : String(err) });
    return [] as OrgSummary[];
  });
  if (rows.length > 0) return rows;
  return fallback ? [fallback] : [];
}

/** The org the shell is currently showing, out of the rows it already loaded. */
export const activeOrgOf = (orgs: readonly OrgSummary[], p: Principal): OrgSummary | null =>
  orgs.find((o) => o.id === p.orgId) ?? orgs[0] ?? null;

/**
 * The user menu and the guest banner read this. `isGuest` is true for a device visitor **and** for an anonymous
 * account: both still have to create a real account to keep the workspace, and SAAS §8.2 shows them one banner.
 */
export function viewerOf(p: Principal, profile?: { name?: string | null; email?: string | null }): ViewerSummary {
  const isGuest = p.kind === "visitor" || p.isAnonymous || p.userId === null;
  const name = profile?.name?.trim();
  return {
    userId: p.userId,
    name: name && name.length > 0 ? name : isGuest ? "Guest" : "You",
    email: profile?.email?.trim() || null,
    isGuest,
    role: p.role,
    plan: p.plan,
  };
}

/** `PLANS[plan].name`, for the badge next to the org name. */
export const planLabel = (plan: ViewerSummary["plan"]): string => PLANS[plan].name;
