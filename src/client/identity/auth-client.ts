"use client";

/**
 * The browser auth client (SAAS §3.1, §3.8). WP19.
 *
 * **Components never import Better Auth server code.** This module and `src/server/identity/**` are the only two
 * places the `better-auth` package appears; the boundaries test enforces it, and the split is what keeps the server
 * secret, the database handle and the plugin internals out of the client bundle.
 *
 * **Reads live here; mutations do not.** §3.8 blocks `organization/{create,update,delete,invite-member,…}`,
 * `api-key/*`, `/checkout` and `/delete-user` at the catch-all, so calling them from this client returns 403
 * `E_USE_APP_API`. The equivalents are WP19·3's and WP21/22/24's `/api/app/**` routes, which run
 * `requirePrincipal` + `can()` + the entitlement check and write the audit row. What stays on the client is
 * exactly the §3.8 read list: `getSession`, `organization.list`, `getFullOrganization`, `setActive`,
 * `acceptInvitation`, `listInvitations`, sign-in/up/out, `listSessions`, `revokeSession` and `changePassword`.
 *
 * `baseURL` is deliberately **not** set: the client talks to its own origin, which is what makes the same build
 * work on localhost and on the Zerops URL without a `NEXT_PUBLIC_*` variable (DESIGN §3.4 forbids one).
 */
import "client-only";

import { createAuthClient } from "better-auth/react";
import { anonymousClient, organizationClient } from "better-auth/client/plugins";

/** Matches `advanced.cookiePrefix` on the server (§3.9): the session cookie is `co.session_token`. */
export const COOKIE_PREFIX = "co";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    anonymousClient(),
    organizationClient(),
    // WP22 adds `apiKeyClient()` and WP21 `polarClient()` here when their plugins land server-side; both are
    // additive and neither changes anything below.
  ],
});

export const { signIn, signUp, signOut, useSession, getSession, organization } = authClient;

/** The §3.8 paths that are server-mediated. Exported so a UI helper can fail fast instead of round-tripping. */
export const SERVER_MEDIATED_HINT =
  "This action goes through /api/app/** so the plan check and the audit row happen server-side.";

export type Session = typeof authClient.$Infer.Session;
