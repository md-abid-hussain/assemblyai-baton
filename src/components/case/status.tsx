"use client";
/** Status chip, evidence chip and the reason copy for the case card (DESIGN §1.4 S2 center column, §5.11). */
import { AlertTriangleIcon, CheckCircle2Icon, CircleDashedIcon, CircleIcon, Loader2Icon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { formatMmSs } from "@/client/store/selectors";
import type { Evidence, FieldId, FieldState, FieldStatus, StatusReason } from "@/core/contracts/case";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useActions } from "../common/console-context";

export type ChipKind = FieldStatus | "CONFLICT";

export const chipKindOf = (f: Pick<FieldState, "status" | "reason" | "conflict">): ChipKind =>
  f.reason === "conflict" || (f.conflict && f.status !== "VERIFIED") ? "CONFLICT" : f.status;

const CHIP: Record<ChipKind, { label: string; cls: string; Icon: typeof CheckCircle2Icon }> = {
  VERIFIED: { label: "Verified", cls: "bg-(--verified-bg) text-(--verified-fg) border-(--verified)/40", Icon: CheckCircle2Icon },
  PENDING: { label: "Pending", cls: "bg-(--pending-bg) text-(--pending-fg) border-(--pending)/60", Icon: CircleDashedIcon },
  MISSING: { label: "Missing", cls: "bg-(--missing-bg) text-(--missing-fg) border-(--missing)/40", Icon: CircleIcon },
  CONFLICT: { label: "Conflict", cls: "bg-(--conflict-bg) text-(--conflict-fg) border-(--conflict)/50", Icon: AlertTriangleIcon },
};

export const railColor: Record<ChipKind, string> = {
  VERIFIED: "bg-(--verified)",
  PENDING: "bg-(--pending)",
  MISSING: "bg-(--missing)/60",
  CONFLICT: "bg-(--conflict)",
};

export function StatusChip({ kind, className }: { kind: ChipKind; className?: string }) {
  const c = CHIP[kind];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase bt-display", c.cls, className)}>
      <c.Icon className="size-3" aria-hidden="true" />
      {c.label}
    </span>
  );
}

const WHO: Record<string, string> = { rep: "the rep", customer: "the customer", ai: "the AI", customer_ai: "the customer (to the AI)" };

/** "acknowledged by customer at 01:12" (the reason tooltip). */
export function reasonText(f: FieldState, names: { rep: string; customer: string }): string {
  const ev = f.evidence[0];
  const at = ev ? ` at ${formatMmSs(ev.startMs)}` : f.updatedAtMs ? ` at ${formatMmSs(f.updatedAtMs)}` : "";
  const by = ev ? (ev.channel === "rep" ? names.rep : ev.channel === "customer" ? names.customer : WHO[ev.channel]) : "";
  const map: Record<StatusReason, string> = {
    acknowledged: `acknowledged by ${by || "the other party"}${at}`,
    read_back: `read back by ${by || "the rep"}${at}`,
    both_stated: `stated by both parties${at}`,
    policy_record: "from the policy record",
    ai_confirmed: `confirmed by ${names.customer} to the AI`,
    stated_once: `stated once by ${by || "one party"}${at}; not confirmed yet`,
    late_turn: "arrived after the pass; the AI did not rely on it",
    conflict: "the parties said different things",
    denied: `denied${at}`,
    verifier_disagrees: "the verifier disagrees, so it stays pending",
    verifier_only: "only the verifier heard it; the AI will confirm it",
    rep_only_violation: "only the rep can verify this field",
    out_of_range: "outside the allowed date window; the AI will confirm it",
    absent: "not mentioned yet",
  };
  return map[f.reason];
}

const CH_CLS: Record<Evidence["channel"], string> = {
  rep: "text-(--rep-fg) border-(--rep)/35 hover:bg-(--rep-bg)",
  customer: "text-(--customer-fg) border-(--customer)/40 hover:bg-(--customer-bg)",
  ai: "text-(--ai-fg) border-(--ai)/35 hover:bg-(--ai-bg)",
  customer_ai: "text-(--customer-fg) border-(--customer)/40 hover:bg-(--customer-bg)",
};
const CH_NAME: Record<Evidence["channel"], string> = { rep: "rep", customer: "customer", ai: "AI", customer_ai: "customer" };

/** ▶ plays a padded clip of the call (§5.11). AI-half chips appear only once verified from the recording. */
export function EvidenceChip({ ev, field }: { ev: Evidence; field: FieldId | null }) {
  const actions = useActions();
  const [playing, setPlaying] = useState(false);
  const play = async () => {
    if (playing) return;
    setPlaying(true);
    try {
      await actions.playEvidence(ev, field);
    } finally {
      setPlaying(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={play}
          aria-label={`Play evidence from the ${CH_NAME[ev.channel]} at ${formatMmSs(ev.startMs)}: “${ev.quote}”`}
          aria-pressed={playing}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border bg-(--bt-panel) px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none",
            CH_CLS[ev.channel],
            playing && "ring-2 ring-current/30",
          )}
        >
          {playing ? <Loader2Icon className="size-3 animate-spin" aria-hidden="true" /> : <PlayIcon className="size-3 fill-current" aria-hidden="true" />}
          <span className="bt-mono">{formatMmSs(ev.startMs)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <span className="font-semibold">{CH_NAME[ev.channel][0]?.toUpperCase() + CH_NAME[ev.channel].slice(1)}:</span> “{ev.quote}”
        {ev.source === "stt_cache" ? <span className="opacity-75"> (cached transcript)</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export const playableEvidence = (evs: readonly Evidence[]): Evidence[] =>
  evs.filter((e) => e.source !== "va_transcript").slice(0, 3);
