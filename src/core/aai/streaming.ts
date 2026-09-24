/**
 * aai/streaming.ts - AssemblyAI Streaming STT v3 client (browser + Node). Promoted from spikes/streaming/client.ts
 * per DESIGN §3.2. Changes from the spike:
 *  - the `ws` package is only loaded lazily inside `defaultWebSocketFactory`, and only when Authorization headers
 *    are requested (Node, API-key auth); the import is marked bundler-ignored so it never enters a browser bundle;
 *  - `mintStreamingToken` / `StreamingHttpError` (they need the API key) moved to src/server/aai/va-node.ts;
 *  - no Node types (Buffer) are referenced; incoming frames are decoded with TextDecoder;
 *  - `sttCloseToErrorCode()` maps closes to DESIGN §7.4 error codes.
 *
 * Opening a live session is a spend: every product/script open goes through the limits helpers
 * (scripts/lib/aai-open.ts, src/client/stt/**), never directly (TASKS §0.5, tests/unit/boundaries.test.ts).
 *
 * Design rules baked in (all verified live on 2026-09-24, research/10b):
 *  - Audio is BINARY frames of raw PCM16 LE (or mu-law bytes). Each frame must be 50..1000 ms, else the server sends
 *    Error 3007 and closes with code 3007. `sendAudio` enforces this client-side.
 *  - Array / object query params (keyterms_prompt, language_codes, redact_pii_policies, llm_gateway) are
 *    JSON-encoded strings in the URL.
 *  - Unknown / misspelled query params are silently ignored. Begin.configuration only echoes model, mode,
 *    api_version, speaker_labels, redact_pii, filter_profanity, domain, voice_focus.
 *  - Every server-side failure is an `Error` frame followed by a close whose code == error_code and reason
 *    "See Error message for details". Auth failures happen AFTER the upgrade (Error 1008), so browsers see them too.
 *  - Billing runs from open until Termination (whole seconds): always `terminate()`.
 *  - The server needs audio (silence) to end a turn: the last turn finalizes on Terminate, ForceEndpoint or
 *    trailing silence (`streamAudioPaced({ tailSilenceMs })`).
 *  - Auth: `Authorization: <raw key>` header (NO "Bearer": rejected with 1008) or `?token=`. Tokens are reusable
 *    until they expire, so the product mints them per connect with a 10 s lifetime.
 */
import type { ErrorCode } from "../contracts/errors";

// ---------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------

export const STREAMING_WS_URL = "wss://streaming.assemblyai.com/v3/ws";
export const STREAMING_WS_URL_US = "wss://streaming.us.assemblyai.com/v3/ws";
export const STREAMING_WS_URL_EU = "wss://streaming.eu.assemblyai.com/v3/ws";

// ---------------------------------------------------------------------------------------------
// Connection parameters
// ---------------------------------------------------------------------------------------------

/**
 * Documented models, all accepted live on 2026-09-24 (10b T1). "universal-3-5-pro-realtime" is REJECTED (3006);
 * u3-rt-pro is being cut off. The product uses universal-3-5-pro.
 */
export type SpeechModel = "universal-3-5-pro" | "universal-streaming-english" | "universal-streaming-multilingual";

/**
 * `language_codes` values the server's validator accepts (from its own 3006 enum, 2026-09-24). Acceptance is not
 * quality: only hi/en were exercised. For Hinglish list "en" FIRST.
 */
export const ACCEPTED_LANGUAGE_CODES = ["en", "es", "de", "fr", "it", "pt", "tr", "nl", "sv", "no", "da", "fi", "hi", "vi", "ar", "he", "ja", "ur", "zh", "ru", "ko", "ca", "gl", "ro", "et", "fa", "yue", "af", "mr", "zu", "xh", "nn", "multi"] as const;
export type AudioEncoding = "pcm_s16le" | "pcm_mulaw" | "opus" | "ogg_opus" | "aac";
export type TurnMode = "min_latency" | "balanced" | "max_accuracy";
export type PiiSubstitution = "hash" | "entity_name";

export interface LlmGatewayMessage {
  role: "system" | "user" | "assistant" | (string & {});
  /** `{{turn}}` is replaced with the finalized turn's transcript. */
  content: string;
}
export interface LlmGatewayConfig {
  model: string;
  messages: LlmGatewayMessage[];
  max_tokens: number;
}

