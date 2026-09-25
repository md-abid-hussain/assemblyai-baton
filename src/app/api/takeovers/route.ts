import { armHandler } from "@/server/takeovers/routes";
import { takeoverRouteDeps } from "@/server/takeovers/default-deps";

/**
 * #9 POST /api/takeovers (case token) → ArmResponse {takeoverId, takeoverToken, leadMs}. Case status → armed.
 * 409 for runs with aiHalf:"recorded". DESIGN §4.4 #9, §5.5.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = armHandler(takeoverRouteDeps);
