/**
 * client/store/reduce.ts - the console's pure reducer: BatonEvent | UiAction → BatonUiState (DESIGN §1.4 S2, D12).
 *
 * Everything the call console shows is a function of this state, so a fixture log, a live run and a recorded AI
 * bundle render identically. Slices are copied only when they change (selectors compare by reference).
 */
import "client-only";

import type { CaseState, Channel, FactEvent, FieldId, PaymentStatus } from "@/core/contracts/case";
import type { ErrorCode } from "@/core/contracts/errors";
import type { BatonEvent, BatonEventOf } from "@/core/contracts/events";
import type {
  HudStatView, TranscriptLine, UiAction, UiLogEntry, UiPhase, Wp7UiState,
} from "@/core/contracts/ext/wp7-ui";
import { parseTurnId } from "@/core/contracts/turns";

export type UiState = Wp7UiState;

/**
 * Errors that stop the page (red banner, Try again / Watch replay). Everything else is a notice: STT and VA
 * failures have their own retry and labelled-fallback paths (§7.4), and a VA failure only becomes the error state
 * through `takeover.phase: "failed"`.
 */
export const FATAL_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_CASE_TOKEN", "E_CASE_STATE", "E_DB", "E_INTERNAL", "E_MAINTENANCE", "E_NOT_FOUND", "E_FORBIDDEN", "E_BAD_REQUEST",
]);

const TERMINAL_PAYMENT: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["succeeded", "failed", "expired", "timeout"]);
export const isTerminalPayment = (s: PaymentStatus | undefined | null): boolean => !!s && TERMINAL_PAYMENT.has(s);

const MAX_FACTS = 600;
const MAX_HUD_VALUES = 200;

export function initialUiState(): UiState {
  return {
    phase: "preflight",
    flowPhase: "preflight",
    t: 0,
    context: null,
    plan: null,
    started: null,
    mode: "live",
    modeReason: null,
    stt: { rep: { status: "idle", detail: null }, customer: { status: "idle", detail: null } },
    queue: null,
    clock: { callMs: 0, playing: false, t: 0 },
    human: [],
    partials: { rep: null, customer: null },
    ai: [],
    aiUserPartial: null,
    caseState: null,
    facts: [],
    aiConfirmed: [],
    shadowGreyed: false,
    verifier: null,
    takeover: { phase: "idle", steps: [], tArmMs: null, armedT: null, connectedT: null, source: null, midUtterance: false, count: 0 },
    va: { status: "idle", sessionId: null, code: null, speaking: false, thinking: false, checking: false, activeReplyId: null },
    tools: [],
    stage: null,
    stagesSeen: [],
    payment: null,
    phone: { state: "idle", sms: [] },
    qa: { status: "none", provisional: null, verified: null, reason: null, since: null },
    hud: {},
    sessionIds: {},
    suggestions: [],
    autopilot: true,
    fallbacks: [],
    error: null,
    paused: null,
    handBack: null,
    disclosuresGiven: [],
    callEnded: false,
    audioLocked: false,
  };
}

// ------------------------------------------------------------------------------------------------ helpers

const QUEUE_DETAIL_RE = /position\s+(\d+).*?~\s*(\d+(?:\.\d+)?)\s*s/i;