/** Query parameters of the v3 WS URL. Names are the wire names (snake_case) so they diff 1:1 against Begin. */
export interface StreamingParams {
  speech_model?: SpeechModel | (string & {});
  sample_rate?: number;
  encoding?: AudioEncoding;
  // turn detection
  mode?: TurnMode;
  min_turn_silence?: number;
  max_turn_silence?: number;
  vad_threshold?: number;
  interruption_delay?: number;
  continuous_partials?: boolean;
  include_partial_turns?: boolean;
  /** Universal-Streaming only. */
  end_of_turn_confidence_threshold?: number;
  /** Universal-Streaming only (U3.5 Pro always formats). */
  format_turns?: boolean;
  // accuracy levers
  prompt?: string;
  keyterms_prompt?: string[];
  agent_context?: string;
  previous_context_n_turns?: number;
  language_codes?: string[];
  language_detection?: boolean;
  domain?: "medical-v1";
  voice_focus?: "near-field" | "far-field";
  voice_focus_threshold?: number;
  // diarization
  speaker_labels?: boolean;
  max_speakers?: number;
  speaker_labels_revision_interval_ms?: number;
  // redaction
  redact_pii?: boolean;
  redact_pii_policies?: string[];
  redact_pii_sub?: PiiSubstitution;
  filter_profanity?: boolean;
  // session
  session_heartbeat?: boolean;
  inactivity_timeout?: number;
  /** Never used by Baton (the Gateway is locked; the param is silently ignored). */
  llm_gateway?: LlmGatewayConfig;
}

/** Fields accepted by the `UpdateConfiguration` client message (delta; no ack is sent). */
export interface UpdateConfigurationPatch {
  prompt?: string;
  keyterms_prompt?: string[];
  agent_context?: string;
  language_codes?: string[];
  mode?: TurnMode;
  min_turn_silence?: number;
  max_turn_silence?: number;
  vad_threshold?: number;
  interruption_delay?: number;
  end_of_turn_confidence_threshold?: number;
  format_turns?: boolean;
  session_heartbeat?: boolean;
  filter_profanity?: boolean;
}

/** Server-enforced limits (verified: exceeding any of them -> Error 3006 + close, even mid-stream). */
export const LIMITS = { agentContextChars: 1750, promptChars: 1750, keyterms: 100, keytermChars: 50 } as const;

/**
 * Clip fields that would otherwise kill the session with 3006: agent_context keeps its END (the most recent words
 * matter most), prompt keeps its start, keyterms are capped at 100 (terms > 50 chars are dropped).
 */
export function sanitizeParams<T extends { agent_context?: string; prompt?: string; keyterms_prompt?: string[] }>(p: T): T {
  const out = { ...p };
  if (out.agent_context && out.agent_context.length > LIMITS.agentContextChars) out.agent_context = out.agent_context.slice(-LIMITS.agentContextChars);
  if (out.prompt && out.prompt.length > LIMITS.promptChars) out.prompt = out.prompt.slice(0, LIMITS.promptChars);
  if (out.keyterms_prompt) out.keyterms_prompt = out.keyterms_prompt.filter((k) => k.length <= LIMITS.keytermChars).slice(0, LIMITS.keyterms);
  return out;
}

