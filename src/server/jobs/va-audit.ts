/**
 * server/jobs/va-audit.ts - F6 Voice Agent audit (DESIGN §4.5; tightened in PLATFORM v2.1 §8.4, WP18·0). WP2's
 * in-process worker calls the hook every 3 min while `mode=live` (cron `light` is the backstop).
 *
 * `GET /v1/sessions?limit=50`, following `has_more` / `next_cursor`, over the last 60 min. Every compiled system
 * prompt ends with `(internal ref: baton-deploy={BATON_DEPLOY_ID}; never mention this)`; the audit reads it from
 * `GET /v1/sessions/{id}.config.system_prompt` once per new id (cached per process).
 *
 * v2.1 (tightened): the audit accounts for EVERY session on the account, whatever its marker. A session is matched,
 * in this order, by:
 *  1. `registry`: a `live_sessions` row (kind va) with its provider session id;
 *  2. `takeover`: a `takeovers.va_session_id`;
 *  3. `publication`: a publication's stored agent (`agent_id` in `/v1/sessions`) - one running session per active
 *     run; an ended session of a known publication agent is accounted for;
 *  4. `dev_lease`: an OPEN dev VA-slot lease from the limits authority (`live_sessions` kind va, status open, a dev
 *     deploy id, no provider session id yet), COUNT-matched (one lease covers one running session created within
 *     [lease − skew, lease + lead]); a copied `dev-*` marker therefore buys nothing without a lease.
 * Anomalies (any one → `mode=replay_only`, reason `va_audit_anomaly`; the integrator clears it after a look):
 *  - `unknown_session`: a session carrying THIS deploy's marker that matches none of 1-3 (running or ended; v2.0);
 *  - `unregistered_session`: any other RUNNING session (dev marker, another marker, none) that matches none of 1-4;
 *  - `running_but_closed`: still running while its row is `closed`/`stale`/`released` (any marker);
 *  - `over_concurrency`: more running sessions on the account than `VA_MAX_CONCURRENT` (rows closed within the grace
 *    are not counted: the provider marks a session ended a few seconds after `session.end`).
 * Sessions younger than `UNKNOWN_GRACE_MS` are not flagged yet (session.ready → report "opened" takes a moment).
 * It never deletes a running session: T-D1-0b showed that `DELETE /v1/sessions/{id}` does not end a live one (see
 * `DELETE_ENDS_LIVE_SESSION`). A running session reads `status:"created"`, `ended_at:null`, `duration_seconds:null`,
 * no artifacts (T-D1-0b). The audit also settles the VA ledger entries of this deploy's ended sessions.
 */
import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { PublishedAgentRef, VaAuditAnomalyV21, VaAuditMatch, VaAuditReportV21 } from "../../core/contracts/ext/wp18-audit";
import { listSessionsSince, type SessionRecord } from "../aai/va-rest";
import type { Db } from "../db/client";
import { liveSessions, takeovers } from "../db/schema";
import { log } from "../log";
import { wp8, type Wp8Ports } from "../qa/deps";
import { ensureWp8Wired } from "../qa/wiring";
import { VERIFY_PRICES } from "./verify-takeover";

const alog = log.child({ component: "va-audit" });

export const AUDIT = {
  WINDOW_MS: 60 * 60_000,
  PAGE_SIZE: 50,
  MAX_PAGES: 10,
  /** A session this young may not be reported to `live_sessions` yet (session.ready → report "opened"). */
  UNKNOWN_GRACE_MS: 90_000,
  /** session.end → the provider marks it ended a few seconds later. */
  CLOSED_GRACE_MS: 60_000,
  /** Dev lease count-match window: the lease is granted just before the connect (clock skew allowance)… */
  DEV_LEASE_SKEW_MS: 15_000,
  /** …and a script opens its session within this long of the grant (VA caps are ≤ 10 min). */
  DEV_LEASE_MAX_LEAD_MS: 10 * 60_000,
} as const;

/**
 * T-D1-0b (2026-09-25, scripts/day1/session-delete.ts; docs/notes/wp8.md): `DELETE /v1/sessions/{id}` on a LIVE
 * session answers 204 but does NOT end it (the socket stayed open and a reply.create was answered after the delete);
 * it only hides the session from GET (404) and the list. So F6 never deletes a running session (that would blind the
 * next audit without stopping the spend): it only flips the mode. On an ENDED session the delete is immediate: GET →
 * 404 and the pre-signed audio/timeline URLs → 404 at once.
 */
export const DELETE_ENDS_LIVE_SESSION = false;

export const DEPLOY_MARKER_RE = /\(internal ref: baton-deploy=([^;)\s]+); never mention this\)/;

