"use client";
/**
 * Top bar (title, call date, plain-words notice, HUD), narrator strip and the fallback / error banners.
 *
 * The run's provenance lives in ONE place, `ProvenanceStrip` (PLATFORM §7.6): this bar carries no LIVE STT /
 * CACHED REPLAY / RECORDED AI SESSION badge any more, and no provenance banner. The dev-only FIXTURE marker stays,
 * because it says what is driving the page, not where the run comes from.
 */
import { AlertOctagonIcon, CircleAlertIcon, FlaskConicalIcon, HistoryIcon, HomeIcon, InfoIcon, PlayIcon, RotateCcwIcon } from "lucide-react";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { formatCallDate, formatMmSs, narrator, phaseCopy, planNotice, softNotice } from "@/client/store/selectors";
import { cn } from "@/lib/utils";

import { BatonMark, ThemeToggle } from "../common/bits";
import { useActions, useConsoleEnv } from "../common/console-context";
import { LatencyHud } from "../hud/latency-hud";

export function TopBar() {
  const ctx = useBaton((s) => s.context);
  const phase = useBaton((s) => s.phase);
  const notice = useBaton(planNotice);
  const env = useConsoleEnv();
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--bt-line) bg-(--bt-panel)/90 px-4 py-2 backdrop-blur">
      <a href={env.links.home} className="flex shrink-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none" aria-label="Baton home">
        <BatonMark />
        <span className="bt-display hidden text-lg font-bold tracking-tight sm:inline">Baton</span>
      </a>
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="bt-display truncate text-[15px] leading-tight font-semibold" title={ctx?.title}>
          {ctx?.title ?? (phase === "error" ? "Call unavailable" : "Loading call…")}
        </h1>
        <div className="flex items-center gap-2 text-xs text-(--bt-muted)">
          {ctx ? <span>Call date: {formatCallDate(ctx.callDate)}</span> : null}
          {notice ? (
            <span className="hidden min-w-0 items-center gap-1 truncate text-(--bt-cached) lg:inline-flex" title={notice}>
              <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{notice}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {env.fixture ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-(--bt-line-strong) px-2 text-[11px] font-semibold text-(--bt-muted)" title={`Driven by the dev fixture "${env.fixture}", not a live run`}>
            <FlaskConicalIcon className="size-3.5" aria-hidden="true" /> FIXTURE
          </span>
        ) : null}
        <div className="hidden md:block">
          <LatencyHud />
        </div>
        <div className="md:hidden">
          <LatencyHud compact />
        </div>
        <ThemeToggle />
      </div>
      {notice ? <p className="w-full text-xs text-(--bt-cached) lg:hidden">{notice}</p> : null}
    </header>
  );
}

const TONE: Record<ReturnType<typeof narrator>["tone"], string> = {
  neutral: "text-(--bt-muted)",
  human: "text-(--rep-fg)",
  protocol: "text-(--ai-fg)",
  ai: "text-(--ai-fg)",
  // A call to action, not an error: the AI accent (the phone's "Your turn" pill), underlined.
  action: "text-(--ai-fg) underline decoration-(--ai)/45 decoration-2 underline-offset-4",
  done: "text-(--verified-fg)",
  warn: "text-(--pending-fg)",
  error: "text-(--conflict-fg)",
};

export function NarratorStrip() {
  const n = useBaton(narrator, shallowEqual);
  const clock = useBaton((s) => s.clock);
  const dur = useBaton((s) => s.context?.durationMs ?? null);
  const started = useBaton((s) => !!s.started || s.human.length > 0);
  return (
    <div className="flex items-center gap-3 border-b border-(--bt-line) bg-(--bt-panel-2) px-4 py-1.5">
      <span className="bt-display rounded bg-(--bt-ink) px-1.5 py-0.5 text-[10px] font-bold tracking-[0.14em] text-(--bt-panel)">NOW</span>
      <p className={cn("bt-display line-clamp-2 min-w-0 flex-1 text-[14px] leading-tight font-semibold sm:truncate", TONE[n.tone])} aria-live="polite">
        {n.text}
      </p>
      {started && dur ? (
        <span role="timer" className="bt-mono hidden shrink-0 items-center gap-1 text-xs text-(--bt-muted) sm:inline-flex" aria-label={`Call clock ${formatMmSs(clock.callMs)} of ${formatMmSs(dur)}`}>
          <PlayIcon className={cn("size-3", clock.playing ? "fill-current text-(--bt-live)" : "")} aria-hidden="true" />
          {formatMmSs(clock.callMs)} / {formatMmSs(dur)}
        </span>
      ) : null}
    </div>
  );
}

export function Banners() {
  const fallbacks = useBaton((s) => s.fallbacks);
  const phase = useBaton((s) => s.phase);
  const copy = useBaton(phaseCopy, shallowEqual);
  const soft = useBaton(softNotice);
  const hasBundle = useBaton((s) => !!s.context?.hasRecordedAiBundle);
  const unknownCall = useBaton((s) => s.error?.code === "E_NOT_FOUND" && !s.context);
  const actions = useActions();
  const env = useConsoleEnv();
  return (
    <>
      {phase === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-(--conflict)/40 bg-(--conflict-bg) px-4 py-2 text-sm text-(--conflict-fg)">
          <AlertOctagonIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <strong>{copy.title}.</strong> {copy.body}
          </span>
          {unknownCall ? (
            <a href={env.links.home} className="inline-flex h-8 items-center gap-1 rounded-md bg-(--conflict-fg) px-3 text-xs font-semibold text-(--bt-accent-ink)">
              <HomeIcon className="size-3.5" aria-hidden="true" /> All calls
            </a>
          ) : (
            <button type="button" onClick={() => actions.retry()} className="inline-flex h-8 items-center gap-1 rounded-md bg-(--conflict-fg) px-3 text-xs font-semibold text-(--bt-accent-ink)">
              <RotateCcwIcon className="size-3.5" aria-hidden="true" /> Try again
            </button>
          )}
          {hasBundle ? (
            <button type="button" onClick={() => actions.watchReplay()} className="inline-flex h-8 items-center gap-1 rounded-md border border-(--conflict)/50 bg-(--bt-panel) px-3 text-xs font-semibold">
              <HistoryIcon className="size-3.5" aria-hidden="true" /> Watch replay
            </button>
          ) : null}
        </div>
      ) : null}
      {fallbacks.length ? (
        <div role="status" className="border-b border-(--bt-cached)/35 bg-(--bt-cached-bg) px-4 py-1.5 text-xs text-(--bt-cached)">
          {fallbacks.map((f) => (
            <p key={`${f.kind}-${f.t}`} className="flex items-center gap-2">
              <HistoryIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="font-semibold">{f.label}</span>
            </p>
          ))}
        </div>
      ) : null}
      {soft ? (
        <div role="status" className="flex items-center gap-2 border-b border-(--bt-line) bg-(--bt-panel) px-4 py-1 text-xs text-(--bt-muted)">
          <CircleAlertIcon className="size-3.5" aria-hidden="true" />
          {soft}
        </div>
      ) : null}
    </>
  );
}