/** Serialize params the way the server expects: scalars as strings, arrays/objects as JSON. */
export function buildStreamingUrl(
  params: StreamingParams | Record<string, unknown>,
  opts: { token?: string; baseUrl?: string } = {},
): string {
  const url = new URL(opts.baseUrl ?? STREAMING_WS_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (opts.token) url.searchParams.set("token", opts.token);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------------------------

export interface StreamingWord {
  text: string;
  /** ms of session audio */
  start: number;
  end: number;
  confidence: number;
  word_is_final: boolean;
  speaker?: string;
  speaker_confidence?: number;
}

export interface BeginMessage {
  type: "Begin";
  id: string;
  /** Unix seconds. */
  expires_at: number;
  /** Echo of the effective configuration (typos are silently ignored, so check it). */
  configuration?: Record<string, unknown>;
}
export interface TurnMessage {
  type: "Turn";
  turn_order: number;
  turn_is_formatted: boolean;
  end_of_turn: boolean;
  transcript: string;
  end_of_turn_confidence: number;
  words: StreamingWord[];
  utterance?: string;
  language_code?: string;
  language_confidence?: number;
  speaker_label?: string;
  speaker_confidence?: number;
}
export interface SpeechStartedMessage {
  type: "SpeechStarted";
  timestamp: number;
  confidence?: number;
}
export interface SpeakerRevisionMessage {
  type: "SpeakerRevision";
  revisions: { turn_order: number; speaker_label?: string; words: StreamingWord[] }[];
}
export interface HeartbeatMessage {
  type: "Heartbeat";
  total_audio_received_ms: number;
  total_duration_ms: number;
  realtime_factor: number;
  max_speech_probability: number;
}
export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  /** What you are billed on. */
  session_duration_seconds: number;
}
export interface WarningMessage {
  type: "Warning";
  warning_code: number;
  warning: string;
}
export interface ErrorMessage {
  type?: "Error";
  error_code?: number;
  error: string;
}
export interface LlmGatewayResponseMessage {
  type: "LLMGatewayResponse";
  turn_order: number;
  transcript: string;
  data: {
    request_id?: string;
    choices?: { index: number; message: { role: string; content: string | null }; finish_reason: string }[];
    usage?: Record<string, unknown>;
    [k: string]: unknown;
  };
}
export interface SilenceMessage {
  type: "Silence";
  start_ms: number;
  end_ms: number;
}
export type ServerMessage =
  | BeginMessage
  | TurnMessage
  | SpeechStartedMessage
  | SpeakerRevisionMessage
  | HeartbeatMessage
  | TerminationMessage
  | WarningMessage
  | ErrorMessage
  | LlmGatewayResponseMessage
  | SilenceMessage;

/** Error frames may arrive without `type` (the SDK keys on `"error" in msg`). */
export function isErrorMessage(m: unknown): m is ErrorMessage {
  return !!m && typeof m === "object" && ("error" in m || (m as { type?: unknown }).type === "Error");
}

/** Close codes seen / documented. 3007 and 3006 are the ones a client usually causes. */
export const CLOSE_CODES: Record<number, string> = {
  1000: "normal (after Termination)",
  1008: "policy violation / unauthorized / rate limit (docs)",
  1011: "internal error during setup (retry)",
  3005: "server error (retry)",
  3006: "invalid message / JSON / inactivity timeout",
  3007: "audio chunk duration outside 50..1000 ms, or audio sent too fast",
  3008: "max session duration exceeded",
  3009: "too many concurrent sessions (docs)",
  4001: "auth failed (SDK table)",
  4002: "insufficient funds (SDK table)",
  4003: "free-tier user (SDK table)",
  4029: "rate limited (SDK table)",
};

/** Close codes worth retrying with a fresh token (transient server-side). */
export function isRetryableClose(code: number): boolean {
  return code === 1011 || code === 3005 || code === 1006;
}

/** True when an AssemblyAI error text points at the account balance (F8: flips replay_only, reason aai_balance). */
export function looksLikeBalanceError(text: string | null | undefined): boolean {
  return !!text && /\b(balance|credit|credits|payment|quota|insufficient funds)\b/i.test(text);
}

/**
 * DESIGN §5.1.9 / §7.4 mapping of a streaming close (code + the preceding Error frame text) to an ErrorCode.
 * Returns null for a normal close (1000).
 */
export function sttCloseToErrorCode(code: number, errorText?: string | null): ErrorCode | null {
  const text = errorText ?? "";
  if (code === 1000) return null;
  if (looksLikeBalanceError(text) || code === 4002 || code === 4003) return "E_AAI_BALANCE";
  if (isRetryableClose(code)) return "E_STT_TRANSIENT";
  if ((code === 1008 || code === 3009 || code === 4029) && /too many|concurrent|rate/i.test(text)) return "E_STT_RATE";
  if (code === 3009 || code === 4029) return "E_STT_RATE";
  if (code === 1008 || code === 4001) return "E_STT_AUTH";
  if (code === 3006 && /inactivity/i.test(text)) return "E_STT_INACTIVITY";
  if (code === 3006 || code === 3007) return "E_STT_INPUT";
  return "E_STT_TRANSIENT";
}

// ---------------------------------------------------------------------------------------------
// WebSocket abstraction (browser WebSocket and `ws` both satisfy this)
// ---------------------------------------------------------------------------------------------

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string, headers?: Record<string, string>) => WebSocketLike | Promise<WebSocketLike>;

