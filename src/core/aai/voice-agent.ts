/**
 * aai/voice-agent.ts - AssemblyAI Voice Agent API client, browser-safe part. Promoted from
 * spikes/voice-agent/client.ts per DESIGN §3.2 (fix 5.3-1):
 *  - the Node `ws` import, the Node connect helpers and the REST client (needs the API key: token minting,
 *    stored agents, session history) moved to src/server/aai/va-node.ts;
 *  - no Node types (Buffer) are referenced; base64 goes through src/core/audio/base64.ts;
 *  - `vaErrorToErrorCode()` maps session errors to DESIGN §7.4 codes.
 * Everything else is kept verbatim: typed client and server event unions, `VoiceAgentSession`, `ToolDispatcher`,
 * `ReplyTracker`, `RealtimeAudioFeeder`, `errorCode`, `RETRYABLE_ERROR_CODES`, `chunkLevelDb`, base64 helpers.
 *
 * Browser use: `new VoiceAgentSession(new WebSocket(tokenUrl(token)))` with a token minted server-side by the
 * takeover-keyed /api/va/token route; send the first session.update right after the socket opens.
 */
import type { ErrorCode } from "../contracts/errors";
import { base64ToBytes, bytesToBase64 } from "../audio/base64";
import { alawDecodeSample, mulawDecodeSample } from "../audio/mulaw";
import { looksLikeBalanceError } from "./streaming";

export { base64ToBytes, bytesToBase64 };

// =============================================================================================
// Endpoints
// =============================================================================================

export const VA_HOST = "agents.assemblyai.com";
export const VA_WS_URL = `wss://${VA_HOST}/v1/ws`;
export const VA_REST_BASE = `https://${VA_HOST}/v1`;
/** Region-pinned US host used by the SIP phone-number endpoints (agent ids are NOT shared with VA_HOST). */
export const VA_US_REST_BASE = "https://agents.us.assemblyai.com/v1";
export const LLM_GATEWAY_BASE = "https://llm-gateway.assemblyai.com/v1";

/** Default wire format both ways: PCM16 mono little-endian @ 24 kHz. */
export const VA_SAMPLE_RATE = 24000;
/** 50 ms of 24 kHz PCM16 = 2400 bytes (the input frame size, DESIGN App. A.3). */
export const VA_INPUT_FRAME_BYTES = 2400;

/** The 18 verified voice ids (10 §3.3). `ivy`, `claire` and `dawn` are invalid. */
export const VA_VOICES = [
  "alba", "anna", "charles", "estelle", "eve", "george", "giovanni", "iris", "jane", "jean", "juergen", "lola",
  "mary", "michael", "paul", "rafael", "reid", "vera",
] as const;
export type VaVoice = (typeof VA_VOICES)[number];

export const tokenUrl = (token: string, base = VA_WS_URL): string => {
  const u = new URL(base);
  u.searchParams.set("token", token);
  return u.toString();
};

// =============================================================================================
// Session configuration types
// =============================================================================================

export type AudioEncoding = "audio/pcm" | "audio/pcmu" | "audio/pcma";
export interface AudioFormat {
  encoding: AudioEncoding;
  /** Optional; implied by the encoding (pcm = 24000, pcmu/pcma = 8000). */
  sample_rate?: number;
}
export type TranscriptionMode = "min_latency" | "balanced" | "max_accuracy";
export interface TurnDetection {
  vad_threshold?: number;
  /** Setting min/max_silence disables adaptive + entity-aware waiting for the rest of the session. */
  min_silence?: number;
  max_silence?: number;
  interrupt_response?: boolean;
  interruption_delay?: number;
}
export interface InputConfig {
  format?: AudioFormat;
  keyterms?: string[];
  transcription_mode?: TranscriptionMode;
  transcription_prompt?: string;
  language_codes?: string[];
  voice_focus?: "near-field" | "far-field";
  voice_focus_threshold?: number;
  turn_detection?: TurnDetection;
}
export interface OutputConfig {
  /** Immutable after session.ready. */
  voice?: string;
  /** Immutable after session.ready. */
  format?: AudioFormat;
  volume?: number | null;
}
export type JsonSchema = Record<string, unknown>;
export type ExecutionMode = "interactive" | "hold";

/** Client-side function tool (inline session.tools). You answer tool.call with tool.result. */
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters?: JsonSchema;
  execution_mode?: ExecutionMode;
  timeout_seconds?: number;
}
export interface HttpToolHeader {
  name: string;
  value?: string;
  remove?: boolean;
}
/** Server-side HTTP tool (stored agents only). AssemblyAI calls `http.url`; never send tool.result for it. */
export interface HttpTool {
  name: string;
  description: string;
  parameters?: JsonSchema;
  execution_mode?: ExecutionMode;
  timeout_seconds?: number;
  http: { url: string; http_method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; headers?: HttpToolHeader[] };
}
export interface LlmConfig {
  base_url: string;
  model: string;
  api_key: string;
}

