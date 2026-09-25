/**
 * contracts/ext/wp5b-va.ts - additive types for the Voice Agent client and the HUD (WP5b; TASKS §0.2 "missing
 * types go in ext/"). TYPES ONLY. The frozen seams (`VoiceAgentController`, `LatencyHud`, `PhoneState`) stay in
 * services.ts; these extend them with what WP5 (TakeoverController), WP7 (call console, HUD component) and WP11
 * (CustomerInput) need to wire the AI half.
 */
import type { ToolResponse, TakeoverEventsRequest, PaymentView } from "../api";
import type { Stage } from "../case";
import type { ErrorCode } from "../errors";
import type { HudMetric, ReplyKind } from "../events";
import type { LatencyHud, MicSource, VoiceAgentController } from "../services";
import type { TranscriptionMode } from "../takeover";
import type { ToolName, VaFunctionTool } from "../tools";

/** DESIGN §5.8: `hold` (default; T-D1-1) or the `push` fallback. */
export type PayToolMode = "hold" | "push";

/** The controller's own view of the session (WP5's machine keeps the authoritative TakeoverPhase). */
export type VaControllerPhase = "idle" | "connecting" | "open" | "ready" | "active" | "paying" | "closing" | "ended" | "failed";

/** Signals from the Voice Agent controller to its owner (WP5 TakeoverController). */
export type VaControllerEvent =
  | { type: "ready"; sessionId: string; ctxMs: number }
  /** First audible chunk PLAYED (not received). `greeting` marks the first reply of the session. */
  | { type: "first_audible"; replyId: string; ctxMs: number; greeting: boolean }
  | { type: "stage"; stage: Stage }
  | { type: "paying"; on: boolean }
  /**
   * hand_back_to_rep: the tool.result was sent and the agent's one-sentence reply finished (or the 4 s grace ran
   * out). The owner now plays the rep's "I'm back" line and ends the session (DESIGN §5.8).
   */
  | { type: "hand_back"; reason: string; summary: string }
  /** send_confirmation succeeded, the closing reply finished and 2.5 s passed quietly: the owner may enter CLOSING. */
  | { type: "close_ready" }
  /** The wrap-up reply.create was sent (effective cap − 20 s). */
  | { type: "wrap_up"; atMs: number }
  /**
   * A failure the owner must act on. `retryable` = RETRYING is allowed (once, with a new takeover-keyed token,
   * attempt 1). Non-fatal mid-session config errors are NOT reported here (logged as `error` BatonEvents only).
   */
  | { type: "error"; code: ErrorCode; retryable: boolean; message: string; afterFirstUpdate: boolean }
  | { type: "ended"; reason: string; sessionSeconds: number | null; sessionId: string | null };

/** The controller interface WP5/WP7/WP11 use (a superset of services.ts `VoiceAgentController`). */
export interface VoiceAgentControllerExt extends VoiceAgentController {
  readonly phase: VaControllerPhase;
  readonly stage: Stage | null;
  onEvent(cb: (e: VaControllerEvent) => void): () => void;
  /**
   * Customer audio for the AI half (WP11 chips/typed/autopilot): queue a 24 kHz PCM16 clip on the customer feeder.
   * Resolves at the clip's end on the AudioContext clock and marks the HUD `eos` there (DESIGN §5.10).
   */
  playCustomerClip(pcm24k: Int16Array): Promise<{ endCtxMs: number }>;
  /** Mic mode (roadmap P2): frames go to the VA; local VAD ducks agent playback on onset (§5.10 barge-in). */
  setMicSource(src: MicSource | null): void;
  /** Synchronous best-effort end for `pagehide` (session.end sent without waiting; §5.9.5, G0 keepalive rule). */
  endNow(reason: string): void;
}

/** Tool route call (#14) as the controller needs it; WP6's `callTool()` satisfies it (or an adapter does). */
export type VaToolCaller = (name: ToolName, args: unknown, ctx: { takeoverId: string; callId: string }) => Promise<ToolResponse>;
/** GET /api/payments/[id] (#15). */
export type VaPaymentPoller = (paymentId: string) => Promise<PaymentView>;
/**
 * The system prompt and tool list of a stage the controller must enter WITHOUT a tool response carrying them
 * (the hold protocol's paid → close transition, §5.8 step 3 and step 8). WP1's `compilePrompt`/`toolsForStage` on
 * the current case state, or a server call; injected by the owner.
 */
export type VaStageSource = (stage: Stage) => Promise<{ systemPrompt: string; tools: VaFunctionTool[]; transcriptionMode?: TranscriptionMode }>;
/** POST /api/takeovers/[id]/events (#12): heartbeats, HUD values, the VA session id, failures. */
export type VaEventsPoster = (body: TakeoverEventsRequest) => Promise<void>;

/** LatencyHud (services.ts) + what the controller and the HUD component need. */
export interface LatencyHudExt extends LatencyHud {
  /** The reply's kind at reply.done (a reply after a tool_preamble is a tool turn, §5.10). */
  noteReplyKind(replyId: string, kind: ReplyKind): void;
  /** Output underruns and the "slow network" (WS bufferedAmount > ~1 s of audio) signal for the HUD. */
  setAudioHealth(h: { underruns?: number; slowNetwork?: boolean }): void;
  snapshot(): HudSnapshot;
  subscribe(cb: () => void): () => void;
  reset(): void;
}

export interface HudStat { last: number; p50: number; p90: number; n: number }

export interface HudSnapshot {
  metrics: Partial<Record<HudMetric, HudStat>>;
  sessionIds: { rep?: string; customer?: string; va?: string };
  underruns: number;
  slowNetwork: boolean;
  /** Raw marks (ctx ms) of the current takeover, for debugging and the Explorer. */
  marks: { name: string; ctxMs: number; replyId?: string }[];
}