/** The deploy id in a compiled system prompt's marker line, or null. */
export function markerOf(systemPrompt: unknown): string | null {
  if (typeof systemPrompt !== "string") return null;
  const all = [...systemPrompt.matchAll(new RegExp(DEPLOY_MARKER_RE.source, "g"))];
  return all.length ? (all[all.length - 1]![1] ?? null) : null;
}

/** Deploys that never audit, and whose open VA leases are "dev leases": dev laptops and the Vercel mirror. */
export const isIgnoredDeploy = (id: string): boolean => id.startsWith("dev-") || id === "dev" || id.startsWith("vercel-") || id === "local";

const ENDED = new Set(["completed", "ended", "failed", "error", "closed", "terminated", "deleted"]);
/** Running = no `ended_at` and a non-terminal status. */
export const isRunning = (s: Pick<SessionRecord, "status" | "ended_at">): boolean => !s.ended_at && !ENDED.has(String(s.status ?? "").toLowerCase());

const systemPromptOf = (s: SessionRecord): unknown => (s.config && typeof s.config === "object" ? (s.config as Record<string, unknown>).system_prompt : undefined);
const createdMs = (s: Pick<SessionRecord, "created_at">): number => (s.created_at ? Date.parse(s.created_at) : NaN);

type Cache = { markers: Map<string, string | null>; settled: Set<string> };
const g = globalThis as typeof globalThis & { __batonVaAuditCache?: Cache };
const cache = (): Cache => (g.__batonVaAuditCache ??= { markers: new Map(), settled: new Set() });
/** Tests. */
export function resetVaAuditCache(): void {
  g.__batonVaAuditCache = { markers: new Map(), settled: new Set() };
}

async function markerFor(p: Wp8Ports, s: SessionRecord): Promise<string | null> {
  const c = cache().markers;
  if (c.has(s.id)) return c.get(s.id) ?? null;
  let prompt = systemPromptOf(s);
  if (prompt === undefined) {
    try {
      prompt = systemPromptOf(await p.vaRest().getSession(s.id));
    } catch (err) {
      // Deleted between list and get (404), or a transient error: skip it this round, retry next audit (not cached).
      alog.warn("audit could not read a session config", { sessionId: s.id, err });
      return null;
    }
  }
  const m = markerOf(prompt);
  c.set(s.id, m);
  if (c.size > 5000) c.delete(c.keys().next().value!);
  return m;
}

// ============================================================================================ dev-lease count-match

export interface LeaseSlot {
  id: string;
  createdAtMs: number;
}
export interface SessionSlot {
  id: string;
  /** NaN when the provider gave no `created_at` (then any open lease may cover it). */
  createdAtMs: number;
}

/**
 * Count-match running sessions to open dev leases (pure). A lease covers at most one session, and only one created
 * within [lease.createdAt − skew, lease.createdAt + lead]. Greedy by session creation time, each taking the earliest
 * eligible lease: optimal for these intervals (every session's window ends later for later sessions).
 * Returns sessionId → leaseId for the covered sessions.
 */
export function matchDevLeases(
  sessions: readonly SessionSlot[],
  leases: readonly LeaseSlot[],
  o: { skewMs?: number; leadMs?: number } = {},
): Map<string, string> {
  const skew = o.skewMs ?? AUDIT.DEV_LEASE_SKEW_MS;
  const lead = o.leadMs ?? AUDIT.DEV_LEASE_MAX_LEAD_MS;
  const free = [...leases].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const used = new Set<string>();
  const out = new Map<string, string>();
  const order = [...sessions].sort((a, b) => (Number.isNaN(a.createdAtMs) ? 1 : Number.isNaN(b.createdAtMs) ? -1 : a.createdAtMs - b.createdAtMs));
  for (const s of order) {
    const lease = free.find(
      (l) => !used.has(l.id) && (Number.isNaN(s.createdAtMs) || (l.createdAtMs >= s.createdAtMs - lead && l.createdAtMs <= s.createdAtMs + skew)),
    );
    if (!lease) continue;
    used.add(lease.id);
    out.set(s.id, lease.id);
  }
  return out;
}

// ============================================================================================ publications

/**
 * The publications' stored agents from `relay_publications` (WP14b's migration 0001, PLATFORM §2.4). Returns [] while
 * the table does not exist, so the audit runs unchanged before 0001 lands. Deleted publications are left out.
 */
export async function readPublishedAgents(db: Db): Promise<PublishedAgentRef[]> {
  const exists = await db.execute(sql`select to_regclass('public.relay_publications') is not null as ok`);
  if (!(exists.rows[0] as { ok?: boolean } | undefined)?.ok) return [];
  const res = await db.execute(
    sql`select id, aai_agent_id, active_run_id, active_until from relay_publications where aai_agent_id is not null and deleted_at is null and status <> 'deleted'`,
  );
  return (res.rows as { id: string; aai_agent_id: string; active_run_id: string | null; active_until: Date | string | null }[]).map((r) => ({
    publicationId: r.id,
    agentId: r.aai_agent_id,
    activeRunId: r.active_run_id ?? null,
    activeUntilMs: r.active_until === null || r.active_until === undefined ? null : new Date(r.active_until).getTime(),
  }));
}

