/**
 * `/app/runs` — the runs list with its filters (TASKS-v3 §7 WP20·1, SAAS §8.5). WP20·1.
 *
 * Filters live in the query string and are parsed defensively: an unknown `source`, a malformed date or a junk
 * cursor is **ignored**, never an error. A shared link with a stale filter should show the list, not a 400.
 */
import type { Metadata } from "next";
import { ActivityIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState, PageHeader } from "@/components/app-shell/bits";
import { RunFilters } from "@/components/runs/run-filters";
import { RunsPager, RunsTable } from "@/components/runs/runs-table";
import { parseRunFilter, type RunFilter } from "@/core/contracts/ext/wp20-app";
import { log } from "@/server/log";
import { appPrincipal, pathWithQuery } from "@/server/read-models/app-guard";
import { runsReadModel } from "@/server/read-models/runs";

export const metadata: Metadata = { title: "Runs" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const asQuery = (f: RunFilter, cursor?: string): Record<string, string | undefined> => ({
  relayId: f.relayId,
  source: f.source,
  since: f.since,
  until: f.until,
  cursor,
});

export default async function RunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const filter = parseRunFilter(search);
  const principal = await appPrincipal(pathWithQuery("/app/runs", asQuery(filter, filter.cursor)));
  const orgId = principal.orgId ?? "";

  const model = runsReadModel();
  // The list is the page. A failure here is reported as a failure — the first version of this page caught it
  // and fell through to "No runs yet.", which told a workspace with runs in it that it had none. The relay
  // filter's options are genuinely optional, so that one does degrade.
  const [page, relays] = await Promise.all([
    model.list(orgId, filter).then(
      (p) => ({ ok: true as const, ...p }),
      (err: unknown) => {
        log.error("runs_list_failed", { err: err instanceof Error ? err.message : String(err) });
        return { ok: false as const, items: [] as never[], nextCursor: null };
      },
    ),
    model.relayOptions(orgId).catch(() => []),
  ]);

  const filtered = Boolean(filter.relayId || filter.source || filter.since || filter.until);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Runs"
        description="Every handoff this workspace has run, with the evidence behind it."
      />

      <RunFilters filter={filter} relays={relays} active={filtered || Boolean(filter.cursor)} />

      {!page.ok ? (
        <EmptyState
          icon={<TriangleAlertIcon />}
          title="We could not load your runs."
          body="Something went wrong on our side, not with your workspace. Your runs are safe; try again in a moment."
          actions={
            <Link
              href="/app/runs"
              className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
            >
              Try again
            </Link>
          }
        />
      ) : page.items.length > 0 ? (
        <>
          <RunsTable runs={page.items} />
          <RunsPager
            count={page.items.length}
            nextHref={
              page.nextCursor ? pathWithQuery("/app/runs", asQuery(filter, page.nextCursor)) : null
            }
          />
        </>
      ) : filtered ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No runs match these filters."
          body="Try a wider date range, or clear the filters to see everything in this workspace."
          actions={
            <Link
              href="/app/runs"
              className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
            >
              Clear filters
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon={<ActivityIcon />}
          title="No runs yet."
          body="Run the Dental template's simulated call, or watch Baton's recorded handoff."
          actions={
            <Link
              href="/app/relays"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
            >
              Open the Dental template
            </Link>
          }
        />
      )}
    </div>
  );
}
