import { handler, ipKeyOf, json } from "@/server/auth";
import { buildStatus } from "@/server/health/status";
import { getRateLimiter, RATE } from "@/server/limits";

/** #2 GET /api/status (no auth; 60/min/IP). → `StatusResponse` (DESIGN §4.4, §7.7). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler("status", async (req) => {
  if (process.env.VISITOR_SECRET) {
    const r = await getRateLimiter()
      .hit(RATE.status.bucket, ipKeyOf(req), RATE.status.limit, RATE.status.windowSec)
      .catch(() => ({ ok: true, retryAfterSec: 0 }));
    if (!r.ok) {
      return json(
        { error: { code: "E_RATE_LIMITED", message: "Too many status requests.", retryAfterMs: r.retryAfterSec * 1000 } },
        { status: 429, headers: { "retry-after": String(r.retryAfterSec) } },
      );
    }
  }
  return json(await buildStatus());
});
