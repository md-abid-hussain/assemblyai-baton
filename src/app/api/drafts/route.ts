import { handleCreateDraft } from "@/server/draft/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/drafts` (PLATFORM §7.4; WP17): the "Describe your desk" wizard. Answers 202 with a `DraftView` at once
 * and runs the drafting pipeline as a job; the client polls `GET /api/drafts/:id` every 1.5 s.
 */
export const POST = handleCreateDraft;