/** WP4's queued detail is "position 2, ~10 s". */
export function parseQueueDetail(detail: string | undefined): { position: number; etaMs: number } | null {
  if (!detail) return null;
  const m = QUEUE_DETAIL_RE.exec(detail);
  if (!m) return null;
  return { position: Number(m[1]), etaMs: Math.round(Number(m[2]) * 1000) };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function hudStat(values: number[]): HudStatView & { values: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  return { values, last: values[values.length - 1] ?? 0, p50: percentile(sorted, 50), p90: percentile(sorted, 90), n: values.length };
}

function addUnique<T>(xs: readonly T[], x: T): T[] {
  return xs.includes(x) ? (xs as T[]) : [...xs, x];
}

function aiFieldsOf(events: readonly FactEvent[]): FieldId[] {
  return events.filter((e) => e.kind === "tool_update" || e.party === "ai" || e.extractor === "tool").map((e) => e.field);
}

function aiFieldsOfState(state: CaseState): FieldId[] {
  return Object.values(state.fields)
    .filter((f) => f.reason === "ai_confirmed" || f.source === "ai")
    .map((f) => f.field);
}

function mergeFields(cur: readonly FieldId[], add: readonly FieldId[]): FieldId[] {
  let out = cur as FieldId[];
  for (const f of add) out = addUnique(out, f);
  return out;
}

function lineFromTurn(ev: BatonEventOf<"stt.final">, mode: UiState["mode"]): TranscriptLine {
  const turn = ev.turn;
  return {
    id: turn.turnId,
    lane: turn.channel,
    text: turn.text,
    t: ev.t,
    startMs: turn.startMs,
    endMs: turn.endMs,
    turnId: turn.turnId,
    source: turn.source === "stt_cache" ? "cached" : mode === "recorded_ai" ? "recorded" : "live",
    late: turn.late,
    cut: turn.cut,
    interrupted: false,
    words: null,
    turn,
    kind: null,
  };
}

function upsertLine(lines: readonly TranscriptLine[], line: TranscriptLine): TranscriptLine[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i < 0) return [...lines, line];
  const out = lines.slice();
  out[i] = { ...lines[i], ...line, t: lines[i]?.t ?? line.t };
  return out;
}

function patchLine(lines: readonly TranscriptLine[], id: string, patch: Partial<TranscriptLine>): TranscriptLine[] {
  const i = lines.findIndex((l) => l.id === id);
  if (i < 0) return lines as TranscriptLine[];
  const out = lines.slice();
  out[i] = { ...(lines[i] as TranscriptLine), ...patch };
  return out;
}

const truthy = (v: number | string | undefined): boolean => v === 1 || v === "1" || v === "true";

// ------------------------------------------------------------------------------------------------ events

