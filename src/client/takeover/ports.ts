import "client-only";

import type {
  ArmRequest, ArmResponse, EndTakeoverRequest, EndTakeoverResponse, SessionReport, TakeoverEventsRequest, VaTokenRequest, VaTokenResponse,
} from "@/core/contracts/api";
import type { ErrorCode, FallbackKind } from "@/core/contracts/errors";
import type { CallHandoff } from "@/core/contracts/scenario";
import type { AudioEngine, CallPlayback, CaseSync, EventSink, LatencyHud, SttChannelManager } from "@/core/contracts/services";
import type { CompiledTakeover, DrainReport } from "@/core/contracts/takeover";

/**
 * The seams of the TakeoverController (DESIGN §5.5.3). Every collaborator is injected, so the controller runs in
 * unit tests with fakes and in the page with WP4's engine/STT/CaseSync, WP5b's Voice Agent controller, WP11's
 * replay player and the HTTP API below.
 */

/**
 * Voice Agent events the controller acts on. Mirrors WP5b's `VaControllerEvent` (contracts/ext/wp5b-va.ts, merged at
 * G1) so `VoiceAgentControllerImpl` plugs in as a `VaSession` without an adapter.
 */
export type VaSessionEvent =
  | { type: "ready"; sessionId: string; ctxMs: number }
  | { type: "first_audible"; replyId: string; ctxMs: number; greeting: boolean }
  /** The stage id (a string, so stages from any relay blueprint pass through; the controller only forwards it). */
  | { type: "stage"; stage: string }
  | { type: "paying"; on: boolean }
  | { type: "hand_back"; reason: string; summary: string }
  | { type: "close_ready" }
  | { type: "wrap_up"; atMs: number }
  | { type: "error"; code: ErrorCode; retryable: boolean; message: string; afterFirstUpdate: boolean }
  | { type: "ended"; reason: string; sessionSeconds: number | null; sessionId: string | null };

/** One Voice Agent attempt (WP5b `VoiceAgentControllerExt` satisfies it). */
export interface VaSession {
  connect(token: string): Promise<void>;
  start(c: CompiledTakeover, opts: { holdAudioUntilCtxMs: number }): Promise<{ sessionId: string }>;
  end(reason: string): Promise<void>;
  /** Synchronous best-effort `session.end` (pagehide, aborting a failed attempt). */
  endNow(reason: string): void;
  onEvent(cb: (e: VaSessionEvent) => void): () => void;
}

/** A failed API call, with the ApiError code (or a transport code). */
export class TakeoverApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly fallback: FallbackKind | null = null,
  ) {
    super(message);
    this.name = "TakeoverApiError";
  }
}

export interface RequestOpts {
  /** pagehide: `fetch(..., {keepalive:true})` with the Authorization header (G0: never sendBeacon). */
  keepalive?: boolean;
}

/** The HTTP calls of the takeover protocol (routes #9–#13, #5b, #7). */
export interface TakeoverApi {
  arm(req: ArmRequest, caseToken: string): Promise<ArmResponse>;
  compile(takeoverId: string, drain: DrainReport, takeoverToken: string): Promise<CompiledTakeover>;
  events(takeoverId: string, body: TakeoverEventsRequest, takeoverToken: string, opts?: RequestOpts): Promise<void>;
  end(takeoverId: string, body: EndTakeoverRequest, takeoverToken: string, opts?: RequestOpts): Promise<EndTakeoverResponse>;
  vaToken(req: VaTokenRequest, takeoverToken: string): Promise<VaTokenResponse>;
  releaseRun(runId: string, caseToken: string, opts?: RequestOpts): Promise<void>;
  reportSession(r: SessionReport, token: string): Promise<void>;
}

/** The recorded AI session of the call (WP11 `ReplayPlayer` bound to the page's sink and bundle). */
export interface RecordedAiPlayer {
  play(): Promise<void>;
  stop(): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface TakeoverControllerDeps {
  ids: { caseId: string; runId: string; caseToken: string };
  /** RunPlan.aiHalf. */
  aiHalf: "live" | "recorded";
  call: { handoff: CallHandoff | null; recordedAiBundle: string | null };
  /** Watch mode: true (rule 6). Live/be-the-customer mode: false. */
  autoBaton: boolean;
  engine: Pick<AudioEngine, "nowMs">;
  playback: Pick<CallPlayback, "stop" | "channelEnergyDb" | "playHandoffClip" | "onTick" | "onEnded">;
  stt: Pick<SttChannelManager, "hasOpenPartial" | "forceEndpoint" | "terminateAll">;
  caseSync: Pick<CaseSync, "drain">;
  api: TakeoverApi;
  /**
   * A fresh Voice Agent controller per attempt (WP5b `createVoiceAgentController`). `ctx` carries the takeover id and
   * its token for the controller's own calls (#12 heartbeats, #14 tools, #15 payment polls).
   */
  createVa(attempt: 0 | 1, ctx: { takeoverId: string; takeoverToken: string }): VaSession;
  /** COMPILING + 1500 ms fallback: WP1 `compileTakeover(caseSync.state, policy, {compiledBy:"client", …})`. Throws E_VA_CONFIG. */
  localCompile(drain: DrainReport): CompiledTakeover;
  /** The labelled recorded AI session (rule 7 and FALLBACK); null when the call has none. */
  recorded: RecordedAiPlayer | null;
  /** hand_back_to_rep: the rep's "I'm back" line (WP11/WP4). Resolves when it finished playing. */
  playRepBack?: () => Promise<void>;
  sink: EventSink;
  hud?: Pick<LatencyHud, "mark">;
  /** BatonEvent `t` (ms since the page session start); default `engine.nowMs()`. */
  eventTime?: () => number;
  /** Default: `window.addEventListener("pagehide", …)`. */
  onPageHide?: (cb: () => void) => () => void;
  timers?: Timers;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}
