/**
 * The provenance strip, read-only (PLATFORM §7.6). WP20·1.
 *
 * Four segments, in the order the call happened: the human half, the transcription, the AI half, and who the
 * customer was while the AI spoke. Each is a plain phrase, not an icon, because the whole point is that a
 * reader can tell a recording from a simulation without a legend.
 *
 * `detail` is the §7.5 sentence a simulated run carries; it is shown verbatim and never summarised.
 */
import type { ProvenanceStrip } from "@/core/contracts/v2/api";
import { cn } from "@/lib/utils";

const HUMAN: Record<ProvenanceStrip["humanHalf"], { label: string; tone: Tone }> = {
  recorded: { label: "Recorded role-play", tone: "ok" },
  simulated: { label: "Simulated call", tone: "warn" },
  text_dry_run: { label: "Text dry run", tone: "quiet" },
};

const TRANSCRIPTION: Record<ProvenanceStrip["transcription"]["kind"], { label: string; tone: Tone }> = {
  live: { label: "Transcribed live", tone: "ok" },
  cached: { label: "Cached transcript", tone: "quiet" },
};

const AI_HALF: Record<ProvenanceStrip["aiHalf"]["kind"], { label: string; tone: Tone }> = {
  live: { label: "Live voice agent", tone: "ok" },
  recorded: { label: "Recorded AI half", tone: "quiet" },
  none: { label: "No AI half", tone: "quiet" },
};

const CUSTOMER: Record<ProvenanceStrip["customerInAiHalf"], { label: string; tone: Tone }> = {
  recorded: { label: "Recorded customer", tone: "ok" },
  synthetic: { label: "Synthetic customer", tone: "warn" },
  mic: { label: "You on the mic", tone: "quiet" },
  none: { label: "No customer audio", tone: "quiet" },
};

type Tone = "ok" | "warn" | "quiet";

const TONE: Record<Tone, string> = {
  ok: "text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))] border-[var(--cx-ok)]/30",
  warn: "text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))] border-[var(--cx-warn)]/35",
  quiet: "text-muted-foreground border-border",
};

function Segment({ caption, label, tone, date }: { caption: string; label: string; tone: Tone; date?: string | null }) {
  return (
    <li className={cn("min-w-0 flex-1 basis-[10rem] rounded-lg border px-3 py-2", TONE[tone])}>
      <p className="cx-eyebrow">{caption}</p>
      <p className="mt-0.5 text-sm font-medium text-pretty">{label}</p>
      {date ? <p className="text-muted-foreground cx-num text-[11px]">{date}</p> : null}
    </li>
  );
}

export function ProvenanceStripView({ strip, className }: { strip: ProvenanceStrip; className?: string }) {
  const human = HUMAN[strip.humanHalf];
  const trans = TRANSCRIPTION[strip.transcription.kind];
  const ai = AI_HALF[strip.aiHalf.kind];
  const cust = CUSTOMER[strip.customerInAiHalf];
  return (
    <div className={cn("space-y-2", className)}>
      <ul className="flex flex-wrap gap-2" aria-label="Where this run's evidence came from">
        <Segment caption="Human half" label={human.label} tone={human.tone} />
        <Segment caption="Transcription" label={trans.label} tone={trans.tone} date={strip.transcription.date} />
        <Segment caption="AI half" label={ai.label} tone={ai.tone} date={strip.aiHalf.date} />
        <Segment caption="Customer in the AI half" label={cust.label} tone={cust.tone} />
      </ul>
      {strip.detail ? <p className="text-muted-foreground text-xs text-pretty">{strip.detail}</p> : null}
    </div>
  );
}
