import "server-only";

import { vaAbsoluteCeilingMs } from "../../core/contracts/takeover";
import { env, type Env } from "../env";

/**
 * Limits configuration (DESIGN §2.3, §7.2, §7.3), read once from `env()` and injectable in tests.
 * Every clock in the authority is injected (`Clock`), so the rolling STT window, ticket expiry, hold expiry,
 * heartbeats and the ledger day all move with a fake clock.
 */

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** List prices (DESIGN §7.1): Streaming U3.5 Pro $0.45/h per session, Voice Agent $4.50/h. */
export const STT_USD_PER_SEC = 0.45 / 3600;
export const VA_USD_PER_SEC = 4.5 / 3600;
/** Streaming `inactivity_timeout` (s) and the Voice Agent bare-close billing tail (s) used for wall-time settles. */
export const STT_INACTIVITY_S = 30;
export const VA_BARE_CLOSE_S = 30;

export interface LedgerConfig {
  /** `LEDGER_EPOCH` (ms) or null: before it only the dev guard applies. */
  epochMs: number | null;
  judgingBudgetUsd: number;
  reserveUsd: number;
  dailyCapMaxUsd: number;
  /** Lower clamp of the dynamic daily cap (DESIGN §7.2). */
  dailyCapMinUsd: number;
  /** `JUDGING_END_DATE` (YYYY-MM-DD, UTC). */
  judgingEndDate: string;
  openaiDailyCapUsd: number;
  /** Pre-epoch guard per env family per UTC day (DESIGN §7.2: "$3 per day for env = dev-*"). */
  devDailyCapUsd: number;
}

export interface LimitsConfig {
  deployId: string;
  sttOpensPerMin: number;
  /** Rolling window of the broker. */
  sttWindowMs: number;
  sttQueueMaxWaitMs: number;
  /** Client poll interval for queued tickets (route #5 `pollMs`). */
  sttPollMs: number;
  /** A ticket not polled for this many intervals expires. */
  ticketMissedPolls: number;
  /** At most this many open (queued) tickets per ipKey. */
  maxTicketsPerIpKey: number;
  /** `cap_ms` of an STT live-session row (the token's max_session_duration; not enforced upstream). */
  sttCapMs: number;
  vaMaxConcurrent: number;
  vaHeartbeatStaleMs: number;
  /** F5: an `open` row past cap_ms + this becomes stale. */
  capGraceMs: number;
  /** The absolute VA ceiling (VA_SESSION_CAP_MAX_MS + 180 s hold) = `vaAcquire.capMs` (G0). */
  vaCeilingMs: number;
  /** The dynamic-cap maximum (VA_SESSION_CAP_MAX_MS), used for the VA budget reservation (≈ $0.53). */
  vaSessionCapMaxMs: number;
  ledger: LedgerConfig;
}

export function limitsConfigFromEnv(e: Env = env()): LimitsConfig {
  const epoch = e.LEDGER_EPOCH ? Date.parse(e.LEDGER_EPOCH) : NaN;
  return {
    deployId: e.BATON_DEPLOY_ID,
    sttOpensPerMin: e.STT_OPENS_PER_MIN,
    sttWindowMs: 60_000,
    sttQueueMaxWaitMs: e.STT_QUEUE_MAX_WAIT_S * 1000,
    sttPollMs: 2000,
    ticketMissedPolls: 3,
    maxTicketsPerIpKey: 2,
    sttCapMs: 600_000,
    vaMaxConcurrent: e.VA_MAX_CONCURRENT,
    vaHeartbeatStaleMs: 30_000,
    capGraceMs: 60_000,
    vaCeilingMs: vaAbsoluteCeilingMs(e.VA_SESSION_CAP_MAX_MS),
    vaSessionCapMaxMs: e.VA_SESSION_CAP_MAX_MS,
    ledger: {
      epochMs: Number.isFinite(epoch) ? epoch : null,
      judgingBudgetUsd: e.AAI_JUDGING_BUDGET_USD,
      reserveUsd: e.AAI_RESERVE_USD,
      dailyCapMaxUsd: e.AAI_DAILY_CAP_MAX_USD,
      dailyCapMinUsd: 0.75,
      judgingEndDate: e.JUDGING_END_DATE.slice(0, 10),
      openaiDailyCapUsd: e.OPENAI_DAILY_CAP_USD,
      devDailyCapUsd: 3,
    },
  };
}

/** Defaults for tests (no env needed). */
export function defaultLimitsConfig(over: Partial<Omit<LimitsConfig, "ledger">> & { ledger?: Partial<LedgerConfig> } = {}): LimitsConfig {
  const base: LimitsConfig = {
    deployId: "dev-test",
    sttOpensPerMin: 4,
    sttWindowMs: 60_000,
    sttQueueMaxWaitMs: 15_000,
    sttPollMs: 2000,
    ticketMissedPolls: 3,
    maxTicketsPerIpKey: 2,
    sttCapMs: 600_000,
    vaMaxConcurrent: 3,
    vaHeartbeatStaleMs: 30_000,
    capGraceMs: 60_000,
    vaCeilingMs: vaAbsoluteCeilingMs(420_000),
    vaSessionCapMaxMs: 420_000,
    ledger: {
      epochMs: null,
      judgingBudgetUsd: 28,
      reserveUsd: 5,
      dailyCapMaxUsd: 3,
      dailyCapMinUsd: 0.75,
      judgingEndDate: "2026-10-21",
      openaiDailyCapUsd: 3,
      devDailyCapUsd: 3,
    },
  };
  const { ledger, ...rest } = over;
  return { ...base, ...rest, ledger: { ...base.ledger, ...(ledger ?? {}) } };
}

/** The VA budget reservation for one run/takeover: the dynamic-cap maximum at list price (≈ $0.525 for 420 s). */
export const vaReservationUsd = (cfg: Pick<LimitsConfig, "vaSessionCapMaxMs">): number => (cfg.vaSessionCapMaxMs / 1000) * VA_USD_PER_SEC;

/** STT reservation for one channel session that may run `ms` (plus the inactivity tail). */
export const sttReservationUsd = (ms: number): number => (Math.max(0, ms) / 1000 + STT_INACTIVITY_S) * STT_USD_PER_SEC;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const utcDayStartMs = (ms: number): number => Date.parse(`${utcDay(ms)}T00:00:00.000Z`);
