import { deleteRelay, getRelay, updateRelay } from "@/server/relays/routes";

/** GET/PUT/DELETE /api/relays/:id (WP14b; TASKS-v2 §5). `:id` = `rl_…` or the relay slug. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getRelay;
export const PUT = updateRelay;
export const DELETE = deleteRelay;
