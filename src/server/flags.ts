import "server-only";

import { inArray, sql } from "drizzle-orm";

import type { AppFlags, FlagStore } from "../core/contracts/services";
import type { Db } from "./db/client";
import { appFlags } from "./db/schema";
import { log } from "./log";

/**
 * App flags (DESIGN §2.3, §7.2, §4.4 #27): `mode` (live | replay_only | maintenance) with its `reason`, `notice`,
 * `payments_mode_override`, `aai_balance_usd`. One `app_flags` row per key (seeded by migrate). The mode row's
 * `reason` column is `AppFlags.reason`.
 *
 * Reasons and who clears them:
 *   budget_daily       ledger refusal over today's dynamic cap → auto-cleared at 00:00 UTC by the budget guard (F8)
 *   budget_total       ledger refusal over the judging budget   → operator
 *   aai_balance        balance/credit mint error, 3×1008, or the operator's balance below AAI_RESERVE_USD → operator
 *   synthetic_failed   two consecutive full synthetic failures → the next full success (F7)
 *   va_audit_anomaly   F6 (WP8) → operator
 *   operator / other   POST /api/admin/flags → operator
 * A stronger (operator-cleared) reason is never overwritten by a weaker (auto-cleared) one.
 */

export type ModeReason = "budget_daily" | "budget_total" | "aai_balance" | "synthetic_failed" | "va_audit_anomaly" | "operator" | (string & {});

export const DEFAULT_FLAGS: AppFlags = { mode: "live", reason: null, notice: null, paymentsModeOverride: null, aaiBalanceUsd: null };

/** Higher = harder to clear. Auto-cleared reasons rank lowest. */
const REASON_RANK: Record<string, number> = {
  budget_daily: 1,
  synthetic_failed: 2,
  va_audit_anomaly: 3,
  budget_total: 4,
  aai_balance: 5,
  operator: 6,
};
export const reasonRank = (r: string | null | undefined): number => (r ? (REASON_RANK[r] ?? 3) : 0);

const KEY = { mode: "mode", notice: "notice", paymentsModeOverride: "payments_mode_override", aaiBalanceUsd: "aai_balance_usd" } as const;

export interface FlagsWithMeta {
  flags: AppFlags;
  /** When the mode row last changed (ms), or null. */
  modeUpdatedAt: number | null;
}

export class DbFlagStore implements FlagStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async getWithMeta(): Promise<FlagsWithMeta> {
    const rows = await this.db.select().from(appFlags).where(inArray(appFlags.key, Object.values(KEY)));
    const by = new Map(rows.map((r) => [r.key, r]));
    const modeRow = by.get(KEY.mode);
    const modeVal = modeRow?.value;
    const mode: AppFlags["mode"] = modeVal === "replay_only" || modeVal === "maintenance" ? modeVal : "live";
    const notice = by.get(KEY.notice)?.value;
    const pay = by.get(KEY.paymentsModeOverride)?.value;
    const bal = by.get(KEY.aaiBalanceUsd)?.value;
    return {
      flags: {
        mode,
        reason: mode === "live" ? null : (modeRow?.reason ?? null),
        notice: typeof notice === "string" ? notice : null,
        paymentsModeOverride: pay === "polar" || pay === "mock" ? pay : null,
        aaiBalanceUsd: typeof bal === "number" && Number.isFinite(bal) ? bal : null,
      },
      modeUpdatedAt: modeRow?.updatedAt ? modeRow.updatedAt.getTime() : null,
    };
  }

  async get(): Promise<AppFlags> {
    return (await this.getWithMeta()).flags;
  }

  /** Upsert the given keys. `reason` is stored on every written row (for the mode row it is `AppFlags.reason`). */
  async set(patch: Partial<AppFlags>, reason: string): Promise<void> {
    const at = new Date(this.now());
    const writes: { key: string; value: unknown }[] = [];
    if (patch.mode !== undefined) writes.push({ key: KEY.mode, value: patch.mode });
    if (patch.notice !== undefined) writes.push({ key: KEY.notice, value: patch.notice });
    if (patch.paymentsModeOverride !== undefined) writes.push({ key: KEY.paymentsModeOverride, value: patch.paymentsModeOverride });
    if (patch.aaiBalanceUsd !== undefined) writes.push({ key: KEY.aaiBalanceUsd, value: patch.aaiBalanceUsd });
    for (const w of writes) {
      await this.db
        .insert(appFlags)
        .values({ key: w.key, value: w.value as never, reason, updatedAt: at })
        .onConflictDoUpdate({ target: appFlags.key, set: { value: sql`excluded.value`, reason, updatedAt: at } });
    }
    if (patch.mode !== undefined) log.child({ component: "flags" }).warn("mode set", { mode: patch.mode, reason });
  }

  /**
   * Flip to `replay_only` for `reason`, unless the current state is already at least as strong (maintenance, or a
   * replay_only reason of equal/higher rank). Returns true when it changed the mode.
   */
  async tripReplayOnly(reason: ModeReason): Promise<boolean> {
    const cur = await this.get();
    if (cur.mode === "maintenance") return false;
    if (cur.mode === "replay_only" && reasonRank(cur.reason) >= reasonRank(reason)) return false;
    await this.set({ mode: "replay_only" }, reason);
    return true;
  }

  /** Restore `live` only if the current replay_only reason is exactly `reason` (auto-cleared reasons). */
  async clearIf(reason: ModeReason): Promise<boolean> {
    const cur = await this.get();
    if (cur.mode !== "replay_only" || cur.reason !== reason) return false;
    await this.set({ mode: "live" }, `auto_clear:${reason}`);
    return true;
  }
}

/**
 * Why a live open is refused under these flags (null when live). Maps the mode reason onto the contract's denial
 * codes: aai_balance → E_AAI_BALANCE; budget_* → E_BUDGET; anything else → E_MODE_REPLAY_ONLY. Plain words.
 */
export function modeDenial(flags: AppFlags): { code: "E_AAI_BALANCE" | "E_BUDGET" | "E_MODE_REPLAY_ONLY"; message: string } | null {
  if (flags.mode === "live") return null;
  if (flags.reason === "aai_balance") {
    return { code: "E_AAI_BALANCE", message: "The live AssemblyAI credit is paused for today, so this run uses the labelled replay." };
  }
  if (flags.reason === "budget_daily" || flags.reason === "budget_total") {
    return {
      code: "E_BUDGET",
      message:
        flags.reason === "budget_daily"
          ? "Today's live budget is used up, so this run uses the labelled replay. Live runs come back after 00:00 UTC."
          : "The live budget for the judging window is used up, so this run uses the labelled replay.",
    };
  }
  if (flags.mode === "maintenance") return { code: "E_MODE_REPLAY_ONLY", message: "Baton is in maintenance: live runs are paused." };
  return { code: "E_MODE_REPLAY_ONLY", message: "Live runs are paused right now, so this run uses the labelled replay." };
}