/** Inline configuration (first session.update, and mutable fields afterwards). */
export interface InlineSessionConfig {
  system_prompt?: string;
  /**
   * Immutable after session.ready. Spoken verbatim (not passed through the LLM). Omit it for "agent listens first":
   * an explicit `null` is rejected with invalid_format.
   */
  greeting?: string;
  input?: InputConfig;
  output?: OutputConfig;
  /** Replaces the whole list (no merge). Partially validated (e.g. properties must be an object). */
  tools?: FunctionTool[];
}
/** Bind a stored agent. Must be the first session.update and cannot be mixed with inline fields. */
export interface AgentBinding {
  agent_id: string;
}
export type SessionUpdatePayload = InlineSessionConfig | AgentBinding;

/** Stored agent (POST/PUT /v1/agents). Only name, system_prompt and voice are required. */
export interface AgentDefinition {
  name: string;
  system_prompt: string;
  voice: { voice_id: string };
  greeting?: string | null;
  input?: InputConfig;
  output?: OutputConfig;
  tools?: (HttpTool | FunctionTool | Omit<HttpTool, "http">)[];
  /** Only one entry accepted. `[]` switches back to the managed LLM. */
  llm?: LlmConfig[];
  pre_connect_requests?: unknown[];
}
/**
 * Stored agent as returned by POST/GET. Observed: id looks like "agent_<32 hex>"; `voice.voice_id` is what sessions
 * use (`output.voice` on the record showed a stale default "ivy"); HTTP tool header values are omitted on read.
 */
export interface AgentRecord extends Omit<AgentDefinition, "llm"> {
  id: string;
  created_at?: string;
  updated_at?: string;
  llm?: { base_url: string; model: string }[];
  [k: string]: unknown;
}

/** A session history record (GET /v1/sessions/{id}). Artifacts appear ≈7 s after the end; URLs live 1 h. */
export interface SessionRecord {
  id: string;
  agent_id?: string | null;
  status?: string;
  public_close_reason?: string;
  duration_seconds?: number;
  created_at?: string;
  ended_at?: string | null;
  config?: Record<string, unknown>;
  artifacts?: { type: string; url: string; content_type?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

// =============================================================================================
// Events
// =============================================================================================

export type ClientEvent =
  | { type: "session.update"; session: SessionUpdatePayload }
  | { type: "session.resume"; session_id: string }
  | { type: "session.end" }
  | { type: "input.audio"; audio: string }
  | { type: "tool.result"; call_id: string; result: string; is_error?: boolean }
  | { type: "reply.create"; instructions?: string }
  | { type: "conversation.message"; role: "user" | "system"; content: string };

export interface SessionReadyEvent {
  type: "session.ready";
  session_id: string;
  expires_at?: number;
  resume_token?: string;
  config?: Record<string, unknown>;
}
export interface SessionUpdatedEvent {
  type: "session.updated";
  config?: Record<string, unknown>;
}
export interface SessionEndedEvent {
  type: "session.ended";
  session_duration_seconds?: number;
  /** Always null in testing. */
  audio_duration_seconds?: number;
  timestamp?: number;
}
/** The live API sends lower-case `code` (C5); read it through errorCode(). */
export interface SessionErrorEvent {
  type: "session.error";
  code?: string;
  error_code?: string;
  message?: string;
  param?: string;
  timestamp?: string | number;
}
export interface SpeechStartedEvent {
  type: "input.speech.started";
}
export interface SpeechStoppedEvent {
  type: "input.speech.stopped";
}
export interface TranscriptUserDeltaEvent {
  type: "transcript.user.delta";
  item_id?: string;
  /** Full transcript so far for item_id (replace, don't append). */
  text: string;
}
export interface TranscriptUserEvent {
  type: "transcript.user";
  item_id?: string;
  text: string;
}
export interface ReplyStartedEvent {
  type: "reply.started";
  reply_id: string;
  item_id?: string;
}
export interface ReplyAudioEvent {
  type: "reply.audio";
  /** base64 audio in the configured output encoding. */
  data: string;
  reply_id?: string;
}
export interface TranscriptAgentDeltaEvent {
  type: "transcript.agent.delta";
  reply_id?: string;
  item_id?: string;
  /** Next word (append). */
  delta: string;
  start_ms?: number | null;
  end_ms?: number | null;
}
export interface TranscriptAgentEvent {
  type: "transcript.agent";
  text: string;
  reply_id?: string;
  item_id?: string;
  interrupted?: boolean;
}
export interface ReplyDoneEvent {
  type: "reply.done";
  reply_id?: string;
  status?: "completed" | "interrupted" | (string & {});
}
export interface ToolCallEvent {
  type: "tool.call";
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface UnknownServerEvent {
  type: string;
  [k: string]: unknown;
}

export interface ServerEventMap {
  "session.ready": SessionReadyEvent;
  "session.updated": SessionUpdatedEvent;
  "session.ended": SessionEndedEvent;
  "session.error": SessionErrorEvent;
  "input.speech.started": SpeechStartedEvent;
  "input.speech.stopped": SpeechStoppedEvent;
  "transcript.user.delta": TranscriptUserDeltaEvent;
  "transcript.user": TranscriptUserEvent;
  "reply.started": ReplyStartedEvent;
  "reply.audio": ReplyAudioEvent;
  "transcript.agent.delta": TranscriptAgentDeltaEvent;
  "transcript.agent": TranscriptAgentEvent;
  "reply.done": ReplyDoneEvent;
  "tool.call": ToolCallEvent;
}
export type ServerEventType = keyof ServerEventMap;
export type ServerEvent = ServerEventMap[ServerEventType] | UnknownServerEvent;

/** Normalised, lower-cased error code from a session.error (handles `code` / `error_code`, any casing). */
export const errorCode = (ev: { code?: unknown; error_code?: unknown }): string =>
  String(ev.code ?? ev.error_code ?? "unknown").toLowerCase();

/** Retryable per docs: reconnect with backoff (fresh token!). Every other code is fatal. */
export const RETRYABLE_ERROR_CODES = new Set(["at_capacity", "concurrency_exceeded", "internal_error", "server_error"]);

/** Mid-session config errors that keep the session open (10a VA-3). */
export const NON_FATAL_CONFIG_ERROR_CODES = new Set(["immutable_field", "invalid_format", "invalid_audio", "invalid_value", "agent_id_not_first"]);

/**
 * DESIGN §5.9.6 / §7.4 mapping of a Voice Agent session error to an ErrorCode. `afterFirstUpdate` marks errors
 * that arrived in answer to the first session.update (fatal config: E_VA_CONFIG, no retry with the same config).
 */
export function vaErrorToErrorCode(ev: { code?: unknown; error_code?: unknown; message?: unknown }, opts: { afterFirstUpdate?: boolean } = {}): ErrorCode {
  const code = errorCode(ev);
  if (looksLikeBalanceError(typeof ev.message === "string" ? ev.message : null)) return "E_AAI_BALANCE";
  if (code === "unauthorized") return "E_VA_AUTH";
  if (code === "at_capacity" || code === "concurrency_exceeded") return "E_VA_CAPACITY";
  if (RETRYABLE_ERROR_CODES.has(code)) return "E_VA_TRANSIENT";
  if (opts.afterFirstUpdate || NON_FATAL_CONFIG_ERROR_CODES.has(code)) return "E_VA_CONFIG";
  return "E_VA_TRANSIENT";
}

// =============================================================================================
// Small utilities
// =============================================================================================

const now = (): number => performance.now();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const textOf = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return String(raw);
};

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`timed out after ${ms} ms waiting for ${what}`);
    this.name = "TimeoutError";
  }
}