const OPEN = 1;

/**
 * Default factory: the global WebSocket when no headers are needed (browser, Node 22). Authorization headers need
 * the Node `ws` package, loaded lazily (never bundled for the browser). Node callers may instead pass
 * `nodeWebSocketFactory` from src/server/aai/va-node.ts.
 */
export const defaultWebSocketFactory: WebSocketFactory = async (url, headers) => {
  const G = globalThis as { WebSocket?: new (u: string) => WebSocketLike };
  if (!headers && G.WebSocket) return new G.WebSocket(url);
  let mod: { default: new (u: string, o: { headers?: Record<string, string> }) => WebSocketLike };
  try {
    mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ "ws")) as unknown as typeof mod;
  } catch (e) {
    throw new Error(
      headers
        ? "Authorization headers need the Node 'ws' package (browsers must use a temporary token)"
        : "No global WebSocket and the 'ws' package is unavailable",
      { cause: e },
    );
  }
  return new mod.default(url, headers ? { headers } : {});
};

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Auth = { apiKey: string } | { token: string };

export interface ConnectOptions {
  auth: Auth;
  params: StreamingParams;
  baseUrl?: string;
  /** Wait this long for `Begin` (default 8000 ms). */
  connectTimeoutMs?: number;
  factory?: WebSocketFactory;
  /** Observability hook: every frame in/out (audio frames are passed as byte counts only). */
  onFrame?: (dir: "in" | "out", frame: unknown, meta: { binaryBytes?: number }) => void;
  /** Clip agent_context / prompt / keyterms to the server limits (default true). */
  sanitize?: boolean;
  /**
   * Validate outgoing audio frame duration against the server's 50..1000 ms rule (default true).
   * Requires `sample_rate` + a PCM encoding; skipped for opus/ogg_opus/aac.
   */
  validateChunkDuration?: boolean;
}

export interface ConnectErrorDetails {
  closeCode?: number;
  closeReason?: string;
  serverError?: ErrorMessage;
  /** Only available with the Node `ws` implementation (browsers just see close 1006). */
  httpStatus?: number;
  httpBody?: string;
}
export class StreamingConnectError extends Error {
  readonly details: ConnectErrorDetails;
  constructor(message: string, details: ConnectErrorDetails) {
    super(message);
    this.name = "StreamingConnectError";
    this.details = details;
  }
  /** DESIGN §7.4 code for this failure. */
  get errorCode(): ErrorCode {
    return sttCloseToErrorCode(this.details.closeCode ?? 1006, this.details.serverError?.error ?? this.details.httpBody) ?? "E_STT_TRANSIENT";
  }
}

export interface SessionEvents {
  begin: BeginMessage;
  turn: TurnMessage;
  speechStarted: SpeechStartedMessage;
  speakerRevision: SpeakerRevisionMessage;
  heartbeat: HeartbeatMessage;
  llmGatewayResponse: LlmGatewayResponseMessage;
  silence: SilenceMessage;
  warning: WarningMessage;
  error: ErrorMessage;
  termination: TerminationMessage;
  /** Any message, including unknown types. */
  message: ServerMessage | Record<string, unknown>;
  close: { code: number; reason: string };
}

type Listener<T> = (ev: T) => void;

const textOf = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
};

export class StreamingSession {
  readonly url: string;
  begin!: BeginMessage;
  termination: TerminationMessage | null = null;
  lastError: ErrorMessage | null = null;
  closeInfo: { code: number; reason: string } | null = null;
  /** Resolves when the socket closes (never rejects). */
  readonly closed: Promise<{ code: number; reason: string }>;

  private ws!: WebSocketLike;
  private listeners = new Map<keyof SessionEvents, Set<Listener<never>>>();
  private resolveClosed!: (v: { code: number; reason: string }) => void;
  private terminateSent = false;
  private readonly bytesPerMs: number | null;

  private readonly opts: ConnectOptions;

  private constructor(opts: ConnectOptions, url: string) {
    this.opts = opts;
    this.url = url;
    this.closed = new Promise((r) => (this.resolveClosed = r));
    const p = opts.params;
    const enc = p.encoding ?? "pcm_s16le";
    const pcm = enc === "pcm_s16le" || enc === "pcm_mulaw";
    this.bytesPerMs = pcm && p.sample_rate ? (p.sample_rate * (enc === "pcm_mulaw" ? 1 : 2)) / 1000 : pcm ? 32 : null; // default 16 kHz s16le
  }

