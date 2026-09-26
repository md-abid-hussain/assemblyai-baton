import { authCatchAll } from "@/server/identity/routes";

/**
 * `/api/auth/[...all]` = `toNextJsHandler(auth)` behind the §3.8 blocked-path filter (SAAS §3.1, WP19).
 * The filter and the handler live in `src/server/identity/routes.ts`, so they are testable with a plain `Request`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = authCatchAll();
