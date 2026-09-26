/**
 * The AI-minutes meter and the relay cards on the `/app` overview (SAAS §8.3). WP20·1.
 *
 * **`basis` is printed, not hidden.** Until WP21's usage meter lands, these minutes are derived from this org's
 * own runs, and a derived number is not a billing number. A meter that silently switches its own definition
 * between releases is how a "you used 9 of 10 minutes" screen ends up being argued with, so the page says which
 * one it is showing.
 */
import { CodeIcon, PinIcon, PlayIcon } from "lucide-react";
import Link from "next/link";

import { formatMinutes, formatUtcDate, type MinutesMeterView, type RelayCardView } from "@/core/contracts/ext/wp20-app";
import { PLANS } from "@/core/contracts/v3/plans";
import { cn } from "@/lib/utils";

import { Note } from "../app-shell/bits";

export function MinutesMeter({ meter, className }: { meter: MinutesMeterView; className?: string }) {
  const allowance = Math.max(1, meter.allowanceMinutes);
  const pct = Math.min(100, Math.round((meter.usedMinutes / allowance) * 100));
  const tight = pct >= 80;
  const parts = [
    { key: "recorded" as const, label: "Recorded", minutes: meter.byProvenance.recorded, cls: "bg-[var(--cx-ok)]" },
    { key: "simulated" as const, label: "Simulated", minutes: meter.byProvenance.simulated, cls: "bg-[var(--cx-warn)]" },
    { key: "published" as const, label: "Published", minutes: meter.byProvenance.published, cls: "bg-foreground/60" },
  ];

  return (
    <div className={cn("bg-card rounded-xl border p-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">AI minutes this month</h2>
        <span className="text-muted-foreground text-xs">
          {PLANS[meter.plan].name} plan · {meter.period}
        </span>
      </div>

      <p className="cx-num mt-2 text-2xl font-semibold tracking-tight">
        {formatMinutes(meter.usedMinutes)}
        <span className="text-muted-foreground text-sm font-normal"> of {meter.allowanceMinutes} min</span>
      </p>

      <div className="bg-muted mt-2 flex h-2 overflow-hidden rounded-full" aria-hidden="true">
        {parts.map((p) =>
          p.minutes > 0 ? (
            <span
              key={p.key}
              className={p.cls}
              style={{ width: `${Math.min(100, (p.minutes / allowance) * 100)}%` }}
            />
          ) : null,
        )}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <li key={p.key} className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span aria-hidden="true" className={cn("size-2 rounded-full", p.cls)} />
            {p.label} <span className="cx-num text-foreground">{formatMinutes(p.minutes)}</span>
          </li>
        ))}
      </ul>

      {tight ? (
        <p className="mt-2 text-xs font-medium text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))]">
          You have used {pct}% of this month&rsquo;s AI minutes.
        </p>
      ) : null}

      <Note className="mt-2">
        {meter.basis === "metered"
          ? "Metered usage, the same figure your plan is measured against."
          : "Derived from this workspace's own runs. It is an estimate, not a billing figure."}
      </Note>
    </div>
  );
}

export function RelayCards({ relays, className }: { relays: readonly RelayCardView[]; className?: string }) {
  return (
    <ul className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {relays.map((r) => (
        <li key={r.id} className="bg-card flex flex-col gap-2 rounded-xl border p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{r.title}</p>
              <p className="text-muted-foreground truncate text-xs capitalize">{r.industry}</p>
            </div>
            {r.pinned ? (
              <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium">
                <PinIcon className="size-3" aria-hidden="true" />
                {r.flagship ? "Flagship · read-only" : "Pinned"}
              </span>
            ) : null}
          </div>

          <p className="text-muted-foreground cx-num text-xs">
            {r.versionCount} {r.versionCount === 1 ? "version" : "versions"}
            {r.lintErrors > 0 ? (
              <span className="text-destructive"> · {r.lintErrors} lint {r.lintErrors === 1 ? "error" : "errors"}</span>
            ) : null}
            {r.lastRunAt ? <> · last run {formatUtcDate(r.lastRunAt)}</> : null}
          </p>

          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Link
              href={`/app/relays/${encodeURIComponent(r.id)}`}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium"
            >
              <PlayIcon className="size-3.5" aria-hidden="true" />
              Open
            </Link>
            <Link
              href={`/app/relays/${encodeURIComponent(r.id)}/code`}
              className="hover:bg-accent inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium"
            >
              <CodeIcon className="size-3.5" aria-hidden="true" />
              View code
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
