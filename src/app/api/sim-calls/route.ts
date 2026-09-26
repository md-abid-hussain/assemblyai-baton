import { handleCreateSimCall } from "@/server/sim/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/sim-calls` (PLATFORM §7.5, §7.5.2; WP17): a TEXT DRY RUN (`kind:"text_dry_run"`, the default test for a
 * drafted relay) or a voiced simulated call. Answers at once and the client polls `GET /api/sim-calls/[id]`.
 */
export const POST = handleCreateSimCall;
