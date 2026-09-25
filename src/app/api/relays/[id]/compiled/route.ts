import { getCompiled } from "@/server/relays/routes";

/** GET /api/relays/:id/compiled?version=<rv_…>|draft → CompiledRelayView (WP14b; PLATFORM §7.3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getCompiled;
