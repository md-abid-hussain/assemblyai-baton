/**
 * The shared furniture of the settings panels (SAAS §8.4). WP20·2.
 *
 * Server-safe: no hooks and no `"use client"`, so a panel can be server-rendered and only the parts that need a
 * click become islands. The settings area is eight pages across five WPs, and the thing that makes them look
 * like one product is that the card, the heading level and the danger styling are decided here once.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

/** One titled card. `h2` under the page's `h1`, so the heading order holds across every settings page. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-card rounded-xl border", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="text-muted-foreground max-w-prose text-xs text-pretty">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="px-4 py-4 sm:px-5">{children}</div> : null}
    </section>
  );
}

/**
 * The destructive card. Bordered in the destructive colour and **never** the first thing on a page.
 *
 * Colour alone does not say "dangerous" to everyone looking at it, so every row inside carries a sentence that
 * names the consequence in words. The border is the second signal, not the only one.
 */
export function DangerPanel({
  title = "Danger zone",
  children,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-destructive/35 bg-card rounded-xl border", className)}>
      <div className="border-destructive/25 border-b px-4 py-3.5 sm:px-5">
        <h2 className="text-destructive text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="divide-border divide-y">{children}</div>
    </section>
  );
}

/** A row inside a panel: an explanation on the left, one control on the right. Stacks at 390 px. */
export function Row({
  title,
  body,
  action,
  className,
}: {
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        {body ? <p className="text-muted-foreground max-w-prose text-xs text-pretty">{body}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A definition list of read-only facts. Two columns on a wide screen, stacked on a phone. */
export function FactList({ children }: { children: React.ReactNode }) {
  return <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">{children}</dl>;
}

export function Fact({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="cx-eyebrow">{label}</dt>
      <dd className="truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

/** A role, a status or a plan as a quiet pill. Never the only carrier of meaning: the text says it too. */
export function Pill({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "muted";
  className?: string;
}) {
  const tones = {
    neutral: "border-border text-foreground",
    good: "border-[var(--cx-ok)]/40 text-[var(--cx-ok)]",
    warn: "border-[var(--cx-warn)]/40 text-[var(--cx-warn)]",
    muted: "border-border text-muted-foreground",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
