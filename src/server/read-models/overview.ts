import "server-only";

/**
 * The `/app` overview read model (SAAS §8.3). WP20·1.
 *
 * Three things the overview needs and nobody else assembles: the **checklist**, the **AI-minutes meter** and the
 * counts behind the empty states.
 *
 * **The checklist is derived from data, not stored** (SAAS §8.3: "no new table"). That is a constraint worth
 * stating, because it decides what an item may claim. Each item maps to a signal this module can actually
 * observe; an item whose owning WP has not shipped its signal yet reads as *not done*, never as done-by-default
 * and never as an error. A checklist that ticks itself optimistically would be the one dishonest surface on the
 * page that the judge path runs through end to end (§13.1).
 *
 * Signal → item, and who supplies it:
 *
 * | Item | Signal | Source |
 * |---|---|---|
 * | Watch a handoff | the org has ≥ 1 run | WP20's `RunsReadModel.count` |
 * | Try an edit | an owned relay has `draft_rev > 0` | WP14b's `relays` |
 * | Open the relay as code | an owned relay has a stored `draft_source` | WP14b's `RelaySourceStore` (port) |
 * | Publish a relay | an owned relay has a live publication | WP18's `relay_publications` |
 * | Create your account | the viewer is not a guest | the principal |
 * | Upgrade | `plan` is neither `guest` nor `free` | WP21's entitlements, through the principal |
 * | Create an API key | — (WP22) | not observable yet → not done |
 * | Receive a webhook | — (WP24) | not observable yet → not done |
 *
 * Every query here is a SELECT, and every one is scoped by `orgId`.
 */
import { sql } from "drizzle-orm";

import type {
  ChecklistId, ChecklistItemView, MinutesMeterView, OverviewData, RelayCardView, RunListItem,
} from "../../core/contracts/ext/wp20-app";
import type { PlanId } from "../../core/contracts/v3/identity";
import { PLANS } from "../../core/contracts/v3/plans";
import { getDb, type Db } from "../db";
import { log } from "../log";
import { RelaysReadModel } from "./relays";
import { RunsReadModel } from "./runs";

/** How many runs the overview lists (SAAS §8.3: "the 5 most recent runs"). */
export const RECENT_RUNS = 5;

/** Everything the checklist is derived from. Each field is one observation, never a conclusion. */
export interface ChecklistSignals {
  runs: number;
  relayEdited: boolean;
  sourceStored: boolean;
  published: boolean;
  isGuest: boolean;
  plan: PlanId;
}

interface ItemSpec {
  id: ChecklistId;
  label: string;
  href: (ctx: { featuredCallId: string | null; relayId: string | null }) => string;
  done: (s: ChecklistSignals) => boolean;
  /** Non-null → the item cannot be done yet and the card says why instead of pretending it is clickable. */
  blocked?: (s: ChecklistSignals) => string | null;
}

const needsAccount = (s: ChecklistSignals): string | null =>
  s.isGuest ? "Create a free account first — 10 s, no card." : null;

const ITEMS: readonly ItemSpec[] = [
  {
    id: "watch_handoff",
    label: "Watch a handoff",
    href: (c) => (c.featuredCallId ? `/call/${encodeURIComponent(c.featuredCallId)}?express=1` : "/call"),
    done: (s) => s.runs > 0,
  },
  {
    id: "try_edit",
    label: "Try an edit",
    href: (c) => (c.relayId ? `/app/relays/${encodeURIComponent(c.relayId)}/configure` : "/app/relays"),
    done: (s) => s.relayEdited,
  },
  {
    id: "open_code",
    label: "Open the relay as code",
    href: (c) => (c.relayId ? `/app/relays/${encodeURIComponent(c.relayId)}/code` : "/app/relays"),
    done: (s) => s.sourceStored,
  },
  {
    id: "publish",
    label: "Publish a relay",
    href: (c) => (c.relayId ? `/app/relays/${encodeURIComponent(c.relayId)}/publish` : "/app/relays"),
    done: (s) => s.published,
  },
  {
    id: "create_account",
    label: "Create your account",
    href: () => "/sign-up?next=%2Fapp",
    done: (s) => !s.isGuest,
  },
  {
    id: "upgrade",
    label: "Upgrade (sandbox, card 4242)",
    href: () => "/app/settings/billing",
    done: (s) => s.plan !== "guest" && s.plan !== "free",
  },
  {
    id: "api_key",
    label: "Create an API key",
    href: () => "/app/settings/api-keys",
    done: () => false,
    blocked: needsAccount,
  },
  {
    id: "webhook",
    label: "Receive a webhook",
    href: () => "/app/settings/webhooks",
    done: () => false,
    blocked: needsAccount,
  },
];

export function checklistFrom(
  signals: ChecklistSignals,
  ctx: { featuredCallId: string | null; relayId: string | null },
): ChecklistItemView[] {
  return ITEMS.map((i) => ({
    id: i.id,
    label: i.label,
    href: i.href(ctx),
    done: i.done(signals),
    blockedReason: i.done(signals) ? null : (i.blocked?.(signals) ?? null),
  }));
}

