/**
 * client.ts - reusable AssemblyAI Voice Agent API client (TypeScript, ESM).
 *
 * Distilled from the 2026-09-24 smoke tests (research/10a-voice-agent-smoke.md). Everything here was
 * exercised against the live API; behaviour that differs from the docs is called out inline.
 *
 * What it gives you:
 *   - Typed client->server and server->client events (plus `errorCode()`; the live API only ever sent
 *     a lower-case `code`, never `error_code`).
 *   - `VoiceAgentRest`: temp-token minting, stored-agent CRUD, session history + artifact polling.
 *   - `VoiceAgentSession`: wraps any WHATWG-style WebSocket (browser `WebSocket` or Node `ws`),
 *     typed `on()/waitFor()`, `start()` (session.update -> session.ready), `update()`
 *     (-> session.updated | session.error), `replyNow()`, a client-side session cap (`maxDurationMs`,
 *     because the token's max_session_duration_seconds was NOT enforced) and clean shutdown
 *     (session.end -> session.ended -> close).
 *   - `ToolDispatcher`: client function tools with the documented "send tool.result only when
 *     reply.done is the latest event" rule, dropping results of interrupted replies, and never answering
 *     the informational tool.call that server-side HTTP tools also emit (auto-detected from the config).
 *   - `ReplyTracker`: per-reply audio, AUDIBLE onset (every reply starts with 0.2-2 s of silent PCM;
 *     tool pre-ambles are entirely silent), word captions, transcript, interruption, and a `kind` that
 *     flags unspoken transcript text and the BYO-LLM failure mode (silent reply, no session.error).
 *   - `RealtimeAudioFeeder`: mic-like continuous sender (50 ms chunks at wall-clock pace, silence when
 *     idle) so pre-recorded clips never trip `audio_rate_violation`.
 *   - `connectNode()`: Node helper (package `ws`) that connects with `?token=` or an Authorization header.
 *     (Auth failures are NOT upgrade rejections: the socket opens, then a `session.error` code
 *     `unauthorized` arrives and the socket closes 1008.)
 *
 * Browser use: construct `new VoiceAgentSession(new WebSocket(url))` with a token URL from
 * `tokenUrl(token)`; do not import `connectNode` (alias the `ws` import to a stub in the bundler, or split
 * the file). Never ship the API key to the browser - mint tokens server-side with `VoiceAgentRest`.
 */
import WebSocket from "ws";

// =============================================================================================
// Endpoints
// =============================================================================================

export const VA_HOST = "agents.assemblyai.com";
export const VA_WS_URL = `wss://${VA_HOST}/v1/ws`;
export const VA_REST_BASE = `https://${VA_HOST}/v1`;
/** Region-pinned US host used by the SIP phone-number endpoints (agent ids are NOT shared with VA_HOST per docs). */
export const VA_US_REST_BASE = "https://agents.us.assemblyai.com/v1";
export const LLM_GATEWAY_BASE = "https://llm-gateway.assemblyai.com/v1";

/** Default wire format both ways: PCM16 mono little-endian @ 24 kHz. */
export const VA_SAMPLE_RATE = 24000;

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
   * Immutable after session.ready. Spoken verbatim (not passed through the LLM). Omit it for "agent
   * listens first": an explicit `null` is rejected with invalid_format (docs type it string | null).
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
 * Stored agent as returned by POST/GET. Observed: id looks like "agent_<32 hex>"; `voice.voice_id` is what
 * sessions use (`output.voice` on the record showed a stale default "ivy"); HTTP tool header values are
 * omitted on read ({name, last_set_at}); undocumented fields transfer_targets, outbound_trunk_id, caller_id.
 */
export interface AgentRecord extends Omit<AgentDefinition, "llm"> {
  id: string;
  created_at?: string;
  updated_at?: string;
  llm?: { base_url: string; model: string }[];
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
  audio_duration_seconds?: number;
  timestamp?: number;
}
/** Docs disagree on `code` vs `error_code` (C5); read both via errorCode(). */
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

// =============================================================================================
// Small utilities
// =============================================================================================

const hasBuffer = typeof (globalThis as { Buffer?: unknown }).Buffer !== "undefined";

export function bytesToBase64(bytes: Uint8Array): string {
  if (hasBuffer) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  if (hasBuffer) return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const now = (): number => performance.now();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`timed out after ${ms} ms waiting for ${what}`);
    this.name = "TimeoutError";
  }
}

// =============================================================================================
// REST: tokens, agents, sessions
// =============================================================================================

export type AuthStyle = "raw" | "bearer";