// =============================================================================================
// WebSocket session
// =============================================================================================

/** Minimal WHATWG-style socket surface (browser WebSocket and Node `ws` both satisfy it). */
export interface WebSocketLike {
  readonly readyState: number;
  /** Bytes queued but not yet sent (browser; DESIGN §5.9.3 "slow network" badge). */
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: (ev: unknown) => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
}

const WS_OPEN = 1;

export interface SessionOptions {
  /** Raw event hook for logging/metrics: every parsed server event ("in") and every client event ("out"). */
  onEvent?: (dir: "in" | "out", ev: ServerEvent | ClientEvent, atMs: number) => void;
  /**
   * Client-side session cap: call end() this many ms after the socket is wrapped. The server did not enforce the
   * token's max_session_duration_seconds in testing, so this is the real spend limit.
   */
  maxDurationMs?: number;
}

type Handler<E> = (ev: E) => void;

export interface CloseInfo {
  code: number;
  reason: string;
  atMs: number;
}

export class VoiceAgentSession {
  readonly ws: WebSocketLike;
  sessionId: string | undefined;
  ready: SessionReadyEvent | undefined;
  ended: SessionEndedEvent | undefined;
  closed: CloseInfo | undefined;
  /** Every server event type seen, in order, with receive time (performance.now()). */
  readonly timeline: { type: string; atMs: number }[] = [];
  readonly tools: ToolDispatcher;
  readonly replies: ReplyTracker;

  private handlers = new Map<string, Set<Handler<never>>>();
  private closeWaiters = new Set<(c: CloseInfo) => void>();
  private readonly onEvent: SessionOptions["onEvent"];

