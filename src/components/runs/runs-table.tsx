/**
 * The runs list (SAAS §8.1 `/app/runs`, and the overview's five most recent). WP20·1.
 *
 * One component, two densities. A real table from `sm` up, because runs are compared column by column and a
 * card grid makes that impossible; stacked cards below it, because a five-column table at 390 px is a
 * horizontal scrollbar with extra steps (acceptance 6).
 *
 * The whole row is a link, so the target is the row and not a 40 px "View" affordance.
 */
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import {
  formatDurationMs, formatUtcDateTime, type RunListItem,
} from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

import { OutcomeBadge, PaymentBadge, ReadinessBadge, SourceBadge } from "./badges";

const href = (r: RunListItem) => `/app/runs/${encodeURIComponent(r.id)}`;

function RelayCell({ run }: { run: RunListItem }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium">{run.relayTitle}</span>
      {run.relayVersion !== null ? (
        <span className="text-muted-foreground cx-num block text-xs">v{run.relayVersion}</span>
      ) : null}
    </span>
  );
}

export function RunsTable({ runs, compact = false }: { runs: readonly RunListItem[]; compact?: boolean }) {
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      {/* Narrow: stacked cards. */}
      <ul className="divide-y sm:hidden">
        {runs.map((run) => (
          <li key={run.id}>
            <Link href={href(run)} className="hover:bg-accent/50 block space-y-2 px-4 py-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <RelayCell run={run} />
                <ChevronRightIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceBadge source={run.source} />
                <OutcomeBadge outcome={run.outcome} />
                <ReadinessBadge readiness={run.readiness} />
              </div>
              <p className="text-muted-foreground cx-num text-xs">
                {formatUtcDateTime(run.startedAt)} · {formatDurationMs(run.durationMs)}
              </p>
            </Link>
          </li>
        ))}
      </ul>

      {/* Wide: a real table. */}
      <table className="hidden w-full text-sm sm:table">
        <caption className="sr-only">Runs in this workspace, newest first.</caption>
        <thead>
          <tr className="text-muted-foreground cx-hair [&>th]:px-4 [&>th]:py-2 [&>th]:text-left [&>th]:text-xs [&>th]:font-medium">
            <th scope="col">Relay</th>
            <th scope="col">Source</th>
            <th scope="col">Outcome</th>
            <th scope="col">Facts</th>
            {compact ? null : (
              <>
                <th scope="col">Payment</th>
                <th scope="col" className="text-right!">
                  Length
                </th>
              </>
            )}
            <th scope="col" className="text-right!">
              Started
            </th>
            <th scope="col" className="w-8">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-accent/40 group transition-colors">
              <td className="max-w-[18rem] px-4 py-2.5">
                {/* The title is the row's link. A stretched pseudo-element over a `tr` is unreliable across
                    browsers, so the chevron cell carries a second, labelled link rather than a fake hit area. */}
                <Link href={href(run)} className="block hover:underline underline-offset-4">
                  <RelayCell run={run} />
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <SourceBadge source={run.source} />
              </td>
              <td className="px-4 py-2.5">
                <OutcomeBadge outcome={run.outcome} />
              </td>
              <td className="px-4 py-2.5">
                <ReadinessBadge readiness={run.readiness} />
              </td>
              {compact ? null : (
                <>
                  <td className="px-4 py-2.5">
                    <PaymentBadge status={run.paymentStatus} />
                  </td>
                  <td className="cx-num text-muted-foreground px-4 py-2.5 text-right">
                    {formatDurationMs(run.durationMs)}
                  </td>
                </>
              )}
              <td className="cx-num text-muted-foreground px-4 py-2.5 text-right whitespace-nowrap">
                {formatUtcDateTime(run.startedAt)}
              </td>
              <td className="px-2 py-2.5">
                <Link
                  href={href(run)}
                  aria-label={`Open the run of ${run.relayTitle} started ${formatUtcDateTime(run.startedAt)}`}
                  className="text-muted-foreground group-hover:text-foreground inline-flex"
                >
                  <ChevronRightIcon className="size-4" aria-hidden="true" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Showing 1–20" plus the Load more link the keyset cursor produces. */
export function RunsPager({
  count,
  nextHref,
  className,
}: {
  count: number;
  nextHref: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 pt-3", className)}>
      <p className="text-muted-foreground cx-num text-xs">
        {count} {count === 1 ? "run" : "runs"} on this page
      </p>
      {nextHref ? (
        <Link href={nextHref} className="text-sm font-medium underline underline-offset-4">
          Older runs →
        </Link>
      ) : null}
    </div>
  );
}