export interface HttpTrace {
  label: string;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

export class VoiceAgentHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(label: string, status: number, body: unknown) {
    super(`${label} failed: HTTP ${status} ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`);
    this.name = "VoiceAgentHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface RestOptions {
  base?: string;
  /** Both work on every endpoint tested (T2); raw is what the docs show. */
  authStyle?: AuthStyle;
  /** Hook for logging (bodies may contain secrets you passed in, e.g. llm.api_key - redact before writing). */
  onHttp?: (t: HttpTrace) => void;
}

export interface MintTokenOptions {
  /**
   * Redemption window, 1-600 s. Observed 2026-09-24: the token is NOT single-use inside this window (one
   * token opened 2 sequential and 2 concurrent sessions), so keep it short (<= 60 s) and rate-limit the
   * route that mints it. After the window, connecting yields session.error `unauthorized` + close 1008.
   */
  expiresInSeconds: number;
  /**
   * Documented as the hard cap for the resulting session (60-10800 s). Observed 2026-09-24: NOT enforced
   * (a 60 s token kept a session alive for 102 s, and session.ready.expires_at is always now+3600 s).
   * Still send it, but enforce your own cap with `SessionOptions.maxDurationMs`.
   */
  maxSessionDurationSeconds?: number;
  /** Undocumented starter-repo parameter (C23); accepted but not required. */
  product?: string;
}

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

export class VoiceAgentRest {
  readonly base: string;
  private readonly apiKey: string;
  private readonly authStyle: AuthStyle;
  private readonly onHttp: ((t: HttpTrace) => void) | undefined;

  constructor(apiKey: string, opts: RestOptions = {}) {
    this.apiKey = apiKey;
    this.base = opts.base ?? VA_REST_BASE;
    this.authStyle = opts.authStyle ?? "raw";
    this.onHttp = opts.onHttp;
  }

  get authHeader(): string {
    return this.authStyle === "bearer" ? `Bearer ${this.apiKey}` : this.apiKey;
  }

  /** Low-level request; returns {status, body} without throwing. */
  async request<T = unknown>(method: string, path: string, body?: unknown, label = `${method} ${path}`): Promise<{ status: number; body: T; ms: number; headers: Headers }> {
    const url = path.startsWith("http") ? path : this.base + path;
    const t0 = now();
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.authHeader, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep text */
    }
    const ms = Math.round(now() - t0);
    this.onHttp?.({ label, method, url, status: res.status, ms, requestBody: body, responseBody: parsed });
    return { status: res.status, body: parsed as T, ms, headers: res.headers };
  }

  private async ok<T>(method: string, path: string, body?: unknown, label?: string): Promise<T> {
    const r = await this.request<T>(method, path, body, label);
    if (r.status < 200 || r.status >= 300) throw new VoiceAgentHttpError(label ?? `${method} ${path}`, r.status, r.body);
    return r.body;
  }

  /** GET /v1/token - single-use temp token for browser `?token=` connects. */
  async mintToken(o: MintTokenOptions): Promise<{ token: string; expires_in_seconds?: number }> {
    const q = new URLSearchParams({ expires_in_seconds: String(o.expiresInSeconds) });
    if (o.maxSessionDurationSeconds !== undefined) q.set("max_session_duration_seconds", String(o.maxSessionDurationSeconds));
    if (o.product) q.set("product", o.product);
    return this.ok("GET", `/token?${q}`, undefined, "mint-token");
  }

  createAgent(def: AgentDefinition): Promise<AgentRecord> {
    return this.ok("POST", "/agents", def, "create-agent");
  }
  getAgent(id: string): Promise<AgentRecord> {
    return this.ok("GET", `/agents/${encodeURIComponent(id)}`, undefined, "get-agent");
  }
  listAgents(): Promise<unknown> {
    return this.ok("GET", "/agents", undefined, "list-agents");
  }
  updateAgent(id: string, patch: Partial<AgentDefinition>): Promise<AgentRecord> {
    return this.ok("PUT", `/agents/${encodeURIComponent(id)}`, patch, "update-agent");
  }
  async deleteAgent(id: string): Promise<number> {
    const r = await this.request("DELETE", `/agents/${encodeURIComponent(id)}`, undefined, "delete-agent");
    return r.status;
  }

