import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";

import { BatonError, type FallbackKind } from "../../core/contracts/errors";
import type { RateLimiter } from "../../core/contracts/services";
import type { Db } from "../db/client";
import { rateEvents } from "../db/schema";
import type { Clock } from "./config";

/**
 * RateLimiter (DESIGN §7.3): insert the hit, then sum the window in the same transaction; over the limit → delete
 * the inserted row and return `retryAfterSec` (when the oldest counted hit leaves the window). Cleanup is the purge
 * job (rate_events older than 2 days).
 *
 * `check()` is the read-only variant for "count only on success" limits (e.g. STT *grants*: a queued poll must not
 * burn the visitor's budget); record the hit with `hit()` after the grant.
 */
export class DbRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly now: Clock = Date.now,
  ) {}

  async hit(bucket: string, key: string, limit: number, windowSec: number, cost = 1): Promise<{ ok: boolean; retryAfterSec: number }> {
    const nowMs = this.now();
    const since = new Date(nowMs - windowSec * 1000);
    return this.db.transaction(async (tx) => {
      // Serialize hits of one (bucket, key) so two concurrent requests cannot both squeeze under the limit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rate:${bucket}:${key}`}))`);
      const [row] = await tx.insert(rateEvents).values({ bucket, key, cost, ts: new Date(nowMs) }).returning({ id: rateEvents.id });
      const used = await this.used(tx, bucket, key, since);
      if (used <= limit) return { ok: true, retryAfterSec: 0 };
      if (row) await tx.delete(rateEvents).where(eq(rateEvents.id, row.id));
      return { ok: false, retryAfterSec: await this.retryAfter(tx, bucket, key, since, windowSec, nowMs) };
    });
  }

  /** Would `cost` more fit? (No insert.) */
  async check(bucket: string, key: string, limit: number, windowSec: number, cost = 1): Promise<{ ok: boolean; retryAfterSec: number }> {
    const nowMs = this.now();
    const since = new Date(nowMs - windowSec * 1000);
    const used = await this.used(this.db, bucket, key, since);
    if (used + cost <= limit) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: await this.retryAfter(this.db, bucket, key, since, windowSec, nowMs) };
  }

  private async used(x: Pick<Db, "select">, bucket: string, key: string, since: Date): Promise<number> {
    const [r] = await x
      .select({ n: sql<string>`coalesce(sum(${rateEvents.cost}),0)` })
      .from(rateEvents)
      .where(and(eq(rateEvents.bucket, bucket), eq(rateEvents.key, key), gt(rateEvents.ts, since)));
    return Number(r?.n ?? 0);
  }

  private async retryAfter(x: Pick<Db, "select">, bucket: string, key: string, since: Date, windowSec: number, nowMs: number): Promise<number> {
    const [r] = await x
      .select({ oldest: sql<Date | string | null>`min(${rateEvents.ts})` })
      .from(rateEvents)
      .where(and(eq(rateEvents.bucket, bucket), eq(rateEvents.key, key), gt(rateEvents.ts, since)));
    const oldest = r?.oldest ? new Date(r.oldest).getTime() : nowMs;
    return Math.max(1, Math.ceil((oldest + windowSec * 1000 - nowMs) / 1000));
  }
}

/** Standard buckets (DESIGN §4.4, §7.3), so every route names them the same way. */
export const RATE = {
  status: { bucket: "status-ip", limit: 60, windowSec: 60 },
  sttVisitor: { bucket: "stt", limit: 6, windowSec: 3600 },
  sttIp: { bucket: "stt-ip", limit: 15, windowSec: 3600 },
  runsVisitor: { bucket: "runs", limit: 10, windowSec: 3600 },
  reportCase: { bucket: "report", limit: 60, windowSec: 60 },
  vaHourVisitor: { bucket: "va-h", limit: 4, windowSec: 3600 },
  vaDayVisitor: { bucket: "va-d", limit: 8, windowSec: 86_400 },
  vaHourIp: { bucket: "va-ip", limit: 12, windowSec: 3600 },
} as const;

export type RateSpec = { bucket: string; limit: number; windowSec: number };

/**
 * Check several limits first (no writes), then record a hit on each, so a refused request never burns another
 * bucket. Throws 429 `E_RATE_LIMITED` (with `Retry-After`) naming the reason in plain words.
 */
export async function enforceRates(
  r: RateLimiter & { check?: DbRateLimiter["check"] },
  specs: { spec: RateSpec; key: string; message: string }[],
  opts: { fallback?: FallbackKind } = {},
): Promise<void> {
  for (const s of specs) {
    const c = r.check ? await r.check(s.spec.bucket, s.key, s.spec.limit, s.spec.windowSec) : { ok: true, retryAfterSec: 0 };
    if (!c.ok) {
      throw new BatonError("E_RATE_LIMITED", s.message, { retryAfterMs: c.retryAfterSec * 1000, ...(opts.fallback ? { fallback: opts.fallback } : {}) });
    }
  }
  for (const s of specs) {
    const h = await r.hit(s.spec.bucket, s.key, s.spec.limit, s.spec.windowSec);
    if (!h.ok) {
      throw new BatonError("E_RATE_LIMITED", s.message, { retryAfterMs: h.retryAfterSec * 1000, ...(opts.fallback ? { fallback: opts.fallback } : {}) });
    }
  }
}
