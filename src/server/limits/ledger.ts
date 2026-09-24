import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { SpendLedger } from "../../core/contracts/services";
import type { Db } from "../db/client";
import { liveSessions, spendLedger } from "../db/schema";
import { newId } from "../../lib/ids";
import type { DbFlagStore } from "../flags";
import { log } from "../log";
import { utcDay, utcDayStartMs, type Clock, type LedgerConfig, type LimitsConfig } from "./config";

/**
 * SpendLedger (DESIGN §2.3, §7.2): reserve before mint, settle on report.
 *
 * Epoch semantics: only rows with `created_at ≥ LEDGER_EPOCH` count against AAI_JUDGING_BUDGET_USD and the dynamic
 * daily cap. Before the epoch (development) only a dev guard applies: $3 per UTC day per env family (all `dev-*`
 * envs together; any other env on its own), and a dev refusal never flips the production mode.
 *
 * In the judging window a refusal flips `mode=replay_only`: `budget_daily` (auto-cleared at 00:00 UTC by F8) or
 * `budget_total` (operator). OpenAI has its own daily cap (OPENAI_DAILY_CAP_USD) and never flips the mode. Polar
 * costs $0 and is always accepted.
 *
 * Row amount = settled → actual (fallback est), reserved → est, released → 0.
 */

