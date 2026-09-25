"use client";
/**
 * QaCard (DESIGN §1.4 S3): Provisional (live transcript.agent) → ✓ Verified from recording (async ch2). Metrics grid;
 * each count expands to its details[] sentences with classification and time; disclosure "View diff" popover.
 */
import { CheckCircle2Icon, ChevronRightIcon, ClipboardCheckIcon, Loader2Icon, ShieldCheckIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { useBaton } from "@/client/store/hooks";
import { formatMmSs, formatMsExact, names } from "@/client/store/selectors";
import type { QaResult } from "@/core/contracts/events";
import type { Wp7UiState } from "@/core/contracts/ext/wp7-ui";
import { FIELD_LABEL } from "@/core/intents/add-driver.fields";
import { cn } from "@/lib/utils";

import { useConsoleEnv, useNow } from "../common/console-context";
import { bestWindow, wordDiff } from "./diff";

type Detail = QaResult["details"][number];
const CLASS_LABEL: Record<Detail["classification"], string> = {
  reask: "re-ask of a verified fact",
  new: "newly asked (was missing)",
  pending_confirm: "confirming a pending fact",
  verified_reconfirm: "confirming a verified fact, with its value",
  advice: "advice",
  other: "other request",
};

function Details({ items, empty }: { items: Detail[]; empty: string }) {
  if (!items.length) return <p className="px-1 pt-1 text-xs text-(--bt-muted)">{empty}</p>;
  return (
    <ul className="space-y-1.5 pt-1.5">
      {items.map((d, i) => (
        <li key={i} className="rounded-md bg-(--bt-panel-2) px-2 py-1.5 text-xs">
          <p className="text-(--bt-ink)">“{d.sentence}”</p>
          <p className="mt-0.5 text-(--bt-muted)">
            <span className="bt-mono">{formatMmSs(d.atMs)}</span> · {CLASS_LABEL[d.classification]}
            {d.field ? ` · ${FIELD_LABEL[d.field]}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

function CountMetric({ label, n, items, big = false, good, emptyText }: { label: string; n: number; items: Detail[]; big?: boolean; good?: boolean; emptyText: string }) {
  return (
    <details className={cn("group rounded-xl border border-(--bt-line) bg-(--bt-panel) px-3 py-2", big && "col-span-2 row-span-2 flex flex-col justify-center")}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-2 focus-visible:outline-none">
        <span className="min-w-0">
          <span className="bt-eyebrow block">{label}</span>
          <span className={cn("bt-display bt-num block leading-none font-bold", big ? "mt-1 text-6xl" : "mt-0.5 text-2xl", good === true && "text-(--verified-fg)", good === false && "text-(--conflict-fg)")}>{n}</span>
        </span>
        <ChevronRightIcon className="mt-1 size-4 shrink-0 text-(--bt-muted) transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className="sr-only">Show the sentences behind this number</span>
      </summary>
      <Details items={items} empty={emptyText} />
    </details>
  );
}

function PlainMetric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className="rounded-xl border border-(--bt-line) bg-(--bt-panel) px-3 py-2">
      <div className="bt-eyebrow">{label}</div>
      <div className={cn("bt-display bt-num mt-0.5 text-lg leading-tight font-bold", tone === "good" && "text-(--verified-fg)", tone === "warn" && "text-(--pending-fg)")}>{value}</div>
      {sub ? <div className="text-[11px] text-(--bt-muted)">{sub}</div> : null}
    </div>
  );
}

function DisclosureMetric({ d, s }: { d: QaResult["disclosures"][number]; s: Pick<Wp7UiState, "tools" | "ai"> }) {
  const tool = s.tools.find((x) => x.name === "get_disclosure" && (x.args as { kind?: string } | null)?.kind === d.kind);
  const required = (tool?.result as { text?: string } | null)?.text ?? null;
  const spokenLine = required
    ? s.ai
        .filter((l) => l.lane === "ai")
        .map((l) => ({ l, score: wordDiff(required, l.text).filter((o) => o.op === "same").length }))
        .sort((a, b) => b.score - a.score)[0]?.l
    : undefined;
  const spoken = required && spokenLine ? bestWindow(required, spokenLine.text) : null;
  const label = d.kind === "premium_change" ? "Premium disclosure verbatim" : "E-sign consent verbatim";
  return (
    <div className="rounded-xl border border-(--bt-line) bg-(--bt-panel) px-3 py-2">
      <div className="bt-eyebrow">{label}</div>
      <div className={cn("bt-display bt-num mt-0.5 flex items-center gap-1 text-lg font-bold", d.ok ? "text-(--verified-fg)" : "text-(--conflict-fg)")}>
        {d.ok ? <CheckCircle2Icon className="size-4" aria-hidden="true" /> : <XCircleIcon className="size-4" aria-hidden="true" />}
        {d.ok ? "Yes" : "No"} <span className="text-sm font-semibold">({d.similarity.toFixed(2)})</span>
      </div>
      {d.missingCritical.length ? <div className="text-[11px] text-(--conflict-fg)">missing: {d.missingCritical.join(", ")}</div> : null}
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger className="text-[11px] font-medium text-(--rep-fg) underline underline-offset-2">View diff</PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content sideOffset={6} className="z-[60] w-[min(380px,calc(100vw-24px))] rounded-xl border border-(--bt-line) bg-(--bt-panel) p-3 text-xs text-(--bt-ink) shadow-xl">
            <div className="bt-eyebrow mb-1">{label}: similarity {d.similarity.toFixed(2)}</div>
            {required && spoken ? (
              <p className="leading-relaxed">
                {wordDiff(required, spoken).map((o, i) => (
                  <span key={i} className={cn(o.op === "missing" && "bg-(--conflict-bg) text-(--conflict-fg) line-through", o.op === "extra" && "bg-(--verified-bg) text-(--verified-fg)")}>
                    {o.text}{" "}
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-(--bt-muted)">The required text and the agent&apos;s words are compared token by token after normalising numbers and punctuation.</p>
            )}
            <p className="mt-2 text-[11px] text-(--bt-muted)">
              <span className="line-through">struck</span> = required but not said · <span className="text-(--verified-fg)">green</span> = said in addition. Pass: similarity ≥ 0.90 and no critical token missing.
            </p>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

const PAYMENT_COPY: Record<QaResult["payment"], { v: string; tone?: "good" | "warn" }> = {
  verified_webhook: { v: "Verified by Polar webhook", tone: "good" },
  verified_poll: { v: "Verified by Polar (server poll)", tone: "good" },
  simulated: { v: "Simulated (mock mode)", tone: "warn" },
  unpaid: { v: "Not paid" },
};

export function QaCardBody() {
  const qa = useBaton((s) => s.qa);
  const tools = useBaton((s) => s.tools);
  const ai = useBaton((s) => s.ai);
  const rep = useBaton((s) => names(s).rep);
  const env = useConsoleEnv();
  const waiting = !qa.verified && qa.status !== "failed";
  useNow(waiting, 1000);
  const r = qa.verified ?? qa.provisional;
  const elapsed = qa.since !== null ? Math.max(0, env.clockNow() - qa.since) : 0;
  const by = (c: Detail["classification"]) => r?.details.filter((d) => d.classification === c) ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {qa.verified ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-(--verified-bg) px-3 py-1 text-sm font-bold text-(--verified-fg)">
            <ShieldCheckIcon className="size-4" aria-hidden="true" /> Verified from recording
          </span>
        ) : qa.status === "failed" ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-(--pending-bg) px-3 py-1 text-sm font-bold text-(--pending-fg)">
            <TriangleAlertIcon className="size-4" aria-hidden="true" /> Provisional
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-(--pending-bg) px-3 py-1 text-sm font-bold text-(--pending-fg)">Provisional</span>
        )}
        {waiting ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-(--bt-muted)" role="status">
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            {elapsed > 60_000 ? "Verification delayed; provisional numbers shown" : `Verifying from the agent's recording… ${Math.round(elapsed / 1000)} s`}
          </span>
        ) : null}
      </div>
      {qa.status === "failed" ? (
        <p role="status" className="rounded-lg border border-(--pending)/50 bg-(--pending-bg) px-3 py-2 text-xs text-(--pending-fg)">
          Couldn&apos;t verify from recording ({qa.reason ?? "unknown reason"}). Provisional numbers shown.
        </p>
      ) : null}
      {r ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CountMetric label="Re-asked" n={r.reAsked} items={by("reask")} big good={r.reAsked === 0} emptyText="No verified fact was asked again." />
          <CountMetric label="Newly asked" n={r.newlyAsked} items={by("new")} emptyText="Nothing was missing, so nothing new was asked." />
          <CountMetric label="Pending confirmed" n={r.pendingConfirmed} items={by("pending_confirm")} emptyText="No pending facts needed confirming." />
          {r.verifiedReconfirmed > 0 ? <CountMetric label="Verified reconfirmed" n={r.verifiedReconfirmed} items={by("verified_reconfirm")} emptyText="" /> : null}
          <PlainMetric label="Advice flags" value={String(r.adviceFlags)} sub="target 0" tone={r.adviceFlags === 0 ? "good" : "warn"} />
          {r.disclosures.map((d) => (
            <DisclosureMetric key={d.kind} d={d} s={{ tools, ai }} />
          ))}
          <PlainMetric label="Click → first audible" value={formatMsExact(r.clickToFirstAudibleMs)} sub={`includes ${rep}'s ≈3.5 s handoff line`} />
          <PlainMetric label={`Dead air after ${rep}'s line`} value={formatMsExact(r.deadAirAfterRepMs)} />
          <PlainMetric label="p50 audible turn latency" value={formatMsExact(r.turnLatencyP50Ms)} />
          <PlainMetric label="Payment" value={PAYMENT_COPY[r.payment].v} {...(PAYMENT_COPY[r.payment].tone ? { tone: PAYMENT_COPY[r.payment].tone } : {})} />
          <PlainMetric label="Hand-back" value={r.handedBack ? "Yes" : "No"} />
          <PlainMetric label="AI minutes" value={(r.aiSeconds / 60).toFixed(1)} sub={`${Math.round(r.aiSeconds)} s`} />
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-(--bt-line-strong) px-3 py-6 text-sm text-(--bt-muted)" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> Computing the provisional numbers…
        </div>
      )}
      <p className="text-[11px] text-(--bt-muted)">
        {qa.verified
          ? "Computed deterministically from the AssemblyAI async multichannel transcript of the agent's own recording (channel 2). "
          : "Provisional: computed from the Voice Agent's live transcript. The verified figures replace these when the recording is analysed. "}
        <a href={env.links.about} className="font-medium text-(--rep-fg) underline underline-offset-2">
          How →
        </a>
      </p>
    </div>
  );
}

export function QaTitle() {
  return (
    <span className="bt-display inline-flex items-center gap-2 text-xl font-bold">
      <ClipboardCheckIcon className="size-5 text-(--ai-fg)" aria-hidden="true" /> Call QA
    </span>
  );
}