  constructor(ws: WebSocketLike, opts: SessionOptions = {}) {
    this.ws = ws;
    this.onEvent = opts.onEvent;
    this.tools = new ToolDispatcher(this);
    this.replies = new ReplyTracker();
    const cap = opts.maxDurationMs ? setTimeout(() => void this.end(), opts.maxDurationMs) : undefined;
    ws.addEventListener("message", (m) => this.handleRaw(m.data));
    ws.addEventListener("close", (c) => {
      if (cap) clearTimeout(cap);
      this.closed = { code: c.code, reason: String(c.reason ?? ""), atMs: now() };
      for (const w of this.closeWaiters) w(this.closed);
      this.closeWaiters.clear();
      this.emit("__close", this.closed as never);
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WS_OPEN && !this.closed;
  }

  // ---- events ------------------------------------------------------------------------------

  on<K extends ServerEventType>(type: K, fn: Handler<ServerEventMap[K]>): () => void;
  on(type: "*", fn: Handler<ServerEvent>): () => void;
  on(type: "__close", fn: Handler<CloseInfo>): () => void;
  on(type: string, fn: Handler<ServerEvent>): () => void;
  on(type: string, fn: Handler<never>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Resolve with the next event of `type` matching `pred`. Rejects on timeout or socket close.
   * Pass `alsoResolveOn` (e.g. ["session.error"]) to resolve early with a different event type.
   */
  waitFor<K extends ServerEventType>(
    type: K,
    o: { pred?: (ev: ServerEventMap[K]) => boolean; timeoutMs?: number; alsoResolveOn?: ServerEventType[] } = {},
  ): Promise<ServerEventMap[K] | ServerEvent> {
    const timeoutMs = o.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const unsubs: (() => void)[] = [];
      const done = (fn: () => void) => {
        clearTimeout(timer);
        unsubs.forEach((f) => f());
        this.closeWaiters.delete(onClose);
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new TimeoutError(type, timeoutMs))), timeoutMs);
      unsubs.push(this.on(type, (ev: ServerEventMap[K]) => (!o.pred || o.pred(ev)) && done(() => resolve(ev))));
      for (const alt of o.alsoResolveOn ?? []) unsubs.push(this.on(alt, (ev: ServerEvent) => done(() => resolve(ev))));
      const onClose = (c: CloseInfo) => done(() => reject(new Error(`socket closed (${c.code} ${c.reason}) while waiting for ${type}`)));
      if (this.closed) return onClose(this.closed);
      this.closeWaiters.add(onClose);
    });
  }

  waitForClose(timeoutMs = 5000): Promise<CloseInfo | undefined> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.closeWaiters.delete(w);
        resolve(undefined);
      }, timeoutMs);
      const w = (c: CloseInfo) => {
        clearTimeout(t);
        resolve(c);
      };
      this.closeWaiters.add(w);
    });
  }

  private emit(type: string, ev: never): void {
    for (const fn of this.handlers.get(type) ?? []) {
      try {
        (fn as Handler<unknown>)(ev);
      } catch (e) {
        console.error(`[voice-agent] handler for ${type} threw`, e);
      }
    }
  }

  private handleRaw(raw: unknown): void {
    const text = textOf(raw);
    let ev: ServerEvent;
    try {
      ev = JSON.parse(text) as ServerEvent;
    } catch {
      ev = { type: "__unparsed", text };
    }
    const at = now();
    this.timeline.push({ type: ev.type, atMs: at });
    if (ev.type === "session.ready") {
      this.ready = ev as SessionReadyEvent;
      this.sessionId = this.ready.session_id;
    } else if (ev.type === "session.ended") {
      this.ended = ev as SessionEndedEvent;
    }
    this.onEvent?.("in", ev, at);
    this.replies.observe(ev, at);
    this.tools.observe(ev); // before user handlers, so dispatch order is deterministic
    this.emit(ev.type, ev as never);
    this.emit("*", ev as never);
  }

  // ---- sending -----------------------------------------------------------------------------

  send(ev: ClientEvent): void {
    if (this.ws.readyState !== WS_OPEN) throw new Error(`cannot send ${ev.type}: socket not open (readyState ${this.ws.readyState})`);
    this.onEvent?.("out", ev, now());
    this.ws.send(JSON.stringify(ev));
  }

  /** Send raw wire audio (PCM16 LE or G.711 bytes, per the configured input encoding). */
  sendAudio(bytes: Uint8Array): void {
    if (this.ws.readyState !== WS_OPEN) return;
    const ev: ClientEvent = { type: "input.audio", audio: bytesToBase64(bytes) };
    this.onEvent?.("out", ev, now());
    this.ws.send(JSON.stringify(ev));
  }

  /**
   * First session.update -> wait for session.ready. Resolves with the ready event, or throws with the session.error
   * (or close) that came instead. Do not send audio before this resolves. The server sends nothing before the first
   * update; a good first update yields session.updated then session.ready (~0.4-0.5 s after sending). A bad first
   * update is usually FATAL (session.error then close 1008): invalid voice, agent_id mixed with inline fields,
   * unknown agent_id, inline `llm`. `greeting: null` gives invalid_format (omit the field instead).
   * Baton validates the payload with validateFirstUpdate() (WP1) before calling this.
   */
  async start(config: SessionUpdatePayload, timeoutMs = 15_000): Promise<SessionReadyEvent> {
    const p = this.waitFor("session.ready", { timeoutMs, alsoResolveOn: ["session.error"] });
    this.send({ type: "session.update", session: config });
    const ev = await p;
    if (ev.type !== "session.ready") throw new SessionError(ev as SessionErrorEvent);
    return ev as SessionReadyEvent;
  }

  /** Mid-session update. Resolves with session.updated or session.error (whichever comes first). */
  async update(config: SessionUpdatePayload, timeoutMs = 10_000): Promise<SessionUpdatedEvent | SessionErrorEvent> {
    const p = this.waitFor("session.updated", { timeoutMs, alsoResolveOn: ["session.error"] });
    this.send({ type: "session.update", session: config });
    return (await p) as SessionUpdatedEvent | SessionErrorEvent;
  }

  /** Fire-and-forget mid-session update (stage changes send this, then tool.result, DESIGN §5.9.4). */
  sendUpdate(config: SessionUpdatePayload): void {
    this.send({ type: "session.update", session: config });
  }

  /**
   * Ask the agent to speak now. `instructions` is the ONLY verified way to push per-turn context into the model
   * without audio (tools can be triggered from it). For durable context use `update({ system_prompt })`.
   */
  replyNow(instructions?: string): void {
    this.send(instructions ? { type: "reply.create", instructions } : { type: "reply.create" });
  }

  /**
   * @deprecated NEVER USE (DESIGN §5.9.5, golden config 10 §0.4). conversation.message is schema-validated, but in
   * testing (2026-09-24) the content never reached the model. Use replyNow(instructions) for one turn or
   * update({ system_prompt }) for durable context. Kept only as a record of the tested API; the boundaries test
   * fails any call outside this file.
   */
  sendConversationMessage(content: string, role: "user" | "system" = "user"): void {
    this.send({ type: "conversation.message", role, content });
  }

  /**
   * Clean shutdown: session.end (stops billing immediately; a bare close bills a 30 s resume period), wait for
   * session.ended, then close the socket. Safe to call more than once.
   */
  async end(timeoutMs = 5000): Promise<SessionEndedEvent | undefined> {
    if (this.isOpen && !this.ended) {
      const p = this.waitFor("session.ended", { timeoutMs }).catch(() => undefined);
      try {
        this.send({ type: "session.end" });
      } catch {
        /* socket raced closed */
      }
      await p;
    }
    if (this.ws.readyState === WS_OPEN) this.ws.close(1000, "client done");
    await this.waitForClose(2000);
    return this.ended;
  }

  /** Synchronous best-effort end for `pagehide` (no waiting possible): session.end, then close. */
  endNow(): void {
    try {
      if (this.isOpen && !this.ended) this.ws.send(JSON.stringify({ type: "session.end" } satisfies ClientEvent));
    } catch {
      /* ignore */
    }
    try {
      if (this.ws.readyState === WS_OPEN) this.ws.close(1000, "pagehide");
    } catch {
      /* ignore */
    }
  }
}

