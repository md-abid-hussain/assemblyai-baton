import "server-only";

import type { AppFlags } from "../../core/contracts/services";
import { log } from "../log";
import type { DbLimitsAuthority } from "../limits/db-authority";
import { utcDay } from "../limits/config";

/**
 * F8 budget guard (DESIGN §4.5, §7.2): the in-process ticker every 60 s, cron `light`, and after every admin
 * balance update. Reservations enforce the caps themselves (a refusal flips replay_only in the ledger); this job:
 *  - recomputes today's dynamic daily cap (returned for logs and /api/admin/ledger);
 *  - auto-clears `replay_only (budget_daily)` once the UTC day has changed since it was set;
 *  - flips `replay_only (aai_balance)` when the operator-entered balance is below AAI_RESERVE_USD (only the
 *    operator clears it).
 * Balance/credit mint errors and 3×1008 fresh-token closes flip `aai_balance` where they happen
 * (src/server/aai/tokens.ts, DbLimitsAuthority.report).
 */

export interface BudgetGuardResult {
  flags: AppFlags;
  dailyCapUsd: number;
  pctToday: number;
  cleared: string | null;
  tripped: string | null;
}

const guardLog = log.child({ component: "budget-guard" });

export async function runBudgetGuard(a: DbLimitsAuthority): Promise<BudgetGuardResult> {
  const nowMs = a.now();
  let cleared: string | null = null;
  let tripped: string | null = null;
  const meta = await a.flagStore.getWithMeta();
  const f = meta.flags;

  if (f.mode === "replay_only" && f.reason === "budget_daily" && meta.modeUpdatedAt !== null && utcDay(meta.modeUpdatedAt) < utcDay(nowMs)) {
    if (await a.flagStore.clearIf("budget_daily")) cleared = "budget_daily";
  }
  if (f.aaiBalanceUsd !== null && f.aaiBalanceUsd < a.cfg.ledger.reserveUsd) {
    if (await a.flagStore.tripReplayOnly("aai_balance")) tripped = "aai_balance";
  }
  const s = await a.ledger.summary();
  const flags = await a.flagStore.get();
  if (cleared || tripped) guardLog.warn("mode changed", { cleared, tripped, mode: flags.mode, reason: flags.reason });
  return { flags, dailyCapUsd: s.dailyCapUsd, pctToday: s.pctToday, cleared, tripped };
}
