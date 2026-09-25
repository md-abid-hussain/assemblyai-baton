import { createRelay, listRelays } from "@/server/relays/routes";

/** GET /api/relays → {gallery, mine}; POST /api/relays → RelayDetail (WP14b; TASKS-v2 §5). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = listRelays;
export const POST = createRelay;
