import "server-only";

import { EsignRequestSchema } from "../../core/contracts/api";
import { BatonError } from "../../core/contracts/errors";
import { log } from "../log";
import { mapPolarEvent, PolarSignatureError, redactPolarPayload, verifyPolarWebhook } from "../polar/webhook";
import { wp6 } from "../tools/wiring";
import { errorResponse, json, rateLimited, readJson, route, type Params } from "./http";

/**
 * Route handlers #15–#18 (+ the additive …/timeout), exported as plain functions so the unit tests call them with
 * `Request` objects; `src/app/api/**` re-exports them. Auth: a takeover-scoped case token whose `tko` equals the
 * payment's takeover (DESIGN §4.3). Clients poll #15 every 1.5–2 s and ignore 429s silently.
 */

const whLog = log.child({ component: "polar-webhook" });

async function authorizedPayment(req: Request, id: string | undefined) {
  if (!id) throw new BatonError("E_NOT_FOUND", "No such payment.");
  const w = wp6();
  const p = await w.payments.store.get(id);
  if (!p) throw new BatonError("E_NOT_FOUND", "No such payment.");
  const auth = await w.requireTakeover(req, { takeoverId: p.takeoverId, scope: "case" });
  if (auth.caseId !== p.caseId) throw new BatonError("E_FORBIDDEN", "The token is for another case.");
  return { w, p };
}

/** #15 GET /api/payments/[id][?reconcile=1][&extras=1] → PaymentView (+ WP6 extras). Rate: 4 per 2 s per payment. */
export const getPayment = route<{ id: string }>("payments.get", async (req, ctx: Params<{ id: string }>) => {
  const { id } = await ctx.params;
  const { w, p } = await authorizedPayment(req, id);
  const rl = await w.rateLimiter.hit("payment_get", p.id, 4, 2);
  if (!rl.ok) rateLimited(rl.retryAfterSec);
  const q = new URL(req.url).searchParams;
  const reconcile = q.get("reconcile") === "1";
  // `?extras=1` (the phone, once): the SMS text and the e-sign summary.
  const extras = q.get("extras") === "1";
  return json(await w.payments.view(p.id, { reconcile, extras, origin: req.headers.get("origin") ?? w.appUrl }));
});

/** #16 POST /api/payments/[id]/esign {consent:true, typedName} → {ok, signedAt}. Rate: 5 per payment. */
export const postEsign = route<{ id: string }>("payments.esign", async (req, ctx: Params<{ id: string }>) => {
  const { id } = await ctx.params;
  const { w, p } = await authorizedPayment(req, id);
  const rl = await w.rateLimiter.hit("payment_esign", p.id, 5, 3600);
  if (!rl.ok) rateLimited(rl.retryAfterSec);
  const body = await readJson(req, EsignRequestSchema);
  const r = await w.payments.esign(p.id, body.typedName);
  return json({ ok: true, signedAt: r.signedAt });
});

/** #17 POST /api/payments/[id]/simulate → {ok:true}. Any provider, any PAYMENTS_MODE. Rate: 3 per payment. */
export const postSimulate = route<{ id: string }>("payments.simulate", async (req, ctx: Params<{ id: string }>) => {
  const { id } = await ctx.params;
  const { w, p } = await authorizedPayment(req, id);
  const rl = await w.rateLimiter.hit("payment_simulate", p.id, 3, 3600);
  if (!rl.ok) rateLimited(rl.retryAfterSec);
  await w.payments.simulate(p.id);
  return json({ ok: true });
});

/** POST /api/payments/[id]/timeout (WP6, additive): the hold deadline passed → `timeout` if still non-terminal. */
export const postTimeout = route<{ id: string }>("payments.timeout", async (req, ctx: Params<{ id: string }>) => {
  const { id } = await ctx.params;
  const { w, p } = await authorizedPayment(req, id);
  const rl = await w.rateLimiter.hit("payment_timeout", p.id, 3, 3600);
  if (!rl.ok) rateLimited(rl.retryAfterSec);
  const r = await w.payments.markTimeout(p.id);
  return json({ ok: true, status: r.status });
});

/**
 * #18 POST /api/webhooks/polar: raw body → verify (both schemes; 403 on failure) → idempotency on `webhook-id`
 * (a replay is a no-op 202) → map → apply → 202. Unknown events: 202, ignored. No Polar calls here, so it answers
 * well under 2 s.
 */
export const postPolarWebhook = route("webhooks.polar", async (req) => {
  const w = wp6();
  const raw = await req.text();
  if (!w.webhookSecret) {
    whLog.error("POLAR_WEBHOOK_SECRET is not configured (value never printed)");
    return errorResponse("E_INTERNAL", "Webhook secret not configured.", { status: 503 });
  }
  let payload: unknown;
  try {
    payload = verifyPolarWebhook(raw, req.headers, w.webhookSecret);
  } catch (e) {
    if (e instanceof PolarSignatureError) {
      whLog.warn("signature rejected", { webhookId: req.headers.get("webhook-id") });
      return errorResponse("E_POLAR_SIG", "Invalid signature.", { status: 403 });
    }
    throw e;
  }
  const webhookId = req.headers.get("webhook-id") ?? "";
  const type = typeof (payload as { type?: unknown })?.type === "string" ? (payload as { type: string }).type : "unknown";
  const key = `polar:${webhookId}`;
  const fresh = await w.payments.store.recordWebhook(key, type, redactPolarPayload(payload));
  if (!fresh) return json({ ok: true, duplicate: true }, { status: 202 });
  const mapped = mapPolarEvent(payload);
  if (!mapped) {
    await w.payments.store.finishWebhook(key, null);
    return json({ ok: true, ignored: true }, { status: 202 });
  }
  try {
    const outcome = await w.payments.applyWebhook(mapped);
    await w.payments.store.finishWebhook(key, null);
    whLog.info("webhook processed", { webhookId, type, status: mapped.status, outcome });
    return json({ ok: true, outcome }, { status: 202 });
  } catch (e) {
    await w.payments.store.finishWebhook(key, e instanceof Error ? e.message.slice(0, 200) : "error").catch(() => undefined);
    throw e; // 500 → Polar retries; the errored row is claimable again (DbPaymentStore.recordWebhook)
  }
});
