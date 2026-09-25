/**
 * contracts/ext/wp7-ui.ts - the call console's UI store state (WP7; additive, TASKS §0.2).
 *
 * `BatonUiState` is declared empty in services.ts so WP7 can fill it by module augmentation (below). Everything the
 * console renders is derived from `BatonEvent`s (contracts/events.ts) plus a handful of `UiAction`s: facts the page
 * orchestrator knows that are not part of the replayable event log (call metadata, the Start click, the QA
 * verification status, suggested replies, the playhead clock). A recorded bundle stays a pure `BatonEvent[]`.
 *
 * Pure types and constants: no imports outside src/core/contracts.
 */
import type {
  CaseState, Channel, DisclosureKind, FactEvent, FieldId, PaymentStatus, PolicyRecord, Stage,
} from "../case";
import type { ErrorCode, FallbackKind } from "../errors";
import type { BatonEvent, HudMetric, QaResult, ReplyKind, TakeoverPhase } from "../events";
import type { RunPlan } from "../run";
import type { CallHandoff, CallManifestEntry, Peaks } from "../scenario";
import type { Suggestion } from "../services";
import type { ToolName } from "../tools";
import type { TurnInput } from "../turns";

/** DESIGN §1.4 S2 page states (store `ui.phase`). */
export const UI_PHASES = [
  "preflight", "queued", "connecting", "shadowing",
  "arming", "sealing", "draining", "compiling", "connecting-agent",
  "ai-listening", "ai-thinking", "ai-speaking", "paying",
  "paused", "completed", "handed-back", "fallback", "error",
] as const;
export type UiPhase = (typeof UI_PHASES)[number];

/** The protocol stepper (§1.3 P1 step 4): Arming → Sealing → Draining → Compiling → Connecting. */
export const PROTOCOL_STEPS = ["armed", "sealing", "draining", "compiling", "connecting"] as const satisfies readonly TakeoverPhase[];
export type ProtocolStep = (typeof PROTOCOL_STEPS)[number];

export type SttUiStatus = "idle" | "queued" | "connecting" | "open" | "reconnecting" | "terminated" | "error";
export type TranscriptLane = "rep" | "customer" | "ai" | "customer_ai";
export type QaUiStatus = "none" | "waiting" | "provisional" | "verified" | "failed";

export interface TranscriptLine {
  /** turnId (human half), replyId (AI lane) or `user-<n>` (customer lane of the AI half). */
  id: string;
  lane: TranscriptLane;
  text: string;
  /** Page-clock time the line arrived (`BatonEvent.t`). */
  t: number;
  /** Call clock for the human half (turn start/end); null in the AI half. */
  startMs: number | null;
  endMs: number | null;
  turnId: string | null;
  source: "live" | "cached" | "recorded";
  late: boolean;
  cut: boolean;
  interrupted: boolean;
  /** AI captions: word offsets (ms from the first word) for the staggered reveal. */
  words: { text: string; atMs: number }[] | null;
  /** The full turn (evidence playback, hover ▶). */
  turn: TurnInput | null;
  /** Reply kind once known (`va.reply done`). tool_preamble / unspoken_text are never captioned (§5.10 rule 2). */
  kind: ReplyKind | null;
}

export interface ToolRailItem {
  callId: string;
  name: ToolName;
  args: unknown;
  result: unknown;
  pending: boolean;
  /** send_esign_and_pay_link runs in hold mode (§5.8). */
  hold: boolean;
  t: number;
  tResult: number | null;
}

export interface ProtocolStepView {
  phase: TakeoverPhase;
  /** Page clock of the transition. */
  t: number;
  /** Call clock at the transition (`takeover.phase.atMs`). */
  atMs: number;
  detail: Record<string, number | string> | null;
}

export interface HudStatView {
  last: number;
  p50: number;
  p90: number;
  n: number;
}

/** Call metadata the page knows before any event (from /api/cases or the fixture). */
export interface UiCallContext {
  callId: string;
  title: string;
  /** ISO date (the call's recorded date; the AI half runs "as of" it). */
  callDate: string;
  durationMs: number;
  source: CallManifestEntry["source"];
  language: CallManifestEntry["language"];
  decisionPointMs: number | null;
  handoff: CallHandoff | null;
  hasRecordedAiBundle: boolean;
  policy: PolicyRecord;
  peaks: Peaks | null;
  /** `StatusResponse.limits.sttOpensPerMin` for the queued copy (DESIGN says 5). */
  sttOpensPerMin?: number;
  /** Cached-turn transcription date for the CACHED REPLAY tooltip ("transcribed live by AssemblyAI on …"). */
  cachedTranscribedAt?: string | null;
}

