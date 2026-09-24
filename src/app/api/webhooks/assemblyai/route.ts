import { after } from "next/server";

import { handleAaiWebhook } from "@/server/qa/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Route #19 `POST /api/webhooks/assemblyai?job=<jobId>` (DESIGN §4.4, §4.5 F3 S3). Auth: the `X-Baton-Webhook`
 * header secret set at submit time. Body `{transcript_id, status}` → 200 at once; the job advances after the response.
 */
export function POST(req: Request): Promise<Response> {
  return handleAaiWebhook(req, (fn) => after(fn));
}
