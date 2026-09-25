import { LimitsRoutes, type LimitsRouteName } from "@/core/contracts/api";
import { BatonError } from "@/core/contracts/errors";
import { handler, json, paramsOf, readJson, requireLimitsKey } from "@/server/auth";
import { getDbAuthority } from "@/server/limits";

/**
 * #28 POST /api/internal/limits/{stt-acquire,stt-cancel,va-hold,va-acquire,va-release,heartbeat,report,reserve,settle,
 * release,summary,flags}: the LimitsAuthority over HTTP for remote openers (DESIGN §2.3). `x-limits-key` only, and
 * only when this process is the authority (LIMITS_ROLE=authority; 404 elsewhere). Same zod schemas as the in-process
 * calls (`LimitsRoutes`).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler<{ op: string }>("limits", async (req, ctx) => {
  requireLimitsKey(req);
  const { op } = await paramsOf(ctx);
  if (!op || !Object.hasOwn(LimitsRoutes, op)) throw new BatonError("E_NOT_FOUND", "Unknown limits operation.");
  const a = getDbAuthority();
  if (!a) throw new BatonError("E_NOT_FOUND", "Not the limits authority.");
  const name = op as LimitsRouteName;
  switch (name) {
    case "stt-acquire":
      return json(await a.sttAcquire(await readJson(req, LimitsRoutes["stt-acquire"].request)));
    case "stt-cancel":
      await a.sttCancel((await readJson(req, LimitsRoutes["stt-cancel"].request)).ticket);
      return json({ ok: true });
    case "va-hold":
      return json(await a.vaHold(await readJson(req, LimitsRoutes["va-hold"].request)));
    case "va-acquire":
      return json(await a.vaAcquire(await readJson(req, LimitsRoutes["va-acquire"].request)));
    case "va-release": {
      const b = await readJson(req, LimitsRoutes["va-release"].request);
      await a.release(b.id, b.reason);
      return json({ ok: true });
    }
    case "heartbeat":
      await a.heartbeat((await readJson(req, LimitsRoutes.heartbeat.request)).liveSessionId);
      return json({ ok: true });
    case "report":
      await a.report(await readJson(req, LimitsRoutes.report.request));
      return json({ ok: true });
    case "reserve":
      return json(await a.ledger.reserve(await readJson(req, LimitsRoutes.reserve.request)));
    case "settle": {
      const b = await readJson(req, LimitsRoutes.settle.request);
      await a.ledger.settle(b.id, b.actualUsd);
      return json({ ok: true });
    }
    case "release":
      await a.ledger.release((await readJson(req, LimitsRoutes.release.request)).id);
      return json({ ok: true });
    case "summary":
      return json(await a.ledger.summary());
    case "flags":
      return json(await a.flags());
  }
});
