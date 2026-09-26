import { handler } from "@/server/auth/http";
import { handleEcho } from "@/server/connectors/echo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET|POST /api/connectors/echo` (PLATFORM §6.2 "Demo target"; WP16): the built-in HMAC-verifying echo that the
 * gallery relays and the connector test console call. It verifies with the fixed, published demo secret
 * `CHANGEOVER_DEMO_ECHO_SECRET`: unsigned → 200 `signature:"absent"`, valid → 200 `"valid"`, tampered or stale → 401
 * `E_ECHO_SIGNATURE`. No auth, no DB, no external call.
 */
export const GET = handler("connectors.echo", (req) => handleEcho(req));
export const POST = handler("connectors.echo", (req) => handleEcho(req));