export function reduceEvent(s: UiState, ev: BatonEvent): UiState {
  const t = Math.max(s.t, ev.t);
  switch (ev.type) {
    case "call.loaded":
      return { ...s, t, context: s.context ? { ...s.context, durationMs: ev.durationMs } : s.context };
    case "run.plan":
      return { ...s, t, plan: ev.plan };
    case "paused":
      return { ...s, t, paused: ev.resumed ? null : { reason: ev.reason, t: ev.t } };
    case "phone.state":
      return { ...s, t, phone: { ...s.phone, state: ev.state } };
    case "mode":
      return {
        ...s,
        t,
        mode: ev.mode,
        modeReason: ev.reason ?? null,
        shadowGreyed: s.shadowGreyed || ev.mode === "recorded_ai",
      };
    case "stt.status": {
      const stt = { ...s.stt, [ev.channel]: { status: ev.status, detail: ev.detail ?? null } } as UiState["stt"];
      let queue = s.queue;
      if (ev.status === "queued") {
        const q = parseQueueDetail(ev.detail);
        queue = q ? { ...q, t: ev.t } : (queue ?? { position: 1, etaMs: 15_000, t: ev.t });
      } else if (ev.status === "open" || ev.status === "error" || ev.status === "terminated") {
        queue = stt.rep.status === "queued" || stt.customer.status === "queued" ? queue : null;
      }
      return { ...s, t, stt, queue };
    }
    case "stt.partial":
      return { ...s, t, partials: { ...s.partials, [ev.channel]: { turnOrder: ev.turnOrder, text: ev.text, t: ev.t } } };
    case "stt.final": {
      const ch: Channel = ev.turn.channel;
      const parsed = parseTurnId(ev.turn.turnId);
      const p = s.partials[ch];
      const clear = !p || !parsed || parsed.kind !== "live" || p.turnOrder <= parsed.order;
      if (!ev.turn.text.trim()) return { ...s, t };
      return {
        ...s,
        t,
        human: upsertLine(s.human, lineFromTurn(ev, s.mode)),
        partials: clear ? { ...s.partials, [ch]: null } : s.partials,
        clock: ev.turn.recvMs > s.clock.callMs ? { ...s.clock, callMs: ev.turn.recvMs, t: ev.t } : s.clock,
      };
    }
    case "case.state": {
      const armed = s.takeover.armedT !== null;
      return {
        ...s,
        t,
        caseState: ev.state,
        stage: ev.state.stage ?? s.stage,
        disclosuresGiven: ev.state.disclosuresGiven,
        aiConfirmed: armed ? mergeFields(s.aiConfirmed, aiFieldsOfState(ev.state)) : s.aiConfirmed,
      };
    }
    case "case.facts": {
      const facts = [...s.facts, ...ev.events];
      return {
        ...s,
        t,
        facts: facts.length > MAX_FACTS ? facts.slice(facts.length - MAX_FACTS) : facts,
        aiConfirmed: mergeFields(s.aiConfirmed, aiFieldsOf(ev.events)),
      };
    }
    case "verifier":
      return { ...s, t, verifier: { agrees: ev.agrees, disagreements: ev.disagreements, t: ev.t } };
    case "takeover.phase":
      return reduceTakeoverPhase({ ...s, t }, ev);
    case "va.status":
      return {
        ...s,
        t,
        va: {
          ...s.va,
          status: ev.status,
          sessionId: ev.sessionId ?? s.va.sessionId,
          code: ev.code ?? null,
          ...(ev.status === "ended" || ev.status === "error" ? { speaking: false, thinking: false, checking: false } : {}),
        },
        sessionIds: ev.sessionId ? { ...s.sessionIds, va: ev.sessionId } : s.sessionIds,
      };
    case "va.reply":
      return reduceReply({ ...s, t }, ev);
    case "va.caption": {
      const base = ev.words[0]?.atMs ?? 0;
      const words = ev.words.map((w) => ({ text: w.text, atMs: Math.max(0, w.atMs - base) }));
      const existing = s.ai.find((l) => l.id === ev.replyId);
      const line: TranscriptLine = {
        id: ev.replyId,
        lane: "ai",
        text: words.map((w) => w.text).join(" "),
        t: existing?.t ?? ev.t,
        startMs: null,
        endMs: null,
        turnId: null,
        source: s.mode === "recorded_ai" ? "recorded" : "live",
        late: false,
        cut: false,
        interrupted: existing?.interrupted ?? false,
        words,
        turn: null,
        kind: existing?.kind ?? null,
      };
      return { ...s, t, ai: upsertLine(s.ai, line) };
    }
    case "va.user": {
      if (!ev.final) return { ...s, t, aiUserPartial: { text: ev.text, t: ev.t } };
      if (!ev.text.trim()) return { ...s, t, aiUserPartial: null };
      const n = s.ai.filter((l) => l.lane === "customer_ai").length;
      const line: TranscriptLine = {
        id: `user-${n}`,
        lane: "customer_ai",
        text: ev.text,
        t: ev.t,
        startMs: null,
        endMs: null,
        turnId: null,
        source: s.mode === "recorded_ai" ? "recorded" : "live",
        late: false,
        cut: false,
        interrupted: false,
        words: null,
        turn: null,
        kind: null,
      };
      // End of the customer's speech: the "…" bubble shows until the first audible reply (§1.4 ai-thinking).
      return { ...s, t, ai: [...s.ai, line], aiUserPartial: null, va: { ...s.va, thinking: !s.va.speaking, checking: false } };
    }
    case "va.tool":
      return reduceTool({ ...s, t }, ev);
    case "stage":
      return { ...s, t, stage: ev.stage, stagesSeen: addUnique(s.stagesSeen, ev.stage) };
    case "payment":
      return { ...s, t, payment: { status: ev.status, source: ev.source ?? s.payment?.source ?? null, t: ev.t } };
    case "phone.sms":
      return {
        ...s,
        t,
        phone: {
          state: s.phone.state === "idle" ? "sms-received" : s.phone.state,
          sms: [...s.phone.sms, { text: ev.text, link: ev.link ?? null, t: ev.t }],
        },
      };
    case "qa":
      return ev.qa.provisional
        ? { ...s, t, qa: { ...s.qa, provisional: ev.qa, status: s.qa.verified ? "verified" : s.qa.status === "failed" ? "failed" : "provisional" } }
        : { ...s, t, qa: { ...s.qa, verified: ev.qa, status: "verified", reason: null } };
    case "hud": {
      const prev = s.hud[ev.metric]?.values ?? [];
      const values = [...prev, ev.ms].slice(-MAX_HUD_VALUES);
      return { ...s, t, hud: { ...s.hud, [ev.metric]: hudStat(values) } };
    }
    case "fallback": {
      if (s.fallbacks.some((f) => f.kind === ev.kind && f.label === ev.label)) return { ...s, t };
      return { ...s, t, fallbacks: [...s.fallbacks, { kind: ev.kind, label: ev.label, t: ev.t }] };
    }
    case "error":
      return { ...s, t, error: { code: ev.code, message: ev.message, t: ev.t } };
    default: {
      const never: never = ev;
      void never;
      return s;
    }
  }
}