export const LEDGER_LOCK_KEY = 7_711_001;
const AAI = ["aai_stt", "aai_va", "aai_async"] as const;
type Provider = Parameters<SpendLedger["reserve"]>[0]["provider"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

const AMOUNT = sql`(case ${spendLedger.status} when 'settled' then coalesce(${spendLedger.actualUsd}, ${spendLedger.estUsd}) when 'reserved' then ${spendLedger.estUsd} else 0 end)`;
const IS_AAI = sql`${spendLedger.provider} in ('aai_stt','aai_va','aai_async')`;

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** `dev-*` envs share one family; every other env is its own. */
export const envFamily = (env: string): string => (env.startsWith("dev-") ? "dev-*" : env);

/**
 * DESIGN §7.2: `clamp(remaining / max(1, daysLeft) × (first 3 judging days ? 2 : 1), 0.75, AAI_DAILY_CAP_MAX_USD)`,
 * `remaining = budget − spentSinceEpoch` measured at the START of the current UTC day (so the cap does not shrink
 * while today's runs spend). `daysLeft` = whole UTC days from today to JUDGING_END_DATE (≥ 1).
 */
export function dynamicDailyCap(cfg: LedgerConfig, nowMs: number, spentSinceEpochBeforeTodayUsd: number): number {
  const DAY = 86_400_000;
  const todayStart = utcDayStartMs(nowMs);
  const end = Date.parse(`${cfg.judgingEndDate}T00:00:00.000Z`);
  const daysLeft = Math.max(1, Math.round((end - todayStart) / DAY));
  const epochDay = cfg.epochMs !== null ? utcDayStartMs(cfg.epochMs) : todayStart;
  const dayIndex = Math.floor((todayStart - epochDay) / DAY);
  const boost = dayIndex >= 0 && dayIndex < 3 ? 2 : 1;
  const remaining = Math.max(0, cfg.judgingBudgetUsd - spentSinceEpochBeforeTodayUsd);
  const raw = (remaining / daysLeft) * boost;
  return round5(Math.min(cfg.dailyCapMaxUsd, Math.max(cfg.dailyCapMinUsd, raw)));
}

export type ReserveRefusal = { ok: false; code: "E_BUDGET"; reason: "budget_daily" | "budget_total" | "dev_daily" | "openai_daily" };
export type ReserveResult = { ok: true; id: string } | ReserveRefusal;

export interface LedgerSummary {
  sinceEpochUsd: number;
  todayUsd: Record<string, number>;
  dailyCapUsd: number;
  judgingBudgetUsd: number;
  pctToday: number;
  byEnv: Record<string, number>;
}

export class DbSpendLedger implements SpendLedger {
  constructor(
    private readonly db: Db,
    private readonly cfg: LimitsConfig,
    private readonly now: Clock,
    private readonly flags: DbFlagStore | null,
  ) {}

  private judging(nowMs: number): boolean {
    return this.cfg.ledger.epochMs !== null && nowMs >= this.cfg.ledger.epochMs;
  }

  private async sum(x: Exec, where: ReturnType<typeof sql>): Promise<number> {
    const r = await x.execute(sql`select coalesce(sum(${AMOUNT}), 0)::float8 as usd from ${spendLedger} where ${where}`);
    return round5(num((r.rows[0] as { usd?: unknown } | undefined)?.usd));
  }

  /** The judging-window numbers at `nowMs`: spend since the epoch, today's since-epoch spend and today's cap. */
  async judgingNumbers(x: Exec, nowMs: number): Promise<{ sinceEpochUsd: number; todaySinceEpochUsd: number; dailyCapUsd: number }> {
    const epoch = new Date(this.cfg.ledger.epochMs ?? 0);
    const todayStart = new Date(utcDayStartMs(nowMs));
    const sinceEpochUsd = await this.sum(x, sql`${IS_AAI} and ${spendLedger.createdAt} >= ${epoch}`);
    const beforeToday = await this.sum(x, sql`${IS_AAI} and ${spendLedger.createdAt} >= ${epoch} and ${spendLedger.createdAt} < ${todayStart}`);
    const todaySinceEpochUsd = round5(sinceEpochUsd - beforeToday);
    return { sinceEpochUsd, todaySinceEpochUsd, dailyCapUsd: dynamicDailyCap(this.cfg.ledger, nowMs, beforeToday) };
  }

  /** Would a reservation be accepted right now? (No insert; used by POST /api/runs and /api/status.) */
  async check(x: Exec, e: { provider: Provider; estUsd: number; env: string }, nowMs = this.now()): Promise<{ ok: true } | ReserveRefusal> {
    if (e.provider === "polar") return { ok: true };
    const day = utcDay(nowMs);
    const judging = this.judging(nowMs);
    const est = Math.max(0, e.estUsd);
    if (e.provider === "openai") {
      const epochCond = judging ? sql` and ${spendLedger.createdAt} >= ${new Date(this.cfg.ledger.epochMs ?? 0)}` : sql``;
      const today = await this.sum(x, sql`${spendLedger.provider} = 'openai' and ${spendLedger.day} = ${day}${epochCond}`);
      return today + est > this.cfg.ledger.openaiDailyCapUsd + 1e-9 ? { ok: false, code: "E_BUDGET", reason: "openai_daily" } : { ok: true };
    }
    if (judging) {
      const n = await this.judgingNumbers(x, nowMs);
      if (n.sinceEpochUsd + est > this.cfg.ledger.judgingBudgetUsd + 1e-9) return { ok: false, code: "E_BUDGET", reason: "budget_total" };
      if (n.todaySinceEpochUsd + est > n.dailyCapUsd + 1e-9) return { ok: false, code: "E_BUDGET", reason: "budget_daily" };
      return { ok: true };
    }
    const fam = envFamily(e.env);
    const famCond = fam === "dev-*" ? sql`${spendLedger.env} like 'dev-%'` : sql`${spendLedger.env} = ${e.env}`;
    const today = await this.sum(x, sql`${IS_AAI} and ${spendLedger.day} = ${day} and ${famCond}`);
    return today + est > this.cfg.ledger.devDailyCapUsd + 1e-9 ? { ok: false, code: "E_BUDGET", reason: "dev_daily" } : { ok: true };
  }

  /** Reserve inside an existing transaction (the caller holds or takes the ledger lock). No mode flip here. */
  async reserveTx(tx: Tx, e: Parameters<SpendLedger["reserve"]>[0], nowMs = this.now()): Promise<ReserveResult> {
    await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
    const verdict = await this.check(tx, e, nowMs);
    if (!verdict.ok) return verdict;
    const id = newId();
    await tx.insert(spendLedger).values({
      id,
      day: utcDay(nowMs),
      provider: e.provider,
      action: e.action,
      refId: e.refId,
      env: e.env,
      estUsd: round5(Math.max(0, e.estUsd)),
      status: "reserved",
      createdAt: new Date(nowMs),
    });
    // Link the reservation to our live-session row when the refId is one (scripts reserve with refId = sessionId).
    await tx
      .update(liveSessions)
      .set({ ledgerId: id })
      .where(and(eq(liveSessions.id, e.refId), sql`${liveSessions.ledgerId} is null`));
    return { ok: true, id };
  }

  /** Flip the mode after a judging-window refusal (outside the refused transaction). */
  async onRefusal(r: ReserveRefusal, e: { provider: Provider; action: string; env: string }): Promise<void> {
    log.child({ component: "ledger" }).warn("reservation refused", { provider: e.provider, action: e.action, env: e.env, reason: r.reason });
    if ((r.reason === "budget_daily" || r.reason === "budget_total") && this.flags) await this.flags.tripReplayOnly(r.reason);
  }

  async reserveDetailed(e: Parameters<SpendLedger["reserve"]>[0]): Promise<ReserveResult> {
    const nowMs = this.now();
    const r = await this.db.transaction((tx) => this.reserveTx(tx, e, nowMs));
    if (!r.ok) await this.onRefusal(r, e);
    return r;
  }

  async reserve(e: Parameters<SpendLedger["reserve"]>[0]): Promise<{ ok: true; id: string } | { ok: false; code: "E_BUDGET" }> {
    const r = await this.reserveDetailed(e);
    return r.ok ? r : { ok: false, code: "E_BUDGET" };
  }

  async settle(id: string, actualUsd: number): Promise<void> {
    await this.settleOn(this.db, id, actualUsd);
  }

  async settleOn(x: Exec, id: string, actualUsd: number): Promise<void> {
    await x
      .update(spendLedger)
      .set({ status: "settled", actualUsd: round5(Math.max(0, actualUsd)), settledAt: new Date(this.now()) })
      .where(eq(spendLedger.id, id));
  }

  async release(id: string): Promise<void> {
    await this.releaseOn(this.db, id);
  }

  async releaseOn(x: Exec, id: string): Promise<void> {
    await x
      .update(spendLedger)
      .set({ status: "released", settledAt: new Date(this.now()) })
      .where(and(eq(spendLedger.id, id), eq(spendLedger.status, "reserved")));
  }

  /** Settle a still-reserved row at its reserved amount (F5 worst case). */
  async settleAtEstimateOn(x: Exec, id: string): Promise<void> {
    await x
      .update(spendLedger)
      .set({ status: "settled", actualUsd: sql`${spendLedger.estUsd}`, settledAt: new Date(this.now()) })
      .where(and(eq(spendLedger.id, id), eq(spendLedger.status, "reserved")));
  }

  async summary(): Promise<LedgerSummary> {
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const byProvider = await this.db.execute(
      sql`select ${spendLedger.provider} as k, coalesce(sum(${AMOUNT}),0)::float8 as usd from ${spendLedger} where ${spendLedger.day} = ${day} group by 1`,
    );
    const todayUsd: Record<string, number> = {};
    for (const r of byProvider.rows as { k: string; usd: unknown }[]) todayUsd[r.k] = round5(num(r.usd));
    const envRows = await this.db.execute(sql`select ${spendLedger.env} as k, coalesce(sum(${AMOUNT}),0)::float8 as usd from ${spendLedger} group by 1`);
    const byEnv: Record<string, number> = {};
    for (const r of envRows.rows as { k: string; usd: unknown }[]) byEnv[r.k] = round5(num(r.usd));

    let sinceEpochUsd = 0;
    let dailyCapUsd = this.cfg.ledger.dailyCapMaxUsd;
    let todayCounted = AAI.reduce((s, p) => s + (todayUsd[p] ?? 0), 0);
    if (this.judging(nowMs)) {
      const n = await this.judgingNumbers(this.db, nowMs);
      sinceEpochUsd = n.sinceEpochUsd;
      dailyCapUsd = n.dailyCapUsd;
      todayCounted = n.todaySinceEpochUsd;
    }
    const pctToday = dailyCapUsd > 0 ? Math.min(100, Math.round((todayCounted / dailyCapUsd) * 1000) / 10) : 100;
    return { sinceEpochUsd, todayUsd, dailyCapUsd, judgingBudgetUsd: this.cfg.ledger.judgingBudgetUsd, pctToday, byEnv };
  }
}