export class SessionError extends Error {
  readonly event: SessionErrorEvent;
  readonly code: string;
  constructor(ev: SessionErrorEvent) {
    super(`session.error ${errorCode(ev)}: ${ev.message ?? ""}`);
    this.name = "SessionError";
    this.event = ev;
    this.code = errorCode(ev);
  }
  get retryable(): boolean {
    return RETRYABLE_ERROR_CODES.has(this.code);
  }
}

// =============================================================================================
// Client function tools
// =============================================================================================

export type ToolHandler = (args: Record<string, unknown>, call: ToolCallEvent) => unknown | Promise<unknown>;

export interface ToolTrace {
  call: ToolCallEvent;
  receivedAtMs: number;
  handlerDoneAtMs?: number;
  sentAtMs?: number;
  /** The reply (reply.started id) that carried this tool.call, if one was open. */
  replyId?: string;
  /** interrupted: the carrying reply was barged-in, result discarded. server_side: HTTP tool (AssemblyAI ran it; never answer). */
  dropped?: "interrupted" | "server_side";
  result?: string;
  isError?: boolean;
}

/**
 * Sends tool.result for client function tools. `result` is always a JSON string. Unknown tool names get an is_error
 * result (a missing tool.result stalls the agent). A result is dropped only when the reply that CARRIED its
 * tool.call was interrupted (G0): an interrupted later reply (e.g. a reassurance `reply.create` during the 180 s
 * send_esign_and_pay_link hold) must not swallow the held result.
 *
 * HTTP (server-side) tools ALSO emit tool.call to the client (observed). Those are recorded but never answered:
 * names are learned from session.ready / session.updated config (tools with a non-null `http` block) or declared
 * with `markServerSide()`.
 */
