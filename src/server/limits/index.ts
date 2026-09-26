import "server-only";

import { LocalOpenGuard, getLocalOpenGuard } from "../../../scripts/lib/local-open-guard";
import type { GetLimitsAuthority, LimitsAuthority, RateLimiter } from "../../core/contracts/services";
import { setBalanceErrorHandler } from "../aai/tokens";
import { getDb } from "../db/client";
import { env } from "../env";
import { DbFlagStore } from "../flags";
import { log } from "../log";
import { DbLimitsAuthority } from "./db-authority";
import { DbRateLimiter } from "./rate-limiter";
import { RemoteLimitsAuthority } from "./remote-authority";

/**
 * `getLimitsAuthority()` for server code (DESIGN §2.3, TASKS §2), by role:
 *   LIMITS_ROLE=authority            → DbLimitsAuthority on this app's Postgres (the Zerops app)
 *   LIMITS_AUTHORITY_URL (+ KEY) set → RemoteLimitsAuthority (local `next dev`, the Vercel mirror), with the split-budget
 *                                      laptop guard (2 opens/min, 1 VA) as the fallback when the authority is down
 *   neither                          → the laptop file guard (scripts/lib/local-open-guard.ts), the pre-deploy authority
 *                                      shared by every worktree on this machine
 * Tests inject with `setLimitsAuthority()` / `setRateLimiter()`.
 */

type Holder = { authority: LimitsAuthority | null; injected: LimitsAuthority | null; limiter: RateLimiter | null; injectedLimiter: RateLimiter | null };
const g = globalThis as typeof globalThis & { __batonLimits?: Holder };
const holder: Holder = (g.__batonLimits ??= { authority: null, injected: null, limiter: null, injectedLimiter: null });

export function setLimitsAuthority(a: LimitsAuthority | null): void {
  holder.injected = a;
}

export function setRateLimiter(r: RateLimiter | null): void {
  holder.injectedLimiter = r;
}

/** Drop cached instances (tests, env changes). */
export function resetLimitsCache(): void {
  holder.authority = null;
  holder.limiter = null;
}

export const getLimitsAuthority: GetLimitsAuthority = () => {
  if (holder.injected) return holder.injected;
  if (holder.authority) return holder.authority;
  const e = env();
  if (e.LIMITS_ROLE === "authority") {
    const auth = new DbLimitsAuthority({ db: getDb() });
    // F8: a balance/credit mint error flips replay_only (aai_balance) on the authority.
    setBalanceErrorHandler(async () => {
      await auth.flagStore.tripReplayOnly("aai_balance");
    });
    holder.authority = auth;
  } else if (e.LIMITS_AUTHORITY_URL) {
    if (!e.LIMITS_AUTHORITY_KEY) throw new Error("[limits] LIMITS_AUTHORITY_URL is set but LIMITS_AUTHORITY_KEY is missing (value never printed)");
    holder.authority = new RemoteLimitsAuthority(e.LIMITS_AUTHORITY_URL, e.LIMITS_AUTHORITY_KEY, {
      fallback: new LocalOpenGuard({ sttOpensPerMin: 2, vaMax: 1 }),
      onWarn: (msg, data) => log.child({ component: "limits-remote" }).warn(msg, data ?? {}),
    });
  } else {
    log.child({ component: "limits" }).warn("no LIMITS_ROLE/LIMITS_AUTHORITY_URL: using the laptop file guard");
    holder.authority = getLocalOpenGuard();
  }
  return holder.authority;
};

/**
 * The DB authority when this process IS the authority (status extras, sweeper, run planning), else null.
 *
 * QA-FIX: brand-checked, never `instanceof` — see `DbLimitsAuthority.isDbLimitsAuthority` for the 404 that cost.
 */
export const isDbLimitsAuthority = (a: unknown): a is DbLimitsAuthority =>
  a instanceof DbLimitsAuthority ||
  (typeof a === "object" && a !== null && (a as { isDbLimitsAuthority?: unknown }).isDbLimitsAuthority === true);

export function getDbAuthority(): DbLimitsAuthority | null {
  const a = getLimitsAuthority();
  return isDbLimitsAuthority(a) ? a : null;
}

export function getRateLimiter(): RateLimiter {
  if (holder.injectedLimiter) return holder.injectedLimiter;
  holder.limiter ??= new DbRateLimiter(getDb());
  return holder.limiter;
}

export function getFlagStore(): DbFlagStore {
  const a = getDbAuthority();
  return a ? a.flagStore : new DbFlagStore(getDb());
}

export { DbLimitsAuthority, vaSessionIdFor } from "./db-authority";
export { DbRateLimiter, RATE } from "./rate-limiter";
export { RemoteLimitsAuthority, LimitsHttpError } from "./remote-authority";
export { DbSpendLedger, dynamicDailyCap } from "./ledger";
export * from "./config";
