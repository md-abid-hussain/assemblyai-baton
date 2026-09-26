import "server-only";

/**
 * Server-mediated mutations (SAAS §3.8).
 *
 * The Better Auth catch-all would otherwise let a browser call `organization/create` or `api-key/create` directly,
 * which would skip our entitlement check, our `can()` check and the audit row. So the catch-all refuses these paths
 * with 403 `E_USE_APP_API`, and `/api/app/**` performs the same operations server-side through `auth.api.*` with
 * the caller's headers — Better Auth's own role checks still run, ours run first, and the audit row is written.
 *
 * **Reads stay on the client plugin** (`get-session`, `organization/list`, `set-active`, `accept-invitation`,
 * sign-in/up/out, …), which is why this is an explicit list and not "block every POST".
 *
 * Pure data + a matcher: no `better-auth` import, so the route wrapper and the tests share it cheaply.
 */

/** Exactly the §3.8 list, as Better Auth path suffixes (no `/api/auth` prefix, leading slash). */
export const BLOCKED_CLIENT_AUTH_PATHS: readonly string[] = Object.freeze([
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/add-member",
  "/organization/leave",
  "/api-key/create",
  "/api-key/update",
  "/api-key/delete",
  "/checkout",
  "/delete-user",
  "/usage/ingestion",
]);

const BLOCKED = new Set(BLOCKED_CLIENT_AUTH_PATHS);

/** Where our catch-all is mounted. Everything after this prefix is the Better Auth path. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The Better Auth path of a request to the catch-all, normalised: no query, no trailing slash, lowercased.
 * Returns `null` when the URL is not under `AUTH_BASE_PATH` at all.
 */
export function authPathOf(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, "http://local.invalid").pathname;
  } catch {
    return null;
  }
  // Collapse `%2f`-style escapes and duplicate slashes so `/organization//create` cannot slip through.
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* a malformed escape: judge the raw path */
  }
  const collapsed = decoded.replace(/\/{2,}/g, "/");
  if (!collapsed.toLowerCase().startsWith(AUTH_BASE_PATH)) return null;
  const rest = collapsed.slice(AUTH_BASE_PATH.length) || "/";
  const trimmed = rest.length > 1 && rest.endsWith("/") ? rest.slice(0, -1) : rest;
  return trimmed.toLowerCase();
}

/**
 * Is this request one of the blocked client paths? Only non-GET requests can mutate, and Better Auth serves these
 * endpoints as POST, so a GET (for example the OpenAPI reference page) is never blocked.
 */
export function isBlockedClientAuthPath(req: { method?: string; url: string }): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const path = authPathOf(req.url);
  return path !== null && BLOCKED.has(path);
}
