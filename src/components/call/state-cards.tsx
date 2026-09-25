"use client";
/** Per-state cards of S2: pre-flight, queued, connecting, paused, audio locked, hand-back, call ended, QA sheet. */
import { ClipboardCheckIcon, ExternalLinkIcon, HistoryIcon, Loader2Icon, PauseIcon, PlayIcon, UndoIcon, Volume2Icon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { formatCallDate, formatMmSs, humanReason, names, phaseCopy } from "@/client/store/selectors";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { Eyebrow, LiveDot } from "../common/bits";
import { useActions, useConsoleEnv, useNow } from "../common/console-context";
import { QaCardBody, QaTitle } from "../qa/qa-card";

const AI_HALF_MIN = 2.5;
/** `/call/[id]?express=1` (the landing CTA, PLATFORM §12.1): Express starts after this countdown. */
export const EXPRESS_COUNTDOWN_S = 3;

/**
 * Counts down from `seconds` while `active`, then calls `onDone` once. Returns the seconds left (null when inactive).
 * `onDone` runs from a timer, not a click: the landing CTA's click created and resumed the AudioContext (DESIGN
 * autoplay rule); a deep link without that click gets the "Tap to enable sound" overlay from the orchestrator.
 */
export function useCountdown(active: boolean, seconds: number, onDone: () => void): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!active) {
      setLeft(null);
      return;
    }
    const t0 = Date.now();
    setLeft(seconds);
    const id = setInterval(() => {
      const l = seconds - Math.floor((Date.now() - t0) / 1000);
      if (l > 0) {
        setLeft(l);
        return;
      }
      clearInterval(id);
      setLeft(0);
      done.current();
    }, 100);
    return () => clearInterval(id);
  }, [active, seconds]);
  return left;
}