  /** Open a session and resolve once `Begin` arrives. Rejects with StreamingConnectError otherwise. */
  static async connect(opts: ConnectOptions): Promise<StreamingSession> {
    const token = "token" in opts.auth ? opts.auth.token : undefined;
    const params = opts.sanitize === false ? opts.params : sanitizeParams(opts.params);
    const url = buildStreamingUrl(params, { ...(token ? { token } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
    const s = new StreamingSession({ ...opts, params }, url);
    await s.open();
    return s;
  }

  private async open(): Promise<void> {
    const headers = "apiKey" in this.opts.auth ? { Authorization: this.opts.auth.apiKey } : undefined;
    const ws = await (this.opts.factory ?? defaultWebSocketFactory)(this.url, headers);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    let httpStatus: number | undefined;
    let httpBody: string | undefined;
    // `ws` (Node) exposes the HTTP response of a rejected upgrade; browsers only see close 1006.
    const nodeWs = ws as unknown as { on?: (ev: string, fn: (...a: unknown[]) => void) => void };
    if (typeof nodeWs.on === "function") {
      nodeWs.on("unexpected-response", (_req: unknown, res: unknown) => {
        const r = res as { statusCode?: number; on: (e: string, f: (c?: { toString(enc?: string): string }) => void) => void };
        httpStatus = r.statusCode;
        let body = "";
        r.on("data", (c) => (body += c ? c.toString("utf8") : ""));
        r.on("end", () => {
          httpBody = body;
          ws.close();
        });
      });
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(`timed out after ${this.opts.connectTimeoutMs ?? 8000} ms waiting for Begin`), this.opts.connectTimeoutMs ?? 8000);
      const fail = (why: string, extra: Partial<ConnectErrorDetails> = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const details: ConnectErrorDetails = { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(httpBody !== undefined ? { httpBody } : {}), ...extra };
        if (this.lastError) details.serverError = this.lastError;
        reject(new StreamingConnectError(`streaming connect failed: ${why}`, details));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (ev) => {
        const msg = this.handleMessage(ev.data);
        if (!settled && msg && (msg as { type?: string }).type === "Begin") {
          settled = true;
          clearTimeout(timer);
          resolve();
        } else if (!settled && isErrorMessage(msg)) {
          // the server closes right after the Error frame (close code = error_code); wait for it
          setTimeout(() => fail(`server error before Begin: ${msg.error}`), 1500);
        }
      };
      ws.onclose = (ev) => {
        this.onSocketClose(ev.code, ev.reason);
        // give the unexpected-response body a tick to arrive
        const why = this.lastError ? `server error before Begin: ${this.lastError.error}` : `closed before Begin (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`;
        setTimeout(() => fail(why, { closeCode: ev.code, closeReason: ev.reason }), 50);
      };
      ws.onerror = () => {
        /* close always follows; details are captured there */
      };
    });
    // steady-state handlers
    this.ws.onclose = (ev) => this.onSocketClose(ev.code, ev.reason);
  }

  private onSocketClose(code: number, reason: string): void {
    if (this.closeInfo) return;
    this.closeInfo = { code, reason: String(reason ?? "") };
    this.emit("close", this.closeInfo);
    this.resolveClosed(this.closeInfo);
  }

  private handleMessage(data: unknown): ServerMessage | Record<string, unknown> | null {
    const text = textOf(data);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.opts.onFrame?.("in", { unparsable: text.slice(0, 200) }, {});
      return null;
    }
    this.opts.onFrame?.("in", msg, {});
    this.emit("message", msg);
    if (isErrorMessage(msg)) {
      this.lastError = msg;
      this.emit("error", msg);
      return msg;
    }
    switch (msg.type) {
      case "Begin":
        this.begin = msg as unknown as BeginMessage;
        this.emit("begin", this.begin);
        break;
      case "Turn":
        this.emit("turn", msg as unknown as TurnMessage);
        break;
      case "SpeechStarted":
        this.emit("speechStarted", msg as unknown as SpeechStartedMessage);
        break;
      case "SpeakerRevision":
        this.emit("speakerRevision", msg as unknown as SpeakerRevisionMessage);
        break;
      case "Heartbeat":
        this.emit("heartbeat", msg as unknown as HeartbeatMessage);
        break;
      case "LLMGatewayResponse":
        this.emit("llmGatewayResponse", msg as unknown as LlmGatewayResponseMessage);
        break;
      case "Silence":
        this.emit("silence", msg as unknown as SilenceMessage);
        break;
      case "Warning":
        this.emit("warning", msg as unknown as WarningMessage);
        break;
      case "Termination":
        this.termination = msg as unknown as TerminationMessage;
        this.emit("termination", this.termination);
        break;
    }
    return msg;
  }

  on<K extends keyof SessionEvents>(type: K, fn: Listener<SessionEvents[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }
  private emit<K extends keyof SessionEvents>(type: K, ev: SessionEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as Listener<SessionEvents[K]>)(ev);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN && !this.closeInfo;
  }

  /** The session id from Begin (shown in the HUD as liveness proof). */
  get sessionId(): string | undefined {
    return this.begin?.id;
  }

  /** Send one binary audio frame (raw PCM16 LE / mu-law bytes, 50..1000 ms). Returns false if the socket is closed. */
  sendAudio(chunk: Uint8Array | ArrayBuffer): boolean {
    if (!this.isOpen || this.terminateSent) return false;
    const bytes = chunk.byteLength;
    if (this.opts.validateChunkDuration !== false && this.bytesPerMs) {
      const ms = bytes / this.bytesPerMs;
      if (ms < 50 || ms > 1000) throw new RangeError(`audio frame is ${ms.toFixed(1)} ms; the server requires 50..1000 ms (close 3007). Batch with FrameBatcher.`);
    }
    this.ws.send(chunk);
    this.opts.onFrame?.("out", null, { binaryBytes: bytes });
    return true;
  }

  private sendJson(msg: Record<string, unknown>): boolean {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(msg));
    this.opts.onFrame?.("out", msg, {});
    return true;
  }

