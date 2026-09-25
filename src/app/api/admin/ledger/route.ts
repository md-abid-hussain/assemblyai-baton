import { handler, json, requireAdmin } from "@/server/auth";
import { getLimitsAuthority } from "@/server/limits";

/**
 * #27 GET /api/admin/ledger (`x-admin-key`) → `LedgerSummary`: spend by provider (today) and by env, the since-epoch
 * total, today's dynamic daily cap, the judging budget and today's %.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler("admin-ledger", async (req) => {
  requireAdmin(req);
  return json(await getLimitsAuthority().ledger.summary());
});
