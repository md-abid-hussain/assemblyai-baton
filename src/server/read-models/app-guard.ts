import "server-only";

/**
 * The `/app` route guard (SAAS §8.1's layout rule, §3.3). WP20·1.
 *
 * It lives in `read-models/` because that is WP20's one directory under `src/server/**` (TASKS-v3 §6); it is
 * the only module here that is not a read model, and it does no I/O of its own beyond resolving a principal.
 *
 * **Why the caller passes its own path.** SAAS §8.1 puts the guard in `src/app/app/layout.tsx`, and a layout is
 * the natural place for it — except that Next gives a layout no way to learn the pathname it is wrapping, and
 * the redirect has to carry the exact path so `/app/runs?source=simulated` comes back as
 * `/app/runs?source=simulated` and not as `/app` (TASKS-v3 §7 WP20 acceptance 1). The alternatives were a
 * header set in `src/proxy.ts` (WP12's file) or a guess. Each page knows its own route literal, so each page
 * passes it. **The layout must therefore never redirect**: Next renders the layout and the page concurrently,
 * so a layout redirect races the page's and wins with the wrong path. The layout uses `appContextOrNull`.
 * `tests/unit/app/wp20-surface.test.ts` keeps every page honest about calling this.
 */
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";

import { START_ATTEMPT_COOKIE } from "../../core/contracts/ext/wp20-app";
import type { Principal } from "../../core/contracts/v3/identity";
import { log } from "../log";
import { SaasError } from "../saas/errors";
import { legacyVisitorPrincipal, requirePrincipal, startPathFor } from "../saas/principal";


export { START_ATTEMPT_COOKIE };

export interface AppContext {
  principal: Principal;
  /**
   * True when `/start` ran and still could not produce an org, so this page is rendering over the device-scoped
   * legacy workspace (SAAS §3.3 step 2: "`/app/**` renders read-only over the device-scoped legacy
   * workspace"). The shell shows the spec's one-line notice; nothing here says "unavailable" or "paused".
   */
  degraded: boolean;
}

/** The absolute-ish URL `requirePrincipal` needs. Only the path and query are ever read from it. */
function requestFor(h: Headers, path: string): Request {
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const safe = path.startsWith("/") ? path : `/${path}`;
  return new Request(`${proto}://${host}${safe}`, { method: "GET", headers: h });
}

/**
 * "There is no principal" recognised by **code, not by `instanceof`**.
 *
 * `err instanceof SaasError` looked obviously right and was wrong in the one place it mattered: Next loads a
 * module graph more than once (the server-component graph, the route graph, dev reloads), so
 * `src/server/saas/errors` can exist as two classes and an error thrown by one fails `instanceof` against the
 * other. In orgs mode that turned every anonymous `/app` visit into a 500 instead of a redirect to `/start` —
 * the first acceptance criterion — and it cannot reproduce in a unit test, where there is one module instance.
 */
const NO_PRINCIPAL = new Set(["E_AUTH_REQUIRED", "E_ACCOUNT_REQUIRED"]);

export function isNoPrincipal(err: unknown): boolean {
  if (err instanceof SaasError) return NO_PRINCIPAL.has(err.code);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NO_PRINCIPAL.has(code);
}

/** The principal for an `/app` page, or `null` when there is none. Never throws for a missing session. */
export async function appPrincipalOrNull(path = "/app"): Promise<Principal | null> {
  const h = await headers();
  try {
    return await requirePrincipal(requestFor(h, path), { allowVisitor: false });
  } catch (err) {
    if (isNoPrincipal(err)) return null;
    throw err;
  }
}

/** The principal **including** one with no org, which `appPrincipalOrNull` rejects on the caller's behalf. */
async function orglessPrincipal(path: string): Promise<Principal | null> {
  const h = await headers();
  try {
    return await requirePrincipal(requestFor(h, path), { allowVisitor: true });
  } catch (err) {
    if (isNoPrincipal(err)) return null;
    throw err;
  }
}