export class ToolDispatcher {
  readonly traces: ToolTrace[] = [];
  /**
   * "immediate" (default, G0; the golden config, DESIGN §5.9.4): send as soon as the handler returns. Measured
   * 2026-09-24 (T3c): accepted with no error and the audible answer ~1.0 s sooner.
   * "reply_done" (the documented rule): hold results until reply.done is the latest turn event.
   */
  policy: "reply_done" | "immediate" = "immediate";
  private readonly session: VoiceAgentSession;
  private handlers = new Map<string, ToolHandler>();
  private lastTurnEvent: string | undefined;
  /** The latest reply.started id (tool.call carries no reply id; it arrives inside the reply that issued it). */
  private currentReplyId: string | undefined;
  private interruptedReplies = new Set<string>();
  /** Fallback for tool calls with no known carrying reply: bumped by an interrupted reply.done without an id. */
  private generation = 0;
  private pending: { trace: ToolTrace; gen: number }[] = [];
  private serverSide = new Set<string>();

  constructor(session: VoiceAgentSession) {
    this.session = session;
  }

  register(name: string, handler: ToolHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  /** Declare tool names that AssemblyAI executes itself (stored-agent HTTP tools). */
  markServerSide(...names: string[]): this {
    for (const n of names) this.serverSide.add(n);
    return this;
  }

  isServerSide(name: string): boolean {
    return this.serverSide.has(name);
  }

  /** Called by the session for every server event before user handlers run. */
  observe(ev: ServerEvent): void {
    switch (ev.type) {
      case "session.ready":
      case "session.updated": {
        const tools = (ev as { config?: { tools?: { name?: string; http?: unknown }[] } }).config?.tools ?? [];
        for (const t of tools) if (t.name && t.http) this.serverSide.add(t.name);
        break;
      }
      case "reply.started":
        this.currentReplyId = (ev as ReplyStartedEvent).reply_id || undefined;
        this.lastTurnEvent = ev.type;
        break;
      case "input.speech.started":
        this.lastTurnEvent = ev.type;
        break;
      case "reply.done": {
        this.lastTurnEvent = ev.type;
        const done = ev as ReplyDoneEvent;
        if (done.status === "interrupted") {
          const id = done.reply_id ?? this.currentReplyId;
          if (id !== undefined) this.interruptedReplies.add(id);
          else this.generation++;
          const keep: { trace: ToolTrace; gen: number }[] = [];
          for (const p of this.pending) {
            if (this.isInterrupted(p.trace, p.gen)) p.trace.dropped = "interrupted";
            else keep.push(p);
          }
          this.pending = keep;
        }
        this.flush();
        break;
      }
      case "tool.call":
        void this.run(ev as ToolCallEvent);
        break;
    }
  }

  private async run(call: ToolCallEvent): Promise<void> {
    const trace: ToolTrace = { call, receivedAtMs: now(), ...(this.currentReplyId !== undefined ? { replyId: this.currentReplyId } : {}) };
    this.traces.push(trace);
    if (this.serverSide.has(call.name)) {
      trace.dropped = "server_side";
      return;
    }
    const gen = this.generation;
    const h = this.handlers.get(call.name);
    let result: unknown;
    let isError = false;
    if (!h) {
      result = { error: `Unknown tool '${call.name}'. Tell the user you cannot do that right now.` };
      isError = true;
    } else {
      try {
        result = await h(call.arguments ?? {}, call);
      } catch (e) {
        result = { error: `Tool '${call.name}' failed: ${e instanceof Error ? e.message : String(e)}. Apologise and offer another option.` };
        isError = true;
      }
    }
    trace.handlerDoneAtMs = now();
    trace.result = typeof result === "string" ? result : JSON.stringify(result);
    trace.isError = isError;
    if (this.isInterrupted(trace, gen)) {
      trace.dropped = "interrupted";
      return;
    }
    this.pending.push({ trace, gen });
    this.flush();
  }

  /** Was the reply that carried this call interrupted? (Without a known reply: any id-less interruption since.) */
  private isInterrupted(trace: ToolTrace, gen: number): boolean {
    return trace.replyId !== undefined ? this.interruptedReplies.has(trace.replyId) : gen !== this.generation;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    if (this.policy === "reply_done" && this.lastTurnEvent !== "reply.done") return;
    const batch = this.pending;
    this.pending = [];
    for (const { trace } of batch) {
      if (!this.session.isOpen) return;
      this.session.send({ type: "tool.result", call_id: trace.call.call_id, result: trace.result ?? "{}", ...(trace.isError ? { is_error: true } : {}) });
      trace.sentAtMs = now();
    }
  }
}

// =============================================================================================
// Reply tracking (audible onset, captions, silent-reply detection)
// =============================================================================================

/** RMS level (dBFS) of a wire-format audio chunk. */
export function chunkLevelDb(bytes: Uint8Array, encoding: AudioEncoding = "audio/pcm"): number {
  let acc = 0;
  let n = 0;
  if (encoding === "audio/pcm") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const v = view.getInt16(i, true);
      acc += v * v;
      n++;
    }
  } else {
    for (const b of bytes) {
      const v = encoding === "audio/pcmu" ? mulawDecodeSample(b) : alawDecodeSample(b);
      acc += v * v;
      n++;
    }
  }
  if (!n || !acc) return -Infinity;
  return 20 * Math.log10(Math.sqrt(acc / n) / 32768);
}

