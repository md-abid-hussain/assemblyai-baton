/**
 * client.ts - reusable AssemblyAI Streaming STT v3 client (Node + browser).
 *
 * Distilled from the 2026-09-24 smoke tests (research/10b-streaming-smoke.md). Everything here was
 * exercised against the live API; see that note for the evidence behind each default.
 *
 *   Server (Node):  const { token } = await mintStreamingToken(apiKey, { expiresInSeconds: 60, maxSessionDurationSeconds: 900 });
 *   Browser/Node:   const s = await StreamingSession.connect({ auth: { token }, params: GOLDEN_PARAMS });
 *                   s.on("turn", (t) => ...); s.sendAudio(pcm16Chunk /* 50..1000 ms *\/);
 *                   s.updateConfiguration({ agent_context: "What's your policy number?" });
 *                   const termination = await s.terminate();   // ALWAYS: Terminate -> wait for Termination
 *
 * Design rules baked in (all verified live on 2026-09-24, see 10b):
 *  - Audio is BINARY frames of raw PCM16 LE (or mu-law bytes). Each frame must be 50..1000 ms, else
 *    the server sends Error 3007 and closes with code 3007. `sendAudio` enforces this client-side.
 *  - Array / object query params (keyterms_prompt, language_codes, redact_pii_policies, llm_gateway)
 *    are JSON-encoded strings in the URL.
 *  - Unknown / misspelled query params are silently ignored. Begin.configuration only echoes
 *    model, mode, api_version, speaker_labels, redact_pii, filter_profanity, domain, voice_focus -
 *    turn/vad/prompt/keyterm values are NOT echoed, so they cannot be verified from Begin.
 *  - Every server-side failure (bad param, bad auth, bad frame) is an `Error` frame followed by a close
 *    whose code == error_code and reason "See Error message for details". Auth failures happen AFTER
 *    the upgrade (Error 1008), so browsers see them too (not a bare 1006).
 *  - Billing runs from WS open until Termination (whole seconds): always `terminate()`.
 *  - The server needs audio (silence) to end a turn. When a file/stream stops, the last turn only
 *    finalizes on Terminate or ForceEndpoint -> `streamAudioPaced({ tailSilenceMs })`.
 *  - Auth: `Authorization: <raw key>` header (NO "Bearer": rejected with 1008) or `?token=`.
 *    Tokens are NOT single-use: one token opened 3 sequential + 2 concurrent sessions inside its
 *    redemption window. Keep `expires_in_seconds` short and always set max_session_duration_seconds.
 *
 * No dependency on the spike harness. In Node, `ws` is loaded lazily (only when no global WebSocket
 * can do the job, i.e. when an Authorization header is needed).
 */

// ---------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------

export const STREAMING_WS_URL = "wss://streaming.assemblyai.com/v3/ws";
export const STREAMING_WS_URL_US = "wss://streaming.us.assemblyai.com/v3/ws";
export const STREAMING_WS_URL_EU = "wss://streaming.eu.assemblyai.com/v3/ws";
export const STREAMING_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";

// ---------------------------------------------------------------------------------------------
// Connection parameters
// ---------------------------------------------------------------------------------------------

/**
 * Documented models, all accepted live on 2026-09-24 (10b T1). The server's own enum (from a 3006
 * rejection) also lists whisper-rt, u3-rt-pro(-beta-1), u3-rt-agent, universal-3-6(-pro),
 * universal-3-7-preview: u3-rt-pro is being cut off, 3-7-preview / u3-rt-agent returned 3005 after
 * Begin, 3-6(-pro) work but are undocumented. "universal-3-5-pro-realtime" is REJECTED (3006).
 */
export type SpeechModel = "universal-3-5-pro" | "universal-streaming-english" | "universal-streaming-multilingual";

/**
 * `language_codes` values the server's validator accepts (from its own 3006 enum, 2026-09-24). The docs
 * list 18; the validator takes 33 incl. "multi". Acceptance != quality: only hi/en were exercised.
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

/**
 * Query parameters of wss://streaming.assemblyai.com/v3/ws. Names are the wire names (snake_case)
 * so they can be diffed 1:1 against `Begin.configuration`.
 */
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
 * Clip fields that would otherwise kill the session with 3006: agent_context keeps its END (the most
 * recent words matter most), prompt keeps its start, keyterms are capped at 100 (terms > 50 chars are
 * dropped; the server silently ignores them anyway).
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
  start: number; // ms of session audio
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
  /** Echo of the effective configuration (always check it: typos are silently ignored). */
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