/**
 * The context for an `/app` page, or `null` when the visitor should be sent to `/start`.
 *
 * Three outcomes, in order:
 *  1. a principal with an org → render;
 *  2. a **signed-in user with no org** → `ensurePersonalOrg` (SAAS §3.1) and re-resolve. Deliberately not run
 *     for a visitor or an anonymous guest: the guest start creates the org in the same request that creates
 *     the session, so doing it here would give a guest two workspaces for one click;
 *  3. no org, but `/start` has already been tried → the degraded device workspace, read-only.
 */
export async function appContextOrNull(path = "/app"): Promise<AppContext | null> {
  const direct = await appPrincipalOrNull(path);
  if (direct) return { principal: direct, degraded: false };

  const orphan = await orglessPrincipal(path);

  if (orphan?.userId && !orphan.isAnonymous && !orphan.orgId) {
    const { ensurePersonalOrg } = await import("../identity");
    const made = await ensurePersonalOrg(orphan.userId).catch((err: unknown) => {
      // Falling through to /start is the right failure: the user gets a workspace there rather than a 500.
      log.warn("ensure_personal_org_failed", { err: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (made) {
      const again = await appPrincipalOrNull(path);
      if (again) return { principal: again, degraded: false };
    }
  }

  const tried = (await cookies()).get(START_ATTEMPT_COOKIE)?.value === "1";
  if (tried) {
    const h = await headers();
    try {
      return { principal: legacyVisitorPrincipal({ headers: h }), degraded: true };
    } catch (err) {
      log.warn("degraded_device_principal_failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}

/** The context for an `/app` page, redirecting to `/start?next=<path>` when there is none. */
export async function appContext(path = "/app"): Promise<AppContext> {
  const ctx = await appContextOrNull(path);
  if (ctx) return ctx;
  redirect(startPathFor({ url: `http://internal${path.startsWith("/") ? path : `/${path}`}` }));
}

/** The common case: a page that only needs the principal. */
export async function appPrincipal(path = "/app"): Promise<Principal> {
  return (await appContext(path)).principal;
}

/**
 * What an **auth page** needs to know about the browser it is rendering for (SAAS §3.2, §3.4). WP20·2.
 *
 * `/sign-in`, `/sign-up` and `/accept-invite/[id]` are outside `/app`: they must never redirect to `/start` and
 * they must never 500 because identity is unconfigured. Three facts are enough for all three pages — is there a
 * real account behind this request (send them into the app instead of showing a form), is there an anonymous
 * guest session (show the §3.4 carry-over promise), and what is that account's email (so the invite page can
 * say "you are signed in as someone else" before the accept fails).
 */
export interface VisitorAuthState {
  signedIn: boolean;
  isGuest: boolean;
  userId: string | null;
}

export async function visitorAuthState(path = "/sign-in"): Promise<VisitorAuthState> {
  let p: Principal | null = null;
  try {
    p = await orglessPrincipal(path);
  } catch (err) {
    // An auth page that cannot resolve a principal still renders its form. That is the whole point of it.
    log.warn("visitor_auth_state_failed", { err: err instanceof Error ? err.message : String(err) });
  }
  // **Only an anonymous *session* is a guest for this purpose.** A device-only visitor (`kind: "visitor"`) has
  // `ws_<vid>` data too, but `onLinkAccount` never runs for it — that data is governed by §2.6's claim card, not
  // by the carry-over. Promising "your workspace comes with you" to a visitor would be a promise nothing keeps.
  const anonymous = Boolean(p?.isAnonymous);
  return {
    signedIn: Boolean(p?.userId) && !anonymous,
    isGuest: anonymous,
    userId: anonymous ? null : (p?.userId ?? null),
  };
}

/** `/app/runs` + its query, for the redirect and for the guest banner's return link. */
export function pathWithQuery(path: string, query: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
