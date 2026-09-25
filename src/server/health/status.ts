import "server-only";

import type { StatusResponse } from "../../core/contracts/api";
import { getDb } from "../db/client";
import { env } from "../env";
import { log } from "../log";
import { getDbAuthority, getLimitsAuthority, limitsConfigFromEnv, vaReservationUsd } from "../limits/index";
import { lastChecks } from "./synthetic";

/**
 * #2 GET /api/status body (DESIGN §4.4, §7.7): mode, reason, notice, today's budget % (no $ amounts), STT queue
 * depth, whether a live AI half is available right now, the last light/full checks, the limits, features and the
 * deploy id. The external monitor (.github/workflows/monitor.yml) fails when mode != live or the full check is
 * older than 7 h. Every part degrades on its own: a failing piece never makes /api/status itself fail.
 */
export async function buildStatus(): Promise<StatusResponse> {
  const e = env();
  const cfg = limitsConfigFromEnv(e);
  const authority = getLimitsAuthority();
  const dbA = getDbAuthority();
  const warn = (part: string, err: unknown) => log.child({ component: "status" }).warn("status part failed", { part, err });

  const flags = await authority.flags().catch((err: unknown) => {
    warn("flags", err);
    return { mode: "maintenance" as const, reason: "status_unavailable", notice: null, paymentsModeOverride: null, aaiBalanceUsd: null };
  });
  const budgetPctToday = await authority.ledger
    .summary()
    .then((s) => s.pctToday)
    .catch((err: unknown) => (warn("ledger", err), 0));
  let sttQueueDepth = 0;
  let aiHalfAvailable = flags.mode === "live";
  if (dbA) {
    sttQueueDepth = await dbA.sttPeek(2).then((p) => p.queueDepth).catch((err: unknown) => (warn("queue", err), 0));
    if (aiHalfAvailable) {
      const free = await dbA.vaFree().catch(() => 0);
      const budget = await dbA.ledger.check(dbA.db, { provider: "aai_va", estUsd: vaReservationUsd(cfg), env: cfg.deployId }).catch(() => ({ ok: false }));
      aiHalfAvailable = free > 0 && budget.ok;
    }
  }
  const checks = await lastChecks(getDb()).catch((err: unknown) => (warn("checks", err), { light: null, full: null }));
  return {
    mode: flags.mode,
    reason: flags.reason,
    notice: flags.notice,
    budgetPctToday,
    sttQueueDepth,
    aiHalfAvailable,
    lastChecks: checks,
    limits: { sttOpensPerMin: cfg.sttOpensPerMin, vaMaxConcurrent: cfg.vaMaxConcurrent },
    features: { beCustomer: e.FEATURE_BE_CUSTOMER, payments: flags.paymentsModeOverride ?? e.PAYMENTS_MODE },
    deployId: e.BATON_DEPLOY_ID,
  };
}
