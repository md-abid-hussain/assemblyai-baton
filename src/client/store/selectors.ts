/**
 * client/store/selectors.ts - derived view data and all console copy (DESIGN §1.4 S2/S3). Pure functions of the
 * store state, so every state's copy is unit-tested (TASKS WP7 acceptance 2).
 */
import "client-only";

import type { CaseState, FieldId, FieldState } from "@/core/contracts/case";
import type { ProtocolStepView, TranscriptLine, UiPhase } from "@/core/contracts/ext/wp7-ui";
import { PROTOCOL_STEPS } from "@/core/contracts/ext/wp7-ui";
import { TAKEOVER_TIMING } from "@/core/contracts/takeover";
import { FIELD_LABEL, REQUIRED_FIELDS, SERVER_RESOLVABLE_SET } from "@/core/intents/add-driver.fields";

import { isTerminalPayment, type UiState } from "./reduce";

// ------------------------------------------------------------------------------------------------ formatting

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

/** "01:42.3" (call clock, tenths). */
export function formatCallClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--:--.-";
  const v = Math.max(0, ms);
  const m = Math.floor(v / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const tenths = Math.floor((v % 1000) / 100);
  return `${pad(m)}:${pad(s)}.${tenths}`;
}

/** "01:35". */
export function formatMmSs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--:--";
  const v = Math.max(0, Math.round(ms / 1000));
  return `${pad(v / 60)}:${pad(v % 60)}`;
}

/** "2.9 s" / "850 ms". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatMsExact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-25" → "Fri 25 Sep 2026" (UTC calendar date; no timezone drift). */
export function formatCallDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const formatUsd = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`;

// ------------------------------------------------------------------------------------------------ people

export function names(s: Pick<UiState, "context">): { rep: string; customer: string; customerFull: string } {
  const p = s.context?.policy;
  return {
    rep: p?.repFirstName || "the rep",
    customer: p?.policyholder.firstName || "the customer",
    customerFull: p ? `${p.policyholder.firstName} ${p.policyholder.lastName}` : "the customer",
  };
}

// ------------------------------------------------------------------------------------------------ run plan / pass

export const isRecordedAi = (s: Pick<UiState, "plan" | "mode">): boolean => s.plan?.aiHalf === "recorded" || s.mode === "recorded_ai";

export interface PassState {
  enabled: boolean;
  /** Why it is disabled (tooltip / aria-describedby). */
  reason: string | null;
  manualPassAllowed: boolean;
  remaining: number;
}

export function passState(s: UiState): PassState {
  const { rep } = names(s);
  const remaining = TAKEOVER_TIMING.MAX_TAKEOVERS_PER_CASE - s.takeover.count;
  const manualPassAllowed = s.plan?.aiHalf !== "recorded";
  const handoffAt = s.plan?.recordedHandoffMs ?? s.context?.handoff?.lineStartMs ?? null;
  if (!manualPassAllowed) {
    return {
      enabled: false,
      manualPassAllowed,
      remaining,
      reason: `Live AI is unavailable right now: the recorded AI session starts at ${rep}'s handoff line${handoffAt !== null ? ` (${formatMmSs(handoffAt)})` : ""}.`,
    };
  }
  const retake = s.flowPhase === "handed-back";
  if (s.flowPhase !== "shadowing" && !retake) return { enabled: false, manualPassAllowed, remaining, reason: phaseCopy(s).title };
  if (s.callEnded && !retake) return { enabled: false, manualPassAllowed, remaining, reason: "The call ended without a baton pass." };
  if (remaining <= 0) return { enabled: false, manualPassAllowed, remaining, reason: "Takeovers allow 3 passes per case." };
  if (s.human.length === 0) return { enabled: false, manualPassAllowed, remaining, reason: "Available once the first line is transcribed." };
  return { enabled: true, manualPassAllowed, remaining, reason: null };
}

/**
 * "Pass now: the AI will need to collect 4 facts, about 2 min". Facts = required fields that are not VERIFIED,
 * minus the server-resolvable premium (get_disclosure supplies it). Time model: ≈75 s for disclose + pay + close,
 * plus ≈20 s per fact to confirm or ask (from the s01/s02 dev runs; a rough, labelled estimate).
 */
export function passEstimate(cs: CaseState | null): { facts: number; minutes: number; text: string } {
  if (!cs) return { facts: 0, minutes: 0, text: "Pass any time: the AI inherits whatever the case holds." };
  const facts = REQUIRED_FIELDS.filter((f) => !SERVER_RESOLVABLE_SET.has(f) && cs.fields[f]?.status !== "VERIFIED").length;
  const minutes = Math.max(1, Math.round((75 + 20 * facts) / 60));
  const what = facts === 0 ? "only confirm, disclose and take payment" : `need to collect ${facts} fact${facts === 1 ? "" : "s"}`;
  return { facts, minutes, text: `Pass now: the AI will ${what}, about ${minutes} min.` };
}

