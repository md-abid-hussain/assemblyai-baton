import { saveDraft } from "@/server/relays/routes";

/** PUT /api/relays/:id/draft → {rev, lint} | 409 {conflict, rev} (WP14b; TASKS-v2 §5). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = saveDraft;
