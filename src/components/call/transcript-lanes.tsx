"use client";
/**
 * TranscriptLanes (DESIGN §1.4 S2 left): human half = Rep and Customer lanes (partials grey italic, finals solid, hover ▶
 * and turn id); the separator row; AI half = the AI lane (violet captions on the reply's schedule, §5.10) and the
 * customer lane (agent-side transcript.user).
 */
import { ArrowDownIcon, BotIcon, HeadsetIcon, PlayIcon, UserIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { formatMmSs, humanLines, isRecordedAi, names, separatorText } from "@/client/store/selectors";
import type { TranscriptLine } from "@/core/contracts/ext/wp7-ui";
import { cn } from "@/lib/utils";

import { Eyebrow, LiveDot } from "../common/bits";
import { useActions, useConsoleEnv } from "../common/console-context";

const LANE = {
  rep: { cls: "border-(--rep) ", name: "text-(--rep-fg)", Icon: HeadsetIcon },
  customer: { cls: "border-(--customer)", name: "text-(--customer-fg)", Icon: UserIcon },
  ai: { cls: "border-(--ai)", name: "text-(--ai-fg)", Icon: BotIcon },
  customer_ai: { cls: "border-(--customer)", name: "text-(--customer-fg)", Icon: UserIcon },
} as const;

const HumanLine = memo(function HumanLine({ l, who }: { l: TranscriptLine; who: string }) {
  const actions = useActions();
  const lane = LANE[l.lane];
  const right = l.lane === "customer";
  return (
    <li className={cn("group flex", right ? "justify-end pl-8" : "pr-8")}>
      <div className={cn("relative max-w-full rounded-lg border-l-[3px] bg-(--bt-panel) px-3 py-1.5 shadow-[0_1px_0_var(--bt-line)]", lane.cls)}>
        <div className="flex items-center gap-2 text-[11px]">
          <span className={cn("font-semibold", lane.name)}>{who}</span>
          <span className="bt-mono text-(--bt-faint)">{formatMmSs(l.startMs)}</span>
          {l.source === "cached" ? <span className="rounded bg-(--bt-cached-bg) px-1 text-[10px] font-semibold text-(--bt-cached)">cached</span> : null}
          {l.late ? <span className="rounded border border-(--pending)/60 px-1 text-[10px] text-(--pending-fg)" title="Finalized after the pass: stored, never used by the AI">late</span> : null}
          {l.cut ? <span className="rounded border border-(--conflict)/50 px-1 text-[10px] text-(--conflict-fg)" title="Cut by the pass mid-utterance">cut</span> : null}
          <span className="bt-mono ml-auto hidden text-[10px] text-(--bt-faint) group-hover:inline group-focus-within:inline">{l.turnId}</span>
          <button
            type="button"
            onClick={() => void actions.playTurn(l)}
            className="rounded p-0.5 text-(--bt-muted) opacity-0 group-hover:opacity-100 hover:text-(--bt-ink) focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none"
            aria-label={`Play ${who}'s line at ${formatMmSs(l.startMs)}`}
          >
            <PlayIcon className="size-3 fill-current" aria-hidden="true" />
          </button>
        </div>
        <p className="text-[13.5px] leading-snug">{l.text}</p>
      </div>
    </li>
  );
});

function Partial({ lane, text, who }: { lane: "rep" | "customer"; text: string; who: string }) {
  const right = lane === "customer";
  return (
    <li className={cn("flex", right ? "justify-end pl-8" : "pr-8")} aria-hidden="true">
      <div className={cn("rounded-lg border-l-[3px] border-dashed px-3 py-1.5", LANE[lane].cls)}>
        <div className={cn("text-[11px] font-semibold", LANE[lane].name)}>{who} · speaking</div>
        <p className="text-[13.5px] leading-snug text-(--bt-muted) italic">{text}</p>
      </div>
    </li>
  );
}

const Caption = memo(function Caption({ l, elapsedAtMount }: { l: TranscriptLine; elapsedAtMount: number }) {
  const words = l.words ?? l.text.split(/\s+/).map((text, i) => ({ text, atMs: i * 250 }));
  // Words are scheduled from the caption's own arrival (line.t): a negative delay shows words already spoken at once
  // (after a seek, a reload of a recorded run, or a late mount), the rest reveal on the reply's timing (§5.10).
  return (
    <p className="text-[14px] leading-snug">
      {words.map((w, i) => (
        <span key={i} className="bt-word" style={{ animationDelay: `${Math.min(w.atMs, 30_000) - elapsedAtMount}ms` }}>
          {w.text}{" "}
        </span>
      ))}
      {l.interrupted ? <span aria-label="interrupted">—</span> : null}
    </p>
  );
});

function AiLine({ l, who }: { l: TranscriptLine; who: string }) {
  const ai = l.lane === "ai";
  const env = useConsoleEnv();
  const [elapsed] = useState(() => Math.max(0, env.clockNow() - l.t));
  return (
    <li className={cn("flex", ai ? "pr-8" : "justify-end pl-8")}>
      <div className={cn("max-w-full rounded-lg border-l-[3px] px-3 py-1.5", ai ? "border-(--ai) bg-(--ai-bg)" : "border-(--customer) bg-(--bt-panel) shadow-[0_1px_0_var(--bt-line)]")}>
        <div className={cn("flex items-center gap-1.5 text-[11px] font-semibold", LANE[l.lane].name)}>
          {ai ? <BotIcon className="size-3" aria-hidden="true" /> : null}
          {who}
          {l.source === "recorded" ? <span className="rounded border border-current/40 px-1 text-[10px] font-normal">recorded</span> : null}
        </div>
        {ai ? <Caption l={l} elapsedAtMount={elapsed} /> : <p className="text-[13.5px] leading-snug">{l.text}</p>}
      </div>
    </li>
  );
}

export function TranscriptLanes() {
  const human = useBaton(humanLines, (a, b) => a.length === b.length && a.every((x, i) => x === b[i]));
  const partials = useBaton((s) => s.partials);
  const ai = useBaton((s) => s.ai);
  const userPartial = useBaton((s) => s.aiUserPartial);
  const sep = useBaton(separatorText);
  const phase = useBaton((s) => s.phase);
  const checking = useBaton((s) => s.va.checking);
  const greyed = useBaton((s) => s.shadowGreyed);
  const recorded = useBaton(isRecordedAi);
  const who = useBaton((s) => names(s), shallowEqual);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const count = human.length + ai.length + (partials.rep ? 1 : 0) + (partials.customer ? 1 : 0) + (userPartial ? 1 : 0) + phase.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [count, pinned]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = () => setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);

  const empty = human.length === 0 && !partials.rep && !partials.customer;
  return (
    <section aria-labelledby="tx-h" className="relative flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-(--bt-line) px-4 py-3">
        <Eyebrow id="tx-h">Transcript</Eyebrow>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1 text-(--rep-fg)">
            <span aria-hidden="true" className="h-2.5 w-1 rounded bg-(--rep)" /> Rep · {who.rep}
          </span>
          <span className="inline-flex items-center gap-1 text-(--customer-fg)">
            <span aria-hidden="true" className="h-2.5 w-1 rounded bg-(--customer)" /> Customer · {who.customer}
          </span>
          {ai.length || sep ? (
            <span className="inline-flex items-center gap-1 text-(--ai-fg)">
              <span aria-hidden="true" className="h-2.5 w-1 rounded bg-(--ai)" /> AI
            </span>
          ) : null}
        </div>
      </header>
      <div ref={scroller} className="bt-scroll min-h-0 flex-1 px-3 py-3" tabIndex={0} aria-label="Transcript, newest at the bottom">
        {empty ? (
          <p className="mx-auto mt-10 max-w-64 text-center text-sm text-(--bt-muted)">
            Both speakers will appear here as the recording plays: one live AssemblyAI session per channel.
          </p>
        ) : null}
        <ol role="log" aria-label="Human half" className={cn("space-y-2 transition-[filter,opacity]", greyed && "bt-greyed")}>
          {human.map((l) => (
            <HumanLine key={l.id} l={l} who={l.lane === "rep" ? who.rep : who.customer} />
          ))}
          {partials.rep ? <Partial lane="rep" text={partials.rep.text} who={who.rep} /> : null}
          {partials.customer ? <Partial lane="customer" text={partials.customer.text} who={who.customer} /> : null}
        </ol>
        {greyed && human.length ? <p className="mt-1 text-center text-[11px] text-(--bt-muted)">Your shadow transcript is greyed: the AI half below is the recorded session.</p> : null}
        {sep ? (
          <div role="separator" aria-label={sep} className="my-4 flex items-center gap-2">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-(--ai)" />
            <span className="bt-display rounded-full border border-(--ai)/40 bg-(--ai-bg) px-3 py-1 text-xs font-semibold text-(--ai-fg)">{sep}</span>
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-(--ai)" />
          </div>
        ) : null}
        {ai.length || userPartial || phase.startsWith("ai-") ? (
          <ol role="log" aria-label="AI half" className="space-y-2">
            {ai.map((l) => (
              <AiLine key={l.id} l={l} who={l.lane === "ai" ? (recorded ? "AI assistant (recorded)" : "AI assistant") : who.customer} />
            ))}
            {userPartial ? (
              <li className="flex justify-end pl-8" aria-hidden="true">
                <div className="rounded-lg border-l-[3px] border-dashed border-(--customer) px-3 py-1.5 text-[13.5px] text-(--bt-muted) italic">{userPartial.text}</div>
              </li>
            ) : null}
            {phase === "ai-thinking" ? (
              <li className="flex pr-8">
                <div className="flex items-center gap-2 rounded-lg border-l-[3px] border-(--ai) bg-(--ai-bg) px-3 py-2 text-(--ai-fg)">
                  <span className="bt-think" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="text-xs font-medium">{checking ? "checking…" : "thinking…"}</span>
                </div>
              </li>
            ) : null}
            {phase === "ai-listening" ? (
              <li className="flex justify-end pl-8">
                <div className="inline-flex items-center gap-2 rounded-full border border-(--customer)/40 px-3 py-1 text-xs text-(--customer-fg)">
                  <LiveDot className="text-(--customer)" /> listening to {who.customer}
                </div>
              </li>
            ) : null}
          </ol>
        ) : null}
      </div>
      {!pinned ? (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-(--bt-line) bg-(--bt-panel) px-3 py-1 text-xs shadow"
        >
          <ArrowDownIcon className="size-3" aria-hidden="true" /> Jump to latest
        </button>
      ) : null}
    </section>
  );
}