// ------------------------------------------------------------------------------------------------ copy per state

export interface PhaseCopy {
  title: string;
  body: string;
}

/** Copy for every S2 state. Exhaustive over UiPhase (a test asserts every key is non-empty). */
export function phaseCopy(s: UiState): PhaseCopy {
  const { rep, customer } = names(s);
  const q = s.queue;
  const per = s.context?.sttOpensPerMin ?? 5;
  const lastFallback = s.fallbacks[s.fallbacks.length - 1];
  const map: Record<UiPhase, PhaseCopy> = {
    preflight: {
      title: "Ready when you are",
      body: "Pick Express (about 3 min) or the full call. Turn your sound on: the recording plays out loud.",
    },
    queued: {
      title: "Waiting for a live transcription slot",
      body: `Live transcription is limited to ${per} new sessions per minute on our plan. You're #${q?.position ?? 1}, starting in ~${Math.max(1, Math.round((q?.etaMs ?? 10_000) / 1000))} s.`,
    },
    connecting: { title: "Opening 2 live transcription sessions…", body: "One AssemblyAI Universal-3.5 Pro session per speaker (rep and customer)." },
    shadowing: {
      title: "Human half",
      body: `Baton is listening silently; watch facts turn green. Pass the baton any time.`,
    },
    arming: { title: "Arming", body: `Waiting ≤1.5 s for the current turn to end, then ${rep} hands off.` },
    sealing: { title: "Sealing", body: `${rep}'s handoff line plays while the last words are finalized.` },
    draining: { title: "Draining", body: "Waiting for the last transcripts to reach the case (≤2 s)." },
    compiling: { title: "Compiling", body: "Freezing the case snapshot and compiling the AI's opening from it." },
    "connecting-agent": { title: "Connecting the Voice Agent", body: "The AI's first words are timed to land right after the handoff." },
    "ai-listening": { title: "AI half: listening", body: `You are ${customer}. Let Autopilot answer, click a reply, or type anything.` },
    "ai-thinking": { title: s.va.checking ? "AI half: checking…" : "AI half: thinking…", body: "From the end of the customer's speech to the first audible reply." },
    "ai-speaking": { title: "AI half: speaking", body: "Captions follow the audio; the HUD shows the last latency." },
    paying: { title: "Your turn: tap the text on the phone", body: "Sign, then pay with the Polar sandbox test card or skip with a simulated payment." },
    paused: {
      title: "Paused: tap to resume",
      body: s.paused?.reason === "audio_interrupted" ? "The audio was interrupted (another app or a call took over)." : "The tab went to the background or the screen locked.",
    },
    completed: { title: "Done", body: "This QA card is computed from the AI's own recording." },
    "handed-back": {
      title: `${rep} has the call back`,
      body: `Reason: ${humanReason(s.handBack?.reason)}. The QA card is still computed.`,
    },
    fallback: {
      title: "Labelled fallback",
      body: lastFallback?.label ?? "A recorded run is replayed; it is labelled as such everywhere.",
    },
    error: {
      title: "Something went wrong",
      body: s.error?.message ?? (s.takeover.phase === "failed" ? "The live AI could not start after one retry." : "Please try again."),
    },
  };
  return map[s.phase];
}

const HAND_BACK_COPY: Record<string, string> = {
  advice_requested: "advice requested",
  customer_request: "the customer asked for the rep",
  conflict: "conflicting facts need the rep",
  customer_declined: "the customer declined the AI",
  out_of_scope: "out of scope for the AI",
  payment_problem: "payment problem",
  other: "other",
};
export const humanReason = (r: string | null | undefined): string => (r ? (HAND_BACK_COPY[r] ?? r.replace(/_/g, " ")) : "not given");

