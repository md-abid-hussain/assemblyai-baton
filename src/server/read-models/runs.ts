import "server-only";

/**
 * `RunsReadModel` (SAAS §6.2). WP20·1.
 *
 * `list(orgId, filter)` / `get(orgId, id)` join `cases` → `takeovers` → `verifications` → `payments` under one
 * tenant predicate (`tenant.ts`). The `/app/runs` pages (WP20) and `/api/v1/runs|cases` (WP22) both call this —
 * there is no second query for the same data, so a tenancy fix lands in one place.
 *
 * Read-only by construction: this module only ever SELECTs.
 *
 * **Why raw SQL.** Each row needs the case's newest takeover and newest payment, which is a LATERAL join; doing
 * it with a plain `leftJoin` would multiply rows per case and quietly inflate every count. The tenant predicate
 * and every filter value are bound parameters (drizzle's `sql` template), never string-concatenated.
 */
import { sql, type SQL } from "drizzle-orm";

import { CaseStateSchema, type CaseState } from "../../core/contracts/case";
import { QaResultSchema, type QaResult } from "../../core/contracts/events";
import {
  RUN_SOURCES, secondsToMinutes, type AnalyticsView, type OutcomeCount, type RunFilter, type RunListItem,
  type RunOutcome, type RunPage, type RunSource, type SourceCount,
} from "../../core/contracts/ext/wp20-app";
import { getDb, type Db } from "../db";
import { casesOrgFilter } from "./tenant";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * The run's source, in SQL so the list, the filter and the analytics grouping can never disagree (PLATFORM §7.6).
 *
 * `published` depends on the takeover recording which publication served it. `relay_publications.active_run_id`
 * is released when the run ends, so it cannot be used after the fact; the durable signal is
 * `takeovers.metrics.publicationId`, which WP18 sets when it claims the slot (see
 * `docs/notes/requests/wp20-to-wp18.md`). Until then no run reports `published`, and the other three are exact.
 */
const SOURCE_SQL = sql`case
  when sc.kind = 'text_dry_run' then 'text_dry_run'
  when jsonb_exists(coalesce(t.metrics, '{}'::jsonb), 'publicationId') then 'published'
  when c.sim_call_id is not null then 'simulated'
  else 'recorded' end`;

/** `takeovers.outcome` while it is set, else the case's own status mapped onto the same five words. */
const OUTCOME_SQL = sql`case
  when t.outcome is not null then t.outcome
  when c.status in ('completed', 'handed_back', 'abandoned', 'failed') then c.status
  else 'in_progress' end`;

const FROM_SQL = sql`
  from cases c
  left join lateral (
    select tk.* from takeovers tk where tk.case_id = c.id order by tk.armed_at desc limit 1
  ) t on true
  left join verifications ver on ver.takeover_id = t.id
  left join lateral (
    select py.* from payments py where py.case_id = c.id order by py.created_at desc limit 1
  ) pay on true
  left join sim_calls sc on sc.id = c.sim_call_id
  left join relay_versions rv on rv.id = c.relay_version_id
  left join relays rel on rel.id = rv.relay_id`;

// ---------------------------------------------------------------------------------------------------- cursors

/**
 * `timestamptz` as it actually arrives.
 *
 * `db.execute` with a raw `sql` template returns the driver's own values, and node-postgres hands back a
 * **string** (`2026-09-26 11:36:11.652+00`) for `timestamptz` — only drizzle's typed query builder maps it to a
 * `Date`. Assuming a `Date` here threw `toISOString is not a function` on every populated page, so every
 * timestamp in this file goes through `toIso`.
 */
export type Timestamp = Date | string | number;

