import "server-only";

/**
 * The database `UsageMeter` (SAAS §4.5, §14). WP19·3.
 *
 * `record()` is idempotent on `idempotency_key` — `live_run:<takeoverId>`, `ai_minutes:<takeoverId>` — so a
 * retried job, a replayed webhook or a double-clicked button bills once. That is enforced by the unique index in
 * `0002`, not by a read-then-write, so it holds under concurrency.
 *
 * `summary()` keeps Recorded / Simulated / Published minutes **separate** (P§9, §4.5): only recorded and
 * published minutes draw on the monthly allowance, simulated minutes are free, and a replay is recorded at
 * quantity 0 so runs stay countable and are never billed. The in-memory default in `ports.ts` computes exactly
 * the same numbers; this one computes them in Postgres, and `tests/unit/server/saas` asserts the two agree.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { UsageKind, UsageRecord, UsageSummary } from "../../core/contracts/v3/usage";
import { PLANS } from "../../core/contracts/v3/plans";
import type { UsageMeter } from "../../core/contracts/v3/services";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { usageEvents } from "../db/schema-saas";
import { saasId } from "../identity/ids";
import { resolvePlan } from "./ports";

/** The id prefix of a usage row (SAAS §2.7). */
export const USAGE_ID_PREFIX = "use_";

type Runner = Pick<Db, "insert">;

/** Minutes are minutes; everything else is a count. One place decides, so the column can never disagree. */
export const unitFor = (kind: UsageKind): "minutes" | "count" => (kind === "ai_minutes" ? "minutes" : "count");

const monthStart = (at: Date): string => `${at.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

export interface DbUsageMeterOptions {
  db?: Db;
  now?: () => number;
}

export function createDbUsageMeter(opts: DbUsageMeterOptions = {}): UsageMeter {
  const now = opts.now ?? Date.now;
  const dbOf = () => opts.db ?? getDb();

  return {
    async record(u: UsageRecord, tx?: unknown): Promise<void> {
      const run: Runner = tx && typeof tx === "object" ? (tx as Runner) : dbOf();
      await run
        .insert(usageEvents)
        .values({
          id: saasId(USAGE_ID_PREFIX),
          orgId: u.orgId,
          kind: u.kind,
          quantity: u.quantity,
          unit: unitFor(u.kind),
          caseId: u.caseId ?? null,
          relayId: u.relayId ?? null,
          source: u.source ?? null,
          idempotencyKey: u.idempotencyKey,
          occurredAt: u.occurredAt ? new Date(u.occurredAt) : new Date(now()),
        })
        // The second write of the same key is a no-op, not a conflict the caller has to handle.
        .onConflictDoNothing({ target: usageEvents.idempotencyKey });
    },

    async summary(orgId: string, period?: { from: string; to: string }): Promise<UsageSummary> {
      const db = dbOf();
      const at = new Date(now());
      const from = period?.from ?? monthStart(at);
      const to = period?.to ?? at.toISOString();
      const inPeriod = and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.occurredAt, new Date(from)),
        lte(usageEvents.occurredAt, new Date(to)),
      );

      // One grouped read for the period, one for today. Two round trips, no N+1, and both hit
      // `usage_events_org_time_idx`.
      const [periodRows, todayRows, plan] = await Promise.all([
        db
          .select({
            day: sql<string>`to_char(${usageEvents.occurredAt} at time zone 'utc', 'YYYY-MM-DD')`,
            kind: usageEvents.kind,
            source: usageEvents.source,
            total: sql<string>`sum(${usageEvents.quantity})`,
          })
          .from(usageEvents)
          .where(inPeriod)
          .groupBy(
            sql`to_char(${usageEvents.occurredAt} at time zone 'utc', 'YYYY-MM-DD')`,
            usageEvents.kind,
            usageEvents.source,
          ),
        db
          .select({ kind: usageEvents.kind, total: sql<string>`sum(${usageEvents.quantity})` })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.orgId, orgId),
              sql`to_char(${usageEvents.occurredAt} at time zone 'utc', 'YYYY-MM-DD') = ${dayOf(at)}`,
            ),
          )
          .groupBy(usageEvents.kind),
        resolvePlan(orgId),
      ]);

      const minutes = { recorded: 0, simulated: 0, published: 0 };
      const daily = new Map<string, { aiMinutes: number; runs: number }>();
      for (const r of periodRows) {
        const total = Number(r.total ?? 0);
        if (r.kind === "ai_minutes") {
          // `text_dry_run` and `replay` minutes are neither billable nor shown as simulated: §4.5 splits the view
          // three ways and a replay is recorded at quantity 0 anyway.
          const source = (r.source ?? "recorded") as keyof typeof minutes;
          if (source in minutes) minutes[source] += total;
        }
        const row = daily.get(r.day) ?? { aiMinutes: 0, runs: 0 };
        if (r.kind === "ai_minutes") row.aiMinutes += total;
        if (r.kind === "live_run") row.runs += total;
        daily.set(r.day, row);
      }

      const today = { liveRuns: 0, dryRuns: 0, voicedSims: 0, drafts: 0 };
      const todayKey: Partial<Record<UsageKind, keyof typeof today>> = {
        live_run: "liveRuns",
        dry_run: "dryRuns",
        voiced_sim: "voicedSims",
        draft: "drafts",
      };
      for (const r of todayRows) {
        const key = todayKey[r.kind];
        if (key) today[key] += Number(r.total ?? 0);
      }

      const limits = PLANS[plan].limits;
      const billable = minutes.recorded + minutes.published;
      const over = Math.max(0, billable - limits.aiMinutesPerMonth);
      return {
        orgId,
        period: { from, to },
        plan,
        aiMinutes: {
          ...minutes,
          allowance: limits.aiMinutesPerMonth,
          overageUsdEstimate: limits.overageUsdPerMin === null ? 0 : over * limits.overageUsdPerMin,
        },
        today,
        daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
      } satisfies UsageSummary;
    },
  };
}
