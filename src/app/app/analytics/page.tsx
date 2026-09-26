/**
 * `/app/analytics` (SAAS §8.1, §8.5). WP20·1.
 *
 * Counts by source and by outcome over the plan's analytics window, with the "never blended" note. There is no
 * combined success rate here, on purpose (see `components/runs/analytics.tsx`).
 */
import type { Metadata } from "next";
import { BarChart3Icon } from "lucide-react";
import Link from "next/link";

import { EmptyState, PageHeader } from "@/components/app-shell/bits";
import { AnalyticsPanels } from "@/components/runs/analytics";
import { PLANS } from "@/core/contracts/v3/plans";
import { appPrincipal } from "@/server/read-models/app-guard";
import { runsReadModel } from "@/server/read-models/runs";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const principal = await appPrincipal("/app/analytics");
  const windowDays = PLANS[principal.plan].limits.analyticsDays;

  const view = await runsReadModel()
    .analytics(principal.orgId ?? "", windowDays)
    .catch(() => null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description={`Runs in this workspace over the last ${windowDays} days (${PLANS[principal.plan].name} plan).`}
      />

      {view && view.totalRuns > 0 ? (
        <AnalyticsPanels view={view} />
      ) : (
        <EmptyState
          icon={<BarChart3Icon />}
          title="Analytics appear after your first verified run."
          body="Recorded and simulated runs are never blended."
          actions={
            <Link
              href="/app/runs"
              className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
            >
              Go to Runs
            </Link>
          }
        />
      )}
    </div>
  );
}
