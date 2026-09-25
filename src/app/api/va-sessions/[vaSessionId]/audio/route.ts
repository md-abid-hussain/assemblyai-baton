import { handleVaAudio } from "@/server/qa/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Route #21 `GET /api/va-sessions/[vaSessionId]/audio?t=<seconds>` (DESIGN §4.4): takeover token of the takeover that
 * owns the session, 30/min → 302 to a fresh pre-signed OGG URL (1 h TTL) with `#t=` for the seek; 403 for others.
 */
export async function GET(req: Request, ctx: { params: Promise<{ vaSessionId: string }> }): Promise<Response> {
  const { vaSessionId } = await ctx.params;
  return handleVaAudio(req, vaSessionId);
}
