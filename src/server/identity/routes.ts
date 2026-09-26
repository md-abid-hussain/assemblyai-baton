import "server-only";

/**
 * The two WP19·2 route handlers, kept out of `src/app/**` so they are testable with a plain `Request` and so the
 * `route.ts` files stay one-line re-exports (the shape WP14b and WP18 already use).
 *
 * - `authCatchAll` = `toNextJsHandler(auth)` behind the §3.8 blocked-path filter;
 * - `guestStart` = `POST /api/guest/start` (§3.3).
 */
import { toNextJsHandler } from "better-auth/next-js";

import { SaasError, saasErrorResponse } from "../saas/errors";
import { log } from "../log";
import { getAuth } from "./auth";
import { isBlockedClientAuthPath } from "./blocked-paths";
import { startGuest } from "./guest-start";
import { installIdentity } from "./index";

const routeLog = log.child({ component: "identity" });

const json = (status: number, body: unknown, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

/**
 * K-AUTH (§2.8): with no `BETTER_AUTH_SECRET` the app still boots and the v2 paths still work, so the auth
 * endpoints answer 503 with the documented envelope rather than crashing the route.
 */
const unavailable = (): Response =>
  saasErrorResponse(
    new SaasError("E_AUTH_UNAVAILABLE", "Accounts are temporarily unavailable. The demo works without one."),
  );

/** The §3.8 refusal. A 403 with `E_USE_APP_API` says *what to call instead*, which is the whole point. */
const blocked = (): Response =>
  saasErrorResponse(
    new SaasError(
      "E_USE_APP_API",
      "This operation is server-mediated. Call the matching /api/app/** route instead.",
    ),
  );

/**
 * `src/app/api/auth/[...all]/route.ts`. The filter runs **before** Better Auth sees the request, so a blocked path
 * cannot mutate anything even if the plugin's own checks would have allowed it.
 */
export function authCatchAll(): { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> } {
  const guard =
    (method: "GET" | "POST") =>
    async (req: Request): Promise<Response> => {
      installIdentity();
      const auth = getAuth();
      if (!auth) return unavailable();
      if (isBlockedClientAuthPath({ method, url: req.url })) return blocked();
      const handlers = toNextJsHandler(auth);
      return handlers[method](req);
    };
  return { GET: guard("GET"), POST: guard("POST") };
}

/** `src/app/api/guest/start/route.ts`. */
export async function guestStart(req: Request): Promise<Response> {
  installIdentity();
  try {
    const r = await startGuest(req);
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    if ("setCookie" in r) for (const c of r.setCookie) headers.append("set-cookie", c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers });
  } catch (err) {
    if (err instanceof SaasError) return saasErrorResponse(err);
    routeLog.error("guest start failed", { err });
    // Never an outage-shaped answer on the judged URL: the caller keeps the user where they are.
    return json(200, { orgId: null, degraded: true, reason: "start_failed" });
  }
}