  /** Delta update; no acknowledgement is sent by the server. Applies to audio processed afterwards. */
  updateConfiguration(patch: UpdateConfigurationPatch): boolean {
    return this.sendJson({ type: "UpdateConfiguration", ...(this.opts.sanitize === false ? patch : sanitizeParams(patch)) });
  }
  /** End the current turn now (the final Turn arrives without waiting for silence). Only ever in fed silence. */
  forceEndpoint(): boolean {
    return this.sendJson({ type: "ForceEndpoint" });
  }
  /** Resets the inactivity timer (only meaningful with `inactivity_timeout`). */
  keepAlive(): boolean {
    return this.sendJson({ type: "KeepAlive" });
  }
  /** Low-level escape hatch (used by tests to send malformed frames). */
  sendRaw(data: string | Uint8Array): void {
    this.ws.send(data);
    this.opts.onFrame?.("out", typeof data === "string" ? { raw: data } : null, typeof data === "string" ? {} : { binaryBytes: data.byteLength });
  }

  /**
   * Graceful shutdown: send Terminate once, wait for Termination and the server's close.
   * Resolves with the Termination (billing fields) or null if the socket died first / timed out.
   */
  async terminate(opts: { timeoutMs?: number } = {}): Promise<TerminationMessage | null> {
    if (this.closeInfo) return this.termination;
    if (!this.terminateSent) {
      this.sendJson({ type: "Terminate" });
      this.terminateSent = true;
    }
    const timeoutMs = opts.timeoutMs ?? 15000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.closed.then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs))),
    ]);
    clearTimeout(timer);
    if (timedOut) this.abort(1000, "client terminate timeout");
    return this.termination;
  }

  /** Close the socket without Terminate (use only when the session is already broken). */
  abort(code = 1000, reason = "client abort"): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------------------------

export interface FrameBatcherOptions {
  sampleRate: number;
  /** 2 for PCM16 (default), 1 for mu-law. */
  bytesPerSample?: number;
  /** Frame length (50..1000 ms, default 50). DESIGN §5.1.4: 100 for 8 kHz mu-law, 50 for 16 kHz PCM16. */
  targetMs?: number;
  /** Pad byte for flush(): default 0xFF for mu-law, 0x00 for PCM16. */
  silenceByte?: number;
}