/** The meter the overview shows. `basis: "runs"` says out loud that these are derived, not billed, minutes. */
export function meterFrom(
  plan: PlanId,
  byProvenance: { recorded: number; simulated: number; published: number },
  period: string,
): MinutesMeterView {
  const used = byProvenance.recorded + byProvenance.simulated + byProvenance.published;
  return {
    plan,
    usedMinutes: Math.round(used * 100) / 100,
    allowanceMinutes: PLANS[plan].limits.aiMinutesPerMonth,
    byProvenance,
    period,
    basis: "runs",
  };
}

/** Log what failed, then fall back. The page still renders; the failure is not invisible. */
const degrade =
  <T,>(part: string, fallback: T) =>
  (err: unknown): T => {
    log.warn("overview_degraded", { part, err: err instanceof Error ? err.message : String(err) });
    return fallback;
  };

export class OverviewReadModel {
  private readonly runs: RunsReadModel;
  private readonly relays: RelaysReadModel;

  constructor(
    private readonly db: Db = getDb(),
    deps?: { runs?: RunsReadModel; relays?: RelaysReadModel },
  ) {
    this.runs = deps?.runs ?? new RunsReadModel(db);
    this.relays = deps?.relays ?? new RelaysReadModel(db);
  }

  /**
   * One round of queries for the whole page. Every part degrades on its own: a failing relay registry costs the
   * page its relay cards, not its runs.
   *
   * Every degradation is **logged**. A silent `.catch(() => [])` is how a real bug becomes an empty state that
   * looks like a new workspace — which is exactly what happened to the runs list during WP20·1's browser pass,
   * and it cost an hour before the detail page (which had no catch) showed the actual stack.
   */
  async load(input: {
    orgId: string;
    plan: PlanId;
    isGuest: boolean;
    featuredCallId: string | null;
  }): Promise<OverviewData> {
    const { orgId, plan, isGuest, featuredCallId } = input;
    const [page, totalRuns, minutes, relays, relaySignals] = await Promise.all([
      this.runs.list(orgId, { limit: RECENT_RUNS }).catch(degrade("recent_runs", { items: [] as RunListItem[], nextCursor: null })),
      this.runs.count(orgId).catch(degrade("run_count", 0)),
      this.runs
        .aiMinutesThisMonth(orgId)
        .catch(degrade("ai_minutes", { recorded: 0, simulated: 0, published: 0, period: new Date().toISOString().slice(0, 7) })),
      this.relays.listForOrg(orgId).catch(degrade("relays", [] as RelayCardView[])),
      this.relaySignals(orgId).catch(degrade("relay_signals", { relayEdited: false, sourceStored: false, published: false })),
    ]);

    const owned = relays.find((r) => !r.pinned) ?? relays[0] ?? null;
    const signals: ChecklistSignals = { runs: totalRuns, isGuest, plan, ...relaySignals };
    const { period, ...byProvenance } = minutes;

    return {
      checklist: checklistFrom(signals, { featuredCallId, relayId: owned?.id ?? null }),
      meter: meterFrom(plan, byProvenance, period),
      recentRuns: page.items,
      relays,
      totalRuns,
    };
  }

  /**
   * The three relay-shaped checklist signals in one query.
   *
   * `draft_source` is WP14b's column (SAAS §5.3); it does not exist before `0001_relays`'s follow-up, so the
   * probe is a `to_regclass`-style column check rather than a hard reference — a missing column means "not done",
   * which is the honest answer and not a 500 on the overview.
   */
  async relaySignals(orgId: string): Promise<{ relayEdited: boolean; sourceStored: boolean; published: boolean }> {
    const hasSource = await this.hasDraftSource();
    const sourceExpr = hasSource ? sql`bool_or(r.draft_source is not null)` : sql`false`;
    const res = await this.db.execute(sql`
      select
        coalesce(bool_or(r.draft_rev > 0), false) as relay_edited,
        coalesce(${sourceExpr}, false) as source_stored,
        coalesce(bool_or(p.id is not null), false) as published
      from relays r
      left join relay_publications p
        on p.relay_id = r.id and p.status = 'live' and p.deleted_at is null
      where r.workspace_id = ${orgId} and r.deleted_at is null`);
    const row = res.rows[0] as
      | { relay_edited?: boolean; source_stored?: boolean; published?: boolean }
      | undefined;
    return {
      relayEdited: row?.relay_edited === true,
      sourceStored: row?.source_stored === true,
      published: row?.published === true,
    };
  }

  private async hasDraftSource(): Promise<boolean> {
    return this.db
      .execute(
        sql`select count(*)::int as n from information_schema.columns
            where table_schema = current_schema() and table_name = 'relays' and column_name = 'draft_source'`,
      )
      .then((r) => Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0) > 0)
      .catch(() => false);
  }
}

export const overviewReadModel = (db?: Db): OverviewReadModel => new OverviewReadModel(db ?? getDb());
