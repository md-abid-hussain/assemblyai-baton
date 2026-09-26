import { handleGetSimCall } from "@/server/sim/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/sim-calls/[id]` (PLATFORM §7.5; WP17): the poll, to `ready` or `failed`. */
export const GET = handleGetSimCall;