function reduceTakeoverPhase(s: UiState, ev: BatonEventOf<"takeover.phase">): UiState {
  const prev = s.takeover;
  const step = { phase: ev.phase, t: ev.t, atMs: ev.atMs, detail: ev.detail ?? null };
  if (ev.phase === "armed") {
    const restart = prev.phase === "done" || prev.phase === "failed" || prev.phase === "fallback";
    const source = ev.detail?.source === "auto_handoff" ? "auto_handoff" : "manual";
    return {
      ...s,
      takeover: {
        phase: "armed",
        steps: [step],
        tArmMs: ev.atMs,
        armedT: ev.t,
        connectedT: null,
        source,
        midUtterance: truthy(ev.detail?.midUtterance),
        count: prev.count + 1,
      },
      clock: { ...s.clock, callMs: Math.max(s.clock.callMs, ev.atMs) },
      ...(restart
        ? {
            handBack: null,
            tools: [],
            va: { ...initialUiState().va },
            qa: { status: "none" as const, provisional: null, verified: null, reason: null, since: null },
            payment: null,
            phone: { state: "idle", sms: [] },
            stage: null,
            stagesSeen: [],
          }
        : {}),
    };
  }
  const takeover = { ...prev, phase: ev.phase, steps: [...prev.steps, step] };
  let qa = s.qa;
  if (ev.phase === "done" && qa.since === null) qa = { ...qa, since: ev.t, status: qa.status === "none" ? "waiting" : qa.status };
  if (ev.phase === "done" || ev.phase === "failed") {
    return { ...s, takeover, qa, va: { ...s.va, speaking: false, thinking: false, checking: false } };
  }
  return { ...s, takeover, qa };
}