export function PreflightCard() {
  const actions = useActions();
  const env = useConsoleEnv();
  const ctx = useBaton((s) => s.context);
  const plan = useBaton((s) => s.plan);
  const phase = useBaton((s) => s.phase);
  const [cancelled, setCancelled] = useState(false);
  const canExpress = !!ctx && ctx.decisionPointMs !== null;
  const counting = env.autoStart === "express" && canExpress && !!plan && phase === "preflight" && !cancelled;
  const left = useCountdown(counting, EXPRESS_COUNTDOWN_S, () => actions.start("express"));
  const [ios, setIos] = useState(false);
  useEffect(() => {
    setIos(/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  }, []);
  if (!ctx) {
    return (
      <div className="bt-panel w-full max-w-xl p-6" role="status">
        <Loader2Icon className="size-5 animate-spin" aria-hidden="true" /> Loading the call…
      </div>
    );
  }
  const { rep } = names({ context: ctx });
  const replay = plan?.aiHalf === "recorded" || plan?.sttHalf === "cached";
  const expressStart = ctx.decisionPointMs !== null ? Math.max(0, ctx.decisionPointMs - 25_000) : null;
  const expressMin = expressStart !== null ? Math.round((ctx.durationMs - expressStart) / 60_000 + AI_HALF_MIN) : null;
  const fullMin = Math.round(ctx.durationMs / 60_000 + AI_HALF_MIN);
  if (counting && left !== null) {
    return (
      <ExpressCountdownCard
        left={left}
        minutes={expressMin}
        title={`${ctx.policy.policyholder.firstName} calls to add a driver. ${rep} diagnoses, then passes the baton to an AI.`}
        onNow={() => actions.start("express")}
        onFull={() => {
          setCancelled(true);
          actions.start("full");
        }}
        onCancel={() => setCancelled(true)}
        ios={ios}
      />
    );
  }
  return (
    <section aria-labelledby="pre-h" className="bt-panel bt-rise w-full max-w-xl overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-(--rep) via-(--customer) to-(--ai)" aria-hidden="true" />
      <div className="p-6">
        <Eyebrow as="p">Watch a real call · no mic needed</Eyebrow>
        <h2 id="pre-h" className="bt-display mt-1 text-2xl leading-tight font-bold">
          {ctx.policy.policyholder.firstName} calls to add a driver. {rep} diagnoses, then passes the baton to an AI.
        </h2>
        {replay ? (
          <p className="mt-3 rounded-lg border border-(--bt-cached)/40 bg-(--bt-cached-bg) px-3 py-2 text-sm text-(--bt-cached)">
            <HistoryIcon className="mr-1 inline size-4 align-[-3px]" aria-hidden="true" />
            {plan?.reason ?? "Live budget for today is used up (or live AI is busy)."} You&apos;ll watch a labelled run: real audio, AssemblyAI transcripts{plan?.sttHalf === "cached" ? " cached earlier" : " live"}
            {plan?.aiHalf === "recorded" ? `, and the recorded AI session at ${rep}'s handoff line` : ""}.
          </p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-(--bt-ink)">
            This is a real role-play phone call recorded by volunteers (consented). It streams through <strong>two live AssemblyAI Universal-3.5 Pro sessions</strong>, one per speaker.
            Call date: <strong>{formatCallDate(ctx.callDate)}</strong>; the AI half runs as of that date.
          </p>
        )}
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {expressMin !== null ? (
            <button
              type="button"
              onClick={() => actions.start("express")}
              className="bt-pass bt-display inline-flex h-14 items-center justify-center gap-2 rounded-xl text-lg font-bold focus-visible:ring-4 focus-visible:ring-(--ai)/40 focus-visible:outline-none"
            >
              <ZapIcon className="size-5" aria-hidden="true" /> Express · about {expressMin} min
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => actions.start("full")}
            className="bt-display inline-flex h-14 items-center justify-center gap-2 rounded-xl border border-(--bt-line-strong) bg-(--bt-panel) text-lg font-bold hover:bg-(--bt-panel-2) focus-visible:ring-4 focus-visible:ring-(--ai)/30 focus-visible:outline-none"
          >
            <PlayIcon className="size-5" aria-hidden="true" /> Full call · about {fullMin} min
          </button>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-(--bt-muted)">
          <Volume2Icon className="size-3.5" aria-hidden="true" />
          {expressMin !== null ? `Express fast-forwards to 25 s before the decision point with cached transcription (labelled). ` : ""}Sound on: the recording plays out loud.
          {ios ? " No sound? Turn off silent mode." : ""}
        </p>
      </div>
    </section>
  );
}

function ExpressCountdownCard(p: { left: number; minutes: number | null; title: string; onNow(): void; onFull(): void; onCancel(): void; ios: boolean }) {
  const pct = Math.max(0, Math.min(1, p.left / EXPRESS_COUNTDOWN_S));
  return (
    <section aria-labelledby="pre-h" className="bt-panel bt-rise w-full max-w-xl overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-(--rep) via-(--customer) to-(--ai)" aria-hidden="true" />
      <div className="p-6">
        <Eyebrow as="p">Watch the handoff · no mic needed</Eyebrow>
        <h2 id="pre-h" className="bt-display mt-1 text-2xl leading-tight font-bold">
          {p.title}
        </h2>
        <div className="mt-5 flex items-center gap-4">
          <div className="relative size-16 shrink-0" aria-hidden="true">
            <svg viewBox="0 0 36 36" className="size-16 -rotate-90">
              <circle cx="18" cy="18" r="16" fill="none" stroke="var(--bt-line)" strokeWidth="3" />
              <circle cx="18" cy="18" r="16" fill="none" stroke="var(--ai)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(pct * 100.5).toFixed(1)} 100.5`} className="transition-[stroke-dasharray] duration-200" />
            </svg>
            <span className="bt-display bt-num absolute inset-0 flex items-center justify-center text-2xl font-bold">{p.left}</span>
          </div>
          <p className="min-w-0 text-sm leading-relaxed" role="status" aria-live="polite">
            <strong>Express starts in {p.left} s</strong>
            {p.minutes !== null ? ` · about ${p.minutes} min` : ""}. It fast-forwards to 25 s before the handoff with cached transcription (labelled), then streams live.
          </p>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={p.onNow}
            className="bt-pass bt-display inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-base font-bold focus-visible:ring-4 focus-visible:ring-(--ai)/40 focus-visible:outline-none"
          >
            <ZapIcon className="size-5" aria-hidden="true" /> Start now
          </button>
          <button type="button" onClick={p.onFull} className="text-sm font-semibold text-(--rep-fg) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none">
            Full call instead
          </button>
          <button type="button" onClick={p.onCancel} className="ml-auto text-xs text-(--bt-muted) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none">
            Wait, let me choose
          </button>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-(--bt-muted)">
          <Volume2Icon className="size-3.5" aria-hidden="true" />
          Sound on: the recording plays out loud.{p.ios ? " No sound? Turn off silent mode." : ""}
        </p>
      </div>
    </section>
  );
}

export function QueuedCard() {
  const actions = useActions();
  const copy = useBaton(phaseCopy, shallowEqual);
  const q = useBaton((s) => s.queue);
  const env = useConsoleEnv();
  useNow(true, 250);
  const left = q ? Math.max(0, q.etaMs - (env.clockNow() - q.t)) : null;
  return (
    <div className="space-y-3" role="status">
      <div className="flex items-center gap-2">
        <Loader2Icon className="size-5 animate-spin text-(--rep-fg)" aria-hidden="true" />
        <h3 className="bt-display text-lg font-bold">{copy.title}</h3>
      </div>
      <p className="text-sm">{copy.body}</p>
      {left !== null ? (
        <div className="bt-display bt-num text-4xl font-bold text-(--rep-fg)" aria-label={`about ${Math.ceil(left / 1000)} seconds`}>
          {Math.ceil(left / 1000)} s
        </div>
      ) : null}
      <button type="button" onClick={() => actions.watchCachedNow()} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-(--bt-line-strong) px-3 text-sm font-semibold hover:bg-(--bt-panel-2)">
        <HistoryIcon className="size-4" aria-hidden="true" /> Watch the cached replay now
      </button>
    </div>
  );
}

export function ConnectingCard() {
  const stt = useBaton((s) => s.stt);
  const copy = useBaton(phaseCopy, shallowEqual);
  const dot = (st: string) => (st === "open" ? "text-(--bt-live)" : st === "error" ? "text-(--conflict)" : "text-(--pending)");
  return (
    <div className="space-y-3" role="status">
      <div className="flex items-center gap-2">
        <Loader2Icon className="size-5 animate-spin text-(--rep-fg)" aria-hidden="true" />
        <h3 className="bt-display text-lg font-bold">{copy.title}</h3>
      </div>
      <p className="text-sm text-(--bt-muted)">{copy.body}</p>
      <ul className="space-y-1 text-sm">
        {(["rep", "customer"] as const).map((ch) => (
          <li key={ch} className="flex items-center gap-2">
            <LiveDot className={dot(stt[ch].status)} pulse={stt[ch].status !== "open"} />
            <span className="capitalize">{ch}</span>
            <span className="text-xs text-(--bt-muted)">{stt[ch].status === "idle" ? "waiting" : stt[ch].status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PausedOverlay() {
  const actions = useActions();
  const phase = useBaton((s) => s.phase);
  const copy = useBaton(phaseCopy, shallowEqual);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "paused") ref.current?.focus();
  }, [phase]);
  if (phase !== "paused") return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--bt-bg)/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="paused-h">
      <div className="bt-panel w-full max-w-sm p-6 text-center">
        <PauseIcon className="mx-auto size-8 text-(--pending-fg)" aria-hidden="true" />
        <h2 id="paused-h" className="bt-display mt-2 text-2xl font-bold">
          {copy.title}
        </h2>
        <p className="mt-1 text-sm text-(--bt-muted)">{copy.body}</p>
        <button ref={ref} type="button" onClick={() => actions.resume()} className="bt-pass bt-display mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-lg font-bold">
          <PlayIcon className="size-5" aria-hidden="true" /> Tap to resume
        </button>
      </div>
    </div>
  );
}

export function AudioLockedOverlay() {
  const actions = useActions();
  const locked = useBaton((s) => s.audioLocked);
  if (!locked) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--bt-bg)/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Enable sound">
      <button type="button" onClick={() => actions.unlockAudio()} className="bt-pass bt-display inline-flex h-14 items-center gap-2 rounded-xl px-6 text-lg font-bold">
        <Volume2Icon className="size-5" aria-hidden="true" /> Tap to enable sound
      </button>
    </div>
  );
}

export function HandBackCard() {
  const hb = useBaton((s) => s.handBack);
  const ai = useBaton((s) => s.aiConfirmed.length);
  const rep = useBaton((s) => names(s).rep);
  if (!hb) return null;
  return (
    <div className="rounded-xl border border-(--rep)/40 bg-(--rep-bg) p-3">
      <div className="flex items-center gap-2 text-sm font-bold text-(--rep-fg)">
        <UndoIcon className="size-4" aria-hidden="true" /> {rep} has the call back · reason: {humanReason(hb.reason)}
      </div>
      {hb.summary ? (
        <p className="mt-1.5 text-sm text-(--bt-ink)">
          <span className="font-semibold">What {rep} sees:</span> {hb.summary}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-(--bt-muted)">{ai ? `${ai} fact${ai === 1 ? "" : "s"} confirmed by the AI (violet tags on the case card).` : "No facts were changed by the AI."}</p>
    </div>
  );
}

export function CallEndedCard() {
  const env = useConsoleEnv();
  return (
    <div className="rounded-xl border border-(--bt-line) bg-(--bt-panel-2) p-3 text-sm">
      <p className="font-semibold">Call ended without a baton pass.</p>
      <p className="mt-1 text-xs text-(--bt-muted)">The Takeover Explorer shows what the AI would have said at any second of this call.</p>
      <a href={env.links.explorer} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-(--rep-fg) underline underline-offset-2">
        Open the Explorer <ExternalLinkIcon className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

/** The QA card as a sheet (opens by itself on completed / handed-back) plus a re-open button. */
export function QaSheet() {
  const phase = useBaton((s) => s.flowPhase);
  const count = useBaton((s) => s.takeover.count);
  const has = useBaton((s) => !!(s.qa.provisional || s.qa.verified) || s.qa.status !== "none");
  const verified = useBaton((s) => !!s.qa.verified);
  const done = phase === "completed" || phase === "handed-back";
  const [open, setOpen] = useState(false);
  const shownFor = useRef(-1);
  useEffect(() => {
    if (done && shownFor.current !== count) {
      shownFor.current = count;
      setOpen(true);
    }
  }, [done, count]);
  if (!done && !has) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border text-sm font-semibold", verified ? "border-(--verified)/50 bg-(--verified-bg) text-(--verified-fg)" : "border-(--bt-line-strong) bg-(--bt-panel)")}
      >
        <ClipboardCheckIcon className="size-4" aria-hidden="true" /> {verified ? "QA card · ✓ verified" : "QA card · provisional"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bt-scroll max-h-[92dvh] border-(--bt-line) bg-(--bt-bg) text-(--bt-ink) sm:max-w-3xl">
          <DialogTitle asChild>
            <h2>
              <QaTitle />
            </h2>
          </DialogTitle>
          <DialogDescription className="sr-only">Quality metrics of the AI half of this call.</DialogDescription>
          <QaCardBody />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RecordedAiNote() {
  const at = useBaton((s) => s.plan?.recordedHandoffMs ?? s.context?.handoff?.lineStartMs ?? null);
  const env = useConsoleEnv();
  return (
    <p className="text-xs text-(--bt-muted)">
      The recorded AI session starts at <span className="bt-mono">{formatMmSs(at)}</span>. The{" "}
      <a href={env.links.explorer} className="font-semibold text-(--rep-fg) underline underline-offset-2">
        Takeover Explorer
      </a>{" "}
      shows a pass at any second.
    </p>
  );
}