/**
 * Accumulates small frames (AudioWorklet 128-sample quanta, Twilio 20 ms mu-law frames, call-player ticks) and emits
 * frames of exactly `targetMs` (>= 50 ms). `flush()` returns the remainder (a final frame < 50 ms triggers 3007, so
 * the default is to pad it to 50 ms with silence).
 */
export class FrameBatcher {
  private buf: Uint8Array;
  private len = 0;
  readonly frameBytes: number;
  readonly opts: FrameBatcherOptions;
  constructor(opts: FrameBatcherOptions) {
    this.opts = opts;
    const bps = opts.bytesPerSample ?? 2;
    const ms = opts.targetMs ?? 50;
    if (ms < 50 || ms > 1000) throw new RangeError("targetMs must be 50..1000");
    this.frameBytes = Math.round((opts.sampleRate * ms) / 1000) * bps;
    this.buf = new Uint8Array(this.frameBytes * 4);
  }
  push(bytes: Uint8Array): Uint8Array[] {
    if (this.len + bytes.byteLength > this.buf.byteLength) {
      const bigger = new Uint8Array(Math.max(this.buf.byteLength * 2, this.len + bytes.byteLength));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.byteLength;
    const out: Uint8Array[] = [];
    let off = 0;
    while (this.len - off >= this.frameBytes) {
      out.push(this.buf.slice(off, off + this.frameBytes));
      off += this.frameBytes;
    }
    if (off > 0) {
      this.buf.copyWithin(0, off, this.len);
      this.len -= off;
    }
    return out;
  }
  /** Buffered bytes not yet emitted. */
  get pendingBytes(): number {
    return this.len;
  }
  /** Remainder padded to one full 50 ms frame with silence (0x00 for PCM16, 0xFF for mu-law), or null. */
  flush(pad = true): Uint8Array | null {
    if (this.len === 0) return null;
    const bps = this.opts.bytesPerSample ?? 2;
    const minBytes = Math.round((this.opts.sampleRate * 50) / 1000) * bps;
    const size = pad ? Math.max(this.len, minBytes) : this.len;
    const out = new Uint8Array(size).fill(this.opts.silenceByte ?? (bps === 1 ? 0xff : 0));
    out.set(this.buf.subarray(0, this.len));
    this.len = 0;
    return out;
  }
}

/**
 * Stream a whole buffer as paced binary frames (file / test playback). Real time by default. Stops early if the
 * session closes. Browser Watch mode feeds from worklet ticks instead (DESIGN §5.1.4).
 */
export async function streamAudioPaced(
  session: StreamingSession,
  input: Uint8Array,
  opts: {
    sampleRate: number;
    bytesPerSample?: number;
    chunkMs?: number;
    speed?: number;
    /** Append this much silence so the last turn finalizes without Terminate (verified: 2000 ms -> final 324 ms after the last word). */
    tailSilenceMs?: number;
    signal?: AbortSignal;
    onChunk?: (info: { index: number; audioOffsetMs: number; wallMs: number }) => void;
  },
): Promise<{ frames: number; audioMs: number }> {
  const bps = opts.bytesPerSample ?? 2;
  let bytes = input;
  if (opts.tailSilenceMs) {
    const pad = Math.round((opts.sampleRate * opts.tailSilenceMs) / 1000) * bps;
    const joined = new Uint8Array(input.byteLength + pad).fill(bps === 1 ? 0xff : 0);
    joined.set(input);
    bytes = joined;
  }
  const chunkMs = opts.chunkMs ?? 50;
  const speed = opts.speed ?? 1;
  const frameBytes = Math.round((opts.sampleRate * chunkMs) / 1000) * bps;
  const bytesPerMsRate = (opts.sampleRate * bps) / 1000;
  const t0 = performance.now();
  let sentMs = 0;
  let frames = 0;
  for (let off = 0; off < bytes.byteLength; off += frameBytes) {
    if (opts.signal?.aborted || !session.isOpen) break;
    let frame = bytes.subarray(off, Math.min(off + frameBytes, bytes.byteLength));
    if (frame.byteLength / bytesPerMsRate < 50) {
      const padded = new Uint8Array(Math.round(50 * bytesPerMsRate)).fill(bps === 1 ? 0xff : 0);
      padded.set(frame);
      frame = padded;
    }
    const frameMs = frame.byteLength / bytesPerMsRate;
    const due = t0 + (sentMs + frameMs) / speed; // release once the audio "exists" (mic-like)
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    if (!session.sendAudio(frame)) break;
    opts.onChunk?.({ index: frames, audioOffsetMs: sentMs, wallMs: performance.now() - t0 });
    sentMs += frameMs;
    frames++;
  }
  return { frames, audioMs: sentMs };
}

// ---------------------------------------------------------------------------------------------
// Turn bookkeeping
// ---------------------------------------------------------------------------------------------

export type TurnApplyResult = "partial" | "final" | "duplicate-final" | "empty-final";

/**
 * Keeps the live transcript: each Turn message supersedes the previous one for the same `turn_order` (replace,
 * never append). A turn is final when `end_of_turn` is true AND (for Universal-Streaming with format_turns=true)
 * `turn_is_formatted` is true.
 */
export class TurnTracker {
  readonly turns = new Map<number, TurnMessage>();
  readonly finals = new Map<number, TurnMessage>();
  private readonly opts: { waitForFormatted?: boolean };
  constructor(opts: { waitForFormatted?: boolean } = {}) {
    this.opts = opts;
  }

