import { endHandler } from "@/server/takeovers/routes";
import { takeoverRouteDeps } from "@/server/takeovers/default-deps";

/**
 * #13 POST /api/takeovers/[id]/end (takeover token; on pagehide via a keepalive fetch, G0) {outcome, vaSessionId,
 * reason?} → {ok:true, verificationJobId}. Enqueues verify_takeover (WP8). DESIGN §4.4 #13.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = endHandler(takeoverRouteDeps);
