"use client";

/**
 * The `/app/runs` filters: relay, source, date range (TASKS-v3 §7 WP20·1). WP20·1.
 *
 * **A plain `<form method="get">`.** The filters live in the query string, so a filtered list is a URL a
 * teammate can be sent and the back button does the obvious thing. JavaScript only upgrades it — changing a
 * select submits immediately instead of waiting for the button — and with JS off the Apply button still works.
 *
 * Changing any filter drops the cursor: page 3 of one filter is not page 3 of another.
 */
import { FilterXIcon } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";

import { RUN_SOURCES, SOURCE_LABEL, type RunFilter } from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

const field =
  "bg-background border-input h-9 rounded-md border px-2.5 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none";

export function RunFilters({
  filter,
  relays,
  active,
  className,
}: {
  filter: RunFilter;
  relays: readonly { id: string; title: string }[];
  /** True when at least one filter is set, so "Clear" only appears when it would do something. */
  active: boolean;
  className?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();

  return (
    <form
      ref={form}
      method="get"
      action="/app/runs"
      className={cn("flex flex-wrap items-end gap-2", className)}
      aria-label="Filter runs"
    >
      <label className="flex flex-col gap-1">
        <span className="cx-eyebrow">Relay</span>
        <select name="relayId" defaultValue={filter.relayId ?? ""} onChange={submit} className={cn(field, "max-w-[14rem]")}>
          <option value="">All relays</option>
          {relays.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="cx-eyebrow">Source</span>
        <select name="source" defaultValue={filter.source ?? ""} onChange={submit} className={field}>
          <option value="">All sources</option>
          {RUN_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="cx-eyebrow">From</span>
        <input type="date" name="since" defaultValue={filter.since ?? ""} onChange={submit} className={field} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="cx-eyebrow">To</span>
        <input type="date" name="until" defaultValue={filter.until ?? ""} onChange={submit} className={field} />
      </label>

      <button
        type="submit"
        className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-9 rounded-md px-3 text-sm font-medium shadow-xs"
      >
        Apply
      </button>

      {active ? (
        <Link
          href="/app/runs"
          className="text-muted-foreground hover:text-foreground inline-flex h-9 items-center gap-1.5 px-1 text-sm"
        >
          <FilterXIcon className="size-4" aria-hidden="true" />
          Clear
        </Link>
      ) : null}
    </form>
  );
}
