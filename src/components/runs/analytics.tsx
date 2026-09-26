/**
 * `/app/analytics` (SAAS §8.1, §8.5). WP20·1.
 *
 * **There is no total.** Counts are shown per source and per outcome, and the two tables are never multiplied
 * into a single "success rate". A recorded role-play and a synthetic simulation are different kinds of
 * evidence; a blended percentage would be the one number on the page that means nothing, and it is exactly the
 * number a dashboard wants to invent. The "never blended" note says this out loud rather than leaving the
 * absence to be noticed.
 *
 * The bars are proportional to the largest row, drawn in CSS. No chart library, because four rows of a bar
 * chart do not need one and a recharts canvas would be the heaviest thing on the page.
 */
import {
  OUTCOME_LABEL, SOURCE_HINT, SOURCE_LABEL, formatMinutes, formatUtcDate, type AnalyticsView,
} from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

import { Note } from "../app-shell/bits";
import { OutcomeBadge, SourceBadge } from "./badges";

function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="bg-muted block h-1.5 w-full overflow-hidden rounded-full" aria-hidden="true">
      <span className={cn("block h-full rounded-full", className)} style={{ width: `${pct}%` }} />
    </span>
  );
}

export function AnalyticsPanels({ view }: { view: AnalyticsView }) {
  const maxSource = Math.max(0, ...view.bySource.map((s) => s.runs));
  const maxOutcome = Math.max(0, ...view.byOutcome.map((o) => o.runs));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="bg-card rounded-xl border p-4">
          <p className="cx-eyebrow">Runs in window</p>
          <p className="cx-num mt-1 text-2xl font-semibold">{view.totalRuns}</p>
          <p className="text-muted-foreground mt-1 text-xs">Last {view.windowDays} days on your plan</p>
        </div>
        <div className="bg-card rounded-xl border p-4">
          <p className="cx-eyebrow">First run</p>
          <p className="cx-num mt-1 text-lg font-semibold">{formatUtcDate(view.firstRunAt)}</p>
        </div>
        <div className="bg-card rounded-xl border p-4">
          <p className="cx-eyebrow">Latest run</p>
          <p className="cx-num mt-1 text-lg font-semibold">{formatUtcDate(view.lastRunAt)}</p>
        </div>
      </div>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">By source</h2>
          <Note>Recorded and simulated runs are counted separately and never blended.</Note>
        </div>
        <ul className="bg-card divide-y rounded-xl border">
          {view.bySource.map((s) => (
            <li key={s.source} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SourceBadge source={s.source} />
                <p className="cx-num text-sm">
                  <span className="font-semibold">{s.runs}</span>{" "}
                  <span className="text-muted-foreground">{s.runs === 1 ? "run" : "runs"}</span>
                  <span className="text-muted-foreground"> · {formatMinutes(s.aiMinutes)} of AI</span>
                </p>
              </div>
              <Bar value={s.runs} max={maxSource} className="bg-foreground/70" />
              <p className="text-muted-foreground text-xs">{SOURCE_HINT[s.source]}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">By outcome</h2>
        <ul className="bg-card divide-y rounded-xl border">
          {view.byOutcome.map((o) => (
            <li key={o.outcome} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <OutcomeBadge outcome={o.outcome} />
                <p className="cx-num text-sm">
                  <span className="font-semibold">{o.runs}</span>{" "}
                  <span className="text-muted-foreground">{o.runs === 1 ? "run" : "runs"}</span>
                </p>
              </div>
              <Bar value={o.runs} max={maxOutcome} className="bg-foreground/45" />
            </li>
          ))}
        </ul>
        <Note>
          Outcomes are counted across every source together, so this table says how runs ended, not how well any
          one kind of run performs. Use the source table for that.
        </Note>
      </section>
    </div>
  );
}

/** The label under the outcome table, exported so the page and the tests agree on the wording. */
export const OUTCOME_LEGEND = Object.entries(OUTCOME_LABEL)
  .map(([, v]) => v)
  .join(" · ");