export interface ReplyInfo {
  replyId: string;
  itemId?: string;
  startedAtMs: number;
  /** performance.now() of the first reply.audio chunk (usually silent padding). */
  firstAudioAtMs?: number;
  /** performance.now() of the first chunk above the audibility threshold - the latency users perceive. */
  firstAudibleAtMs?: number;
  /** Audio-time of silent padding before the first audible chunk. */
  leadingSilenceMs: number;
  audioMs: number;
  /** Word captions (transcript.agent.delta) with offsets from reply audio start; they arrive in a burst. */
  words: { text: string; startMs: number | null; endMs: number | null }[];
  text?: string;
  interrupted: boolean;
  status?: string;
  doneAtMs?: number;
  toolCalls: string[];
  /**
   * speech: audible reply. tool_preamble: silent reply that carried a tool.call. unspoken_text: transcript.agent
   * text but NO audible audio (do not caption it as spoken). silent_no_output: completed, no transcript, no audible
   * audio, no tool call - what a failing BYO LLM looks like (no session.error is sent): E_VA_SILENT.
   */
  kind?: "speech" | "tool_preamble" | "unspoken_text" | "silent_no_output";
}

export class ReplyTracker {
  readonly replies: ReplyInfo[] = [];
  current: ReplyInfo | undefined;
  thresholdDb = -50;
  onReplyDone: ((r: ReplyInfo) => void) | undefined;
  private encoding: AudioEncoding = "audio/pcm";
  private bytesPerMs = 48;

  observe(ev: ServerEvent, at: number): void {
    switch (ev.type) {
      case "session.ready":
      case "session.updated": {
        const enc = (ev as { config?: { output?: { format?: { encoding?: AudioEncoding; sample_rate?: number } } } }).config?.output?.format;
        if (enc?.encoding) {
          this.encoding = enc.encoding;
          const rate = enc.sample_rate ?? (enc.encoding === "audio/pcm" ? 24000 : 8000);
          this.bytesPerMs = (rate / 1000) * (enc.encoding === "audio/pcm" ? 2 : 1);
        }
        break;
      }
      case "reply.started": {
        const e = ev as ReplyStartedEvent;
        this.current = { replyId: e.reply_id, ...(e.item_id ? { itemId: e.item_id } : {}), startedAtMs: at, leadingSilenceMs: 0, audioMs: 0, words: [], interrupted: false, toolCalls: [] };
        this.replies.push(this.current);
        break;
      }
      case "reply.audio": {
        const r = this.byId((ev as ReplyAudioEvent).reply_id);
        const data = (ev as ReplyAudioEvent).data;
        if (!r || !data) break;
        const bytes = base64ToBytes(data);
        const ms = bytes.length / this.bytesPerMs;
        r.firstAudioAtMs ??= at;
        if (r.firstAudibleAtMs === undefined) {
          if (chunkLevelDb(bytes, this.encoding) > this.thresholdDb) r.firstAudibleAtMs = at;
          else r.leadingSilenceMs += ms;
        }
        r.audioMs += ms;
        break;
      }
      case "transcript.agent.delta": {
        const e = ev as TranscriptAgentDeltaEvent;
        this.byId(e.reply_id)?.words.push({ text: e.delta, startMs: e.start_ms ?? null, endMs: e.end_ms ?? null });
        break;
      }
      case "transcript.agent": {
        const e = ev as TranscriptAgentEvent;
        const r = this.byId(e.reply_id);
        if (r) {
          r.text = e.text;
          r.interrupted = !!e.interrupted;
        }
        break;
      }
      case "tool.call":
        this.current?.toolCalls.push((ev as ToolCallEvent).name);
        break;
      case "reply.done": {
        const e = ev as ReplyDoneEvent;
        const r = this.byId(e.reply_id);
        if (!r) break;
        r.status = e.status;
        r.doneAtMs = at;
        if (e.status === "interrupted") r.interrupted = true;
        r.kind =
          r.firstAudibleAtMs !== undefined
            ? "speech"
            : r.toolCalls.length
              ? "tool_preamble"
              : r.text
                ? "unspoken_text"
                : e.status === "interrupted"
                  ? "speech"
                  : "silent_no_output";
        this.onReplyDone?.(r);
        break;
      }
    }
  }

