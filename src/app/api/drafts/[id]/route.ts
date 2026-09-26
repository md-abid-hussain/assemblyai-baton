import { handleGetDraft } from "@/server/draft/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/drafts/[id]` (PLATFORM §7.4; WP17): the poll. Scoped to the caller's org. */
export const GET = handleGetDraft;