  getSession(id: string): Promise<SessionRecord> {
    return this.ok("GET", `/sessions/${encodeURIComponent(id)}`, undefined, "get-session");
  }
  listSessions(q: { limit?: number; agent_id?: string; status?: string; cursor?: string } = {}): Promise<{ sessions: SessionRecord[]; has_more?: boolean; [k: string]: unknown }> {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)]));
    return this.ok("GET", `/sessions${p.size ? `?${p}` : ""}`, undefined, "list-sessions");
  }

  /**
   * Poll GET /v1/sessions/{id} until `artifacts` contains every wanted type (default audio + timeline).
   * Artifact URLs are pre-signed with a short TTL: re-fetch right before you download/forward one.
   */
  async waitForArtifacts(
    id: string,
    o: { want?: string[]; timeoutMs?: number; intervalMs?: number; onPoll?: (s: SessionRecord, elapsedMs: number) => void } = {},
  ): Promise<SessionRecord> {
    const want = o.want ?? ["audio", "timeline"];
    const timeout = o.timeoutMs ?? 180_000;
    const interval = o.intervalMs ?? 10_000;
    const t0 = now();
    for (;;) {
      const s = await this.getSession(id);
      o.onPoll?.(s, Math.round(now() - t0));
      const types = new Set((s.artifacts ?? []).map((a) => a.type));
      if (want.every((w) => types.has(w))) return s;
      if (now() - t0 + interval > timeout) throw new TimeoutError(`session ${id} artifacts ${want.join("+")}`, timeout);
      await delay(interval);
    }
  }
}

// =============================================================================================
// WebSocket session
// =============================================================================================

/** Minimal WHATWG-style socket surface (browser WebSocket and Node `ws` both satisfy it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: (ev: unknown) => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason: string | Buffer }) => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
}

const WS_OPEN = 1;

export interface SessionOptions {
  /** Raw event hook for logging/metrics: every parsed server event ("in") and every client event ("out"). */
  onEvent?: (dir: "in" | "out", ev: ServerEvent | ClientEvent, atMs: number) => void;
  /**
   * Client-side session cap: call end() this many ms after the socket is wrapped. The server did not
   * enforce the token's max_session_duration_seconds in testing, so this is the real spend limit.
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
      const offs: (() => void)[] = [];
      const done = (fn: () => void) => {
        clearTimeout(timer);
        offs.forEach((f) => f());
        this.closeWaiters.delete(onClose);
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new TimeoutError(type, timeoutMs))), timeoutMs);
      offs.push(this.on(type, (ev: ServerEventMap[K]) => (!o.pred || o.pred(ev)) && done(() => resolve(ev))));
      for (const alt of o.alsoResolveOn ?? []) offs.push(this.on(alt, (ev: ServerEvent) => done(() => resolve(ev))));
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
    const text = typeof raw === "string" ? raw : hasBuffer && Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
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
   * First session.update -> wait for session.ready. Resolves with the ready event, or throws with the
   * session.error (or close) that came instead. Do not send audio before this resolves.
   * Observed: the server sends nothing before the first update; a good first update yields
   * session.updated then session.ready (~15 ms apart, ~0.4-0.5 s after sending). A bad first update is
   * usually FATAL (session.error then close 1008): invalid voice, agent_id mixed with inline fields,
   * unknown agent_id, inline `llm`. `greeting: null` gives invalid_format (omit the field instead).
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

  /**
   * Ask the agent to speak now. `instructions` is the ONLY verified way to push per-turn context into the
   * model without audio (facts in it are used in the reply; tools can be triggered from it). For durable
   * context use `update({ system_prompt })` - it takes effect on the next reply.
   */
  replyNow(instructions?: string): void {
    this.send(instructions ? { type: "reply.create", instructions } : { type: "reply.create" });
  }

  /**
   * conversation.message. Schema is validated (role must be "user" | "system", content a string, else
   * invalid_format), but in testing (2026-09-24) the content never reached the model - not in text-only
   * sessions and not before a spoken turn. Kept for completeness; prefer replyNow(instructions) or
   * update({ system_prompt }).
   */
  sendConversationMessage(content: string, role: "user" | "system" = "user"): void {
    this.send({ type: "conversation.message", role, content });
  }

  /**
   * Clean shutdown: session.end (stops billing immediately; a bare close bills a 30 s resume window),
   * wait for session.ended, then close the socket. Safe to call more than once.
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
  /** interrupted: reply was barged-in, result discarded. server_side: HTTP tool (AssemblyAI ran it; never answer). */
  dropped?: "interrupted" | "server_side";
  result?: string;
  isError?: boolean;
}

/**
 * Implements the documented tool.result timing rule: results are sent only when `reply.done` is the
 * latest turn event (reply.started / input.speech.started / reply.done), and results belonging to an
 * interrupted reply are dropped. `result` is always a JSON string. Unknown tool names get an is_error
 * result (a missing tool.result stalls the agent).
 *
 * HTTP (server-side) tools ALSO emit tool.call to the client (observed; the docs say they don't). Those
 * are recorded but never answered: names are learned from session.ready / session.updated config
 * (tools with a non-null `http` block) or declared with `markServerSide()`.
 */