function reduceReply(s: UiState, ev: BatonEventOf<"va.reply">): UiState {
  const va = s.va;
  switch (ev.phase) {
    case "started":
      return { ...s, va: { ...va, activeReplyId: ev.replyId, thinking: !va.speaking || va.thinking } };
    case "first_audible": {
      const connectedT = s.takeover.connectedT ?? (s.takeover.armedT !== null ? ev.t : null);
      return {
        ...s,
        va: { ...va, activeReplyId: ev.replyId, speaking: true, thinking: false, checking: false },
        takeover: connectedT !== s.takeover.connectedT ? { ...s.takeover, connectedT } : s.takeover,
      };
    }
    case "done": {
      const hide = ev.kind === "tool_preamble" || ev.kind === "unspoken_text" || ev.kind === "silent_no_output";
      const ai = hide
        ? s.ai.filter((l) => l.id !== ev.replyId)
        : patchLine(s.ai, ev.replyId, { kind: ev.kind ?? null, interrupted: !!ev.interrupted });
      const toolTurn = ev.kind === "tool_preamble";
      return {
        ...s,
        ai,
        va: {
          ...va,
          activeReplyId: va.activeReplyId === ev.replyId ? null : va.activeReplyId,
          speaking: va.activeReplyId === ev.replyId || va.activeReplyId === null ? false : va.speaking,
          thinking: toolTurn,
          checking: toolTurn,
        },
      };
    }
    default:
      return s;
  }
}

function reduceTool(s: UiState, ev: BatonEventOf<"va.tool">): UiState {
  if (ev.phase === "call") {
    if (s.tools.some((x) => x.callId === ev.callId)) return s;
    const item = {
      callId: ev.callId,
      name: ev.name,
      args: ev.args ?? null,
      result: null,
      pending: true,
      hold: ev.name === "send_esign_and_pay_link",
      t: ev.t,
      tResult: null,
    };
    let handBack = s.handBack;
    if (ev.name === "hand_back_to_rep") {
      const a = (ev.args ?? {}) as { reason?: unknown; summary?: unknown };
      handBack = { reason: typeof a.reason === "string" ? a.reason : "other", summary: typeof a.summary === "string" ? a.summary : "", t: ev.t };
    }
    return { ...s, tools: [...s.tools, item], handBack, va: { ...s.va, thinking: !s.va.speaking, checking: true } };
  }
  const i = s.tools.findIndex((x) => x.callId === ev.callId);
  let aiConfirmed = s.aiConfirmed;
  if (ev.name === "update_case_field") {
    const a = (ev.args ?? s.tools[i]?.args ?? {}) as { field?: unknown };
    const r = (ev.result ?? {}) as { status?: unknown; ok?: unknown };
    const accepted = r.status === undefined ? r.ok !== false : r.status !== "rejected";
    if (typeof a.field === "string" && accepted) aiConfirmed = addUnique(aiConfirmed, a.field as FieldId);
  }
  if (i < 0) {
    return {
      ...s,
      aiConfirmed,
      tools: [
        ...s.tools,
        { callId: ev.callId, name: ev.name, args: ev.args ?? null, result: ev.result ?? null, pending: false, hold: ev.name === "send_esign_and_pay_link", t: ev.t, tResult: ev.t },
      ],
    };
  }
  const tools = s.tools.slice();
  tools[i] = { ...(s.tools[i] as (typeof tools)[number]), result: ev.result ?? null, pending: false, tResult: ev.t };
  return { ...s, tools, aiConfirmed };
}

// ------------------------------------------------------------------------------------------------ UI actions

export function reduceUi(s: UiState, a: UiAction): UiState {
  const t = Math.max(s.t, a.t);
  switch (a.type) {
    case "ui.context":
      return { ...s, t, context: a.context };
    case "ui.start":
      return {
        ...s,
        t,
        started: { kind: a.kind, startOffsetMs: a.startOffsetMs, t: a.t },
        clock: { callMs: a.startOffsetMs, playing: true, t: a.t },
        callEnded: false,
      };
    case "ui.clock":
      return { ...s, t, clock: { callMs: a.callMs, playing: a.playing, t: a.t } };
    case "ui.session-ids":
      return { ...s, t, sessionIds: { ...s.sessionIds, ...a.ids } };
    case "ui.suggestions":
      return { ...s, t, suggestions: a.items };
    case "ui.autopilot":
      return { ...s, t, autopilot: a.on };
    case "ui.qa-status":
      return { ...s, t, qa: { ...s.qa, status: a.status === "failed" ? "failed" : s.qa.verified ? "verified" : "waiting", reason: a.reason ?? null, since: s.qa.since ?? a.t } };
    case "ui.call-ended":
      return { ...s, t, callEnded: true, clock: { ...s.clock, playing: false, t: a.t } };
    case "ui.audio-locked":
      return { ...s, t, audioLocked: a.locked };
    case "ui.error-cleared":
      return { ...s, t, error: null };
    case "ui.reset":
      return { ...initialUiState(), context: s.context };
    default: {
      const never: never = a;
      void never;
      return s;
    }
  }
}

