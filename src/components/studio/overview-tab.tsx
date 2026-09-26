"use client";
/**
 * components/studio/overview-tab.tsx - the Overview tab (SAAS §5.5, WP15·2).
 *
 * The tab a relay opens on, and the one that has to answer the question a judge, a new hire and the person who
 * wrote it all ask first: **where does the baton change hands, and what does the assistant inherit when it does?**
 *
 *     the rep's lane  ──▶  ⟨ Pass the baton ⟩  ──▶  confirm ─▶ disclose ─▶ act ─▶ close
 *
 * It is read-only on purpose. Everything on it is editable one tab to the right, and a page whose job is "explain
 * this relay" stops doing that job the moment half of it is an input.
 *
 * "What the AI inherits" is the compiled greeting for a canned state, with the two numbers that decide whether it
 * works on a phone — the same compile Preview and the greeting counter read, so the three can never disagree.
 */
import { AlertTriangle, ArrowRight, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CANNED_STATE_LABEL, greetingFor } from "@/client/studio/preview";
import { STAGE_KIND_LABEL, SET_BY_LABEL, buildTrack, codeHref, lintSummary, type TrackField } from "@/client/studio/overview";
import { useSource } from "@/client/studio/use-source-store";
import { CANNED_STATES, type CannedState } from "@/core/contracts/v2";
import type { CodeDiagnostic } from "@/core/relay-code";
import { cn } from "@/lib/utils";

const MAX_LINT_ROWS = 8;