/**
 * UI actions: what the orchestrator knows that is not a `BatonEvent`. Fixture logs may interleave them with events
 * (`type` always starts with "ui.", so they never collide with a `BatonEventType`).
 */
export type UiAction =
  | { t: number; type: "ui.context"; context: UiCallContext }
  | { t: number; type: "ui.start"; kind: "express" | "full"; startOffsetMs: number }
  | { t: number; type: "ui.clock"; callMs: number; playing: boolean }
  | { t: number; type: "ui.session-ids"; ids: { rep?: string; customer?: string; va?: string } }
  | { t: number; type: "ui.suggestions"; items: Suggestion[] }
  | { t: number; type: "ui.autopilot"; on: boolean }
  | { t: number; type: "ui.qa-status"; status: "waiting" | "failed"; reason?: string }
  | { t: number; type: "ui.call-ended" }
  | { t: number; type: "ui.audio-locked"; locked: boolean }
  | { t: number; type: "ui.error-cleared" }
  /** A plain-words, non-fatal notice from a controller (WP5 `view().notice` at level "info"); null clears it. */
  | { t: number; type: "ui.notice"; message: string | null }
  | { t: number; type: "ui.reset" };
export type UiActionType = UiAction["type"];

/** One entry of a fixture log: a replayable BatonEvent or a UiAction. */
export type UiLogEntry = BatonEvent | UiAction;

export interface Wp7UiState {
  phase: UiPhase;
  /** `phase` without the paused/error overlays (what the page returns to). */
  flowPhase: UiPhase;
  /** Latest page-clock time seen. */
  t: number;
  context: UiCallContext | null;
  plan: RunPlan | null;
  started: { kind: "express" | "full"; startOffsetMs: number; t: number } | null;
  mode: "live" | "cached_replay" | "recorded_ai";
  modeReason: string | null;
  stt: Record<Channel, { status: SttUiStatus; detail: string | null }>;
  queue: { position: number; etaMs: number; t: number } | null;
  clock: { callMs: number; playing: boolean; t: number };
  human: TranscriptLine[];
  partials: Record<Channel, { turnOrder: number; text: string; t: number } | null>;
  ai: TranscriptLine[];
  aiUserPartial: { text: string; t: number } | null;
  caseState: CaseState | null;
  /** Fact events seen (timeline markers), newest last, capped. */
  facts: FactEvent[];
  /** Fields changed by an AI tool update after the pass ("AI-confirmed" tag). */
  aiConfirmed: FieldId[];
  /** The case card shows the recorded bundle's state; the judge's own shadow lanes are greyed (§1.4 S2). */
  shadowGreyed: boolean;
  verifier: { agrees: boolean; disagreements: FieldId[]; t: number } | null;
  takeover: {
    phase: TakeoverPhase;
    steps: ProtocolStepView[];
    /** Call clock at the arm (the separator row "Baton passed at 01:42.3"). */
    tArmMs: number | null;
    /** Page clock of the arm and of the first audible greeting (the separator's "protocol 2.9 s"). */
    armedT: number | null;
    connectedT: number | null;
    source: "manual" | "auto_handoff" | null;
    midUtterance: boolean;
    count: number;
  };
  va: {
    status: "idle" | "connecting" | "ready" | "ended" | "error";
    sessionId: string | null;
    code: string | null;
    speaking: boolean;
    thinking: boolean;
    /** The "…" bubble reads "checking…" when the pending reply is a tool pre-amble / tool turn. */
    checking: boolean;
    activeReplyId: string | null;
  };
  tools: ToolRailItem[];
  stage: Stage | null;
  stagesSeen: Stage[];
  payment: { status: PaymentStatus; source: "webhook" | "server_poll" | "mock" | null; t: number } | null;
  phone: { state: string; sms: { text: string; link: string | null; t: number }[] };
  qa: { status: QaUiStatus; provisional: QaResult | null; verified: QaResult | null; reason: string | null; since: number | null };
  hud: Partial<Record<HudMetric, HudStatView & { values: number[] }>>;
  sessionIds: { rep?: string; customer?: string; va?: string };
  suggestions: Suggestion[];
  autopilot: boolean;
  fallbacks: { kind: FallbackKind; label: string; t: number }[];
  error: { code: ErrorCode; message: string; t: number } | null;
  paused: { reason: "ios_background" | "audio_interrupted"; t: number } | null;
  handBack: { reason: string; summary: string; t: number } | null;
  disclosuresGiven: DisclosureKind[];
  callEnded: boolean;
  audioLocked: boolean;
  /** The latest informational notice (top-bar soft line), or null. */
  notice: string | null;
}

declare module "../services" {
  // Declaration merging: the store state is WP7's (services.ts invites this augmentation).
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface BatonUiState extends Wp7UiState {}
}