  private byId(id: string | undefined): ReplyInfo | undefined {
    if (!id) return this.current;
    if (this.current?.replyId === id) return this.current;
    return this.replies.find((r) => r.replyId === id);
  }
}

// =============================================================================================
// Real-time audio feeder (mic emulation for files, Node bridges, tests)
// =============================================================================================

export interface FeederOptions {
  sampleRate?: number;
  /** 2 for PCM16, 1 for G.711. */
  bytesPerSample?: number;
  /** Chunk size in ms (~50 ms recommended). */
  chunkMs?: number;
  /** If the event loop stalls longer than this, re-anchor instead of bursting (never exceed real time). */
  resyncAfterLateMs?: number;
  /** Silence byte (0 for PCM16, 0xFF for mu-law, 0xD5 for A-law). */
  silenceByte?: number;
}

export interface ClipTiming {
  /** performance.now() at which the clip's first sample was "recorded" (= first chunk send time - chunkMs). */
  recordStartMs: number;
  firstSentMs: number;
  lastSentMs: number;
  chunks: number;
}

/**
 * Sends a continuous audio stream at wall-clock pace like a microphone: each `chunkMs` chunk is sent only after its
 * duration has elapsed ("release at end", so the stream can never run ahead of real time), and silence fills the
 * gaps between clips. `play(bytes)` queues a clip and resolves once it has been sent. (Node/tests; the browser uses
 * the worklet-clocked PacedFeeder, DESIGN §5.9.2.)
 */
export class RealtimeAudioFeeder {
  readonly chunkBytes: number;
  readonly chunkMs: number;
  sentChunks = 0;
  maxLateMs = 0;
  private readonly session: VoiceAgentSession;
  private readonly silence: Uint8Array;
  private readonly resync: number;
  private queue: { bytes: Uint8Array; off: number; timing: Partial<ClipTiming>; resolve: (t: ClipTiming) => void }[] = [];
  private running = false;
  private stopped: Promise<void> | undefined;

  constructor(session: VoiceAgentSession, o: FeederOptions = {}) {
    this.session = session;
    const rate = o.sampleRate ?? VA_SAMPLE_RATE;
    const bps = o.bytesPerSample ?? 2;
    this.chunkMs = o.chunkMs ?? 50;
    this.chunkBytes = Math.round((rate * this.chunkMs) / 1000) * bps;
    this.silence = new Uint8Array(this.chunkBytes).fill(o.silenceByte ?? 0);
    this.resync = o.resyncAfterLateMs ?? 250;
  }

  /** Start streaming (silence until a clip is queued). Call right after session.ready. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  /** Queue a clip; resolves after its last chunk was sent. */
  play(bytes: Uint8Array): Promise<ClipTiming> {
    return new Promise((resolve) => this.queue.push({ bytes, off: 0, timing: {}, resolve }));
  }

  /** Drop queued audio (e.g. the "user" stops talking). */
  clear(): void {
    this.queue = [];
  }

  get idle(): boolean {
    return this.queue.length === 0;
  }

  private async loop(): Promise<void> {
    let t0 = now();
    let n = 0;
    while (this.running && this.session.isOpen) {
      const due = t0 + (n + 1) * this.chunkMs;
      const wait = due - now();
      if (wait > 1) await delay(wait);
      if (!this.running || !this.session.isOpen) break;
      const late = now() - due;
      if (late > this.maxLateMs) this.maxLateMs = late;
      if (late > this.resync) {
        t0 = now() - (n + 1) * this.chunkMs; // forgive the debt, never burst
      }
      const head = this.queue[0];
      let chunk: Uint8Array;
      if (head) {
        const end = Math.min(head.off + this.chunkBytes, head.bytes.length);
        chunk = head.bytes.subarray(head.off, end);
        if (chunk.length < this.chunkBytes) {
          const padded = new Uint8Array(this.silence);
          padded.set(chunk);
          chunk = padded;
        }
        const sentAt = now();
        if (head.off === 0) {
          head.timing.firstSentMs = sentAt;
          head.timing.recordStartMs = sentAt - this.chunkMs;
          head.timing.chunks = 0;
        }
        head.timing.chunks = (head.timing.chunks ?? 0) + 1;
        head.timing.lastSentMs = sentAt;
        head.off = end;
        this.session.sendAudio(chunk);
        if (head.off >= head.bytes.length) {
          this.queue.shift();
          head.resolve(head.timing as ClipTiming);
        }
      } else {
        this.session.sendAudio(this.silence);
      }
      this.sentChunks++;
      n++;
    }
    // release anyone still waiting
    for (const q of this.queue) q.resolve({ recordStartMs: q.timing.recordStartMs ?? -1, firstSentMs: q.timing.firstSentMs ?? -1, lastSentMs: q.timing.lastSentMs ?? -1, chunks: q.timing.chunks ?? 0 });
    this.queue = [];
  }
}
