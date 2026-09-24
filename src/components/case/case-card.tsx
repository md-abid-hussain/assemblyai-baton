"use client";
/** CaseCard (DESIGN §1.4 S2 center): header, ReadinessGauge, FieldRow × 10 (+ extras), ConflictCard, AI-confirmed tags. */
import { AlertTriangleIcon, BotIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { memo } from "react";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { caseRows, fieldLabel, names } from "@/client/store/selectors";
import type { ConflictCard as ConflictCardT, FieldId, FieldState } from "@/core/contracts/case";
import { REQUIRED_FIELDS } from "@/core/intents/add-driver.fields";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { Eyebrow } from "../common/bits";
import { chipKindOf, EvidenceChip, playableEvidence, railColor, reasonText, StatusChip, type ChipKind } from "./status";

const RING: Record<ChipKind, string> = {
  VERIFIED: "var(--verified)",
  PENDING: "var(--pending)",
  MISSING: "color-mix(in oklch, var(--missing) 45%, transparent)",
  CONFLICT: "var(--conflict)",
};

export function ReadinessGauge({ fields }: { fields: Record<FieldId, FieldState> | null }) {
  const segs = REQUIRED_FIELDS.map((f) => (fields?.[f] ? chipKindOf(fields[f]) : "MISSING"));
  const v = segs.filter((k) => k === "VERIFIED").length;
  const p = segs.filter((k) => k === "PENDING" || k === "CONFLICT").length;
  const m = segs.length - v - p;
  const R = 34;
  const C = 2 * Math.PI * R;
  const seg = C / segs.length;
  const gap = 3.2;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 88 88" className="size-[76px] shrink-0 -rotate-90" role="img" aria-label={`Readiness: ${v} of ${segs.length} required facts verified, ${p} pending, ${m} missing`}>
        <circle cx="44" cy="44" r={R} fill="none" stroke="var(--bt-line)" strokeWidth="9" />
        {segs.map((k, i) => (
          <circle
            key={REQUIRED_FIELDS[i]}
            cx="44"
            cy="44"
            r={R}
            fill="none"
            stroke={RING[k]}
            strokeWidth="9"
            strokeDasharray={`${seg - gap} ${C - seg + gap}`}
            strokeDashoffset={-i * seg}
            style={{ transition: "stroke 400ms ease" }}
          />
        ))}
        <text x="44" y="44" transform="rotate(90 44 44)" textAnchor="middle" dominantBaseline="central" className="bt-display" fontSize="19" fontWeight="700" fill="var(--bt-ink)">
          {v}/{segs.length}
        </text>
      </svg>
      <ul className="space-y-0.5 text-xs" aria-hidden="true">
        <Count label="verified" n={v} color="var(--verified-fg)" dot="var(--verified)" />
        <Count label="pending" n={p} color="var(--pending-fg)" dot="var(--pending)" />
        <Count label="missing" n={m} color="var(--missing-fg)" dot="var(--missing)" />
      </ul>
    </div>
  );
}

function Count({ label, n, color, dot }: { label: string; n: number; color: string; dot: string }) {
  return (
    <li className="flex items-baseline gap-1.5">
      <span className="bt-display bt-num w-5 text-right text-lg leading-5 font-bold" style={{ color }}>
        {n}
      </span>
      <span aria-hidden="true" className="size-2 self-center rounded-full" style={{ background: dot }} />
      <span className="text-(--bt-muted)">{label}</span>
    </li>
  );
}

