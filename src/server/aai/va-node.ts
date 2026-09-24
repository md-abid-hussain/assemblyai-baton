/**
 * server/aai/va-node.ts - the Node-only half of the promoted AssemblyAI clients (DESIGN §3.2 fix 5.3-1):
 *  - `connectNode` / `connectWithToken`: open a Voice Agent socket from Node with the `ws` package;
 *  - `VoiceAgentRest`: temp-token minting, stored-agent CRUD, session history + artifact polling (needs the key);
 *  - `mintStreamingToken`: Streaming STT v3 temp tokens (needs the key);
 *  - `nodeWebSocketFactory`: a static-`ws` factory for StreamingSession.connect in scripts.
 *
 * Every function that opens a session or mints a token is a spend: product code calls them only from the limits
 * helpers allow-listed by tests/unit/boundaries.test.ts (src/server/limits/**, src/server/aai/tokens.ts,
 * scripts/lib/aai-open.ts). Never log tokens or keys.
 */
import "server-only";
import WebSocket from "ws";
import type { WebSocketFactory, WebSocketLike as StreamingWebSocketLike } from "../../core/aai/streaming";
import {
  TimeoutError, VA_REST_BASE, VA_WS_URL, VoiceAgentSession, tokenUrl,
  type AgentDefinition, type AgentRecord, type SessionOptions, type SessionRecord, type WebSocketLike,
} from "../../core/aai/voice-agent";

const now = (): number => performance.now();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// =============================================================================================
// Voice Agent REST: tokens, agents, sessions
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
  /** Both work on every endpoint tested (T2); raw is what the docs show and what Baton sends. */
  authStyle?: AuthStyle;
  /** Hook for logging (bodies may contain secrets you passed in, e.g. llm.api_key - redact before writing). */
  onHttp?: (t: HttpTrace) => void;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VaMintTokenOptions {
  /**
   * How long the token can be redeemed, 1-600 s. Observed 2026-09-24: the token is NOT single-use (one token opened
   * 2 sequential and 2 concurrent sessions), so Baton mints per connect with 10 s and rate-limits the route.
   * Connecting after expiry yields session.error `unauthorized` + close 1008.
   */
  expiresInSeconds: number;
  /**
   * Documented as the hard cap for the resulting session (60-10800 s). Observed: NOT enforced. Still send it, but
   * enforce the cap client-side (`SessionOptions.maxDurationMs`, DESIGN §5.9.5).
   */
  maxSessionDurationSeconds?: number;
  /** Undocumented starter-repo parameter (C23); accepted but not required. */
  product?: string;
}
/** @deprecated alias kept for spike-code compatibility. */
export type MintTokenOptions = VaMintTokenOptions;

export class VoiceAgentRest {
  readonly base: string;
  private readonly apiKey: string;
  private readonly authStyle: AuthStyle;
  private readonly onHttp: ((t: HttpTrace) => void) | undefined;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;

  constructor(apiKey: string, opts: RestOptions = {}) {
    if (!apiKey) throw new Error("VoiceAgentRest: apiKey is required");
    this.apiKey = apiKey;
    this.base = opts.base ?? VA_REST_BASE;
    this.authStyle = opts.authStyle ?? "raw";
    this.onHttp = opts.onHttp;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.f = opts.fetchImpl ?? fetch;
  }

  private get authHeader(): string {
    return this.authStyle === "bearer" ? `Bearer ${this.apiKey}` : this.apiKey;
  }

