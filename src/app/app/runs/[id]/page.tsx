/**
 * `/app/runs/[id]` — the case record (SAAS §6.2, §8.1). WP20·1.
 *
 * Read-only. A run belonging to another org is a **404**, not a 403: a 403 would confirm that the id exists
 * (SAAS §10.1 rule 2), and `notFound()` is the only correct answer to "is this yours?" when it is not.
 */
import type { Metadata } from "next";
import { ArrowLeftIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Field, Note, PageHeader } from "@/components/app-shell/bits";
import { BadgeRow, OutcomeBadge, SourceBadge } from "@/components/runs/badges";
import { CaseRecord } from "@/components/runs/case-record";
import { ProvenanceStripView } from "@/components/runs/provenance-strip";
import { PaymentCard, QaSummary } from "@/components/runs/qa-summary";
import {
  SOURCE_HINT, formatDurationMs, formatUtcDateTime,
} from "@/core/contracts/ext/wp20-app";
import { appPrincipal } from "@/server/read-models/app-guard";
import { runDetailReadModel } from "@/server/read-models/detail";

export const metadata: Metadata = { title: "Run" };
export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await appPrincipal(`/app/runs/${encodeURIComponent(id)}`);
  const detail = await runDetailReadModel().get(principal.orgId ?? "", id);
  if (!detail) notFound();

  const { run } = detail;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/app/runs"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 pb-2 text-sm"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Runs
        </Link>
        <PageHeader
          title={run.relayTitle}
          description={SOURCE_HINT[run.source]}
          actions={
            detail.consoleHref ? (
              <Link
                href={detail.consoleHref}
                className="hover:bg-accent inline-flex h-9 items-center gap-1.5 rounded-md border px-4 text-sm font-medium"
              >
                <PlayIcon className="size-4" aria-hidden="true" />
                Replay in the console
              </Link>
            ) : null
          }
        />
        <BadgeRow>
          <SourceBadge source={run.source} />
          <OutcomeBadge outcome={run.outcome} />
          {run.relayVersion !== null ? (
            <span className="text-muted-foreground cx-num text-xs">Relay v{run.relayVersion}</span>
          ) : null}
        </BadgeRow>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Where this evidence came from</h2>
        <ProvenanceStripView strip={detail.provenance} />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-5">
          {detail.caseRecord ? (
            <CaseRecord record={detail.caseRecord} />
          ) : (
            <div className="bg-card rounded-xl border p-4">
              <h3 className="text-sm font-semibold">Case record</h3>
              <Note className="pt-1">
                This run stored no case state, so there are no facts to show. That happens when a run ends before
                the rep passes the baton.
              </Note>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="bg-card rounded-xl border p-4">
            <h3 className="pb-1 text-sm font-semibold">Timing</h3>
            <dl className="divide-y">
              <Field label="Started">{formatUtcDateTime(run.startedAt)}</Field>
              <Field label="Ended">{formatUtcDateTime(run.endedAt)}</Field>
              <Field label="Length">{formatDurationMs(run.durationMs)}</Field>
              <Field label="AI seconds">{run.aiSeconds === null ? "—" : Math.round(run.aiSeconds)}</Field>
              <Field label="Run id">
                <span className="font-mono text-xs">{run.id}</span>
              </Field>
            </dl>
          </div>

          <QaSummary qa={detail.qa} status={detail.qaStatus} />
          <PaymentCard payment={detail.payment} />
        </div>
      </div>
    </div>
  );
}
