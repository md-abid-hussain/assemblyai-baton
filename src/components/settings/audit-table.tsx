/**
 * The audit log viewer (SAAS §8.4, §9). WP20·2.
 *
 * **A server component with a plain GET form, and no JavaScript anywhere in it.** The filters submit as a query
 * string, the page re-renders from the database, and paging is a link carrying the keyset cursor. That is not
 * minimalism for its own sake: it means every state of this table is a URL an admin can paste to another admin,
 * the browser's Back button steps through filters the way people expect, and the one screen whose job is to be
 * *evidence* never depends on client state that a reader cannot see or reproduce.
 *
 * **Keyset paging, not offsets.** The log is append-only and gets new rows at the top while page 2 is being
 * read; an OFFSET would show the same row twice and hide another entirely. The cursor is `occurredAt|id`.
 * Only "Next" exists, and Back is how you go back — a numbered pager over a keyset cursor would be a lie.
 */
import type * as React from "react";

import { Pill } from "@/components/settings/bits";
import { formatUtcDateTime, type AuditPage } from "@/core/contracts/ext/wp20-app";

const ACTOR_TONE = {
  user: "neutral",
  guest: "muted",
  api_key: "warn",
  system: "muted",
} as const;

const ACTOR_LABEL: Record<AuditPage["rows"][number]["actorType"], string> = {
  user: "User",
  guest: "Guest",
  api_key: "API key",
  system: "System",
};

export function AuditFilters({ page }: { page: AuditPage }) {
  const { filter, actions } = page;
  return (
    <form
      method="get"
      className="bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_9rem_auto] lg:items-end"
    >
      <Labelled id="audit-actor" label="Actor">
        <input
          id="audit-actor"
          name="actor"
          type="search"
          defaultValue={filter.actor ?? ""}
          placeholder="Name or email"
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Labelled>

      <Labelled id="audit-action" label="Action">
        <select
          id="audit-action"
          name="action"
          defaultValue={filter.action ?? ""}
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <option value="">Every action</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Labelled>

      <Labelled id="audit-since" label="From">
        <input
          id="audit-since"
          name="since"
          type="date"
          defaultValue={filter.since ?? ""}
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Labelled>

      <Labelled id="audit-until" label="To">
        <input
          id="audit-until"
          name="until"
          type="date"
          defaultValue={filter.until ?? ""}
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Labelled>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors"
        >
          Filter
        </button>
        {filter.actor || filter.action || filter.since || filter.until ? (
          <a
            href="/app/settings/audit"
            className="text-muted-foreground hover:text-foreground text-sm font-medium underline underline-offset-4"
          >
            Clear
          </a>
        ) : null}
      </div>
    </form>
  );
}

function Labelled({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="cx-eyebrow block">
        {label}
      </label>
      {children}
    </div>
  );
}

export function AuditTable({ page, nextHref }: { page: AuditPage; nextHref: string | null }) {
  if (page.rows.length === 0) {
    return (
      <div className="border-border/70 bg-[var(--cx-raise)] rounded-xl border border-dashed px-5 py-10 text-center">
        <p className="text-sm font-semibold">Every change to this workspace is recorded here.</p>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-sm text-pretty">
          Invites, role changes, publishes, secrets and keys. Nothing matches these filters yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/*
        A table at 1024 px and a list of cards at 390 px, from the same rows. `overflow-x-auto` on a wrapper
        would keep the table and give the page a horizontal scrollbar, which acceptance 6 forbids.
      */}
      <div className="bg-card hidden overflow-hidden rounded-xl border lg:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="[&>th]:px-4 [&>th]:py-2.5 [&>th]:text-left [&>th]:text-xs [&>th]:font-medium">
              <th scope="col">When (UTC)</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {page.rows.map((r) => (
              <tr key={r.id} className="[&>td]:px-4 [&>td]:py-2.5 [&>td]:align-top">
                <td className="cx-num text-muted-foreground whitespace-nowrap">
                  {formatUtcDateTime(r.occurredAt)}
                </td>
                <td>
                  <span className="flex items-center gap-2">
                    <span className="max-w-[16ch] truncate font-medium">{r.actorLabel}</span>
                    <Pill tone={ACTOR_TONE[r.actorType]}>{ACTOR_LABEL[r.actorType]}</Pill>
                  </span>
                </td>
                <td className="font-medium">{r.actionLabel}</td>
                <td className="text-muted-foreground">
                  {r.targetType ? (
                    <span className="cx-num block max-w-[22ch] truncate text-xs">
                      {r.targetType}
                      {r.targetId ? ` · ${r.targetId}` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-muted-foreground cx-num max-w-[28ch] text-xs break-words">
                  {r.detail ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 lg:hidden">
        {page.rows.map((r) => (
          <li key={r.id} className="bg-card space-y-1 rounded-xl border p-3.5">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {r.actionLabel}
              <Pill tone={ACTOR_TONE[r.actorType]}>{ACTOR_LABEL[r.actorType]}</Pill>
            </p>
            <p className="text-muted-foreground text-xs">
              {r.actorLabel} · {formatUtcDateTime(r.occurredAt)}
            </p>
            {r.targetType ? (
              <p className="text-muted-foreground cx-num text-xs break-words">
                {r.targetType}
                {r.targetId ? ` · ${r.targetId}` : ""}
              </p>
            ) : null}
            {r.detail ? (
              <p className="text-muted-foreground cx-num text-xs break-words">{r.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {nextHref ? (
        <div className="flex justify-center pt-1">
          <a
            href={nextHref}
            className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors"
          >
            Older entries →
          </a>
        </div>
      ) : null}
    </div>
  );
}