  /** Low-level request; returns {status, body} without throwing on HTTP errors. */
  async request<T = unknown>(method: string, path: string, body?: unknown, label = `${method} ${path}`): Promise<{ status: number; body: T; ms: number; headers: Headers }> {
    const url = path.startsWith("http") ? path : this.base + path;
    const t0 = now();
    const res = await this.f(url, {
      method,
      headers: { Authorization: this.authHeader, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep text */
    }
    const ms = Math.round(now() - t0);
    this.onHttp?.({ label, method, url: url.replace(/token=[^&]+/g, "token=***"), status: res.status, ms, requestBody: body, responseBody: label === "mint-token" ? "[token]" : parsed });
    return { status: res.status, body: parsed as T, ms, headers: res.headers };
  }

  private async ok<T>(method: string, path: string, body?: unknown, label?: string): Promise<T> {
    const r = await this.request<T>(method, path, body, label);
    if (r.status < 200 || r.status >= 300) throw new VoiceAgentHttpError(label ?? `${method} ${path}`, r.status, r.body);
    return r.body;
  }

  /** GET /v1/token - temp token for browser `?token=` connects (reusable until it expires). */
  async mintToken(o: VaMintTokenOptions): Promise<{ token: string; expires_in_seconds?: number }> {
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
  /** Returns the HTTP status (204 on success). */
  async deleteAgent(id: string): Promise<number> {
    const r = await this.request("DELETE", `/agents/${encodeURIComponent(id)}`, undefined, "delete-agent");
    return r.status;
  }

  getSession(id: string): Promise<SessionRecord> {
    return this.ok("GET", `/sessions/${encodeURIComponent(id)}`, undefined, "get-session");
  }
  /**
   * GET /v1/sessions. Live shape (10a §11): `{sessions, has_more, response_metadata:{next_cursor}}` (G0 fix: the
   * cursor is under `response_metadata`, not top level). UNVERIFIED: the name of the query parameter that takes the
   * cursor (`cursor` here). Check it on D1 (T-D1-0b / WP8) before the F6 audit relies on paging past page 1.
   */
  listSessions(q: { limit?: number; agent_id?: string; status?: string; cursor?: string } = {}): Promise<{
    sessions: SessionRecord[];
    has_more?: boolean;
    response_metadata?: { next_cursor?: string | null };
    [k: string]: unknown;
  }> {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)]));
    return this.ok("GET", `/sessions${p.size ? `?${p}` : ""}`, undefined, "list-sessions");
  }
  /** DELETE /v1/sessions/{id} (soft delete; whether it ends a LIVE session is T-D1-0b). Returns the HTTP status. */
  async deleteSession(id: string): Promise<number> {
    const r = await this.request("DELETE", `/sessions/${encodeURIComponent(id)}`, undefined, "delete-session");
    return r.status;
  }

  /**
   * Poll GET /v1/sessions/{id} until `artifacts` contains every wanted type (default audio + timeline).
   * Artifact URLs are pre-signed with a 1 h TTL: re-fetch right before you download/forward one.
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
// Voice Agent: Node connect
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

/**
 * Open a Voice Agent socket from Node. Resolves once the socket is OPEN (send session.update next).
 * Auth failures are NOT upgrade rejections: the socket opens, then session.error `unauthorized` + close 1008.
 */
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
export async function connectWithToken(rest: VoiceAgentRest, mint: VaMintTokenOptions, o: Omit<NodeConnectOptions, "token" | "apiKey"> = {}): Promise<VoiceAgentSession> {
  const { token } = await rest.mintToken(mint);
  return connectNode({ ...o, token });
}

// =============================================================================================
// Streaming STT: temp tokens and a Node socket factory
// =============================================================================================

export const STREAMING_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";

export interface StreamingMintTokenOptions {
  /** How long the token can be redeemed, 1..600 s (default and Baton: 10). */
  expiresInSeconds?: number;
  /** Session cap, 60..10800 s (default 10800). Shows up only as Begin.expires_at; enforcement unverified. */
  maxSessionDurationSeconds?: number;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  timeoutMs?: number;
}

export class StreamingHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`streaming token request failed: HTTP ${status}${typeof body === "string" ? ` ${body.slice(0, 200)}` : body ? ` ${JSON.stringify(body).slice(0, 200)}` : ""}`);
    this.name = "StreamingHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * GET /v3/token with `Authorization: <raw key>` (the endpoint also accepts "Bearer <key>"; the WS does not).
 * Validation errors are HTTP 422 FastAPI-style `{"detail":[...]}`. Tokens are REUSABLE (even concurrently) until
 * `expires_in_seconds` lapses, then fail with Error 1008 "Signature has expired" - so mint per connect.
 */
export async function mintStreamingToken(apiKey: string, opts: StreamingMintTokenOptions = {}): Promise<{ token: string; expires_in_seconds: number }> {
  if (!apiKey) throw new Error("mintStreamingToken: apiKey is required");
  const url = new URL(opts.tokenUrl ?? STREAMING_TOKEN_URL);
  // DESIGN §2.3 / A.1: 10 s windows (tokens are reusable within their window), so forgetting the option stays safe.
  url.searchParams.set("expires_in_seconds", String(opts.expiresInSeconds ?? 10));
  if (opts.maxSessionDurationSeconds !== undefined) url.searchParams.set("max_session_duration_seconds", String(opts.maxSessionDurationSeconds));
  const res = await (opts.fetchImpl ?? fetch)(url, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
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

/** StreamingSession factory backed by the statically imported `ws` package (Node scripts, API-key auth). */
export const nodeWebSocketFactory: WebSocketFactory = (url, headers) =>
  new WebSocket(url, headers ? { headers } : {}) as unknown as StreamingWebSocketLike;