export class ToolDispatcher {
  readonly traces: ToolTrace[] = [];
  /**
   * "reply_done" (default, documented): hold results until reply.done is the latest turn event.
   * "immediate": send as soon as the handler returns. Measured 2026-09-24 (T3c, 2+2 runs): accepted with
   * no error, correct answers, and the audible answer ~1.0 s sooner - the tool.call arrives inside a
   * SILENT pre-amble reply that the server keeps open ~2.3 s unless the result arrives first. Use
   * "immediate" for fast local tools when latency matters; results of replies later marked interrupted
   * may already have been sent in that mode.
   */
  policy: "reply_done" | "immediate" = "reply_done";
  private readonly session: VoiceAgentSession;
  private handlers = new Map<string, ToolHandler>();
  private lastTurnEvent: string | undefined;
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
      case "input.speech.started":
        this.lastTurnEvent = ev.type;
        break;
      case "reply.done":
        this.lastTurnEvent = ev.type;
        if ((ev as ReplyDoneEvent).status === "interrupted") {
          this.generation++;
          for (const p of this.pending) p.trace.dropped = "interrupted";
          this.pending = [];
        } else {
          this.flush();
        }
        break;
      case "tool.call":
        void this.run(ev as ToolCallEvent);
        break;
    }
  }

  private async run(call: ToolCallEvent): Promise<void> {
    const trace: ToolTrace = { call, receivedAtMs: now() };
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
    if (gen !== this.generation) {
      trace.dropped = "interrupted";
      return;
    }
    this.pending.push({ trace, gen });
    this.flush();
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
      const v = encoding === "audio/pcmu" ? mulawToLinear(b) : alawToLinear(b);
      acc += v * v;
      n++;
    }
  }
  if (!n || !acc) return -Infinity;
  return 20 * Math.log10(Math.sqrt(acc / n) / 32768);
}
function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}
function alawToLinear(a: number): number {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
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
   * speech: audible reply. tool_preamble: silent reply that carried a tool.call (normal; it may still have
   * transcript text that was never spoken - see unspoken_text). unspoken_text: transcript.agent text but NO
   * audible audio (observed when the user kept talking after a premature end-of-turn: the server holds
   * the reply silent, merges the user turns, yet still emits the text - do not caption it as spoken).
   * silent_no_output: completed, no transcript, no audible audio, no tool call - what a failing BYO LLM
   * looks like (no session.error is sent). Treat it as an error and recover.
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
 * Sends a continuous audio stream at wall-clock pace like a microphone: each `chunkMs` chunk is sent only
 * after its duration has elapsed ("release at end", so the stream can never run ahead of real time), and
 * silence fills the gaps between clips. `play(bytes)` queues a clip and resolves once it has been sent.
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

// =============================================================================================
// Node connect helper
// =============================================================================================

export interface NodeConnectOptions extends SessionOptions {
  /** Temp token (from VoiceAgentRest.mintToken) -> `?token=`. */
  token?: string;
  /** Server-side alternative: API key in the Authorization header. */
  apiKey?: string;
  authStyle?: AuthStyle;
  url?: string;
  openTimeoutMs?: number;
}

export class UpgradeRejectedError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  constructor(status: number, body: string, headers: Record<string, unknown>) {
    super(`WebSocket upgrade rejected: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = "UpgradeRejectedError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Open a Voice Agent socket from Node. Resolves once the socket is OPEN (send session.update next). */
export function connectNode(o: NodeConnectOptions): Promise<VoiceAgentSession> {
  const url = o.token ? tokenUrl(o.token, o.url ?? VA_WS_URL) : (o.url ?? VA_WS_URL);
  const headers: Record<string, string> = {};
  if (o.apiKey) headers.Authorization = o.authStyle === "bearer" ? `Bearer ${o.apiKey}` : o.apiKey;
  const ws = new WebSocket(url, { headers, handshakeTimeout: o.openTimeoutMs ?? 10_000 });
  const session = new VoiceAgentSession(ws as unknown as WebSocketLike, o);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(session));
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        reject(new UpgradeRejectedError(res.statusCode ?? 0, body, res.headers as Record<string, unknown>));
        ws.terminate();
      });
    });
    ws.once("error", (e) => reject(e));
  });
}

/** Convenience: mint a token server-side and connect with it (the browser flow, run from Node). */
export async function connectWithToken(rest: VoiceAgentRest, mint: MintTokenOptions, o: Omit<NodeConnectOptions, "token" | "apiKey"> = {}): Promise<VoiceAgentSession> {
  const { token } = await rest.mintToken(mint);
  return connectNode({ ...o, token });
}
