import { compileHandler } from "@/server/takeovers/routes";
import { takeoverRouteDeps } from "@/server/takeovers/default-deps";

/**
 * #11 POST /api/takeovers/[id]/compile (takeover token) {drain} → CompiledTakeover, checked by validateFirstUpdate
 * before it is returned. Freezes the snapshot (WP3) and compiles it (WP1). DESIGN §4.4 #11, §5.5.4 rule 2.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = compileHandler(takeoverRouteDeps);
