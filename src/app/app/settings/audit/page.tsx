/**
 * Settings → Audit log (SAAS §8.4, §9). WP20·2.
 *
 * `audit:read` is admin+ (§3.7). A member or a viewer who reaches the URL gets a plain explanation, **not** a
 * 404 and not an error page: they are legitimately in this workspace, and "you need to be an admin" is the
 * true, useful answer. The sub-nav does not show them the link in the first place.
 */
import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/bits";
import { AuditFilters, AuditTable } from "@/components/settings/audit-table";
import { parseAuditFilter } from "@/core/contracts/ext/wp20-app";
import { can } from "@/core/contracts/v3/permissions";
import { appPrincipal, pathWithQuery } from "@/server/read-models/app-guard";
import { loadAudit } from "@/server/read-models/audit";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function AuditSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await appPrincipal("/app/settings/audit");

  if (!can(principal, "audit:read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Audit log" description="Every change to this workspace, and who made it." />
        <div className="border-border/70 bg-[var(--cx-raise)] rounded-xl border border-dashed px-5 py-10 text-center">
          <p className="text-sm font-semibold">The audit log is for owners and admins.</p>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-sm text-pretty">
            It records who invited whom, who published what and when a key was created. Ask an owner or an admin
            in this workspace if you need to see it.
          </p>
        </div>
      </div>
    );
  }

  const filter = parseAuditFilter(await searchParams);
  const page = await loadAudit(principal, filter);

  // The cursor rides on top of the filters that produced it; dropping them would silently widen the next page.
  const nextHref = page.nextCursor
    ? pathWithQuery("/app/settings/audit", { ...filter, cursor: page.nextCursor })
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        description="Every change to this workspace, and who made it. Entries are never edited or deleted."
      />

      <AuditFilters page={page} />
      <AuditTable page={page} nextHref={nextHref} />

      <p className="text-muted-foreground text-xs text-pretty">
        Your plan keeps {page.retentionDays} days of history. Times are UTC. Actor names are recorded as they
        were at the time, so renaming or removing someone never rewrites what they did.
      </p>
    </div>
  );
}
