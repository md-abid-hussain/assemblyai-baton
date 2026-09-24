"use client";
/**
 * CallTimeline (DESIGN §1.4 S2 bottom): both channels' waveform from precomputed peaks (rep up, customer down), the
 * playhead, turn blocks, fact markers (diamonds colored by status), the takeover marker and the AI-half segment.
 */
import { useMemo } from "react";

import { useBaton } from "@/client/store/hooks";
import { caseRows, fieldLabel, formatCallClock, formatMmSs, names } from "@/client/store/selectors";
import type { Peaks } from "@/core/contracts/scenario";
import { cn } from "@/lib/utils";

import { chipKindOf } from "../case/status";

const BARS = 320;

function bucket(xs: readonly number[], n: number): number[] {
  if (!xs.length) return new Array<number>(n).fill(0);
  const out = new Array<number>(n).fill(0);
  const per = xs.length / n;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor(i * per);
    const b = Math.min(xs.length, Math.floor((i + 1) * per) + 1);
    for (let j = a; j < b; j++) m = Math.max(m, xs[j] ?? 0);
    out[i] = m;
  }
  return out;
}

function wavePath(vals: number[], dir: 1 | -1): string {
  const w = 1000 / vals.length;
  let d = "";
  vals.forEach((v, i) => {
    const h = Math.max(0.6, v * 30);
    const x = i * w + w * 0.18;
    d += `M${x.toFixed(2)} 40v${(-dir * h).toFixed(2)}h${(w * 0.64).toFixed(2)}v${(dir * h).toFixed(2)}z`;
  });
  return d;
}

const DIAMOND: Record<string, string> = {
  VERIFIED: "bg-(--verified)",
  PENDING: "bg-(--pending)",
  MISSING: "bg-(--missing)",
  CONFLICT: "bg-(--conflict)",
};

export function CallTimeline({ className }: { className?: string }) {
  const ctx = useBaton((s) => s.context);
  const clock = useBaton((s) => s.clock.callMs);
  const human = useBaton((s) => s.human);
  const cs = useBaton((s) => s.caseState);
  const tArm = useBaton((s) => s.takeover.tArmMs);
  const started = useBaton((s) => s.started);
  const rep = useBaton((s) => names(s).rep);
  const dur = ctx?.durationMs ?? 0;
  const peaks: Peaks | null = ctx?.peaks ?? null;
  const waves = useMemo(() => (peaks ? { rep: wavePath(bucket(peaks.rep, BARS), 1), customer: wavePath(bucket(peaks.customer, BARS), -1) } : null), [peaks]);
  if (!ctx || dur <= 0) return <div className={cn("h-[86px]", className)} />;
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`;
  const markers = caseRows(cs)
    .filter((f) => f.evidence[0] && f.evidence[0].channel !== "ai" && f.evidence[0].channel !== "customer_ai")
    .map((f) => ({ field: f.field, kind: chipKindOf(f), at: f.evidence[f.evidence.length - 1]?.startMs ?? 0 }));
  const prefillTo = started?.kind === "express" ? started.startOffsetMs : 0;
  const handoff = ctx.handoff;
  const summary = `Call timeline, ${formatMmSs(dur)} long; playhead at ${formatMmSs(clock)}${tArm !== null ? `; baton passed at ${formatCallClock(tArm)}` : ""}; ${markers.length} fact markers.`;
  return (
    <div className={cn("relative select-none", className)} role="img" aria-label={summary}>
      <div className="relative h-[70px] overflow-hidden rounded-lg border border-(--bt-line) bg-(--bt-panel)">
        {prefillTo > 0 ? (
          <div className="absolute inset-y-0 left-0 border-r border-dashed border-(--bt-cached)/60 bg-(--bt-cached-bg)/60" style={{ width: pct(prefillTo) }}>
            <span className="absolute top-0.5 left-1 text-[9px] font-semibold text-(--bt-cached) uppercase">cached prefill</span>
          </div>
        ) : null}
        {tArm !== null ? <div className="bt-hatch absolute inset-y-0 right-0 border-l-2 border-(--ai)" style={{ left: pct(tArm) }} /> : null}
        {waves ? (
          <svg viewBox="0 0 1000 80" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
            <path d={waves.rep} fill="var(--rep)" opacity="0.75" />
            <path d={waves.customer} fill="var(--customer)" opacity="0.75" />
            <line x1="0" x2="1000" y1="40" y2="40" stroke="var(--bt-line-strong)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        {human.map((l) =>
          l.startMs !== null && l.endMs !== null ? (
            <div
              key={l.id}
              aria-hidden="true"
              className={cn("absolute h-[3px] rounded-full", l.lane === "rep" ? "top-1 bg-(--rep)" : "bottom-1 bg-(--customer)", l.source === "cached" && "opacity-50")}
              style={{ left: pct(l.startMs), width: `${Math.max(0.3, ((l.endMs - l.startMs) / dur) * 100)}%` }}
            />
          ) : null,
        )}
        {handoff && !handoff.declined ? (
          <div className="absolute inset-y-0 w-px bg-(--rep-fg)/60" style={{ left: pct(handoff.lineStartMs) }} aria-hidden="true">
            <span className="absolute bottom-0.5 left-1 whitespace-nowrap text-[9px] font-semibold text-(--rep-fg)">{rep}&apos;s handoff</span>
          </div>
        ) : null}
        {markers.map((m) => (
          <span
            key={m.field}
            title={`${fieldLabel(m.field)}: ${m.kind.toLowerCase()}`}
            className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-2 ring-(--bt-panel)", DIAMOND[m.kind])}
            style={{ left: pct(m.at) }}
          />
        ))}
        {tArm !== null ? (
          <div className="absolute inset-y-0 w-0.5 bg-(--ai)" style={{ left: pct(tArm) }} aria-hidden="true">
            <span className="bt-display absolute -top-px left-1 rounded-b bg-(--ai) px-1 text-[9px] font-bold whitespace-nowrap text-white">PASS {formatCallClock(tArm)}</span>

          </div>
        ) : null}
        <div className="absolute inset-y-0 w-0.5 bg-(--bt-ink) transition-[left] duration-200 ease-linear" style={{ left: pct(clock) }} aria-hidden="true">
          <span className="absolute -top-1 -left-[3px] size-2 rounded-full bg-(--bt-ink)" />
        </div>
      </div>
      <div className="bt-mono mt-1 flex justify-between text-[10px] text-(--bt-faint)" aria-hidden="true">
        <span>00:00</span>
        <span>{formatMmSs(dur / 2)}</span>
        <span>{formatMmSs(dur)}</span>
      </div>
    </div>
  );
}
