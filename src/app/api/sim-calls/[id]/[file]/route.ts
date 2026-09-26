import { handleSimCallAsset } from "@/server/sim/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/sim-calls/[id]/[file]` (PLATFORM §7.5 step 4; WP17): a simulated call's `rep.ulaw`, `customer.ulaw`,
 * `peaks.json` or `clip.<sha256>.pcm`, served immutable (the id is content-addressed).
 */
export const GET = handleSimCallAsset;