const FieldRow = memo(function FieldRow({ f, ai, disagree, agrees, who }: { f: FieldState; ai: boolean; disagree: boolean; agrees: boolean; who: { rep: string; customer: string } }) {
  const kind = chipKindOf(f);
  const evs = playableEvidence(f.evidence);
  const required = (REQUIRED_FIELDS as readonly string[]).includes(f.field);
  const reason = reasonText(f, who);
  return (
    <li className="group relative flex items-stretch gap-2.5 rounded-lg px-2 py-1 hover:bg-(--bt-panel-2)" data-field={f.field} data-status={kind}>
      <span aria-hidden="true" className={cn("w-1 shrink-0 rounded-full", railColor[kind])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-(--bt-muted)">
          <span className="truncate">{fieldLabel(f.field)}</span>
          {!required ? <span className="rounded border border-(--bt-line) px-1 text-[10px]">extra</span> : null}
          {ai ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-(--ai-bg) px-1 text-[10px] font-semibold text-(--ai-fg)">
              <BotIcon className="size-3" aria-hidden="true" />
              AI-confirmed
            </span>
          ) : null}
        </div>
        <div className={cn("bt-display truncate text-[15px] leading-snug font-semibold", !f.display && !f.value && "font-normal text-(--bt-faint)")}>
          {f.display ?? f.value ?? "—"}
        </div>
        {disagree || f.flags.includes("verifier_disagrees") ? (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-(--pending-fg)">
            <ShieldAlertIcon className="size-3" aria-hidden="true" /> verifier disagrees → PENDING
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap-reverse items-center justify-end gap-1">
        {evs.length ? (
          <div className="flex gap-1">
            {evs.slice(0, 2).map((ev) => (
              <EvidenceChip key={`${ev.turnId}-${ev.startMs}`} ev={ev} field={f.field} />
            ))}
          </div>
        ) : null}
        <div className="flex w-[92px] items-center justify-end gap-1">
          {agrees && kind === "VERIFIED" ? (
            <span className="text-(--verified-fg)" title="The async verifier (sol) agrees">
              <ShieldCheckIcon className="size-3.5" aria-label="verifier agrees" />
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="rounded-full focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none" aria-label={`${fieldLabel(f.field)}: ${kind.toLowerCase()}, ${reason}`}>
                <StatusChip kind={kind} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{reason}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </li>
  );
});

export function ConflictCard({ c, who }: { c: ConflictCardT; who: { rep: string; customer: string } }) {
  const partyName = (p: string) => (p === "rep" ? who.rep : p === "customer" ? who.customer : p === "ai" ? "the AI" : p);
  const [a, b] = c.values;
  return (
    <div role="group" aria-label={`Conflict on ${fieldLabel(c.field)}`} className={cn("rounded-lg border p-3", c.resolved ? "border-(--bt-line) bg-(--bt-panel-2)" : "border-(--conflict)/50 bg-(--conflict-bg)")}>
      <div className="flex items-center gap-2 text-sm font-semibold text-(--conflict-fg)">
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        {c.resolved ? "Resolved conflict" : "Conflict"} · {fieldLabel(c.field)}
      </div>
      <p className="mt-1 text-sm text-(--bt-ink)">
        {a && b ? (
          <>
            {partyName(a.party)} said <strong>{a.value}</strong>, {partyName(b.party)} {b.party === "rep" ? "read back" : "said"} <strong>{b.value}</strong>.
          </>
        ) : (
          c.values.map((v) => `${partyName(v.party)}: ${v.value}`).join(" · ")
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {c.values.map((v) => (v.evidence ? <EvidenceChip key={`${v.party}-${v.value}`} ev={v.evidence} field={c.field} /> : null))}
      </div>
      {c.resolved && c.resolution ? <p className="mt-2 text-xs text-(--bt-muted)">Resolution: {c.resolution}</p> : null}
      {!c.resolved ? <p className="mt-2 text-xs text-(--bt-muted)">Stays PENDING: the AI will confirm it instead of assuming.</p> : null}
    </div>
  );
}

export function CaseCard() {
  const cs = useBaton((s) => s.caseState);
  const ai = useBaton((s) => s.aiConfirmed);
  const verifier = useBaton((s) => s.verifier);
  const ctx = useBaton((s) => s.context);
  const who = useBaton((s) => names(s), shallowEqual);
  const rows = caseRows(cs);
  const p = ctx?.policy;
  return (
    <section aria-labelledby="case-h" className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-(--bt-line) px-4 pt-3 pb-3">
        <div className="min-w-0">
          <Eyebrow id="case-h">Case</Eyebrow>
          <div className="bt-display text-xl leading-tight font-bold">Add a driver</div>
          {p ? (
            <div className="mt-0.5 text-xs text-(--bt-muted)">
              <span className="bt-mono">{p.policyNumber}</span> · {p.policyholder.firstName} {p.policyholder.lastName}{" "}
              <span className="rounded border border-(--bt-line) px-1 text-[10px] whitespace-nowrap">policy record</span>
            </div>
          ) : null}
        </div>
        <ReadinessGauge fields={cs?.fields ?? null} />
      </header>
      <div className="bt-scroll min-h-0 flex-1 px-2 py-2">
        {cs?.conflicts.length ? (
          <div className="mb-2 space-y-2 px-2">
            {cs.conflicts.map((c) => (
              <ConflictCard key={c.field} c={c} who={who} />
            ))}
          </div>
        ) : null}
        {rows.length ? (
          <ul aria-label="Case facts" className="space-y-0.5">
            {rows.map((f) => (
              <FieldRow key={f.field} f={f} ai={ai.includes(f.field)} disagree={!!verifier?.disagreements.includes(f.field)} agrees={!!verifier?.agrees} who={who} />
            ))}
          </ul>
        ) : (
          <EmptyCase />
        )}
      </div>
    </section>
  );
}

function EmptyCase() {
  return (
    <ul aria-label="Case facts (waiting for the call)" className="space-y-1 px-2 py-1">
      {REQUIRED_FIELDS.map((f) => (
        <li key={f} className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span aria-hidden="true" className="h-8 w-1 rounded-full bg-(--missing)/40" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-(--bt-muted)">{fieldLabel(f)}</div>
            <div className="h-3 w-28 rounded bg-(--bt-line)" />
          </div>
          <StatusChip kind="MISSING" />
        </li>
      ))}
    </ul>
  );
}