  /** Universal-Streaming models send an empty final (transcript "", words []) on Terminate - it is ignored. */
  apply(t: TurnMessage): TurnApplyResult {
    if (t.end_of_turn && !t.transcript && !t.words?.length) return "empty-final";
    this.turns.set(t.turn_order, t);
    if (!t.end_of_turn) return "partial";
    if (this.opts.waitForFormatted && !t.turn_is_formatted) return "partial";
    const dup = this.finals.has(t.turn_order);
    this.finals.set(t.turn_order, t);
    return dup ? "duplicate-final" : "final";
  }

  /** True while the latest message of some turn is not final (DESIGN §5.5: `hasOpenPartial`). */
  hasOpenPartial(): boolean {
    for (const [order, t] of this.turns) if (!this.finals.has(order) && t.transcript) return true;
    return false;
  }

  /** Apply a SpeakerRevision delta (last write wins per turn_order; text never changes). */
  applyRevision(rev: SpeakerRevisionMessage): number {
    let n = 0;
    for (const r of rev.revisions) {
      const t = this.finals.get(r.turn_order) ?? this.turns.get(r.turn_order);
      if (!t) continue;
      const patched: TurnMessage = { ...t, ...(r.speaker_label !== undefined ? { speaker_label: r.speaker_label } : {}), words: r.words?.length ? r.words : t.words };
      if (this.finals.has(r.turn_order)) this.finals.set(r.turn_order, patched);
      this.turns.set(r.turn_order, patched);
      n++;
    }
    return n;
  }

  /** Final transcript lines in order. */
  text(): string[] {
    return [...this.finals.values()].sort((a, b) => a.turn_order - b.turn_order).map((t) => (t.speaker_label ? `${t.speaker_label}: ${t.transcript}` : t.transcript));
  }
}

// ---------------------------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------------------------

/**
 * The verified base configuration (10b golden config): 0% normalized WER and 21/21 entities on the 69 s claim-call
 * fixture; ~0.42 s from last word to final. The product's per-channel params come from buildSttParams (WP4).
 */
export const GOLDEN_PARAMS: StreamingParams = {
  speech_model: "universal-3-5-pro",
  sample_rate: 16000,
  encoding: "pcm_s16le",
};

/** Verified presets (10b). Spread over GOLDEN_PARAMS. */
export const PRESETS = {
  /** Barge-in / BYO voice agent: SpeechStarted + first partial ~0.58 s after onset (vs ~1.17 s balanced). */
  voiceAgent: { mode: "min_latency" } satisfies StreamingParams,
  /** Twilio passthrough (batch 20 ms frames to 100 ms with FrameBatcher). */
  telephony: { encoding: "pcm_mulaw", sample_rate: 8000 } satisfies StreamingParams,
  /** Hinglish: "en" FIRST keeps English in Latin script and digits as digits. */
  hinglish: { language_codes: ["en", "hi"], language_detection: true } satisfies StreamingParams,
  /** Finals-only redaction; partials are suppressed entirely (SpeechStarted still fires). */
  pii: { redact_pii: true, redact_pii_policies: ["person_name", "phone_number", "location_address"], redact_pii_sub: "entity_name" } satisfies StreamingParams,
} as const;
