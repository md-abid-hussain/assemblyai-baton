"use client";
/**
 * ProvenanceStrip (PLATFORM §7.6): ONE strip per run, four segments, on every relay console.
 *
 * It replaces every stacked badge the console used to carry — SIMULATED AUDIO, RECORDED AI SESSION, CACHED REPLAY,
 * "synthetic stand-in" — so a judge reads where each half of the run comes from in one place, in every video frame
 * and every screenshot. Each segment has a one-line tooltip; a run with any generated half also prints its detail
 * line ("Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people.").
 *
 * The values come from the store: the server states the run's strip at case creation, the page merges the call
 * manifest's own provenance into it (a generated take is never called a recording), and the console updates the
 * segments only it knows (cached transcripts, a recorded AI session, who answers the AI).
 */
import { HistoryIcon, RadioIcon, SparklesIcon } from "lucide-react";

import { useBaton } from "@/client/store/hooks";
import { provenance, type ProvenanceSegment, type ProvenanceView } from "@/client/store/selectors";
import { relayChip, specOf } from "@/client/store/ui-spec";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useConsoleEnv } from "../common/console-context";

const TONE: Record<ProvenanceSegment["tone"], string> = {
  live: "border-(--bt-live)/50 bg-(--verified-bg) text-(--verified-fg)",
  recorded: "border-(--bt-cached)/50 bg-(--bt-cached-bg) text-(--bt-cached)",
  sim: "border-(--ai)/40 bg-(--ai-bg) text-(--ai-fg)",
};

const ICON: Record<ProvenanceSegment["tone"], typeof RadioIcon> = {
  live: RadioIcon,
  recorded: HistoryIcon,
  sim: SparklesIcon,
};

function Segment({ g }: { g: ProvenanceSegment }) {
  const Icon = ICON[g.tone];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // `group`, not a bare span: ARIA prohibits `aria-label` on a generic element, and axe / Lighthouse fail the
          // page for it (aria-prohibited-attr, weight 7). The segment is a labelled cluster of three hidden spans, so
          // the author-supplied name is the only name it can have.
          role="group"
          tabIndex={0}
          data-provenance={g.key}
          data-tag={g.tag}
          className="inline-flex min-h-7 items-center gap-1.5 rounded focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none"
          aria-label={`${g.label}: ${g.value}. ${g.tooltip}`}
        >
          <span className="text-(--bt-muted)" aria-hidden="true">
            {g.label}:
          </span>
          <span className={cn("bt-display inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold tracking-wider", TONE[g.tone])} aria-hidden="true">
            <Icon className="size-3" aria-hidden="true" />
            {g.tag}
          </span>
          <span className="hidden font-semibold text-(--bt-ink) lg:inline" aria-hidden="true">
            {g.value}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {g.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/** "Relay: <title> v<n>" (§7.6). The flagship shows no version chip: it is the product, not a version of one. */
function RelayChip() {
  const spec = useBaton(specOf);
  const chip = relayChip(spec);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-(--bt-muted)">
      <span className="shrink-0">Relay:</span>
      <span className="truncate font-semibold text-(--bt-ink)">{chip.title}</span>
      {chip.version ? <span className="bt-mono shrink-0 rounded border border-(--bt-line) px-1 text-[10px]">{chip.version}</span> : null}
    </span>
  );
}

export function ProvenanceStrip({ className }: { className?: string }) {
  const env = useConsoleEnv();
  const customerInput = env.inputs && !env.inputs.autopilot && env.inputs.mic ? "mic" : "synthetic";
  const view = useBaton((s) => provenance(s, { customerInput }), sameView);
  const ready = useBaton((s) => !!s.context || !!s.relay);
  if (!ready) return null;
  return (
    <div
      role="note"
      aria-label="Where this run comes from"
      data-simulated={view.simulated ? "1" : "0"}
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--bt-line) bg-(--bt-panel) px-4 py-1 text-[11.5px] leading-snug", className)}
    >
      <RelayChip />
      <span aria-hidden="true" className="hidden h-4 w-px bg-(--bt-line) sm:block" />
      {view.segments.map((g) => (
        <Segment key={g.key} g={g} />
      ))}
      {view.detail ? (
        <p className="w-full text-[11px] text-(--bt-muted) xl:w-auto xl:flex-1 xl:truncate" title={view.detail}>
          {view.detail}
        </p>
      ) : null}
    </div>
  );
}

const sameView = (a: ProvenanceView, b: ProvenanceView): boolean =>
  a.detail === b.detail && a.simulated === b.simulated && a.segments.every((x, i) => x.tag === b.segments[i]?.tag && x.value === b.segments[i]?.value);
