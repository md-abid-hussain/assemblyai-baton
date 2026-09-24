import { CronKindSchema } from "@/core/contracts/api";
import { BatonError } from "@/core/contracts/errors";
import { handler, json, requireCron } from "@/server/auth";
import { runCron } from "@/server/health/cron";

/**
 * #26 POST /api/internal/cron?kind=light|full|purge|tick (`x-cron-secret`, or `Authorization: Bearer <CRON_SECRET>`)
 * → `{ok, details}`. Called by the Zerops crontab (`node bundle/cron.mjs <kind>`) and the Vercel mirror's cron.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = handler("cron", async (req) => {
  requireCron(req);
  const kind = CronKindSchema.safeParse(new URL(req.url).searchParams.get("kind"));
  if (!kind.success) throw new BatonError("E_BAD_REQUEST", "kind must be light, full, purge or tick.");
  const r = await runCron(kind.data);
  return json(r, { status: 200 });
});

/** Vercel Cron sends GET. */
export const GET = POST;
