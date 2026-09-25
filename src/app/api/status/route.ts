import { handler, ipKeyOf, json } from "@/server/auth";
import { describeForwarding, IPKEY_PROBE_HEADER } from "@/server/auth/client-ip";
import { buildStatus } from "@/server/health/status";
import { getRateLimiter, RATE } from "@/server/limits";
import { log } from "@/server/log";

/** #2 GET /api/status (no auth; 60/min/IP). → `StatusResponse` (DESIGN §4.4, §7.7). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler("status", async (req) => {
  // P-0 (PLATFORM §10.2): what the balancer delivered, as address CLASSES only (no IP is logged).
  if (req.headers.get(IPKEY_PROBE_HEADER) === "1") log.info("ipkey_probe", { ...describeForwarding(req.headers) });
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