/** The narrator strip ("Now: …", §1.4 S2): one line that changes by phase. */
export function narrator(s: UiState): { text: string; tone: "neutral" | "human" | "protocol" | "ai" | "action" | "done" | "warn" | "error" } {
  const { rep, customer } = names(s);
  const recorded = isRecordedAi(s);
  switch (s.phase) {
    case "preflight":
      return { text: "Pick Express or the full call to start. Sound on.", tone: "neutral" };
    case "queued":
    case "connecting":
      return { text: phaseCopy(s).title, tone: "neutral" };
    case "shadowing":
      if (s.callEnded) return { text: "The call ended without a baton pass. Open the Explorer to try any second.", tone: "neutral" };
      return { text: "Human half: Baton is listening silently; watch facts turn green", tone: "human" };
    case "arming":
    case "sealing":
    case "draining":
    case "compiling":
    case "connecting-agent":
      return { text: `Passing the baton: ${rep}'s handoff line plays while the case is sealed and compiled`, tone: "protocol" };
    case "ai-listening":
    case "ai-thinking":
    case "ai-speaking":
      return recorded
        ? { text: "AI half (recorded session): watch the AI finish the call; the controls are read-only", tone: "ai" }
        : { text: `AI half: you are ${customer}; let Autopilot answer or type anything`, tone: "ai" };
    case "paying":
      return recorded
        ? { text: "AI half (recorded session): the customer signs and pays on the phone", tone: "action" }
        : { text: "Your turn: tap the text on the phone to sign and pay", tone: "action" };
    case "completed":
      return { text: "Done: this QA card is computed from the AI's own recording", tone: "done" };
    case "handed-back":
      return { text: `${rep} has the call back, with the AI's summary. You can pass the baton again.`, tone: "done" };
    case "paused":
      return { text: "Paused: tap to resume", tone: "warn" };
    case "fallback":
      return { text: `Labelled fallback: ${phaseCopy(s).body}`, tone: "warn" };
    case "error":
      return { text: `Something went wrong: ${phaseCopy(s).body}`, tone: "error" };
  }
}

// ------------------------------------------------------------------------------------------------ mode badge + notice

export function modeBadge(s: UiState): { label: string; tone: "live" | "cached" | "recorded"; tooltip: string } {
  const date = s.context?.cachedTranscribedAt ? formatCallDate(s.context.cachedTranscribedAt) : "an earlier day";
  if (s.mode === "recorded_ai" || (s.plan?.aiHalf === "recorded" && s.flowPhase.startsWith("ai-"))) {
    return {
      label: "RECORDED AI SESSION",
      tone: "recorded",
      tooltip: s.modeReason ?? s.plan?.reason ?? "The AI half is a labelled recording of a real Voice Agent session on this call.",
    };
  }
  if (s.mode === "cached_replay") {
    return {
      label: "CACHED REPLAY",
      tone: "cached",
      tooltip: `Transcribed live by AssemblyAI on ${date}; replayed now because ${s.modeReason ?? s.plan?.reason ?? "live transcription is unavailable"}.`,
    };
  }
  return { label: "LIVE STT", tone: "live", tooltip: "Two live AssemblyAI Universal-3.5 Pro streaming sessions, one per speaker." };
}

/** The queue/budget notice in plain words (top bar), or null. */
/**
 * The run's provenance (PLATFORM §7.6's four segments; the G2 console shows it as one banner line, WP7·3 turns it into
 * the provenance strip). `customer` is who answers the AI after the pass on this page: WP11's synthetic autopilot, the
 * judge's mic, or the recorded session's customer.
 */
export interface ProvenanceSegment {
  key: "human" | "transcription" | "ai" | "customer";
  label: string;
  value: string;
  tooltip: string;
}

export function provenance(s: Pick<UiState, "context" | "plan" | "mode">, o: { customerInput: "synthetic" | "mic" }): ProvenanceSegment[] {
  const phoneLine = s.context?.source === "twilio8k";
  const cachedDate = s.context?.cachedTranscribedAt ? ` (${formatCallDate(s.context.cachedTranscribedAt)})` : "";
  const cached = s.mode === "cached_replay" || s.plan?.sttHalf === "cached";
  const recordedAi = isRecordedAi(s);
  return [
    {
      key: "human",
      label: "Human half",
      value: phoneLine ? "recorded role-play, real phone line" : "recorded role-play",
      tooltip: "A role-play call recorded by consented volunteers" + (phoneLine ? " over a real phone line (8 kHz, one channel per speaker)." : "."),
    },
    {
      key: "transcription",
      label: "Transcription",
      value: cached ? `cached${cachedDate}` : "live AssemblyAI",
      tooltip: cached
        ? "AssemblyAI transcripts made live on an earlier day, replayed now (labelled)."
        : "Two live AssemblyAI Universal-3.5 Pro streaming sessions, one per speaker.",
    },
    {
      key: "ai",
      label: "AI half",
      value: recordedAi ? "recorded session" : "live Voice Agent",
      tooltip: recordedAi ? "A labelled recording of a real AssemblyAI Voice Agent session on this call." : "A live AssemblyAI Voice Agent session starts at the pass.",
    },
    {
      key: "customer",
      label: "Customer in the AI half",
      value: recordedAi ? "recorded" : o.customerInput === "mic" ? "you (mic)" : "synthetic",
      tooltip: recordedAi
        ? "The customer's side of the recorded session."
        : o.customerInput === "mic"
          ? "You answer the AI as the customer, with your mic."
          : "A synthetic stand-in voice answers for the customer (Autopilot).",
    },
  ];
}

