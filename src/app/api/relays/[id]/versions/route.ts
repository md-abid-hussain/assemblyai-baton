import { createVersion } from "@/server/relays/routes";

/** POST /api/relays/:id/versions: content-addressed snapshot of the draft (WP14b; TASKS-v2 §5). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createVersion;