export function OverviewTab({ relayId }: { relayId: string }) {
  const blueprint = useSource((s) => s.blueprint);
  const diagnostics = useSource((s) => s.diagnostics);

  if (!blueprint) {
    return (
      <div className="h-full overflow-auto p-6">
        <p className="text-sm font-medium">This relay does not parse yet.</p>
        <p className="text-muted-foreground mt-1 text-sm">
          The track is built from the blueprint, so it appears as soon as the file parses. The errors are in{" "}
          <Link href={`/app/relays/${encodeURIComponent(relayId)}/code`} className="underline underline-offset-2">Code</Link>.
        </p>
      </div>
    );
  }

  const track = buildTrack(blueprint);
  const summary = lintSummary(diagnostics);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        <LintSummaryCard relayId={relayId} summary={summary} />

        <section aria-labelledby="track-h" className="rounded-xl border">
          <header className="border-b px-4 py-3">
            <h2 id="track-h" className="text-sm font-semibold">The track</h2>
            <p className="text-muted-foreground text-xs">What happens on a call, and where the rep hands it over.</p>
          </header>

          <div className="space-y-3 p-4">
            <Lane title="The rep, before the baton" tone="rep">
              {track.rep.fields.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing: the assistant starts from an empty case.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {track.rep.fields.map((f) => <FieldChip key={f.id} field={f} />)}
                </ul>
              )}
              <p className="text-muted-foreground mt-2 text-xs">
                {track.rep.minCallSeconds > 0
                  ? `Pass is available after ${track.rep.minCallSeconds}s`
                  : "Pass is available straight away"}
                {track.rep.gates.length > 0 ? `, once ${joinList(track.rep.gates)} ${track.rep.gates.length === 1 ? "is" : "are"} verified.` : "."}
              </p>
            </Lane>

            <div className="border-primary/40 bg-primary/5 rounded-lg border-2 border-dashed px-4 py-3">
              <p className="text-xs font-semibold tracking-wide uppercase">Pass the baton</p>
              <p className="mt-1 text-sm">
                The rep says: <span className="font-medium">“{track.baton.repLine}”</span>
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                The customer says something like “{track.baton.acceptance}”.{" "}
                {track.baton.autoBaton ? "The handover arms itself when it hears both." : "The rep presses Pass."}
              </p>
            </div>

            <ol className="space-y-2">
              {track.stages.map((s, i) => (
                <li key={s.id} className="rounded-lg border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="bg-muted rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">{i + 1}</span>
                    <span className="text-sm font-medium">{STAGE_KIND_LABEL[s.kind]}</span>
                    {s.label && s.label !== STAGE_KIND_LABEL[s.kind] ? (
                      <span className="text-muted-foreground text-xs">{s.label}</span>
                    ) : null}
                    <span className="text-muted-foreground ml-auto text-xs">Moves on {s.exit}</span>
                  </div>
                  <p className="mt-1.5 text-sm">{s.goal}</p>
                  {s.disclosureTitle ? (
                    <p className="text-muted-foreground mt-1 text-xs">Reads “{s.disclosureTitle}” word for word.</p>
                  ) : null}
                  <ul className="mt-2 flex flex-wrap gap-1">
                    {s.tools.map((t) => (
                      <li key={t} className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{t}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>

            {track.aiWrites.length > 0 ? (
              <Lane title="The assistant finishes" tone="ai">
                <ul className="flex flex-wrap gap-1.5">
                  {track.aiWrites.map((f) => <FieldChip key={f.id} field={f} />)}
                </ul>
              </Lane>
            ) : (
              <p className="text-muted-foreground text-sm">
                The assistant may not set any field on this relay, so the handover has nothing to finish. That is
                usually a mistake.
              </p>
            )}

            <p className="text-muted-foreground text-xs">
              Then it hands back: <span className="text-foreground">“{track.baton.repReturnLine || "—"}”</span>
            </p>
          </div>
        </section>

        <Inherits />

        {track.connectors.length > 0 ? (
          <section aria-labelledby="does-h" className="rounded-xl border">
            <header className="border-b px-4 py-3">
              <h2 id="does-h" className="text-sm font-semibold">What it can do</h2>
            </header>
            <ul className="divide-y px-4">
              {track.connectors.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                  <span className="text-sm font-medium">{c.label || c.id}</span>
                  {c.toolName ? <span className="text-muted-foreground font-mono text-xs">{c.toolName}</span> : null}
                  <span className="text-muted-foreground ml-auto text-xs">{c.type.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="text-muted-foreground text-sm">
          Everything here is editable in{" "}
          <Link href={`/app/relays/${encodeURIComponent(relayId)}/configure`} className="text-foreground underline underline-offset-2">
            Configure
          </Link>{" "}
          or in{" "}
          <Link href={`/app/relays/${encodeURIComponent(relayId)}/code`} className="text-foreground underline underline-offset-2">
            Code
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

const joinList = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] as string}`;

function Lane({ title, tone, children }: { title: string; tone: "rep" | "ai"; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-lg border px-4 py-3", tone === "rep" ? "bg-muted/40" : "bg-background")}>
      <p className="text-xs font-semibold tracking-wide uppercase">{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function FieldChip({ field }: { field: TrackField }) {
  return (
    <li
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs",
        field.gatesPass && "border-primary/50",
        field.adviceDomain && "bg-amber-500/10",
      )}
      title={`${SET_BY_LABEL[field.setBy]}${field.required ? " · required" : ""}${field.adviceDomain ? " · the rep decides this one" : ""}${field.serverResolved ? " · filled from a named value" : ""}`}
    >
      {field.label}
      {field.required ? <span className="text-muted-foreground"> *</span> : null}
    </li>
  );
}

/** "What the AI inherits": the compiled greeting for a canned state, with words and seconds. */
function Inherits() {
  const preview = useSource((s) => s.preview);
  const [state, setState] = useState<CannedState>("one_pending");
  const greeting = preview ? greetingFor(preview, state) : null;

  return (
    <section aria-labelledby="inherits-h" className="rounded-xl border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="inherits-h" className="text-sm font-semibold">What the AI inherits</h2>
          <p className="text-muted-foreground text-xs">The first thing the customer hears, for each state the rep can leave the case in.</p>
        </div>
        {greeting ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{greeting.wordCount} words · {greeting.estSeconds}s</span>
        ) : null}
      </header>
      <div className="p-4">
        <div className="mb-2 flex flex-wrap gap-1">
          {CANNED_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                state === s ? "bg-primary text-primary-foreground border-transparent" : "hover:bg-accent",
              )}
            >
              {CANNED_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="text-sm">
          {greeting ? greeting.text : <span className="text-muted-foreground">Nothing to show: the relay does not compile right now.</span>}
        </p>
      </div>
    </section>
  );
}

/** The lint summary, with a jump into Code for every row that has a range (acceptance 3). */
function LintSummaryCard({ relayId, summary }: { relayId: string; summary: ReturnType<typeof lintSummary> }) {
  const total = summary.blocking + summary.lintErrors + summary.warnings;
  if (total === 0) {
    return (
      <p className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm">
        <Info aria-hidden className="text-muted-foreground size-4 shrink-0" />
        No problems. This relay is ready to test and publish.
      </p>
    );
  }
  const rows = summary.items.slice(0, MAX_LINT_ROWS);
  return (
    <section aria-labelledby="lint-h" className="rounded-xl border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <AlertTriangle aria-hidden className={cn("size-4 shrink-0", summary.blocking + summary.lintErrors > 0 ? "text-destructive" : "text-amber-600")} />
        <h2 id="lint-h" className="text-sm font-semibold">
          {summary.blocking > 0 ? `${summary.blocking} ${summary.blocking === 1 ? "error blocks" : "errors block"} saving` : null}
          {summary.blocking > 0 && summary.lintErrors > 0 ? " · " : null}
          {summary.lintErrors > 0 ? `${summary.lintErrors} ${summary.lintErrors === 1 ? "error blocks" : "errors block"} test and publish` : null}
          {(summary.blocking > 0 || summary.lintErrors > 0) && summary.warnings > 0 ? " · " : null}
          {summary.warnings > 0 ? `${summary.warnings} ${summary.warnings === 1 ? "warning" : "warnings"}` : null}
        </h2>
      </header>
      <ul className="divide-y px-4">
        {rows.map((d, i) => (
          <LintRow key={`${d.code}-${i}`} relayId={relayId} diagnostic={d} />
        ))}
      </ul>
      {summary.items.length > rows.length ? (
        <p className="text-muted-foreground px-4 py-2 text-xs">
          and {summary.items.length - rows.length} more, all listed under the editor in Code.
        </p>
      ) : null}
    </section>
  );
}

function LintRow({ relayId, diagnostic }: { relayId: string; diagnostic: CodeDiagnostic }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 font-mono text-xs",
          diagnostic.severity === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        {diagnostic.code}
      </span>
      <span className="min-w-0 flex-1 text-sm">{diagnostic.message}</span>
      <Link href={codeHref(relayId, diagnostic)} className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs">
        {diagnostic.range ? `line ${diagnostic.range.startLine}` : "Code"} <ArrowRight aria-hidden className="size-3" />
      </Link>
    </li>
  );
}

export default OverviewTab;
