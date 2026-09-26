"use client";
/**
 * components/studio/diagnostics-list.tsx - the diagnostics under the editor (SAAS §5.2, §5.3).
 *
 * The list is the *authoritative* view of what is wrong, not a duplicate of the squiggles: a diagnostic with a null
 * range (it came from the compiled form, or the file was refused before it was parsed) has no squiggle to show, and
 * the textarea fallback has no squiggles at all. Clicking a located one jumps the caret to it.
 *
 * The order is the order a builder fixes them in: blocking errors (syntax, schema, codec) first, then lint errors,
 * then warnings - because only the first group stops a Save, and the second only stops Test and Publish.
 */
import { AlertTriangle, CircleAlert, CircleCheck } from "lucide-react";

import type { CodeDiagnostic } from "@/core/relay-code";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = { syntax: 0, schema: 1, codec: 2, lint: 3 };

export function sortDiagnostics(diagnostics: readonly CodeDiagnostic[]): CodeDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    const ra = RANK[a.source] ?? 9;
    const rb = RANK[b.source] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0);
  });
}

export interface DiagnosticsListProps {
  diagnostics: readonly CodeDiagnostic[];
  /** 1-based line, 1-based column (what an editor caret wants). */
  onJump?: (line: number, col: number) => void;
  className?: string;
}

export function DiagnosticsList({ diagnostics, onJump, className }: DiagnosticsListProps) {
  if (diagnostics.length === 0) {
    return (
      <p className={cn("text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm", className)}>
        <CircleCheck aria-hidden className="size-4 text-emerald-600" />
        No problems. This file parses, matches the schema and passes lint.
      </p>
    );
  }
  return (
    <ul className={cn("divide-y text-sm", className)} aria-label="Problems">
      {sortDiagnostics(diagnostics).map((d, i) => {
        const at = d.range ? `${d.range.startLine}:${d.range.startCol + 1}` : null;
        const jump = d.range && onJump ? () => onJump(d.range!.startLine, d.range!.startCol + 1) : null;
        const Row = jump ? "button" : "div";
        return (
          <li key={`${d.code}-${i}`}>
            <Row
              {...(jump ? { type: "button" as const, onClick: jump } : {})}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-2 text-left",
                jump && "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              )}
            >
              {d.severity === "error" ? (
                <CircleAlert aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
              ) : (
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{d.message}</span>{" "}
                <span className="text-muted-foreground">
                  ({d.source} · {d.code}
                  {d.path.length > 0 ? ` · ${d.path.join(".")}` : ""})
                </span>
              </span>
              {at ? <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{at}</span> : null}
            </Row>
          </li>
        );
      })}
    </ul>
  );
}