// ============================================================================================ the audit

const CLOSED_ROW = new Set(["closed", "stale", "released"]);

export async function runVaAudit(ports?: Wp8Ports, opts: { deleteAnomalous?: boolean } = {}): Promise<VaAuditReportV21> {
  ensureWp8Wired();
  const p = ports ?? wp8();
  const t0 = p.now();
  const base: VaAuditReportV21 = {
    ok: true, scanned: 0, pages: 0, ours: 0, running: 0, anomalies: [], tripped: false, deleted: [], settled: 0, ms: 0,
    accountRunning: 0, matched: { registry: 0, takeover: 0, publication: 0, dev_lease: 0 }, devLeases: 0, inGrace: 0,
  };
  const flags = await p.flags();
  if (flags.mode !== "live") return { ...base, skipped: "not_live", ms: p.now() - t0 };
  const cfg = p.config();
  if (isIgnoredDeploy(cfg.deployId)) return { ...base, skipped: "not_production", ms: p.now() - t0 };

  const { sessions, pages } = await listSessionsSince(p.vaRest(), { sinceMs: t0 - AUDIT.WINDOW_MS, pageSize: AUDIT.PAGE_SIZE, maxPages: AUDIT.MAX_PAGES });
  const markers = new Map<string, string | null>();
  for (const s of sessions) markers.set(s.id, await markerFor(p, s));
  const isOurs = (s: SessionRecord): boolean => {
    const m = markers.get(s.id) ?? null;
    return m !== null && m === cfg.deployId && !isIgnoredDeploy(m);
  };
  const ours = sessions.filter(isOurs);

  // Registered rows, by provider session id (all markers), and the open dev leases not yet bound to a session.
  const ids = sessions.map((s) => s.id);
  const db = p.db();
  const rows = ids.length
    ? await db
        .select({ id: liveSessions.id, status: liveSessions.status, providerSessionId: liveSessions.providerSessionId, closedAt: liveSessions.closedAt, ledgerId: liveSessions.ledgerId })
        .from(liveSessions)
        .where(and(eq(liveSessions.kind, "va"), inArray(liveSessions.providerSessionId, ids)))
    : [];
  const tkos = ids.length ? await db.select({ sid: takeovers.vaSessionId }).from(takeovers).where(inArray(takeovers.vaSessionId, ids)) : [];
  const leaseRows = await db
    .select({ id: liveSessions.id, deployId: liveSessions.deployId, createdAt: liveSessions.createdAt })
    .from(liveSessions)
    .where(and(eq(liveSessions.kind, "va"), eq(liveSessions.status, "open"), isNull(liveSessions.providerSessionId)));
  const devLeases: LeaseSlot[] = leaseRows.filter((r) => isIgnoredDeploy(r.deployId)).map((r) => ({ id: r.id, createdAtMs: r.createdAt.getTime() }));
  let published: PublishedAgentRef[] = [];
  try {
    published = await (p.publishedAgents ? p.publishedAgents() : readPublishedAgents(db));
  } catch (err) {
    alog.warn("audit could not read the publications (treated as none)", { err });
  }

  const rowBySid = new Map(rows.map((r) => [r.providerSessionId!, r]));
  const knownByTakeover = new Set(tkos.map((t) => t.sid));
  const pubByAgent = new Map(published.map((x) => [x.agentId, x]));
  const activeRunSlots = new Map(published.filter((x) => x.activeRunId && (x.activeUntilMs ?? 0) > t0).map((x) => [x.agentId, 1]));

  const matchOf = new Map<string, VaAuditMatch>();
  // Oldest first, so an active run's single slot goes to the earlier session and a second one stands out.
  const byAge = [...sessions].sort((a, b) => (createdMs(a) || 0) - (createdMs(b) || 0));
  for (const s of byAge) {
    if (rowBySid.has(s.id)) matchOf.set(s.id, "registry");
    else if (knownByTakeover.has(s.id)) matchOf.set(s.id, "takeover");
    else if (s.agent_id && pubByAgent.has(s.agent_id)) {
      if (!isRunning(s)) matchOf.set(s.id, "publication");
      else if ((activeRunSlots.get(s.agent_id) ?? 0) > 0) {
        activeRunSlots.set(s.agent_id, 0);
        matchOf.set(s.id, "publication");
      }
    }
  }
  const unmatchedRunningOther = sessions.filter((s) => isRunning(s) && !matchOf.has(s.id) && !isOurs(s));
  const leaseMatch = matchDevLeases(unmatchedRunningOther.map((s) => ({ id: s.id, createdAtMs: createdMs(s) })), devLeases);
  for (const sid of leaseMatch.keys()) matchOf.set(sid, "dev_lease");

  const anomalies: VaAuditAnomalyV21[] = [];
  const ageOf = (s: SessionRecord): number => {
    const c = createdMs(s);
    return Number.isFinite(c) ? t0 - c : Infinity;
  };
  const closedAgo = (r: { closedAt: Date | null }): number => (r.closedAt ? t0 - r.closedAt.getTime() : Infinity);
  let inGrace = 0;
  for (const s of sessions) {
    const match = matchOf.get(s.id);
    const young = ageOf(s) < AUDIT.UNKNOWN_GRACE_MS;
    if (isOurs(s) && match === undefined) {
      if (young) inGrace++;
      else anomalies.push({ kind: "unknown_session", sessionId: s.id, detail: `status ${s.status ?? "?"}, this deploy's marker, not in live_sessions/takeovers/publications` });
      continue;
    }
    if (match === undefined && isRunning(s)) {
      if (young) inGrace++;
      else {
        const m = markers.get(s.id) ?? null;
        anomalies.push({
          kind: "unregistered_session",
          sessionId: s.id,
          detail: `running, marker ${m ?? "none"}${s.agent_id ? `, agent ${s.agent_id}` : ""}; no registry row, takeover, publication run or free dev lease`,
        });
      }
      continue;
    }
    const row = rowBySid.get(s.id);
    if (row && isRunning(s) && CLOSED_ROW.has(row.status) && closedAgo(row) >= AUDIT.CLOSED_GRACE_MS) {
      anomalies.push({ kind: "running_but_closed", sessionId: s.id, detail: `row ${row.id} is ${row.status}` });
    }
  }

  // Account-wide concurrency: every running session, except those whose row closed within the grace (ending).
  const counted = sessions.filter((s) => {
    if (!isRunning(s)) return false;
    const row = rowBySid.get(s.id);
    return !(row && CLOSED_ROW.has(row.status) && closedAgo(row) < AUDIT.CLOSED_GRACE_MS);
  });
  if (counted.length > cfg.vaMaxConcurrent) {
    anomalies.push({ kind: "over_concurrency", sessionId: counted.map((s) => s.id).join(","), detail: `${counted.length} running > ${cfg.vaMaxConcurrent}` });
  }

  let tripped = false;
  const deleted: string[] = [];
  if (anomalies.length) {
    alog.error("VA audit anomaly", { deployId: cfg.deployId, anomalies });
    if (p.tripReplayOnly) tripped = await p.tripReplayOnly("va_audit_anomaly");
    else alog.error("VA audit could not flip replay_only: no flag store wired");
    if (opts.deleteAnomalous ?? DELETE_ENDS_LIVE_SESSION) {
      for (const a of anomalies) {
        if (a.kind === "over_concurrency") continue;
        const s = sessions.find((x) => x.id === a.sessionId);
        if (!s || !isRunning(s)) continue;
        const status = await p.vaRest().deleteSession(s.id).catch(() => 0);
        if (status >= 200 && status < 300) deleted.push(s.id);
      }
    }
  }

  // Settle this deploy's ended sessions' VA reservations with the actual duration (once per session per process).
  let settled = 0;
  const ledger = p.ledger();
  if (ledger) {
    for (const s of ours) {
      const row = rowBySid.get(s.id);
      if (isRunning(s) || !row?.ledgerId || typeof s.duration_seconds !== "number" || cache().settled.has(s.id)) continue;
      try {
        await ledger.settle(row.ledgerId, s.duration_seconds * VERIFY_PRICES.VA_USD_PER_SEC);
        cache().settled.add(s.id);
        settled++;
      } catch (err) {
        alog.warn("audit settle failed", { sessionId: s.id, err });
      }
    }
  }

  const matched: Record<VaAuditMatch, number> = { registry: 0, takeover: 0, publication: 0, dev_lease: 0 };
  for (const s of sessions) {
    const m = matchOf.get(s.id);
    if (m && isRunning(s)) matched[m]++;
  }
  return {
    ok: anomalies.length === 0,
    scanned: sessions.length,
    pages,
    ours: ours.length,
    running: ours.filter(isRunning).length,
    anomalies,
    tripped,
    deleted,
    settled,
    ms: p.now() - t0,
    accountRunning: counted.length,
    matched,
    devLeases: devLeases.length,
    inGrace,
  };
}

/** The hook WP2's worker calls (`registerVaAuditHook(vaAuditHook)`). */
export const vaAuditHook = (): Promise<VaAuditReportV21> => runVaAudit();
