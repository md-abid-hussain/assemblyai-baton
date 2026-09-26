import { getPublicationRunState } from "@/server/publish/routes";

/**
 * GET /api/publications/:pubId/runs/:takeoverId/state?after=<cursor> - THE ONE STATE ROUTE of a published run
 * (PLATFORM §8.3), polled every second. WP18.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getPublicationRunState;