// ---------------------------------------------------------------------------------------------
// Temporary tokens (server side only: needs the real key)
// ---------------------------------------------------------------------------------------------

export interface MintTokenOptions {
  /** Redemption window, 1..600 s. */
  expiresInSeconds?: number;
  /** Session cap, 60..10800 s (default 10800). Set it on public demos. */
  maxSessionDurationSeconds?: number;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
}

export class StreamingHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`streaming token request failed: HTTP ${status}`);
    this.name = "StreamingHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * GET /v3/token with `Authorization: <raw key>` (the endpoint also accepts "Bearer <key>"; the WS does
 * not). Validation errors are HTTP 422 FastAPI-style `{"detail":[{type,loc,msg,input,ctx}]}`, including
 * a missing Authorization header. Tokens are REUSABLE (even concurrently) until `expires_in_seconds`
 * lapses, then fail with Error 1008 "Signature has expired" - so mint per connect with a short window.
 * `max_session_duration_seconds` shows up as Begin.expires_at (else now + 10800 s).
 */
export async function mintStreamingToken(apiKey: string, opts: MintTokenOptions = {}): Promise<{ token: string; expires_in_seconds: number }> {
  const url = new URL(opts.tokenUrl ?? STREAMING_TOKEN_URL);
  url.searchParams.set("expires_in_seconds", String(opts.expiresInSeconds ?? 60));
  if (opts.maxSessionDurationSeconds !== undefined) url.searchParams.set("max_session_duration_seconds", String(opts.maxSessionDurationSeconds));
  const res = await (opts.fetchImpl ?? fetch)(url, { headers: { Authorization: apiKey } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new StreamingHttpError(res.status, body);
  return body as { token: string; expires_in_seconds: number };
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

/** Default factory: browser/global WebSocket when no headers are needed, else the `ws` package (Node). */
export const defaultWebSocketFactory: WebSocketFactory = async (url, headers) => {
  const G = globalThis as { WebSocket?: new (u: string) => WebSocketLike; window?: unknown };
  if (!headers && G.WebSocket) return new G.WebSocket(url);
  if (headers && G.window) throw new Error("Browsers cannot send an Authorization header on a WebSocket: use a temporary token");
  const mod = (await import("ws")) as unknown as { default: new (u: string, o: { headers?: Record<string, string> }) => WebSocketLike };
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
        const r = res as { statusCode?: number; on: (e: string, f: (c?: Buffer) => void) => void };
        httpStatus = r.statusCode;
        let body = "";
        r.on("data", (c?: Buffer) => (body += c ? c.toString("utf8") : ""));
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
        const details = { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(httpBody !== undefined ? { httpBody } : {}), ...extra };
        if (this.lastError) Object.assign(details, { serverError: this.lastError });
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
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
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

  /** Send one binary audio frame (raw PCM16 LE / mu-law bytes, 50..1000 ms). Returns false if the socket is closed. */
  sendAudio(chunk: Uint8Array | ArrayBuffer): boolean {
    if (!this.isOpen || this.terminateSent) return false;
    const bytes = chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength;
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
  /** End the current turn now (the final Turn arrives without waiting for silence). */
  forceEndpoint(): boolean {
    return this.sendJson({ type: "ForceEndpoint" });
  }
  /** Resets the inactivity timer (only meaningful with `inactivity_timeout`). */
  keepAlive(): boolean {
    return this.sendJson({ type: "KeepAlive" });
  }
  /** Low-level escape hatch (used by the smoke tests to send malformed frames). */
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

/**
 * Accumulates small frames (AudioWorklet 128-sample quanta, Twilio 20 ms mu-law frames) and emits
 * frames of exactly `targetMs` (>= 50 ms). `flush()` returns the remainder (pad it or drop it:
 * a final frame < 50 ms triggers 3007, so the default is to zero-pad to 50 ms).
 */
export class FrameBatcher {
  private buf: Uint8Array;
  private len = 0;
  readonly frameBytes: number;
  readonly opts: { sampleRate: number; bytesPerSample?: number; targetMs?: number; silenceByte?: number };
  constructor(opts: { sampleRate: number; bytesPerSample?: number; targetMs?: number; silenceByte?: number }) {
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
 * Stream a whole buffer as paced binary frames (file / test playback). Real time by default;
 * the server throttles above ~1.25x and never needs faster. Stops early if the session closes.
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
  const bytesPerMs = (opts.sampleRate * bps) / 1000;
  const t0 = performance.now();
  let sentMs = 0;
  let frames = 0;
  for (let off = 0; off < bytes.byteLength; off += frameBytes) {
    if (opts.signal?.aborted || !session.isOpen) break;
    let frame = bytes.subarray(off, Math.min(off + frameBytes, bytes.byteLength));
    if (frame.byteLength / bytesPerMs < 50) {
      const padded = new Uint8Array(Math.round(50 * bytesPerMs)).fill(bps === 1 ? 0xff : 0);
      padded.set(frame);
      frame = padded;
    }
    const frameMs = frame.byteLength / bytesPerMs;
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

/**
 * Keeps the live transcript: each Turn message supersedes the previous one for the same
 * `turn_order` (replace, never append). A turn is final when `end_of_turn` is true AND
 * (for Universal-Streaming with format_turns=true) `turn_is_formatted` is true.
 */
export class TurnTracker {
  readonly turns = new Map<number, TurnMessage>();
  readonly finals = new Map<number, TurnMessage>();
  private readonly opts: { waitForFormatted?: boolean };
  constructor(opts: { waitForFormatted?: boolean } = {}) {
    this.opts = opts;
  }

  /**
   * Returns "partial" | "final" | "duplicate-final" | "empty-final". Universal-Streaming models send an
   * empty final (transcript "", words []) on Terminate - ignore it.
   */
  apply(t: TurnMessage): "partial" | "final" | "duplicate-final" | "empty-final" {
    if (t.end_of_turn && !t.transcript && !t.words?.length) return "empty-final";
    this.turns.set(t.turn_order, t);
    if (!t.end_of_turn) return "partial";
    if (this.opts.waitForFormatted && !t.turn_is_formatted) return "partial";
    const dup = this.finals.has(t.turn_order);
    this.finals.set(t.turn_order, t);
    return dup ? "duplicate-final" : "final";
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

/** Close codes worth retrying with a fresh token (transient server-side). */
export function isRetryableClose(code: number): boolean {
  return code === 1011 || code === 3005 || code === 1006;
}

/**
 * The configuration we recommend for the product (see "Golden config" in 10b). 0% normalized WER and
 * 21/21 entities on the 69 s claim-call fixture; ~0.42 s from last word to final.
 */
export const GOLDEN_PARAMS: StreamingParams = {
  speech_model: "universal-3-5-pro",
  sample_rate: 16000,
  encoding: "pcm_s16le",
};

/** Verified presets (10b). Spread over GOLDEN_PARAMS. */
export const PRESETS = {
  /** Barge-in / BYO voice agent: SpeechStarted + first partial ~0.58 s after onset (vs ~1.17 s balanced), same final latency and accuracy. */
  voiceAgent: { mode: "min_latency" } satisfies StreamingParams,
  /** Twilio Media Streams passthrough (batch 20 ms frames to >= 50 ms with FrameBatcher). */
  telephony: { encoding: "pcm_mulaw", sample_rate: 8000 } satisfies StreamingParams,
  /** Hinglish: "en" FIRST keeps English in Latin script and digits as digits; ["hi"] / ["hi","en"] transliterate everything to Devanagari and spell digits. */
  hinglish: { language_codes: ["en", "hi"], language_detection: true } satisfies StreamingParams,
  /** Finals-only redaction; partials are suppressed entirely (SpeechStarted still fires). */
  pii: { redact_pii: true, redact_pii_policies: ["person_name", "phone_number", "location_address"], redact_pii_sub: "entity_name" } satisfies StreamingParams,
} as const;
