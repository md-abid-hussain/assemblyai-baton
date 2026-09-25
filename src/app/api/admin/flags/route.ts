import { AdminFlagsRequestSchema } from "@/core/contracts/api";
import type { AppFlags } from "@/core/contracts/services";
import { handler, json, readJson, requireAdmin } from "@/server/auth";
import { getFlagStore, limitsConfigFromEnv } from "@/server/limits";

/**
 * #27 POST /api/admin/flags (`x-admin-key`). `{mode?, notice?, aaiBalanceUsd?, paymentsModeOverride?, reason?}` → the
 * flags after the change. Posting `mode:"live"` is the operator clear (any reason). A balance below AAI_RESERVE_USD
 * flips `replay_only (aai_balance)` whatever else was posted (DESIGN §7.2 real-balance guard). GET returns the flags.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler("admin-flags", async (req) => {
  requireAdmin(req);
  const body = await readJson(req, AdminFlagsRequestSchema);
  const store = getFlagStore();
  const patch: Partial<AppFlags> = {};
  if (body.mode !== undefined) patch.mode = body.mode;
  if (body.notice !== undefined) patch.notice = body.notice;
  if (body.paymentsModeOverride !== undefined) patch.paymentsModeOverride = body.paymentsModeOverride;
  if (body.aaiBalanceUsd !== undefined) patch.aaiBalanceUsd = body.aaiBalanceUsd;
  const reserve = limitsConfigFromEnv().ledger.reserveUsd;
  const lowBalance = body.aaiBalanceUsd !== undefined && body.aaiBalanceUsd !== null && body.aaiBalanceUsd < reserve;
  if (lowBalance) patch.mode = "replay_only";
  if (Object.keys(patch).length) {
    await store.set(patch, lowBalance ? "aai_balance" : (body.reason ?? (body.mode && body.mode !== "live" ? "operator" : "operator_update")));
  }
  return json(await store.get());
});

export const GET = handler("admin-flags-get", async (req) => {
  requireAdmin(req);
  return json(await getFlagStore().get());
});
