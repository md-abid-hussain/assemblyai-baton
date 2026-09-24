import { eventsHandler } from "@/server/takeovers/routes";
import { takeoverRouteDeps } from "@/server/takeovers/wiring";

/**
 * #12 POST /api/takeovers/[id]/events (takeover token) → {ok:true}. Phase, timings, VA session id, HUD, provisional
 * QA, `heartbeat` (every 10 s while a VA session is open) and `failure` (sets last_failure_at). DESIGN §4.4 #12.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = eventsHandler(takeoverRouteDeps);
