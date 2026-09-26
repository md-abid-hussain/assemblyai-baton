import { postPubTool } from "@/server/publish/routes";

/**
 * POST /api/connectors/pub/:pubId/:tool - the published gateway AssemblyAI's stored agents call (PLATFORM §6.6).
 * Authenticated by `X-Changeover-Key` alone: their servers carry no cookie and no session. WP18.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = postPubTool;
