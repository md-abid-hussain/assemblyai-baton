/**
 * The evidence-linked case record, read-only (SAAS §6.2 `CaseV1`). WP20·1.
 *
 * This is the page a judge opens to check whether "evidence-linked" is a word or a feature. Every field shows
 * its status, its value, the sentence explaining *why* it has that status, and the quotes it came from with
 * their timecodes. A field with no evidence says so; it never borrows a neighbour's quote.
 *
 * WP7's console renders the same facts live, but its components are bound to the Zustand run store
 * (`useBaton`), so they cannot render from a row. These are the read-only twins: same vocabulary, same status
 * words, no store.
 */
import { AlertTriangleIcon, CheckCircle2Icon, CircleDashedIcon, CircleIcon, QuoteIcon } from "lucide-react";

import type { CaseRecordView, DisclosureRowView, EvidenceView, FieldRowView } from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

type Chip = "VERIFIED" | "PENDING" | "MISSING" | "CONFLICT";

const chipOf = (f: FieldRowView): Chip => (f.conflict ? "CONFLICT" : (f.status as Chip));

const CHIP: Record<Chip, { label: string; cls: string; Icon: typeof CheckCircle2Icon }> = {
  VERIFIED: {
    label: "Verified",
    cls: "border-[var(--cx-ok)]/40 text-[color-mix(in_oklch,var(--success)_72%,var(--foreground))]",
    Icon: CheckCircle2Icon,
  },
  PENDING: {
    label: "Pending",
    cls: "border-[var(--cx-warn)]/45 text-[color-mix(in_oklch,var(--warning)_72%,var(--foreground))]",
    Icon: CircleDashedIcon,
  },
  MISSING: { label: "Missing", cls: "border-border text-muted-foreground", Icon: CircleIcon },
  CONFLICT: { label: "Conflict", cls: "border-destructive/45 text-destructive", Icon: AlertTriangleIcon },
};

const RAIL: Record<Chip, string> = {
  VERIFIED: "bg-[var(--cx-ok)]",
  PENDING: "bg-[var(--cx-warn)]",
  MISSING: "bg-border",
  CONFLICT: "bg-destructive",
};

const mmss = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const WHO: Record<EvidenceView["channel"], string> = {
  rep: "Rep",
  customer: "Customer",
  ai: "AI",
  customer_ai: "Customer → AI",
};

export function StatusChip({ kind, className }: { kind: Chip; className?: string }) {
  const c = CHIP[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        c.cls,
        className,
      )}
    >
      <c.Icon className="size-3" aria-hidden="true" />
      {c.label}
    </span>
  );
}

function Evidence({ e }: { e: EvidenceView }) {
  return (
    <li className="text-muted-foreground flex gap-2 text-xs">
      <QuoteIcon className="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden="true" />
      <span className="min-w-0">
        <span className="text-foreground/80 font-medium">{WHO[e.channel]}</span>{" "}
        <span className="cx-num tabular-nums">
          {mmss(e.startMs)}–{mmss(e.endMs)}
        </span>
        <span className="block text-pretty italic">&ldquo;{e.quote}&rdquo;</span>
      </span>
    </li>
  );
}

function FieldRow({ f }: { f: FieldRowView }) {
  const kind = chipOf(f);
  return (
    <li className="relative flex gap-3 py-3 pl-4">
      <span className={cn("absolute top-3 bottom-3 left-0 w-0.5 rounded-full", RAIL[kind])} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium">
            {f.label}
            {f.required ? null : <span className="text-muted-foreground text-xs font-normal"> · extra</span>}
          </p>
          <StatusChip kind={kind} />
        </div>
        <p className="text-sm">
          {f.value ? (
            <span className="font-medium">{f.value}</span>
          ) : (
            <span className="text-muted-foreground">Not captured</span>
          )}
        </p>
        <p className="text-muted-foreground text-xs text-pretty">{f.reason}</p>
        {f.evidence.length > 0 ? (
          <ul className="space-y-1.5 pt-1">
            {f.evidence.slice(0, 3).map((e, i) => (
              <Evidence key={`${e.channel}-${e.startMs}-${i}`} e={e} />
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function DisclosureRow({ d }: { d: DisclosureRowView }) {
  const label = d.kind.replace(/_/g, " ");
  const ok = d.ok === true;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
      <span className="text-sm capitalize">{label}</span>
      <span className="flex items-center gap-2">
        {d.similarity !== null ? (
          <span className="text-muted-foreground cx-num text-xs">{Math.round(d.similarity * 100)}% match</span>
        ) : null}
        <StatusChip kind={d.ok === null ? (d.given ? "PENDING" : "MISSING") : ok ? "VERIFIED" : "CONFLICT"} />
      </span>
      {d.missingCritical.length > 0 ? (
        <span className="text-destructive w-full text-xs">Missing: {d.missingCritical.join(", ")}</span>
      ) : null}
    </li>
  );
}

export function CaseRecord({ record }: { record: CaseRecordView }) {
  const r = record.readiness;
  return (
    <div className="space-y-5">
      <div className="bg-card flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3">
        <p className="cx-num text-sm">
          <span className="text-lg font-semibold">
            {r.verified}/{r.requiredTotal}
          </span>{" "}
          <span className="text-muted-foreground">required facts verified</span>
        </p>
        <p className="text-muted-foreground cx-num text-xs">
          {r.pending} pending · {r.missing} missing
        </p>
        {record.stage ? (
          <p className="text-muted-foreground text-xs">
            Stage: <span className="text-foreground font-medium capitalize">{record.stage.replace(/_/g, " ")}</span>
          </p>
        ) : null}
        {record.confirmationNumber ? (
          <p className="text-muted-foreground ml-auto text-xs">
            Confirmation{" "}
            <span className="text-foreground cx-num font-mono font-medium">{record.confirmationNumber}</span>
          </p>
        ) : null}
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Facts and their evidence</h3>
        <ul className="bg-card divide-y rounded-xl border px-4">
          {record.fields.map((f) => (
            <FieldRow key={f.field} f={f} />
          ))}
        </ul>
      </section>

      {record.disclosures.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Disclosures</h3>
          <ul className="bg-card divide-y rounded-xl border px-4">
            {record.disclosures.map((d) => (
              <DisclosureRow key={d.kind} d={d} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