export function planNotice(s: UiState): string | null {
  if (s.plan?.reason) return s.plan.reason;
  if (s.mode === "cached_replay" && s.modeReason) return s.modeReason;
  return null;
}

/** Non-fatal error notice (e.g. "1 turn not analysed"). */
export function softNotice(s: UiState): string | null {
  if (s.phase === "error") return null;
  if (!s.error) return s.notice;
  if (s.error.code.startsWith("E_OPENAI")) return "1 turn not analysed (the language model was slow); the verifier may fill it.";
  return s.error.message;
}

// ------------------------------------------------------------------------------------------------ transcript

export function humanLines(s: UiState): TranscriptLine[] {
  return [...s.human].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || a.t - b.t);
}

/** "Baton passed at 01:42.3 · protocol 2.9 s" */
export function separatorText(s: UiState): string | null {
  if (s.takeover.tArmMs === null) return null;
  const g = s.takeover.steps.find((x) => x.phase === "greeting" || x.phase === "active");
  const proto = g && s.takeover.armedT !== null && !g.detail?.recorded ? g.t - s.takeover.armedT : null;
  const who = s.takeover.source === "auto_handoff" ? " (auto, at the handoff line)" : "";
  return `Baton passed at ${formatCallClock(s.takeover.tArmMs)}${who}${proto !== null ? ` · protocol ${formatDuration(proto)}` : ""}`;
}

// ------------------------------------------------------------------------------------------------ protocol stepper

export interface StepView {
  step: (typeof PROTOCOL_STEPS)[number];
  label: string;
  status: "done" | "active" | "pending";
  ms: number | null;
  startT: number | null;
}

const STEP_LABEL: Record<(typeof PROTOCOL_STEPS)[number], string> = {
  armed: "Arming",
  sealing: "Sealing",
  draining: "Draining",
  compiling: "Compiling",
  connecting: "Connecting",
};

export function protocolSteps(s: UiState, now: number = s.t): StepView[] {
  const steps: ProtocolStepView[] = s.takeover.steps;
  const idxOf = (p: string) => steps.findIndex((x) => x.phase === p);
  const endOfProtocol = steps.find((x) => !PROTOCOL_STEPS.includes(x.phase as (typeof PROTOCOL_STEPS)[number]) && x.phase !== "retrying");
  return PROTOCOL_STEPS.map((step, i) => {
    const at = idxOf(step);
    const cur = at >= 0 ? steps[at] : undefined;
    const nextStep = PROTOCOL_STEPS.slice(i + 1).map((p) => steps[idxOf(p)]).find(Boolean);
    let endT: number | null = nextStep?.t ?? null;
    if (endT === null && cur) endT = endOfProtocol?.t ?? null;
    const status: StepView["status"] = !cur ? (nextStep ? "done" : "pending") : endT !== null ? "done" : "active";
    const ms = cur ? (endT ?? now) - cur.t : null;
    return { step, label: STEP_LABEL[step], status, ms, startT: cur?.t ?? null };
  });
}

export const protocolActive = (s: UiState): boolean =>
  ["arming", "sealing", "draining", "compiling", "connecting-agent"].includes(s.flowPhase);

// ------------------------------------------------------------------------------------------------ stages / case

export const STAGE_ORDER = ["confirm", "disclose", "pay", "close"] as const;
export const STAGE_LABEL: Record<(typeof STAGE_ORDER)[number], string> = { confirm: "Confirm", disclose: "Disclose", pay: "Pay", close: "Close" };

export function stageTracker(s: UiState): { stage: (typeof STAGE_ORDER)[number]; status: "done" | "active" | "pending" }[] {
  const cur = s.stage ? STAGE_ORDER.indexOf(s.stage) : -1;
  const finished = s.flowPhase === "completed";
  return STAGE_ORDER.map((stage, i) => ({ stage, status: finished || i < cur ? "done" : i === cur ? "active" : "pending" }));
}

/** Case card rows: the 10 required fields first, then any other field with a value. */
export function caseRows(cs: CaseState | null): FieldState[] {
  if (!cs) return [];
  const req = REQUIRED_FIELDS.map((f) => cs.fields[f]).filter((x): x is FieldState => !!x);
  const extra = (Object.values(cs.fields) as FieldState[]).filter(
    (f) => !(REQUIRED_FIELDS as readonly FieldId[]).includes(f.field) && f.value !== null && f.status !== "MISSING",
  );
  return [...req, ...extra];
}

export const fieldLabel = (f: FieldId): string => FIELD_LABEL[f];

export function paymentInFlight(s: UiState): boolean {
  return s.stage === "pay" && s.phone.sms.length > 0 && !isTerminalPayment(s.payment?.status);
}

export function showFloatingPhone(s: UiState): boolean {
  return s.phone.sms.length > 0;
}