// ------------------------------------------------------------------------------------------------ phase

export const isUiAction = (e: UiLogEntry): e is UiAction => e.type.startsWith("ui.");

export function isFatal(s: Pick<UiState, "error" | "takeover">): boolean {
  return (!!s.error && FATAL_ERROR_CODES.has(s.error.code)) || s.takeover.phase === "failed";
}

function aiPhase(s: UiState): UiPhase {
  const inPay = s.takeover.phase === "paying" || (s.stage === "pay" && s.phone.sms.length > 0 && !isTerminalPayment(s.payment?.status));
  if (inPay) return "paying";
  if (s.va.speaking) return "ai-speaking";
  if (s.va.thinking) return "ai-thinking";
  return "ai-listening";
}

/** The flow phase (DESIGN §1.4 S2 table), ignoring the paused / error overlays. */
export function flowPhaseOf(s: UiState): UiPhase {
  const tp = s.takeover.phase;
  switch (tp) {
    case "armed":
      return "arming";
    case "sealing":
      return "sealing";
    case "draining":
      return "draining";
    case "compiling":
      return "compiling";
    case "connecting":
    case "retrying":
      return "connecting-agent";
    case "failed":
      return "error";
    case "done":
      return s.handBack ? "handed-back" : "completed";
    case "fallback":
      // Until the recorded bundle's first reply arrives, the page shows the labelled fallback state.
      return !s.va.speaking && !s.va.thinking && s.ai.length === 0 ? "fallback" : aiPhase(s);
    case "greeting":
      if (s.takeover.connectedT === null && !s.va.speaking) return s.va.thinking ? "ai-thinking" : "connecting-agent";
      return aiPhase(s);
    case "active":
    case "paying":
    case "closing":
      return aiPhase(s);
    case "idle":
      break;
  }
  // A recorded AI bundle may arrive without takeover phases.
  if (s.mode === "recorded_ai" && (s.va.status !== "idle" || s.ai.length > 0)) {
    if (s.va.status === "ended") return s.handBack ? "handed-back" : "completed";
    return aiPhase(s);
  }
  const liveFinal = s.human.some((l) => l.source !== "cached");
  const cached = s.mode === "cached_replay";
  const st = [s.stt.rep.status, s.stt.customer.status];
  const anyOpen = st.includes("open");
  if (!s.started && s.human.length === 0 && !cached && st.every((x) => x === "idle")) return "preflight";
  if (cached || anyOpen || liveFinal) return "shadowing";
  if (st.includes("queued")) return "queued";
  // Started (or Express-prefilled) but no live session is open yet.
  return "connecting";
}

export function withPhase(s: UiState): UiState {
  const flowPhase = flowPhaseOf(s);
  const phase: UiPhase = isFatal(s) ? "error" : s.paused ? "paused" : flowPhase;
  return phase === s.phase && flowPhase === s.flowPhase ? s : { ...s, phase, flowPhase };
}

/** Apply one fixture/log entry (event or UI action) and re-derive the phase. */
export function reduceEntry(s: UiState, e: UiLogEntry): UiState {
  return withPhase(isUiAction(e) ? reduceUi(s, e) : reduceEvent(s, e));
}

/** Fold a whole log (tests, seeking the fixture player). */
export function replayLog(entries: readonly UiLogEntry[], from: UiState = initialUiState()): UiState {
  let s = from;
  for (const e of entries) s = reduceEntry(s, e);
  return s;
}
