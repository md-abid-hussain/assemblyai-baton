"use client";
/**
 * ControlPanel (DESIGN §1.4 S2 right): the Pass button with the live estimate, the ProtocolStepper, and in the AI half
 * the StageTracker, ToolRail and ReplyControls. Read-only with a "recorded" badge during a recorded AI session.
 */
import {
  CheckIcon, CircleStopIcon, FileSignatureIcon, HandIcon, Loader2Icon, MessageSquareTextIcon, MicIcon, MicOffIcon,
  PhoneOffIcon, SendIcon, SparklesIcon, UserRoundIcon, WrenchIcon, ZapIcon,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { isTerminalPayment } from "@/client/store/reduce";
import {
  formatDuration, formatMmSs, isRecordedAi, names, passEstimate, passState, protocolActive, protocolSteps, STAGE_LABEL,
  stageTracker,
} from "@/client/store/selectors";
import type { ToolRailItem } from "@/core/contracts/ext/wp7-ui";
import type { Suggestion } from "@/core/contracts/services";
import { TAKEOVER_TIMING } from "@/core/contracts/takeover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { Eyebrow } from "../common/bits";
import { useActions, useConsoleEnv, useNow } from "../common/console-context";

// ------------------------------------------------------------------------------------------------ pass

export function PassButton({ compact = false }: { compact?: boolean }) {
  const actions = useActions();
  const st = useBaton(passState, shallowEqual);
  const again = useBaton((s) => s.flowPhase === "handed-back");
  const btn = (
    <button
      type="button"
      onClick={() => actions.pass()}
      disabled={!st.enabled}
      aria-describedby={st.reason ? "pass-why" : undefined}
      className={cn(
        "bt-pass bt-display relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl font-bold tracking-wide transition focus-visible:ring-4 focus-visible:ring-(--ai)/40 focus-visible:outline-none disabled:cursor-not-allowed",
        compact ? "h-12 text-base" : "h-16 text-xl",
      )}
    >
      {st.enabled ? <span aria-hidden="true" className="bt-pass-sheen pointer-events-none absolute inset-0" /> : null}
      <HandIcon className={compact ? "size-5" : "size-6"} aria-hidden="true" />
      {again ? `Pass the baton again` : "Pass the baton"}
    </button>
  );
  return (
    <div>
      {st.enabled || !st.reason ? (
        btn
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none">
              {btn}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            {st.reason}
          </TooltipContent>
        </Tooltip>
      )}
      {st.reason && !compact ? (
        <p id="pass-why" className="sr-only">
          {st.reason}
        </p>
      ) : null}
    </div>
  );
}

function PassSection() {
  const actions = useActions();
  const cs = useBaton((s) => s.caseState);
  const est = passEstimate(cs);
  const st = useBaton(passState, shallowEqual);
  const handoff = useBaton((s) => s.context?.handoff ?? null);
  const rep = useBaton((s) => names(s).rep);
  const ended = useBaton((s) => s.callEnded);
  const again = useBaton((s) => s.flowPhase === "handed-back");
  const recorded = !st.manualPassAllowed;
  return (
    <div className="space-y-3">
      {/* On phones the Pass button lives in the sticky bottom bar instead. */}
      <div className="hidden md:block">
        <PassButton />
      </div>
      {recorded ? (
        <p className="rounded-lg border border-(--bt-cached)/40 bg-(--bt-cached-bg) px-3 py-2 text-xs text-(--bt-cached)">{st.reason}</p>
      ) : (
        <>
          <p className="text-sm text-(--bt-ink)">
            <ZapIcon className="mr-1 inline size-3.5 text-(--ai-fg)" aria-hidden="true" />
            {est.text}
          </p>
          <p className="text-xs text-(--bt-muted)">Pass any time: Baton waits ≤1.5 s for the turn to end.{again ? ` ${st.remaining} of 3 passes left.` : ""}</p>
          {handoff && !handoff.declined && !ended && !again ? (
            <p className="text-xs text-(--bt-muted)">
              Auto-pass at {rep}&apos;s own handoff line (<span className="bt-mono">{formatMmSs(handoff.lineStartMs)}</span>) if you don&apos;t.
            </p>
          ) : null}
        </>
      )}
      {!ended && !again ? (
        <button type="button" onClick={() => actions.stopPlayback()} className="inline-flex items-center gap-1 text-xs text-(--bt-muted) underline-offset-2 hover:text-(--bt-ink) hover:underline">
          <CircleStopIcon className="size-3.5" aria-hidden="true" /> Stop playback
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ protocol stepper

export function ProtocolStepper() {
  const active = useBaton(protocolActive);
  const s = useBaton((x) => x);
  const env = useConsoleEnv();
  const now = useNow(active, 50);
  void now;
  const steps = protocolSteps(s, active ? env.clockNow() : s.t);
  const mid = s.takeover.midUtterance;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Eyebrow as="h3">Takeover protocol</Eyebrow>
        {mid ? <span className="rounded border border-(--pending)/60 px-1.5 text-[10px] text-(--pending-fg)">mid-utterance</span> : null}
      </div>
      <ol className="space-y-1.5" aria-label="Takeover protocol steps">
        {steps.map((st, i) => (
          <li key={st.step} className="flex items-center gap-2.5" aria-current={st.status === "active" ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
                st.status === "done" && "border-(--ai) bg-(--ai) text-(--bt-accent-ink)",
                st.status === "active" && "border-(--ai) text-(--ai-fg)",
                st.status === "pending" && "border-(--bt-line-strong) text-(--bt-faint)",
              )}
            >
              {st.status === "done" ? <CheckIcon className="size-3.5" aria-hidden="true" /> : st.status === "active" ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" /> : i + 1}
            </span>
            <span className={cn("bt-display flex-1 text-sm font-semibold", st.status === "pending" && "text-(--bt-faint)")}>{st.label}</span>
            <span className="bt-mono text-xs text-(--bt-muted)">{st.ms !== null ? `${Math.max(0, Math.round(st.ms)).toLocaleString("en-US")} ms` : ""}</span>
            <span className="sr-only">{st.status}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ AI half

function StageTracker() {
  const stages = useBaton(stageTracker, (a, b) => a.every((x, i) => x.status === b[i]?.status));
  return (
    <div>
      <Eyebrow as="h3" className="mb-2">
        Stage
      </Eyebrow>
      <ol className="grid grid-cols-4 gap-1" aria-label="AI stages">
        {stages.map((st) => (
          <li key={st.stage} aria-current={st.status === "active" ? "step" : undefined}>
            <div className={cn("h-1.5 rounded-full", st.status === "done" ? "bg-(--ai)" : st.status === "active" ? "bg-(--ai)/55" : "bg-(--bt-line)")} />
            <div className={cn("bt-display mt-1 text-center text-xs font-semibold", st.status === "pending" ? "text-(--bt-faint)" : "text-(--bt-ink)")}>
              {STAGE_LABEL[st.stage]}
              <span className="sr-only"> ({st.status})</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const TOOL_ICON: Record<string, typeof WrenchIcon> = {
  send_esign_and_pay_link: FileSignatureIcon,
  hand_back_to_rep: UserRoundIcon,
  send_confirmation: MessageSquareTextIcon,
};

function summarize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "text" && k !== "must_read_verbatim");
  if (!entries.length) return "{}";
  return entries.map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(" · ");
}

function HoldCountdown({ item }: { item: ToolRailItem }) {
  const env = useConsoleEnv();
  const phone = useBaton((s) => s.phone);
  const pay = useBaton((s) => s.payment);
  const done = isTerminalPayment(pay?.status);
  useNow(!done, 500);
  if (done) return null;
  const smsT = phone.sms[0]?.t ?? item.t;
  const now = env.clockNow();
  const progress = ["esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating"].includes(phone.state);
  const base = smsT + TAKEOVER_TIMING.HOLD_DEADLINE_MS;
  const deadline = progress ? Math.min(smsT + TAKEOVER_TIMING.HOLD_MAX_MS, Math.max(base, now + TAKEOVER_TIMING.HOLD_EXTEND_STEP_MS)) : base;
  const left = Math.max(0, deadline - now);
  const pct = Math.min(100, Math.max(0, ((now - smsT) / (deadline - smsT)) * 100));
  return (
    <div className="mt-1.5">
      <div className="flex justify-between text-[11px] text-(--bt-muted)">
        <span>hold · waiting for payment (Polar sandbox)</span>
        <span className="bt-mono">{formatMmSs(left)} left</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-(--bt-line)" role="progressbar" aria-label="Payment hold" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-(--ai) transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-0.5 text-[10px] text-(--bt-muted)">{progress ? "Extends while you sign and pay, up to 3 min." : "Extends as soon as you open the text."}</div>
    </div>
  );
}

function ToolRail() {
  const tools = useBaton((s) => s.tools);
  if (!tools.length) return null;
  return (
    <div>
      <Eyebrow as="h3" className="mb-2">
        Tool calls
      </Eyebrow>
      <ol className="space-y-1.5">
        {tools.map((x) => {
          const Icon = TOOL_ICON[x.name] ?? WrenchIcon;
          return (
            <li key={x.callId} className="rounded-lg border border-(--bt-line) bg-(--bt-panel-2) px-2.5 py-1.5">
              <div className="flex items-center gap-1.5">
                <Icon className="size-3.5 text-(--ai-fg)" aria-hidden="true" />
                <span className="bt-mono truncate text-[12px] font-semibold">{x.name}</span>
                {x.hold ? <span className="rounded bg-(--ai-bg) px-1 text-[10px] font-semibold text-(--ai-fg)">hold</span> : null}
                <span className="ml-auto">
                  {x.pending ? <Loader2Icon className="size-3.5 animate-spin text-(--bt-muted)" aria-label="pending" /> : <CheckIcon className="size-3.5 text-(--verified-fg)" aria-label="done" />}
                </span>
              </div>
              {summarize(x.args) ? <div className="bt-mono mt-0.5 truncate text-[11px] text-(--bt-muted)" title={summarize(x.args)}>→ {summarize(x.args)}</div> : null}
              {!x.pending && summarize(x.result) ? <div className="bt-mono truncate text-[11px] text-(--verified-fg)" title={summarize(x.result)}>← {summarize(x.result)}</div> : null}
              {x.pending && x.hold ? <div className="mt-0.5 text-[11px] text-(--ai-fg)">hold · waiting for payment (Polar sandbox)</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SuggestionChip({ s, disabled }: { s: Suggestion; disabled: boolean }) {
  const actions = useActions();
  const tryThis = s.kind === "try";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void actions.playSuggestion(s)}
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-[13px] leading-tight transition focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
        tryThis
          ? "border-dashed border-(--conflict)/60 bg-(--conflict-bg) text-(--conflict-fg) hover:border-(--conflict)"
          : "border-(--customer)/45 bg-(--bt-panel) text-(--bt-ink) hover:bg-(--customer-bg)",
      )}
    >
      {tryThis ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-(--conflict-fg) px-1 text-[10px] font-bold tracking-wide text-(--bt-accent-ink) uppercase">
          <SparklesIcon className="size-3" aria-hidden="true" /> Try this
        </span>
      ) : null}
      <span className="min-w-0">{s.text}</span>
      <span className="sr-only">{s.voice === "recorded" ? " (customer's recorded voice)" : " (synthetic voice)"}</span>
    </button>
  );
}

export function ReplyControls() {
  const actions = useActions();
  const inputs = useConsoleEnv().inputs ?? { autopilot: true, typed: true, mic: true };
  const suggestions = useBaton((s) => s.suggestions);
  const autopilot = useBaton((s) => s.autopilot);
  const recorded = useBaton(isRecordedAi);
  const phase = useBaton((s) => s.phase);
  const customer = useBaton((s) => names(s).customer);
  const rep = useBaton((s) => names(s).rep);
  const [text, setText] = useState("");
  const [mic, setMic] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const readOnly = recorded;
  const live = phase.startsWith("ai-") || phase === "paying";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || readOnly) return;
    setText("");
    void actions.sendTyped(t);
  };
  return (
    <div className={cn("space-y-3", readOnly && "opacity-80")}>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow as="h3">Your replies as {customer}</Eyebrow>
        {readOnly ? <span className="rounded border border-(--bt-cached)/50 bg-(--bt-cached-bg) px-1.5 text-[10px] font-semibold text-(--bt-cached) uppercase">recorded</span> : null}
      </div>
      {inputs.autopilot ? (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-(--bt-line) px-3 py-2">
          <span className="text-sm">
            <span className="font-semibold">Autopilot</span>
            <span className="block text-[11px] text-(--bt-muted)">Answers for {customer} 0.6 s after each question</span>
          </span>
          <SwitchPrimitive.Root
            checked={autopilot}
            disabled={readOnly}
            onCheckedChange={(v) => actions.setAutopilot(v)}
            aria-label="Autopilot customer"
            className="relative h-6 w-11 shrink-0 rounded-full bg-(--bt-line-strong) transition-colors focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none disabled:opacity-60 data-[state=checked]:bg-(--ai)"
          >
            <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
          </SwitchPrimitive.Root>
        </label>
      ) : (
        <p className="rounded-lg border border-(--bt-line) px-3 py-2 text-sm">
          <span className="font-semibold">Answer as {customer} with your mic.</span>{" "}
          <span className="text-[12px] text-(--bt-muted)">Or stay quiet: the phone&apos;s autopilot still simulates the payment.</span>
        </p>
      )}
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested replies" role="group">
          {suggestions.slice(0, 4).map((s) => (
            <SuggestionChip key={s.id} s={s} disabled={readOnly || !live} />
          ))}
        </div>
      ) : null}
      {inputs.typed ? (
        <>
          <form onSubmit={submit} className="flex gap-1.5">
            <label htmlFor="typed-reply" className="sr-only">
              Type a reply as {customer}
            </label>
            <input
              ref={input}
              id="typed-reply"
              value={text}
              maxLength={200}
              disabled={readOnly || !live}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Type anything as ${customer}…`}
              className="h-9 min-w-0 flex-1 rounded-md border border-(--bt-line-strong) bg-(--bt-panel) px-3 text-sm placeholder:text-(--bt-faint) focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none disabled:opacity-60"
            />
            <button type="submit" disabled={readOnly || !live || !text.trim()} className="inline-flex h-9 items-center gap-1 rounded-md bg-(--bt-ink) px-3 text-sm font-semibold text-(--bt-panel) disabled:opacity-40" aria-label="Send reply">
              <SendIcon className="size-4" aria-hidden="true" />
            </button>
          </form>
          <p className="-mt-1 text-[11px] text-(--bt-muted)">Your reply will be spoken by a synthetic voice.</p>
        </>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {inputs.mic ? (
          <button
            type="button"
            disabled={readOnly || !live}
            aria-pressed={mic}
            onClick={async () => setMic(await actions.toggleMic(!mic))}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-(--bt-line-strong) px-2.5 text-xs font-medium hover:bg-(--bt-panel-2) disabled:opacity-50"
          >
            {mic ? <MicIcon className="size-3.5" aria-hidden="true" /> : <MicOffIcon className="size-3.5" aria-hidden="true" />}
            {mic ? "Mic on" : "Use my mic"}
          </button>
        ) : null}
        <button type="button" disabled={readOnly || !live} onClick={() => actions.askForDaniel()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-(--bt-line-strong) px-2.5 text-xs font-medium hover:bg-(--bt-panel-2) disabled:opacity-50">
          <UserRoundIcon className="size-3.5" aria-hidden="true" /> Ask for {rep}
        </button>
        <button type="button" disabled={readOnly || !live} onClick={() => actions.endCall()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-(--conflict-fg) hover:bg-(--conflict-bg) disabled:opacity-50">
          <PhoneOffIcon className="size-3.5" aria-hidden="true" /> End call
        </button>
      </div>
      {mic ? <p className="text-[11px] text-(--bt-muted)">Headphones recommended. Your voice is recorded by AssemblyAI (stored in eu-west-1; deletion requested after 7 days). Bluetooth headsets switch to call quality when the mic opens.</p> : null}
    </div>
  );
}

function HoldCard() {
  const item = useBaton((s) => s.tools.find((x) => x.hold && x.pending) ?? null);
  const customer = useBaton((s) => names(s).customer);
  if (!item) return null;
  return (
    <div className="rounded-xl border border-(--ai)/40 bg-(--ai-bg) p-3" role="status">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-(--ai-fg)">
        <FileSignatureIcon className="size-4" aria-hidden="true" /> Waiting for {customer} to sign and pay
      </div>
      <p className="mt-0.5 text-xs text-(--bt-ink)">The AI holds the line while the payment runs; only the Polar webhook marks it paid.</p>
      <HoldCountdown item={item} />
    </div>
  );
}

function ProtocolSummary() {
  const proto = useBaton((s) => s.takeover.steps.length > 0 && !s.takeover.steps.some((x) => x.detail?.recorded === 1));
  const protoMs = useBaton((s) => {
    const g = s.takeover.steps.find((x) => x.phase === "greeting" || x.phase === "active");
    return g && s.takeover.armedT !== null ? g.t - s.takeover.armedT : null;
  });
  if (!proto) return null;
  return (
    <details className="group rounded-lg border border-(--bt-line) px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between text-xs">
        <span className="bt-eyebrow">Takeover protocol</span>
        <span className="bt-mono text-(--bt-muted)">
          {protoMs !== null ? `${formatDuration(protoMs)} total` : ""} <span aria-hidden="true">▾</span>
        </span>
      </summary>
      <div className="pt-2">
        <ProtocolStepper />
      </div>
    </details>
  );
}

export function AiHalfPanel() {
  const paying = useBaton((s) => s.flowPhase === "paying");
  return (
    <div className="space-y-5">
      <StageTracker />
      {paying ? <HoldCard /> : null}
      <ToolRail />
      <ReplyControls />
      <ProtocolSummary />
    </div>
  );
}

function CompletedCard() {
  const cs = useBaton((s) => s.caseState);
  const pay = useBaton((s) => s.payment);
  const env = useConsoleEnv();
  const paid = pay?.status === "succeeded";
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-(--verified)/40 bg-(--verified-bg) p-4">
        <div className="bt-display flex items-center gap-2 text-lg font-bold text-(--verified-fg)">
          <CheckIcon className="size-5" aria-hidden="true" /> Call complete
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-(--bt-muted)">Facts verified</dt>
          <dd className="bt-num font-semibold">
            {cs?.readiness.verified ?? 0} / {cs?.readiness.requiredTotal ?? 10}
          </dd>
          <dt className="text-(--bt-muted)">Payment</dt>
          <dd className="font-semibold">{paid ? (pay?.source === "mock" ? "Simulated" : "Paid · Polar webhook") : (pay?.status ?? "none")}</dd>
          {cs?.confirmationNumber ? (
            <>
              <dt className="text-(--bt-muted)">Confirmation</dt>
              <dd className="bt-mono font-semibold">{cs.confirmationNumber}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <ProtocolSummary />
      <div className="flex flex-wrap gap-2 text-sm">
        <a href={env.links.explorer} className="font-semibold text-(--rep-fg) underline underline-offset-2">
          Takeover Explorer: pass at any second →
        </a>
        <a href={env.links.evals} className="font-semibold text-(--rep-fg) underline underline-offset-2">
          Evals →
        </a>
      </div>
    </div>
  );
}

function SessionStatus() {
  const stt = useBaton((s) => s.stt);
  const ids = useBaton((s) => s.sessionIds, shallowEqual);
  const mode = useBaton((s) => s.mode);
  const who = useBaton((s) => names(s), shallowEqual);
  const rows = [
    { ch: "rep" as const, label: `Rep · ${who.rep}`, id: ids.rep },
    { ch: "customer" as const, label: `Customer · ${who.customer}`, id: ids.customer },
  ];
  return (
    <div className="rounded-lg border border-(--bt-line) px-3 py-2">
      <Eyebrow as="h3" className="mb-1.5">
        {mode === "cached_replay" ? "Transcription (cached replay)" : "Live transcription"}
      </Eyebrow>
      <ul className="space-y-1">
        {rows.map((r) => {
          const st = mode === "cached_replay" ? "cached" : stt[r.ch].status;
          return (
            <li key={r.ch} className="flex items-center gap-2 text-xs">
              <span className={cn("bt-dot", st === "open" ? "text-(--bt-live)" : st === "cached" ? "text-(--bt-cached)" : st === "error" ? "text-(--conflict)" : "text-(--missing)")} aria-hidden="true" />
              <span className="font-medium">{r.label}</span>
              <span className="text-(--bt-muted)">{st === "idle" ? "not started" : st}</span>
              {r.id && st === "open" ? <span className="bt-mono ml-auto truncate text-[10px] text-(--bt-faint)" title={`AssemblyAI session ${r.id}`}>{r.id.slice(0, 8)}…</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ControlPanelBody() {
  const phase = useBaton((s) => s.flowPhase);
  if (phase === "arming" || phase === "sealing" || phase === "draining" || phase === "compiling" || phase === "connecting-agent") {
    return <ProtocolStepper />;
  }
  if (phase.startsWith("ai-") || phase === "paying" || phase === "fallback") return <AiHalfPanel />;
  if (phase === "completed") return <CompletedCard />;
  return (
    <div className="space-y-4">
      <PassSection />
      {phase === "shadowing" ? <SessionStatus /> : null}
    </div>
  );
}
