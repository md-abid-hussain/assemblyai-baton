import { deletePublication, getPublication } from "@/server/publish/routes";

/**
 * GET /api/publications/:slug → the `/a/[shareSlug]` page data (public);
 * DELETE /api/publications/:pubId → unpublish (`relay:publish`). Ids start `pub_`, so one dynamic segment serves both
 * (PLATFORM §8; contracts/v2 `V2_ROUTES.publication` / `publicationBySlug`). WP18.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getPublication;
export const DELETE = deletePublication;