export function toIso(v: Timestamp | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Opaque `(created_at, id)` cursor, base64url (SAAS §6.3). Undecodable input is ignored, never an error. */
export function encodeCursor(createdAt: Timestamp, id: string): string {
  return Buffer.from(`${toIso(createdAt) ?? new Date(0).toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const at = raw.indexOf("|");
    if (at <= 0) return null;
    const createdAt = raw.slice(0, at);
    const id = raw.slice(at + 1);
    if (!id || Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ row mapping

interface RunRow {
  id: string;
  mode: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  sim_call_id: string | null;
  takeover_id: string | null;
  armed_at: Timestamp | null;
  ended_at: Timestamp | null;
  metrics: unknown;
  verification_status: string | null;
  qa: unknown;
  payment_status: string | null;
  relay_id: string | null;
  relay_title: string | null;
  relay_version: number | null;
  source: string;
  outcome: string;
  readiness: unknown;
  duration_ms: string | number | null;
}

const asSource = (s: string): RunSource =>
  (RUN_SOURCES as readonly string[]).includes(s) ? (s as RunSource) : "recorded";

const OUTCOMES: readonly RunOutcome[] = ["completed", "handed_back", "abandoned", "failed", "in_progress"];
const asOutcome = (s: string): RunOutcome => (OUTCOMES as readonly string[]).includes(s) ? (s as RunOutcome) : "in_progress";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The final QA result, or the provisional one the takeover carries while verification is still running. */
export function qaOf(row: { qa: unknown; metrics: unknown }): { qa: QaResult | null; provisional: boolean } {
  const verified = QaResultSchema.safeParse(row.qa);
  if (verified.success) return { qa: verified.data, provisional: verified.data.provisional };
  const m = row.metrics as { provisionalQa?: unknown } | null | undefined;
  const prov = QaResultSchema.safeParse(m?.provisionalQa);
  return prov.success ? { qa: prov.data, provisional: true } : { qa: null, provisional: false };
}

function readinessOf(v: unknown): { verified: number; requiredTotal: number } | null {
  const r = v as { verified?: unknown; requiredTotal?: unknown } | null | undefined;
  const verified = num(r?.verified);
  const requiredTotal = num(r?.requiredTotal);
  return verified === null || requiredTotal === null ? null : { verified, requiredTotal };
}

function toListItem(r: RunRow): RunListItem {
  const { qa, provisional } = qaOf(r);
  return {
    id: r.id,
    relayId: r.relay_id,
    // A legacy Baton run has no relay version: it is the flagship on the v2 path (PLATFORM §2.4).
    relayTitle: r.relay_title ?? "Baton · insurance add-a-driver",
    relayVersion: r.relay_version ?? null,
    source: asSource(r.source),
    outcome: asOutcome(r.outcome),
    status: r.status,
    startedAt: toIso(r.created_at) ?? new Date(0).toISOString(),
    endedAt: toIso(r.ended_at),
    durationMs: num(r.duration_ms),
    aiSeconds: qa ? qa.aiSeconds : null,
    readiness: readinessOf(r.readiness),
    qaProvisional: provisional || r.verification_status !== "completed",
    paymentStatus: r.payment_status,
    simulated: r.sim_call_id !== null,
  };
}

// ---------------------------------------------------------------------------------------------------- filters

function filterSql(f: RunFilter): SQL[] {
  const out: SQL[] = [];
  if (f.relayId) out.push(sql`rv.relay_id = ${f.relayId}`);
  if (f.source) out.push(sql`(${SOURCE_SQL}) = ${f.source}`);
  if (f.since) out.push(sql`c.created_at >= ${`${f.since}T00:00:00.000Z`}::timestamptz`);
  // Inclusive day: everything strictly before the next midnight UTC.
  if (f.until) out.push(sql`c.created_at < (${`${f.until}T00:00:00.000Z`}::timestamptz + interval '1 day')`);
  return out;
}

const clampLimit = (n: number | undefined): number =>
  Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(n) ? Math.floor(n as number) : DEFAULT_LIMIT));

// -------------------------------------------------------------------------------------------------- the model

export class RunsReadModel {
  constructor(private readonly db: Db = getDb()) {}

  /** `/app/runs` and `GET /api/v1/runs`. Newest first, keyset-paginated. */
  async list(orgId: string, filter: RunFilter = {}): Promise<RunPage> {
    const limit = clampLimit(filter.limit);
    const where: SQL[] = [await casesOrgFilter(this.db, orgId), ...filterSql(filter)];
    const cur = decodeCursor(filter.cursor);
    if (cur) where.push(sql`(c.created_at, c.id) < (${cur.createdAt}::timestamptz, ${cur.id})`);

    const rows = await this.select(where, sql`order by c.created_at desc, c.id desc limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** One run, or null when it belongs to another org — a foreign id is a 404, never a 403 (SAAS §10.1 rule 2). */
  async get(orgId: string, id: string): Promise<RunListItem | null> {
    const rows = await this.select([await casesOrgFilter(this.db, orgId), sql`c.id = ${id}`], sql`limit 1`);
    return rows[0] ? toListItem(rows[0]) : null;
  }

  /** The row plus the JSONB the detail page needs; `null` when the run is not this org's. */
  async getDetailRow(orgId: string, id: string): Promise<{
    item: RunListItem;
    state: CaseState | null;
    qa: QaResult | null;
    provisional: boolean;
    verificationStatus: string | null;
    takeoverId: string | null;
    mode: string;
    simulated: boolean;
    /** `takeovers.metrics`, for the provenance strip WP7 persists there (`detail.ts`). */
    metrics: unknown;
    /** The recorded call this run played, when there was one: the console replay link. */
    callId: string | null;
  } | null> {
    const where = [await casesOrgFilter(this.db, orgId), sql`c.id = ${id}`];
    const res = await this.db.execute(sql`
      select c.id, c.mode, c.status, c.created_at, c.updated_at, c.sim_call_id, c.state, c.call_id,
             t.id as takeover_id, t.armed_at, t.ended_at, t.metrics,
             ver.status as verification_status, ver.qa,
             pay.status as payment_status,
             rv.version as relay_version, rv.relay_id as relay_id, rel.title as relay_title,
             (${SOURCE_SQL}) as source, (${OUTCOME_SQL}) as outcome,
             c.state -> 'readiness' as readiness,
             extract(epoch from (coalesce(t.ended_at, c.updated_at) - c.created_at)) * 1000 as duration_ms
      ${FROM_SQL} where ${sql.join(where, sql` and `)} limit 1`);
    const raw = res.rows[0] as (RunRow & { state: unknown; call_id: string | null }) | undefined;
    if (!raw) return null;
    const { qa, provisional } = qaOf(raw);
    const state = CaseStateSchema.safeParse(raw.state);
    return {
      item: toListItem(raw),
      state: state.success ? state.data : null,
      qa,
      provisional,
      verificationStatus: raw.verification_status,
      takeoverId: raw.takeover_id,
      mode: raw.mode,
      simulated: raw.sim_call_id !== null,
      metrics: raw.metrics,
      callId: raw.call_id,
    };
  }

  /** The relays this org has actually run, for the `/app/runs` relay filter. */
  async relayOptions(orgId: string): Promise<{ id: string; title: string }[]> {
    const res = await this.db.execute(sql`
      select distinct rv.relay_id as id, coalesce(rel.title, rv.relay_id) as title
      ${FROM_SQL} where ${await casesOrgFilter(this.db, orgId)} and rv.relay_id is not null
      order by 2 asc limit 100`);
    return res.rows.map((r) => ({ id: String((r as { id: unknown }).id), title: String((r as { title: unknown }).title) }));
  }

  /**
   * `/app/analytics`. Counts and AI minutes **per source**, never summed across sources: a recorded run and a
   * simulated run are not the same evidence, and blending them would be the one dishonest number on the page
   * (SAAS §8.5, PLATFORM §7.6).
   */
  async analytics(orgId: string, windowDays: number): Promise<AnalyticsView> {
    const tenant = await casesOrgFilter(this.db, orgId);
    const window = sql`c.created_at >= now() - make_interval(days => ${Math.max(1, Math.floor(windowDays))}::int)`;
    const res = await this.db.execute(sql`
      select (${SOURCE_SQL}) as source, (${OUTCOME_SQL}) as outcome, count(*)::int as runs,
             coalesce(sum(coalesce(
               (ver.qa ->> 'aiSeconds')::double precision,
               (t.metrics -> 'provisionalQa' ->> 'aiSeconds')::double precision, 0)), 0) as ai_seconds,
             min(c.created_at) as first_at, max(c.created_at) as last_at
      ${FROM_SQL} where ${tenant} and ${window} group by 1, 2`);

    const bySource = new Map<RunSource, SourceCount>();
    const byOutcome = new Map<RunOutcome, OutcomeCount>();
    let totalRuns = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const row of res.rows as unknown as {
      source: string; outcome: string; runs: number; ai_seconds: string | number; first_at: Timestamp; last_at: Timestamp;
    }[]) {
      const source = asSource(row.source);
      const outcome = asOutcome(row.outcome);
      const runs = Number(row.runs) || 0;
      totalRuns += runs;
      const s = bySource.get(source) ?? { source, runs: 0, aiMinutes: 0 };
      s.runs += runs;
      s.aiMinutes += secondsToMinutes(num(row.ai_seconds) ?? 0);
      bySource.set(source, s);
      const o = byOutcome.get(outcome) ?? { outcome, runs: 0 };
      o.runs += runs;
      byOutcome.set(outcome, o);
      const f = toIso(row.first_at);
      const l = toIso(row.last_at);
      if (f !== null) { const t = Date.parse(f); if (firstAt === null || t < firstAt) firstAt = t; }
      if (l !== null) { const t = Date.parse(l); if (lastAt === null || t > lastAt) lastAt = t; }
    }
    for (const s of bySource.values()) s.aiMinutes = Math.round(s.aiMinutes * 100) / 100;

    return {
      totalRuns,
      bySource: RUN_SOURCES.map((s) => bySource.get(s)).filter((x): x is SourceCount => x !== undefined),
      byOutcome: OUTCOMES.map((o) => byOutcome.get(o)).filter((x): x is OutcomeCount => x !== undefined),
      firstRunAt: firstAt === null ? null : new Date(firstAt).toISOString(),
      lastRunAt: lastAt === null ? null : new Date(lastAt).toISOString(),
      windowDays,
    };
  }

  /**
   * AI minutes this calendar month, split the way SAAS §4.5 splits them. Derived from the org's own runs, which
   * is what the overview meter shows until WP21's metered usage replaces it (`MinutesMeterView.basis`).
   */
  async aiMinutesThisMonth(orgId: string): Promise<{ recorded: number; simulated: number; published: number; period: string }> {
    const tenant = await casesOrgFilter(this.db, orgId);
    const res = await this.db.execute(sql`
      select (${SOURCE_SQL}) as source,
             coalesce(sum(coalesce(
               (ver.qa ->> 'aiSeconds')::double precision,
               (t.metrics -> 'provisionalQa' ->> 'aiSeconds')::double precision, 0)), 0) as ai_seconds
      ${FROM_SQL} where ${tenant} and c.created_at >= date_trunc('month', now()) group by 1`);
    const out = { recorded: 0, simulated: 0, published: 0, period: new Date().toISOString().slice(0, 7) };
    for (const row of res.rows as unknown as { source: string; ai_seconds: string | number }[]) {
      const minutes = secondsToMinutes(num(row.ai_seconds) ?? 0);
      const source = asSource(row.source);
      // A text dry run costs no AI minutes (SAAS §4.5), so it has no bucket here.
      if (source === "recorded" || source === "simulated" || source === "published") out[source] += minutes;
    }
    out.recorded = Math.round(out.recorded * 100) / 100;
    out.simulated = Math.round(out.simulated * 100) / 100;
    out.published = Math.round(out.published * 100) / 100;
    return out;
  }

  /** Total runs in the org, for the empty state and the checklist. */
  async count(orgId: string): Promise<number> {
    const res = await this.db.execute(sql`
      select count(*)::int as n ${FROM_SQL} where ${await casesOrgFilter(this.db, orgId)}`);
    return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0);
  }

  private async select(where: SQL[], tail: SQL): Promise<RunRow[]> {
    const res = await this.db.execute(sql`
      select c.id, c.mode, c.status, c.created_at, c.updated_at, c.sim_call_id,
             t.id as takeover_id, t.armed_at, t.ended_at, t.metrics,
             ver.status as verification_status, ver.qa,
             pay.status as payment_status,
             rv.version as relay_version, rv.relay_id as relay_id, rel.title as relay_title,
             (${SOURCE_SQL}) as source, (${OUTCOME_SQL}) as outcome,
             c.state -> 'readiness' as readiness,
             extract(epoch from (coalesce(t.ended_at, c.updated_at) - c.created_at)) * 1000 as duration_ms
      ${FROM_SQL} where ${sql.join(where, sql` and `)} ${tail}`);
    return res.rows as unknown as RunRow[];
  }
}

/** One instance per process is plenty: the model holds no state beyond the db handle. */
export const runsReadModel = (db?: Db): RunsReadModel => new RunsReadModel(db ?? getDb());
