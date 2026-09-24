import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { EnqueueVerification } from "../../core/contracts/services";
import { liveSessions, spendLedger, streamQueue } from "../db/schema";
import { log } from "../log";
import { VA_LOCK_KEY, type DbLimitsAuthority } from "../limits/db-authority";

/**
 * F5 registry sweeper (DESIGN §4.5): the in-process ticker every 15 s, and cron `light`.
 *  - a `va` row `open` with no heartbeat for 30 s, or ANY row `open` past (opened_at ?? created_at) + cap_ms + 60 s,
 *    becomes `stale` and frees its slot (a dead browser's WebSocket closes on its own, so this is safe);
 *  - a `held` row past `hold_expires_at` becomes `released` and its reservation is released;
 *  - stale rows settle their ledger entry at the worst case = the reserved amount (STT: sized for the remaining call
 *    + the 30 s inactivity tail; VA: the dynamic-cap maximum);
 *  - reservations still `reserved` after 20 min (VA ceiling 600 s + 5 min, plus slack) that no held/open row owns
 *    are settled at the reserved amount;
 *  - queued STT tickets not polled for 3 intervals expire;
 *  - for each stale `va` row, the stale-VA handler runs once (default: enqueue WP8's `verify_takeover` via the
 *    registered `EnqueueVerification`, else a plain `verify_takeover` job if none exists for that takeover).
 */

export const ORPHAN_RESERVATION_MS = 20 * 60_000;

export interface SweepResult {
  staleVa: number;
  staleStt: number;
  holdsReleased: number;
  orphanReservationsSettled: number;
  ticketsExpired: number;
}

export type StaleVaHandler = (takeoverId: string, vaSessionId: string | null) => Promise<void>;

let staleVaHandler: StaleVaHandler | null = null;
/**
 * WP8 / the integrator: `registerStaleVaHandler((tko, vaSid) => enqueueVerification(tko, vaSid).then(() => {}))`.
 * Until then the sweeper enqueues a bare `verify_takeover` job through `fallbackEnqueue` (set by the job runner).
 */
export function registerStaleVaHandler(h: StaleVaHandler | null): void {
  staleVaHandler = h;
}
let fallbackEnqueue: EnqueueVerification | null = null;
export function setFallbackVerificationEnqueue(f: EnqueueVerification | null): void {
  fallbackEnqueue = f;
}

/** `va_<takeoverId>_<attempt>` → takeoverId (the route #10 row id scheme). */
export function takeoverIdOfVaSession(id: string): string | null {
  const m = /^va_(.+)_[01]$/.exec(id);
  return m?.[1] ?? null;
}

const sweepLog = log.child({ component: "sweeper" });

export async function sweepRegistry(a: DbLimitsAuthority): Promise<SweepResult> {
  const nowMs = a.now();
  const now = new Date(nowMs);
  const cfg = a.cfg;
  const out = await a.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${VA_LOCK_KEY})`);
    const hbCut = new Date(nowMs - cfg.vaHeartbeatStaleMs);
    const staleRows = await tx
      .update(liveSessions)
      .set({ status: "stale", closedAt: now })
      .where(
        and(
          eq(liveSessions.status, "open"),
          sql`(
            (${liveSessions.kind} = 'va' and coalesce(${liveSessions.lastHeartbeatAt}, ${liveSessions.createdAt}) < ${hbCut})
            or coalesce(${liveSessions.openedAt}, ${liveSessions.createdAt}) + (${liveSessions.capMs} + ${cfg.capGraceMs}) * interval '1 millisecond' < ${now}
          )`,
        ),
      )
      .returning();
    for (const r of staleRows) if (r.ledgerId) await a.ledger.settleAtEstimateOn(tx, r.ledgerId);

    const holds = await tx
      .update(liveSessions)
      .set({ status: "released", closedAt: now })
      .where(and(eq(liveSessions.status, "held"), lt(liveSessions.holdExpiresAt, now)))
      .returning();
    for (const h of holds) if (h.ledgerId) await a.ledger.releaseOn(tx, h.ledgerId);

    const orphans = await tx
      .update(spendLedger)
      .set({ status: "settled", actualUsd: sql`${spendLedger.estUsd}`, settledAt: now })
      .where(
        and(
          eq(spendLedger.status, "reserved"),
          lt(spendLedger.createdAt, new Date(nowMs - ORPHAN_RESERVATION_MS)),
          sql`not exists (select 1 from ${liveSessions} ls where ls.ledger_id = ${spendLedger.id} and ls.status in ('held','open'))`,
        ),
      )
      .returning({ id: spendLedger.id });

    const tickets = await tx
      .update(streamQueue)
      .set({ status: "expired" })
      .where(and(eq(streamQueue.status, "queued"), lt(streamQueue.lastPollAt, new Date(nowMs - cfg.ticketMissedPolls * cfg.sttPollMs))))
      .returning({ t: streamQueue.ticket });

    return { staleRows, holds: holds.length, orphans: orphans.length, tickets: tickets.length };
  });

  const staleVa = out.staleRows.filter((r) => r.kind === "va");
  for (const r of staleVa) {
    const tko = takeoverIdOfVaSession(r.id);
    if (!tko) continue;
    try {
      if (staleVaHandler) await staleVaHandler(tko, r.providerSessionId);
      else if (fallbackEnqueue) await fallbackEnqueue(tko, r.providerSessionId);
    } catch (err) {
      sweepLog.warn("stale VA handler failed", { takeoverId: tko, err });
    }
  }
  const res: SweepResult = {
    staleVa: staleVa.length,
    staleStt: out.staleRows.length - staleVa.length,
    holdsReleased: out.holds,
    orphanReservationsSettled: out.orphans,
    ticketsExpired: out.tickets,
  };
  if (out.staleRows.length || out.holds || out.orphans) sweepLog.info("swept", { ...res });
  return res;
}

/** Ids of rows the sweeper would consider for a kind (tests / status). */
export async function activeVaIds(a: DbLimitsAuthority): Promise<string[]> {
  const rows = await a.db
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .where(and(eq(liveSessions.kind, "va"), inArray(liveSessions.status, ["held", "open"])));
  return rows.map((r) => r.id);
}
