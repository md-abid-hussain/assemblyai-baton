/**
 * Small shared pieces of the `/app` surface (SAAS §8.2, §8.5). WP20.
 *
 * Server-safe: no hooks, no `"use client"`, no import of `src/server/**`. Every page in the shell is built from
 * these, so a spacing or a heading-level decision is made once.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

/** The page title block. `h1` per page, so the heading order is `h1 → h2 (section) → h3 (card)` everywhere. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3 pb-5", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
        {description ? <p className="text-muted-foreground max-w-prose text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * An empty state (SAAS §8.5). It always says what to do next, because "No runs yet." on its own is a dead end
 * and the first thing a new workspace shows is, by definition, an empty state.
 */
export function EmptyState({
  icon,
  title,
  body,
  actions,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border/70 bg-[var(--cx-raise)] flex flex-col items-center gap-3 rounded-xl border border-dashed px-5 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground [&>svg]:size-6" aria-hidden="true">{icon}</div> : null}
      <div className="space-y-1.5">
        <p className="text-sm font-semibold">{title}</p>
        {body ? <p className="text-muted-foreground mx-auto max-w-[46ch] text-sm text-pretty">{body}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{actions}</div> : null}
    </div>
  );
}

/** A number with a label. `tone` is advisory only: the label always carries the meaning in words too. */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "good" | "warn";
  className?: string;
}) {
  const color =
    tone === "good" ? "text-[var(--cx-ok)]" : tone === "warn" ? "text-[var(--cx-warn)]" : "text-foreground";
  return (
    <div className={cn("bg-card rounded-xl border p-4", className)}>
      <p className="cx-eyebrow">{label}</p>
      <p className={cn("cx-num mt-1 text-2xl font-semibold tracking-tight", color)}>{value}</p>
      {hint ? <p className="text-muted-foreground mt-1 text-xs text-pretty">{hint}</p> : null}
    </div>
  );
}

/** A quiet inline note. Used for the "never blended" and "derived, not billed" lines. */
export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-muted-foreground text-xs text-pretty", className)}>{children}</p>
  );
}

/** A definition row: label on the left, value on the right, wrapping to two lines on a narrow screen. */
export function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="cx-num text-sm font-medium">{children}</dd>
    </div>
  );
}
