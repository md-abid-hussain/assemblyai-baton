/**
 * The badges that label a run (PLATFORM §7.6, SAAS §8.5). WP20·1.
 *
 * **The source badge is the honesty surface of the whole app.** Recorded, Simulated, Text dry run and Published
 * are four different kinds of evidence, and the product's central claim — that it does not blend them — is only
 * as good as the label on every row. So the badge is never decoration: it is always the same colour for the
 * same source, it always carries its word (never a colour alone, which a colour-blind reader cannot read), and
 * `SOURCE_HINT` puts the one-line explanation within reach on the detail page.
 */
import type { PaymentStatus } from "@/core/contracts/case";
import type * as React from "react";

import {
  OUTCOME_LABEL, SOURCE_HINT, SOURCE_LABEL, type RunOutcome, type RunSource,
} from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

const base =
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap";

const SOURCE_CLASS: Record<RunSource, string> = {
  recorded:
    "border-[var(--cx-ok)]/35 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[color-mix(in_oklch,var(--success)_75%,var(--foreground))]",
  simulated:
    "border-[var(--cx-warn)]/40 bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))]",
  text_dry_run: "border-border bg-muted text-muted-foreground",
  published:
    "border-primary/30 bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] text-foreground",
};

export function SourceBadge({ source, className }: { source: RunSource; className?: string }) {
  return (
    <span className={cn(base, SOURCE_CLASS[source], className)} title={SOURCE_HINT[source]}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

const OUTCOME_CLASS: Record<RunOutcome, string> = {
  completed: "text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))] border-[var(--cx-ok)]/30",
  handed_back: "text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))] border-[var(--cx-warn)]/35",
  abandoned: "text-muted-foreground border-border",
  failed: "text-destructive border-destructive/35",
  in_progress: "text-foreground border-border",
};

export function OutcomeBadge({ outcome, className }: { outcome: RunOutcome; className?: string }) {
  return (
    <span className={cn(base, "bg-transparent", OUTCOME_CLASS[outcome], className)}>
      {outcome === "in_progress" ? (
        <span aria-hidden="true" className="bg-foreground/60 size-1.5 animate-pulse rounded-full" />
      ) : null}
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** `7/10 verified`. Null readiness means the run never built a case state — say so, do not print `0/0`. */
export function ReadinessBadge({
  readiness,
  className,
}: {
  readiness: { verified: number; requiredTotal: number } | null;
  className?: string;
}) {
  if (!readiness || readiness.requiredTotal === 0) {
    return <span className={cn("text-muted-foreground text-xs", className)}>—</span>;
  }
  const done = readiness.verified >= readiness.requiredTotal;
  return (
    <span
      className={cn(
        "cx-num text-xs font-medium",
        done ? "text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))]" : "text-foreground",
        className,
      )}
    >
      {readiness.verified}/{readiness.requiredTotal}
      <span className="text-muted-foreground font-normal"> verified</span>
    </span>
  );
}

/**
 * How much to trust the QA numbers next to it. "Provisional" is the console's own count; "Verified" means the
 * verifier re-read the recording. They are never shown as the same thing.
 */
export function QaBadge({
  status,
  className,
}: {
  status: "verified" | "provisional" | "pending" | "none";
  className?: string;
}) {
  const copy: Record<typeof status, { label: string; cls: string; title: string }> = {
    verified: {
      label: "Verified",
      cls: "border-[var(--cx-ok)]/35 text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))]",
      title: "The verifier re-read the recording and agreed.",
    },
    provisional: {
      label: "Provisional",
      cls: "border-[var(--cx-warn)]/35 text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))]",
      title: "The console's own numbers; verification has not confirmed them yet.",
    },
    pending: {
      label: "Verifying…",
      cls: "border-border text-muted-foreground",
      title: "Verification is still running.",
    },
    none: { label: "No QA", cls: "border-border text-muted-foreground", title: "This run produced no QA result." },
  };
  const c = copy[status];
  return (
    <span className={cn(base, "bg-transparent", c.cls, className)} title={c.title}>
      {c.label}
    </span>
  );
}

/**
 * The words come from `PAYMENT_STATUSES` (`contracts/case.ts`), not from a guess.
 *
 * An earlier version of this file invented `paid` and `verified`, which are not states the engine can produce;
 * a real `succeeded` would have rendered in the neutral style, quietly under-reporting a completed payment.
 * Grouping the real enum means a new status added upstream shows as neutral rather than as an invented colour.
 */
const PAYMENT_TONE: Partial<Record<PaymentStatus, "good" | "bad">> = {
  succeeded: "good",
  confirmed: "good",
  failed: "bad",
  expired: "bad",
  timeout: "bad",
};

export function PaymentBadge({ status, className }: { status: string | null; className?: string }) {
  if (!status || status === "none") return <span className={cn("text-muted-foreground text-xs", className)}>—</span>;
  const tone = PAYMENT_TONE[status as PaymentStatus];
  return (
    <span
      className={cn(
        base,
        "bg-transparent capitalize",
        tone === "good"
          ? "border-[var(--cx-ok)]/35 text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))]"
          : tone === "bad"
            ? "border-destructive/35 text-destructive"
            : "border-border text-muted-foreground",
        className,
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** A wrapper that keeps a row of badges from wrapping mid-badge. */
export const BadgeRow = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{children}</div>
);
