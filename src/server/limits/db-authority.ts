import "server-only";

import { and, asc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";

import type { SessionReport } from "../../core/contracts/api";
import type { AppFlags, LimitsAuthority, OpenSource, SlotResult } from "../../core/contracts/services";
import { newId } from "../../lib/ids";
import type { Db } from "../db/client";
import { liveSessions, rateEvents, streamQueue } from "../db/schema";
import { DbFlagStore, modeDenial } from "../flags";
import { log } from "../log";
import {
  limitsConfigFromEnv, STT_INACTIVITY_S, STT_USD_PER_SEC, systemClock, VA_BARE_CLOSE_S, VA_USD_PER_SEC,
  type Clock, type LimitsConfig,
} from "./config";
import { DbSpendLedger } from "./ledger";

/**
 * DbLimitsAuthority: THE limits authority for the AssemblyAI account (DESIGN §2.3), backed by the Zerops Postgres.
 *
 * STT stream-slot broker
 *  - one `live_sessions` row (kind stt) per granted open, created at grant time (G0: `sessionIds`, [rep, customer]);
 *  - at most STT_OPENS_PER_MIN (4) grants per rolling 60 s, counted from those rows (released rows excluded: they
 *    never reached AssemblyAI). Reconnects (§5.1.9) and synthetic checks may use the free tier's 5th slot;
 *  - FIFO `stream_queue` of tickets, reconnect tickets (`tr_…`) ahead of new calls (`tq_…`); a ticket not polled
 *    for 3 × 2 s expires; ≤ 2 queued tickets per ipKey;
 *  - ETA > STT_QUEUE_MAX_WAIT_S (15 s) → `denied(E_QUEUE_TIMEOUT)`, so the labelled cached replay starts at once.
 *  All under `pg_advisory_xact_lock(BROKER_LOCK_KEY)`.
 *
 * Voice Agent slot registry
 *  - `live_sessions` rows kind va in `held` (a run's reservation, D14) or `open` count against VA_MAX_CONCURRENT (3);
 *  - `vaHold` reserves the VA budget in the ledger in the same transaction;
 *  - `vaAcquire` consumes a hold (the new `open` row inherits its reservation) or takes a free slot; with a
 *    `takeoverId` the row id is `va_<takeoverId>_<attempt>`, so one takeover attempt can never hold two slots;
 *  - heartbeats every 10 s; F5 (src/server/registry/sweeper.ts) marks a slot stale after 30 s without one.
 *  All under `pg_advisory_xact_lock(VA_LOCK_KEY)` (ledger lock taken inside: order VA → LEDGER, never the reverse).
 *
 * Every clock is injected (`now`), so tests drive windows, expiries and ledger days with a fake clock.
 */

export const BROKER_LOCK_KEY = 7_711_002;
export const VA_LOCK_KEY = 7_711_003;
/** F8: this many 1008 closes on fresh tokens within 10 min → replay_only (aai_balance). */
export const BAD_CLOSE_LIMIT = 3;
export const BAD_CLOSE_WINDOW_MS = 10 * 60_000;
const BAD_CLOSE_BUCKET = "aai-1008";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SttReq = Parameters<LimitsAuthority["sttAcquire"]>[0] & { caseId?: string };
type HoldReq = Parameters<LimitsAuthority["vaHold"]>[0] & { caseId?: string };
type AcquireReq = Parameters<LimitsAuthority["vaAcquire"]>[0] & { caseId?: string; visitorId?: string; runId?: string };
type VaDenied = { ok: false; code: "E_VA_CAPACITY" | "E_BUDGET" | "E_MODE_REPLAY_ONLY" | "E_AAI_BALANCE"; message: string };

const authLog = log.child({ component: "limits" });

export interface DbLimitsAuthorityOptions {
  db: Db;
  config?: LimitsConfig;
  now?: Clock;
  flags?: DbFlagStore;
}

export const vaSessionIdFor = (takeoverId: string, attempt: 0 | 1): string => `va_${takeoverId}_${attempt}`;
const isReconnectTicket = (t: string): boolean => t.startsWith("tr_");
let ticketSeq = 0;
/** Tickets sort FIFO even when two are created in the same millisecond (time, then an in-process counter). */
const newTicket = (reconnect: boolean, nowMs: number): string =>
  `${reconnect ? "tr" : "tq"}_${nowMs.toString(36).padStart(9, "0")}${(ticketSeq++ % 1_679_616).toString(36).padStart(4, "0")}_${newId().slice(0, 10)}`;

export class DbLimitsAuthority implements LimitsAuthority {
  /**
   * QA-FIX: the brand `getDbAuthority()` tests, instead of `instanceof`.
   *
   * Next can load this module twice in one process (the route chunk, the server-component graph, the in-process
   * worker), so the singleton on `globalThis` may be an instance of the *other* copy of this class. `instanceof`
   * then answered false and `POST /api/internal/limits/*` replied `404 "Not the limits authority."` on the very
   * process that IS the authority — the documented remote kill-switch path, dead, while `/api/admin/ledger` in the
   * same process worked. A brand is stable across copies; the class identity is not.
   */
  readonly isDbLimitsAuthority = true as const;
  readonly db: Db;
  readonly cfg: LimitsConfig;
  readonly now: Clock;
  readonly flagStore: DbFlagStore;
  readonly ledger: DbSpendLedger;

  constructor(o: DbLimitsAuthorityOptions) {
    this.db = o.db;
    this.cfg = o.config ?? limitsConfigFromEnv();
    this.now = o.now ?? systemClock;
    this.flagStore = o.flags ?? new DbFlagStore(o.db, this.now);
    this.ledger = new DbSpendLedger(o.db, this.cfg, this.now, this.flagStore);
  }

  async flags(): Promise<AppFlags> {
    return this.flagStore.get();
  }

  /** Mode refusal for an opener; synthetic checks may run in replay_only (they are how synthetic_failed clears). */
  private denialFor(flags: AppFlags, source: OpenSource) {
    const d = modeDenial(flags);
    if (!d) return null;
    if (source === "synthetic" && flags.mode === "replay_only" && flags.reason !== "aai_balance") return null;
    return d;
  }

  // ===================================================================================== STT broker

  private async sttOpenTimes(x: Tx | Db, nowMs: number): Promise<number[]> {
    const rows = await x
      .select({ at: liveSessions.createdAt })
      .from(liveSessions)
      .where(
        and(eq(liveSessions.kind, "stt"), ne(liveSessions.status, "released"), gt(liveSessions.createdAt, new Date(nowMs - this.cfg.sttWindowMs))),
      );
    return rows.map((r) => r.at.getTime());
  }

  private usedAt(opens: number[], t: number): number {
    return opens.filter((at) => t - at < this.cfg.sttWindowMs).length;
  }

  /** ms until `need` more opens fit under `limit` in the rolling window (assuming no other grants), or null. */
  private etaMs(opens: number[], nowMs: number, need: number, limit: number): number | null {
    if (need > limit) return null;
    const candidates = [nowMs, ...opens.map((at) => at + this.cfg.sttWindowMs).filter((t) => t > nowMs)].sort((a, b) => a - b);
    for (const t of candidates) if (this.usedAt(opens, t) + need <= limit) return t - nowMs;
    return null;
  }

  private async expireTickets(x: Tx | Db, nowMs: number): Promise<void> {
    const cutoff = new Date(nowMs - this.cfg.ticketMissedPolls * this.cfg.sttPollMs);
    await x
      .update(streamQueue)
      .set({ status: "expired" })
      .where(and(eq(streamQueue.status, "queued"), lt(streamQueue.lastPollAt, cutoff)));
  }

  private async queuedTickets(x: Tx | Db) {
    return x
      .select()
      .from(streamQueue)
      .where(eq(streamQueue.status, "queued"))
      .orderBy(sql`(${streamQueue.ticket} like 'tr\\_%') desc`, asc(streamQueue.createdAt), asc(streamQueue.ticket));
  }

  async sttAcquire(req: SttReq): Promise<SlotResult> {
    const flags = await this.flagStore.get();
    const denial = this.denialFor(flags, req.source);
    if (denial) {
      if (req.ticket) await this.sttCancel(req.ticket);
      return { status: "denied", code: denial.code, message: denial.message };
    }
    const nowMs = this.now();
    const out = await this.db.transaction(async (tx): Promise<SlotResult> => {
      await tx.execute(sql`select pg_advisory_xact_lock(${BROKER_LOCK_KEY})`);
      await this.expireTickets(tx, nowMs);
      const queued = await this.queuedTickets(tx);
      const idx = req.ticket ? queued.findIndex((t) => t.ticket === req.ticket) : -1;
      if (idx >= 0) await tx.update(streamQueue).set({ lastPollAt: new Date(nowMs) }).where(eq(streamQueue.ticket, req.ticket!));
      const reconnect = req.reconnect === true || (idx >= 0 && isReconnectTicket(queued[idx]!.ticket));
      const ahead = idx >= 0 ? queued.slice(0, idx) : reconnect ? queued.filter((t) => isReconnectTicket(t.ticket)) : queued;
      const aheadN = ahead.reduce((s, t) => s + t.n, 0);
      const limit = this.cfg.sttOpensPerMin + (reconnect || req.source === "synthetic" ? 1 : 0);
      const opens = await this.sttOpenTimes(tx, nowMs);

      if (ahead.length === 0 && this.usedAt(opens, nowMs) + req.n <= limit) {
        const grantId = idx >= 0 ? req.ticket! : newId();
        const sessionIds = Array.from({ length: req.n }, () => newId());
        await tx.insert(liveSessions).values(
          sessionIds.map((id) => ({
            id,
            kind: "stt" as const,
            caseId: req.caseId ?? null,
            visitorId: req.visitorId,
            runId: req.runId ?? null,
            deployId: req.deployId,
            source: req.source,
            capMs: this.cfg.sttCapMs,
            status: "open" as const,
            createdAt: new Date(nowMs),
          })),
        );
        if (idx >= 0) await tx.update(streamQueue).set({ status: "granted", grantedAt: new Date(nowMs) }).where(eq(streamQueue.ticket, req.ticket!));
        return { status: "granted", grantId, sessionIds };
      }

      const eta = this.etaMs(opens, nowMs, aheadN + req.n, limit);
      if (eta === null || eta > this.cfg.sttQueueMaxWaitMs) {
        if (idx >= 0) await tx.update(streamQueue).set({ status: "cancelled" }).where(eq(streamQueue.ticket, req.ticket!));
        return {
          status: "denied",
          code: "E_QUEUE_TIMEOUT",
          message: `All live transcription slots are busy for the next ${Math.round(this.cfg.sttWindowMs / 1000)} s, so the labelled cached replay starts right away.`,
        };
      }
      if (idx >= 0) return { status: "queued", ticket: req.ticket!, position: idx, etaMs: Math.max(eta, 250) };

      const mine = queued.filter((t) => t.ipKey === req.ipKey).length;
      if (mine >= this.cfg.maxTicketsPerIpKey) {
        return {
          status: "denied",
          code: "E_RATE_LIMITED",
          message: "Several people on your network are already waiting for a live slot, so this run uses the labelled cached replay.",
        };
      }
      const ticket = newTicket(reconnect, nowMs);
      await tx.insert(streamQueue).values({
        ticket,
        visitorId: req.visitorId,
        ipKey: req.ipKey,
        n: req.n,
        status: "queued",
        createdAt: new Date(nowMs),
        lastPollAt: new Date(nowMs),
      });
      return { status: "queued", ticket, position: ahead.length, etaMs: Math.max(eta, 250) };
    });
    if (out.status === "granted") authLog.info("stt granted", { n: req.n, source: req.source, deployId: req.deployId });
    return out;
  }

  async sttCancel(ticket: string): Promise<void> {
    await this.db.update(streamQueue).set({ status: "cancelled" }).where(and(eq(streamQueue.ticket, ticket), eq(streamQueue.status, "queued")));
  }

  /** Read-only broker view: would `n` opens be granted now, and if not, the ETA (for /api/runs and /api/status). */
  async sttPeek(n: 1 | 2): Promise<{ etaMs: number | null; queueDepth: number; usedInWindow: number }> {
    const nowMs = this.now();
    await this.expireTickets(this.db, nowMs);
    const queued = await this.queuedTickets(this.db);
    const opens = await this.sttOpenTimes(this.db, nowMs);
    const aheadN = queued.reduce((s, t) => s + t.n, 0);
    return { etaMs: this.etaMs(opens, nowMs, aheadN + n, this.cfg.sttOpensPerMin), queueDepth: queued.length, usedInWindow: this.usedAt(opens, nowMs) };
  }

  // ===================================================================================== VA registry

  private async vaActive(x: Tx | Db): Promise<number> {
    const [r] = await x
      .select({ n: sql<string>`count(*)` })
      .from(liveSessions)
      .where(and(eq(liveSessions.kind, "va"), inArray(liveSessions.status, ["held", "open"])));
    return Number(r?.n ?? 0);
  }

  /** Free VA slots right now (status page, run planning). */
  async vaFree(): Promise<number> {
    return Math.max(0, this.cfg.vaMaxConcurrent - (await this.vaActive(this.db)));
  }

  private capacityDenied(): VaDenied {
    return {
      ok: false,
      code: "E_VA_CAPACITY",
      message: `Live AI is busy right now (${this.cfg.vaMaxConcurrent} live AI calls are running), so the recorded AI session plays instead.`,
    };
  }

  async vaHold(req: HoldReq): Promise<{ ok: true; holdId: string } | VaDenied> {
    const flags = await this.flagStore.get();
    const denial = modeDenial(flags);
    if (denial) return { ok: false, code: denial.code, message: denial.message };
    const nowMs = this.now();
    const holdId = newId();
    const expires = Date.parse(req.expiresAt);
    const r = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${VA_LOCK_KEY})`);
      if ((await this.vaActive(tx)) >= this.cfg.vaMaxConcurrent) return { kind: "cap" as const };
      const res = await this.ledger.reserveTx(tx, { provider: "aai_va", action: "va_hold", refId: holdId, estUsd: req.estUsd, env: req.deployId }, nowMs);
      if (!res.ok) return { kind: "budget" as const, refusal: res };
      await tx.insert(liveSessions).values({
        id: holdId,
        kind: "va",
        caseId: req.caseId ?? null,
        visitorId: req.visitorId,
        ledgerId: res.id,
        runId: req.runId,
        deployId: req.deployId,
        source: "judge",
        capMs: this.cfg.vaCeilingMs,
        holdExpiresAt: new Date(Number.isFinite(expires) ? expires : nowMs + 10 * 60_000),
        status: "held",
        createdAt: new Date(nowMs),
      });
      return { kind: "ok" as const };
    });
    if (r.kind === "cap") return this.capacityDenied();
    if (r.kind === "budget") {
      await this.ledger.onRefusal(r.refusal, { provider: "aai_va", action: "va_hold", env: req.deployId });
      const d = modeDenial(await this.flagStore.get());
      return {
        ok: false,
        code: "E_BUDGET",
        message: d?.message ?? "Today's live AI budget is used up, so the recorded AI session plays instead.",
      };
    }
    return { ok: true, holdId };
  }

  /** `vaAcquire` plus whether the new slot already carries a ledger reservation (inherited from the run's hold). */
  async vaAcquireDetailed(req: AcquireReq): Promise<{ ok: true; liveSessionId: string; ledgerId: string | null } | VaDenied> {
    const flags = await this.flagStore.get();
    const denial = this.denialFor(flags, req.source);
    if (denial) return { ok: false, code: denial.code, message: denial.message };
    const nowMs = this.now();
    const id = req.takeoverId ? vaSessionIdFor(req.takeoverId, req.attempt) : newId();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${VA_LOCK_KEY})`);
      const [existing] = await tx.select({ id: liveSessions.id }).from(liveSessions).where(eq(liveSessions.id, id));
      if (existing) return { ok: false as const, code: "E_VA_CAPACITY" as const, message: "This takeover attempt already has a live AI slot." };
      const [hold] = req.holdId ? await tx.select().from(liveSessions).where(and(eq(liveSessions.id, req.holdId), eq(liveSessions.kind, "va"))) : [];
      const usable = !!hold && hold.status === "held" && (!hold.holdExpiresAt || hold.holdExpiresAt.getTime() > nowMs);
      if (usable) {
        await tx.update(liveSessions).set({ status: "released", ledgerId: null, closedAt: new Date(nowMs) }).where(eq(liveSessions.id, hold.id));
      } else if ((await this.vaActive(tx)) >= this.cfg.vaMaxConcurrent) {
        return this.capacityDenied();
      }
      const ledgerId = usable ? hold.ledgerId : null;
      await tx.insert(liveSessions).values({
        id,
        kind: "va",
        caseId: req.caseId ?? (usable ? hold.caseId : null),
        visitorId: req.visitorId ?? (usable ? hold.visitorId : null),
        ledgerId,
        runId: req.runId ?? (usable ? hold.runId : null),
        deployId: req.deployId,
        source: req.source,
        capMs: Math.round(req.capMs),
        lastHeartbeatAt: new Date(nowMs),
        status: "open",
        createdAt: new Date(nowMs),
      });
      return { ok: true as const, liveSessionId: id, ledgerId };
    });
  }

  async vaAcquire(req: AcquireReq): Promise<{ ok: true; liveSessionId: string } | VaDenied> {
    const r = await this.vaAcquireDetailed(req);
    return r.ok ? { ok: true, liveSessionId: r.liveSessionId } : r;
  }

  // ===================================================================================== lifecycle

  private rate(kind: "stt" | "va"): { usdPerSec: number; tailS: number } {
    return kind === "stt" ? { usdPerSec: STT_USD_PER_SEC, tailS: STT_INACTIVITY_S } : { usdPerSec: VA_USD_PER_SEC, tailS: VA_BARE_CLOSE_S };
  }

  /** Release a held/open slot. A never-opened slot releases its reservation; an opened one settles from wall time. */
  async release(liveSessionIdOrHoldId: string, reason: string): Promise<void> {
    const nowMs = this.now();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${VA_LOCK_KEY})`);
      const [row] = await tx.select().from(liveSessions).where(eq(liveSessions.id, liveSessionIdOrHoldId));
      if (!row || (row.status !== "held" && row.status !== "open")) return;
      await tx.update(liveSessions).set({ status: "released", closedAt: new Date(nowMs) }).where(eq(liveSessions.id, row.id));
      if (row.ledgerId) {
        if (row.status === "held" || !row.openedAt) await this.ledger.releaseOn(tx, row.ledgerId);
        else {
          const { usdPerSec, tailS } = this.rate(row.kind);
          await this.ledger.settleOn(tx, row.ledgerId, ((nowMs - row.openedAt.getTime()) / 1000 + tailS) * usdPerSec);
        }
      }
    });
    authLog.info("slot released", { id: liveSessionIdOrHoldId, reason });
  }

  async heartbeat(liveSessionId: string): Promise<void> {
    await this.db
      .update(liveSessions)
      .set({ lastHeartbeatAt: new Date(this.now()) })
      .where(and(eq(liveSessions.id, liveSessionId), eq(liveSessions.status, "open")));
  }

  /** The live-session row (route #7 checks that a report's session belongs to the caller's case). */
  async session(id: string) {
    const [row] = await this.db.select().from(liveSessions).where(eq(liveSessions.id, id));
    return row ?? null;
  }

  async report(r: SessionReport): Promise<void> {
    const nowMs = this.now();
    const [row] = await this.db.select().from(liveSessions).where(eq(liveSessions.id, r.sessionId));
    if (!row || row.kind !== r.kind) {
      authLog.warn("report for unknown session", { sessionId: r.sessionId, kind: r.kind, event: r.event });
      return;
    }
    if (r.event === "opened") {
      await this.db
        .update(liveSessions)
        .set({
          openedAt: row.openedAt ?? new Date(nowMs),
          ...(r.providerSessionId ? { providerSessionId: r.providerSessionId } : {}),
          ...(row.kind === "va" ? { lastHeartbeatAt: new Date(nowMs) } : {}),
        })
        .where(eq(liveSessions.id, row.id));
      return;
    }
    // closed
    const { usdPerSec, tailS } = this.rate(row.kind);
    await this.db.transaction(async (tx) => {
      await tx
        .update(liveSessions)
        .set({
          status: row.status === "open" || row.status === "held" ? "closed" : row.status,
          closedAt: row.closedAt ?? new Date(nowMs),
          ...(r.billedSeconds !== undefined ? { billedSeconds: r.billedSeconds } : {}),
          ...(r.providerSessionId ? { providerSessionId: r.providerSessionId } : {}),
        })
        .where(eq(liveSessions.id, row.id));
      if (!row.ledgerId) return;
      if (r.billedSeconds !== undefined) await this.ledger.settleOn(tx, row.ledgerId, r.billedSeconds * usdPerSec);
      else if (row.openedAt) await this.ledger.settleOn(tx, row.ledgerId, ((nowMs - row.openedAt.getTime()) / 1000 + tailS) * usdPerSec);
      else await this.ledger.releaseOn(tx, row.ledgerId);
    });
    await this.trackBadCloses(r, nowMs);
  }

  /** F8: 3 consecutive 1008 closes on fresh tokens (nothing billed) within 10 min → replay_only (aai_balance). */
  private async trackBadCloses(r: SessionReport, nowMs: number): Promise<void> {
    const fresh1008 = r.closeCode === 1008 && !(r.billedSeconds !== undefined && r.billedSeconds > 0);
    if (!fresh1008) {
      if (r.closeCode === 1000 || (r.billedSeconds ?? 0) > 0) await this.db.delete(rateEvents).where(eq(rateEvents.bucket, BAD_CLOSE_BUCKET));
      return;
    }
    await this.db.insert(rateEvents).values({ bucket: BAD_CLOSE_BUCKET, key: "all", cost: 1, ts: new Date(nowMs) });
    const [c] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(rateEvents)
      .where(and(eq(rateEvents.bucket, BAD_CLOSE_BUCKET), gt(rateEvents.ts, new Date(nowMs - BAD_CLOSE_WINDOW_MS))));
    if (Number(c?.n ?? 0) >= BAD_CLOSE_LIMIT) {
      authLog.error("3 fresh-token 1008 closes within 10 min: flipping replay_only (aai_balance)");
      await this.flagStore.tripReplayOnly("aai_balance");
    }
  }
}
