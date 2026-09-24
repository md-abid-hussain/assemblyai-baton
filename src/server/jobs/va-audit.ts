/**
 * server/jobs/va-audit.ts - F6 Voice Agent audit (DESIGN §4.5): WP2's in-process worker calls the hook every 3 min
 * while `mode=live` (cron `light` is the backstop).
 *
 * `GET /v1/sessions?limit=50`, following `has_more` / `next_cursor`, over the last 60 min. Production sessions are
 * recognised by CONTENT: every compiled system prompt ends with
 * `(internal ref: baton-deploy={BATON_DEPLOY_ID}; never mention this)`; the audit reads it from
 * `GET /v1/sessions/{id}.config.system_prompt` once per new id (cached per process). Sessions with another marker
 * (`dev-*`, `vercel-mirror`) or none are ignored. Anomalies:
 *  - `unknown_session`: a marker-bearing session unknown to `live_sessions` (by provider id) and `takeovers`;
 *  - `running_but_closed`: still running while its row is `closed`/`stale`/`released`;
 *  - `over_concurrency`: more running marker-bearing sessions than `VA_MAX_CONCURRENT`.
 * Any anomaly → `mode=replay_only`, reason `va_audit_anomaly`. It never deletes a running session: T-D1-0b showed
 * that `DELETE /v1/sessions/{id}` does not end a live one (see `DELETE_ENDS_LIVE_SESSION`).
 * A running session reads `status:"created"`, `ended_at:null`, `duration_seconds:null`, no artifacts (T-D1-0b).
 * The audit also settles the VA ledger entries of ended sessions with their actual duration.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import type { VaAuditAnomaly, VaAuditReport } from "../../core/contracts/ext/wp8-verify";
import { listSessionsSince, type SessionRecord } from "../aai/va-rest";
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

/** Deploys whose sessions the audit never counts (and which never audit): dev laptops and the Vercel mirror. */
export const isIgnoredDeploy = (id: string): boolean => id.startsWith("dev-") || id === "dev" || id.startsWith("vercel-") || id === "local";

const ENDED = new Set(["completed", "ended", "failed", "error", "closed", "terminated", "deleted"]);
/** Running = no `ended_at` and a non-terminal status. */
export const isRunning = (s: Pick<SessionRecord, "status" | "ended_at">): boolean => !s.ended_at && !ENDED.has(String(s.status ?? "").toLowerCase());

const systemPromptOf = (s: SessionRecord): unknown => (s.config && typeof s.config === "object" ? (s.config as Record<string, unknown>).system_prompt : undefined);

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
  if (prompt === undefined) prompt = systemPromptOf(await p.vaRest().getSession(s.id));
  const m = markerOf(prompt);
  c.set(s.id, m);
  if (c.size > 5000) c.delete(c.keys().next().value!);
  return m;
}

export async function runVaAudit(ports?: Wp8Ports, opts: { deleteAnomalous?: boolean } = {}): Promise<VaAuditReport> {
  ensureWp8Wired();
  const p = ports ?? wp8();
  const t0 = p.now();
  const base: VaAuditReport = { ok: true, scanned: 0, pages: 0, ours: 0, running: 0, anomalies: [], tripped: false, deleted: [], settled: 0, ms: 0 };
  const flags = await p.flags();
  if (flags.mode !== "live") return { ...base, skipped: "not_live", ms: p.now() - t0 };
  const cfg = p.config();
  if (isIgnoredDeploy(cfg.deployId)) return { ...base, skipped: "not_production", ms: p.now() - t0 };

  const { sessions, pages } = await listSessionsSince(p.vaRest(), { sinceMs: t0 - AUDIT.WINDOW_MS, pageSize: AUDIT.PAGE_SIZE, maxPages: AUDIT.MAX_PAGES });
  const ours: SessionRecord[] = [];
  for (const s of sessions) {
    const m = await markerFor(p, s);
    if (m !== null && m === cfg.deployId && !isIgnoredDeploy(m)) ours.push(s);
  }

  const ids = ours.map((s) => s.id);
  const db = p.db();
  const rows = ids.length
    ? await db
        .select({ id: liveSessions.id, status: liveSessions.status, providerSessionId: liveSessions.providerSessionId, closedAt: liveSessions.closedAt, ledgerId: liveSessions.ledgerId })
        .from(liveSessions)
        .where(and(eq(liveSessions.kind, "va"), inArray(liveSessions.providerSessionId, ids)))
    : [];
  const tkos = ids.length ? await db.select({ sid: takeovers.vaSessionId }).from(takeovers).where(inArray(takeovers.vaSessionId, ids)) : [];
  const rowBySid = new Map(rows.map((r) => [r.providerSessionId!, r]));
  const knownByTakeover = new Set(tkos.map((t) => t.sid));

  const anomalies: VaAuditAnomaly[] = [];
  const running = ours.filter(isRunning);
  for (const s of ours) {
    const row = rowBySid.get(s.id);
    const created = s.created_at ? Date.parse(s.created_at) : NaN;
    const age = Number.isFinite(created) ? t0 - created : Infinity;
    if (!row && !knownByTakeover.has(s.id)) {
      if (age >= AUDIT.UNKNOWN_GRACE_MS) anomalies.push({ kind: "unknown_session", sessionId: s.id, detail: `status ${s.status ?? "?"}, not in live_sessions` });
      continue;
    }
    if (row && isRunning(s) && (row.status === "closed" || row.status === "stale" || row.status === "released")) {
      const closedAgo = row.closedAt ? t0 - row.closedAt.getTime() : Infinity;
      if (closedAgo >= AUDIT.CLOSED_GRACE_MS) anomalies.push({ kind: "running_but_closed", sessionId: s.id, detail: `row ${row.id} is ${row.status}` });
    }
  }
  if (running.length > cfg.vaMaxConcurrent) {
    anomalies.push({ kind: "over_concurrency", sessionId: running.map((s) => s.id).join(","), detail: `${running.length} running > ${cfg.vaMaxConcurrent}` });
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
        const s = ours.find((x) => x.id === a.sessionId);
        if (!s || !isRunning(s)) continue;
        const status = await p.vaRest().deleteSession(s.id).catch(() => 0);
        if (status >= 200 && status < 300) deleted.push(s.id);
      }
    }
  }

  // Settle ended sessions' VA reservations with the actual duration (once per session per process).
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

  return { ok: anomalies.length === 0, scanned: sessions.length, pages, ours: ours.length, running: running.length, anomalies, tripped, deleted, settled, ms: p.now() - t0 };
}

/** The hook WP2's worker calls (`registerVaAuditHook(vaAuditHook)`). */
export const vaAuditHook = (): Promise<VaAuditReport> => runVaAudit();
