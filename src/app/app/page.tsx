/**
 * `/app` — the overview (SAAS §8.3). WP20·1.
 *
 * The checklist first, because it is the judge path (§13.1); then the minutes meter, the five most recent runs
 * and the workspace's relays. Every block has an empty state that says what to do next (§8.5).
 */
import type { Metadata } from "next";
import { ActivityIcon, LayersIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState, PageHeader, Section } from "@/components/app-shell/bits";
import { ClaimCard } from "@/components/app-shell/claim-card";
import { Checklist } from "@/components/onboarding/checklist";
import { MinutesMeter, RelayCards } from "@/components/onboarding/minutes-meter";
import { RunsTable } from "@/components/runs/runs-table";
import { appPrincipal } from "@/server/read-models/app-guard";
import { getCaseDataSource } from "@/server/data";
import { getOrg } from "@/server/identity";
import { loadClaimCard } from "@/server/read-models/claim";
import { overviewReadModel } from "@/server/read-models/overview";
import { viewerOf } from "@/server/read-models/orgs";

// `absolute`, because a layout's `title.template` applies to its **child** segments and not to its own page:
// `/app/runs` picks up "· Changeover" from the `/app` layout, and `/app` itself would fall back to the root
// template and render "Overview · Baton" — the one naming rule SAAS §8.2 states outright, broken on the
// overview. Found in a browser; `metadata` is not something a unit test sees.
export const metadata: Metadata = { title: { absolute: "Overview · Changeover" } };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const principal = await appPrincipal("/app");
  const viewer = viewerOf(principal);
  const orgId = principal.orgId ?? "";

  const featuredCallId = await getCaseDataSource()
    .featuredCall()
    .then((c) => c?.callId ?? null)
    .catch(() => null);

  // SAAS §2.6 R1: only ever offered, never taken. `loadClaimCard` itself returns `offer: false` for a guest,
  // for a viewer and for a device with nothing unclaimed; the cheap test is repeated here so that the common
  // case — every guest visit, which is most of them — does not pay for the org-name lookup the card needs.
  const mayBeOffered = principal.kind === "session" && !principal.isAnonymous && Boolean(principal.userId);
  const claim = mayBeOffered
    ? await loadClaimCard(
        principal,
        (await getOrg(orgId).then((o) => o?.name ?? null).catch(() => null)) ?? "this workspace",
      )
    : null;

  const data = await overviewReadModel().load({
    orgId,
    plan: principal.plan,
    isGuest: viewer.isGuest,
    featuredCallId,
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="Your relays, your runs and what is left to try."
        actions={
          <Link
            href="/app/relays"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium shadow-xs"
          >
            Build a relay
          </Link>
        }
      />

      {claim?.offer ? <ClaimCard view={claim} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-start">
        <Checklist items={data.checklist} />
        <MinutesMeter meter={data.meter} />
      </div>

      <Section
        title="Recent runs"
        description={data.totalRuns > 0 ? `${data.totalRuns} in this workspace` : undefined}
        actions={
          data.recentRuns.length > 0 ? (
            <Link href="/app/runs" className="text-sm font-medium underline underline-offset-4">
              All runs →
            </Link>
          ) : null
        }
      >
        {data.recentRuns.length > 0 ? (
          <RunsTable runs={data.recentRuns} compact />
        ) : (
          <EmptyState
            icon={<ActivityIcon />}
            title="No runs yet."
            body="Run the Dental template's simulated call, or watch Baton's recorded handoff."
            actions={
              <>
                <Link
                  href="/app/relays"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
                >
                  Open the Dental template
                </Link>
                <Link
                  href={featuredCallId ? `/call/${encodeURIComponent(featuredCallId)}?express=1` : "/call"}
                  className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
                >
                  Watch the handoff
                </Link>
              </>
            }
          />
        )}
      </Section>

      <Section
        title="Your relays"
        actions={
          data.relays.length > 0 ? (
            <Link href="/app/relays" className="text-sm font-medium underline underline-offset-4">
              All relays →
            </Link>
          ) : null
        }
      >
        {data.relays.length > 0 ? (
          <RelayCards relays={data.relays.slice(0, 4)} />
        ) : (
          <EmptyState
            icon={<LayersIcon />}
            title="Start from a template"
            body="Dental deposit, Baton · insurance add-a-driver, or a blank relay. You can also import a blueprint file (YAML or JSON)."
            actions={
              <Link
                href="/app/relays"
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
              >
                Browse templates
              </Link>
            }
          />
        )}
      </Section>

      {viewer.isGuest ? null : (
        <Section title="Your team" description="Invite someone to this workspace with a link.">
          <EmptyState
            title="Invite a teammate"
            body="Send a link; they join with the role you pick."
            actions={
              <Link
                href="/app/settings/members"
                className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
              >
                Members &amp; invites
              </Link>
            }
          />
        </Section>
      )}
    </div>
  );
}
