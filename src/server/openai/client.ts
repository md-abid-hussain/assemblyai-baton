/**
 * server/openai/client.ts - OpenAI helpers for the orchestration layer. Promoted from spikes/openai/client.ts per
 * DESIGN §3.2 (fix 5.3-2):
 *  - `ReasoningEffort` no longer contains "minimal" (the API rejects it everywhere, 10d t04);
 *  - the model constants follow the golden config (10 §3.2): gpt-6-luna (fast: extractor, classifier), gpt-6-sol
 *    (balanced: verifier, labels), gpt-4o-mini-tts-2025-12-15 (TTS). luna is NOT a Voice Agent BYO LLM (it fails with
 *    tools on Chat Completions); the BYO choice would be gpt-4.1-mini, which Baton does not use (managed VA LLM);
 *  - the spike's JsonlLogger parameter is replaced by an optional `onTrace(event)` hook (wire it to src/server/log.ts);
 *  - the PCM framing helpers (StreamingDecimator, Pcm24kToMulaw8k, ByteFramer) moved to src/core/audio/framing.ts
 *    (isomorphic, Uint8Array) and are re-exported here; `openSpeechPcmStream` yields Uint8Array chunks.
 * Kept: extractStructured, RefusalError, IncompleteError, usageOf, runToolLoop, streamText, SentenceBuffer,
 * openSpeechPcmStream, streamChat, normalizeChatBodyForReasoningModel.
 *
 * No secrets are read here: pass an API key (or an OpenAI instance) in. Responses API parameter rules (10 §3.8):
 * always set `reasoning.effort`; `temperature` only with effort "none"; `max_output_tokens` ≥ 16.
 */
import "server-only";
import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { EvenByteAligner } from "../../core/audio/framing";

export { ByteFramer, EvenByteAligner, Pcm24kToMulaw8k, StreamingDecimator } from "../../core/audio/framing";

type Responses = OpenAI.Responses.Response;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseCreateParamsNonStreaming = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type ResponseCreateParamsStreaming = OpenAI.Responses.ResponseCreateParamsStreaming;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatStreamParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

// ---------------------------------------------------------------------------------------------
// Models (verified against GET /v1/models for this key on 2026-09-24; 10d t01) - the golden config
// ---------------------------------------------------------------------------------------------

export const MODELS = {
  /** Flagship reasoning (hard offline work only; ~5x sol's cost; effort "none" is rejected). $10 / $50 per 1M tokens. */
  reasoning: "gpt-6-astra",
  /** Balanced tier: the background verifier and ground-truth labelling (effort "low"). $2 / $10 per 1M. */
  balanced: "gpt-6-sol",
  /** Fast tier: the per-turn extractor and the autopilot classifier (effort "none"). $0.10 / $0.50 per 1M. */
  fast: "gpt-6-luna",
  /** TTS (pinned snapshot). PCM out = 24 kHz s16le mono. Voices marin, cedar. */
  tts: "gpt-4o-mini-tts-2025-12-15",
  /**
   * Voice Agent BYO `llm` (stored agents only) - NOT used by Baton (the managed VA LLM is used). GPT-5.6/6 fail on
   * Chat Completions with tools unless reasoning_effort is "none", which the BYO config cannot set (10d t07b).
   */
  byoVoiceAgent: "gpt-4.1-mini",
  /** OpenAI speech-to-speech models (not used in the AssemblyAI pipeline; listed for completeness). */
  realtime: "gpt-realtime-2.1",
  realtimeMini: "gpt-realtime-2.1-mini",
} as const;

/** Luna/sol: none | low | medium | high | xhigh | max. Astra: low..max. "minimal" is rejected everywhere. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** DESIGN §5.3: the per-turn JSON-patch extractor. */
export const EXTRACTOR_MODEL = MODELS.fast;
export const EXTRACTOR_EFFORT: ReasoningEffort = "none";
/** DESIGN F2: the background verifier (can only downgrade). */
export const VERIFIER_MODEL = MODELS.balanced;
export const VERIFIER_EFFORT: ReasoningEffort = "low";
/** DESIGN §5.15: the autopilot field classifier fallback. */
export const CLASSIFIER_MODEL = MODELS.fast;
export const TTS_MODEL = MODELS.tts;
export const TTS_VOICES = ["marin", "cedar"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export function createOpenAI(apiKey: string, opts: { maxRetries?: number; timeoutMs?: number } = {}): OpenAI {
  if (!apiKey) throw new Error("createOpenAI: apiKey is required");
  return new OpenAI({ apiKey, maxRetries: opts.maxRetries ?? 2, timeout: opts.timeoutMs ?? 120_000 });
}

export interface ModelTiers {
  reasoning: string | undefined;
  balanced: string | undefined;
  fast: string | undefined;
  tts: string[];
  realtime: string[];
  transcribe: string[];
}

const TIER_RANK: Record<string, number> = { astra: 4, sol: 3, terra: 2, luna: 1 };

/**
 * Heuristic tiering of a /v1/models id list: highest `gpt-<gen>-<tier>` generation wins; within it
 * astra > sol > terra > luna. Audio families are grouped by name. Verify with a real call before relying on it.
 */
export function pickModels(ids: readonly string[]): ModelTiers {
  const tiered = ids
    .map((id) => {
      const m = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$/.exec(id);
      return m ? { id, gen: Number(m[1]), tier: m[2]!, rank: TIER_RANK[m[2]!]! } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const maxGen = Math.max(...tiered.map((t) => t.gen));
  const top = tiered.filter((t) => t.gen === maxGen).sort((a, b) => b.rank - a.rank);
  const sorted = (re: RegExp) => ids.filter((id) => re.test(id)).sort();
  return {
    reasoning: top[0]?.id,
    balanced: top.find((t) => t.tier === "sol")?.id ?? top[1]?.id,
    fast: top.find((t) => t.tier === "luna")?.id ?? top.at(-1)?.id,
    tts: sorted(/tts/),
    realtime: sorted(/realtime|^gpt-live-1/),
    transcribe: sorted(/transcribe|whisper/),
  };
}

export async function listModelIds(client: OpenAI): Promise<string[]> {
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids.sort();
}

// ---------------------------------------------------------------------------------------------
// Tracing (replaces the spike's JsonlLogger; bodies may contain transcripts - log.ts redacts)
// ---------------------------------------------------------------------------------------------

export type OpenAITraceEvent =
  | { type: "responses.create"; label?: string; round?: number; body: unknown }
  | { type: "responses.response"; label?: string; round?: number; ms: number; response: unknown }
  | { type: "tool.executed"; round: number; call_id: string; name: string; arguments: string; output: string };
export type OnTrace = (event: OpenAITraceEvent) => void;

/** Per-request transport options (openai SDK RequestOptions). */
export interface RequestTransportOptions {
  /** Abort after this long (DESIGN §5.3: ≈8 s for the extractor at 1000 output tokens). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** SDK-level retries for this request (default: the client's). The extractor sets 0 and retries itself. */
  maxRetries?: number;
}

const requestOptions = (o: RequestTransportOptions | undefined): OpenAI.RequestOptions | undefined => {
  if (!o) return undefined;
  const r: OpenAI.RequestOptions = {};
  if (o.timeoutMs !== undefined) r.timeout = o.timeoutMs;
  if (o.signal) r.signal = o.signal;
  if (o.maxRetries !== undefined) r.maxRetries = o.maxRetries;
  return r;
};

// ---------------------------------------------------------------------------------------------
// Structured extraction (Responses API, text.format json_schema, strict)
// ---------------------------------------------------------------------------------------------

export interface JsonSchemaFormat {
  /** ^[a-zA-Z0-9_-]{1,64}$ */
  name: string;
  /** Strict-mode JSON schema: every object needs additionalProperties:false and every key in `required`
   *  (make a field optional with a union type including "null"). */
  schema: Record<string, unknown>;
  description?: string;
  strict?: boolean;
}

export interface ExtractOptions {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  format: JsonSchemaFormat;
  /** Always set it: the default "medium" adds ≈0.5 s to the first token. */
  reasoningEffort?: ReasoningEffort;
  /** Only accepted with reasoningEffort "none" (the extractor uses 0). */
  temperature?: number;
  verbosity?: "low" | "medium" | "high";
  /** ≥ 16. */
  maxOutputTokens?: number;
  /** Default false: extraction calls do not need server-side state. */
  store?: boolean;
  /** Extra Responses params (merged last). */
  extra?: Partial<ResponseCreateParamsNonStreaming>;
  request?: RequestTransportOptions;
  onTrace?: OnTrace;
  label?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
}

export interface ExtractResult<T> {
  data: T;
  response: Responses;
  ms: number;
  usage: Usage;
}

export class RefusalError extends Error {
  readonly refusal: string;
  readonly response: Responses;
  constructor(refusal: string, response: Responses) {
    super(`model refused: ${refusal}`);
    this.name = "RefusalError";
    this.refusal = refusal;
    this.response = response;
  }
}

export class IncompleteError extends Error {
  readonly reason: string;
  readonly response: Responses;
  constructor(reason: string, response: Responses) {
    super(`response incomplete: ${reason}`);
    this.name = "IncompleteError";
    this.reason = reason;
    this.response = response;
  }
}

export function usageOf(r: { usage?: Responses["usage"] | null }): Usage {
  const u = r.usage;
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    cached_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
  };
}

/** Find a refusal content part in a Responses output (strict structured outputs return this instead of JSON). */
export function findRefusal(r: Responses): string | undefined {
  for (const item of r.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) if (part.type === "refusal") return part.refusal;
  }
  return undefined;
}

/**
 * One strict structured-output call. Throws RefusalError (E_OPENAI_REFUSAL), IncompleteError (retry with fewer
 * turns, §5.3), or the SDK's APIConnectionTimeoutError / RateLimitError (E_OPENAI_TIMEOUT / E_OPENAI_RATE).
 */
export async function extractStructured<T>(client: OpenAI, o: ExtractOptions): Promise<ExtractResult<T>> {
  if (o.maxOutputTokens !== undefined && o.maxOutputTokens < 16) throw new RangeError("maxOutputTokens must be >= 16");
  if (o.temperature !== undefined && o.reasoningEffort !== "none") throw new RangeError('temperature is only accepted with reasoningEffort "none"');
  const body: ResponseCreateParamsNonStreaming = {
    model: o.model,
    input: o.input,
    ...(o.instructions ? { instructions: o.instructions } : {}),
    text: {
      format: {
        type: "json_schema",
        name: o.format.name,
        schema: o.format.schema,
        strict: o.format.strict ?? true,
        ...(o.format.description ? { description: o.format.description } : {}),
      },
      ...(o.verbosity ? { verbosity: o.verbosity } : {}),
    },
    ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}),
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    ...(o.maxOutputTokens ? { max_output_tokens: o.maxOutputTokens } : {}),
    store: o.store ?? false,
    ...o.extra,
  };
  o.onTrace?.({ type: "responses.create", ...(o.label ? { label: o.label } : {}), body });
  const t0 = performance.now();
  const response = await client.responses.create(body, requestOptions(o.request));
  const ms = Math.round(performance.now() - t0);
  o.onTrace?.({ type: "responses.response", ...(o.label ? { label: o.label } : {}), ms, response });
  const refusal = findRefusal(response);
  if (refusal) throw new RefusalError(refusal, response);
  if (response.status === "incomplete") throw new IncompleteError(response.incomplete_details?.reason ?? "unknown", response);
  const data = JSON.parse(response.output_text) as T;
  return { data, response, ms, usage: usageOf(response) };
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

export interface ToolSpec<A = any> {
  name: string;
  description: string;
  /** JSON schema for the arguments (strict-mode rules apply when strict is true). */
  parameters: Record<string, unknown>;
  strict?: boolean;
  execute: (args: A, ctx: { callId: string }) => unknown | Promise<unknown>;
}

/** Responses API tool shape: FLAT {type, name, description, parameters, strict}. */
export function toResponsesTool(t: ToolSpec): OpenAI.Responses.FunctionTool {
  return { type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: t.strict ?? true };
}

/** Chat Completions tool shape: NESTED {type, function: {name, description, parameters, strict}}. */
export function toChatTool(t: ToolSpec): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters, strict: t.strict ?? true } };
}

async function runTool(tools: ToolSpec[], name: string, rawArgs: string, callId: string): Promise<{ output: string; args: unknown; error?: string }> {
  const tool = tools.find((t) => t.name === name);
  let args: unknown = undefined;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
    if (!tool) throw new Error(`unknown tool ${name}`);
    const result = await tool.execute(args, { callId });
    return { output: typeof result === "string" ? result : JSON.stringify(result), args };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Hand the error back to the model instead of crashing the loop.
    return { output: JSON.stringify({ error }), args, error };
  }
}

export interface ToolLoopOptions {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  tools: ToolSpec[];
  /**
   * "replay"               - resend the whole item history each round (works with store:false when
   *                          reasoning.encrypted_content is included; stateless, portable).
   * "previous_response_id" - server-side state; only the new function_call_output items are sent.
   *                          Requires store:true. `instructions` are NOT inherited, so they are resent.
   */
  state?: "replay" | "previous_response_id";
  store?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxRounds?: number;
  parallelToolCalls?: boolean;
  toolChoice?: OpenAI.Responses.ResponseCreateParams["tool_choice"];
  maxOutputTokens?: number;
  request?: RequestTransportOptions;
  onTrace?: OnTrace;
}

export interface ToolCallRecord {
  round: number;
  call_id: string;
  name: string;
  arguments: string;
  args: unknown;
  output: string;
  error?: string;
}

export interface ToolLoopResult {
  finalText: string;
  rounds: number;
  toolCalls: ToolCallRecord[];
  responses: Responses[];
  roundMs: number[];
  usage: Usage;
  /** The replayable history (replay mode) - append the next user turn to continue the conversation. */
  history: ResponseInputItem[];
}

export async function runToolLoop(client: OpenAI, o: ToolLoopOptions): Promise<ToolLoopResult> {
  const state = o.state ?? "replay";
  const store = o.store ?? state === "previous_response_id";
  if (state === "previous_response_id" && !store) throw new Error("previous_response_id requires store:true");
  const history: ResponseInputItem[] = typeof o.input === "string" ? [{ role: "user", content: o.input }] : [...o.input];
  const tools = o.tools.map(toResponsesTool);
  const toolCalls: ToolCallRecord[] = [];
  const responses: Responses[] = [];
  const roundMs: number[] = [];
  const total: Usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 };
  let pending: ResponseInputItem[] = history; // what to send this round (previous_response_id mode)
  let prevId: string | undefined;
  const maxRounds = o.maxRounds ?? 6;

  for (let round = 1; round <= maxRounds; round++) {
    const body: ResponseCreateParamsNonStreaming = {
      model: o.model,
      tools,
      input: state === "replay" ? history : pending,
      store,
      ...(o.instructions ? { instructions: o.instructions } : {}),
      ...(prevId ? { previous_response_id: prevId } : {}),
      ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}),
      ...(!store ? { include: ["reasoning.encrypted_content"] as OpenAI.Responses.ResponseIncludable[] } : {}),
      ...(o.parallelToolCalls !== undefined ? { parallel_tool_calls: o.parallelToolCalls } : {}),
      ...(o.toolChoice && round === 1 ? { tool_choice: o.toolChoice } : {}),
      ...(o.maxOutputTokens ? { max_output_tokens: o.maxOutputTokens } : {}),
    };
    o.onTrace?.({ type: "responses.create", round, body });
    const t0 = performance.now();
    const r = await client.responses.create(body, requestOptions(o.request));
    const ms = Math.round(performance.now() - t0);
    roundMs.push(ms);
    responses.push(r);
    o.onTrace?.({ type: "responses.response", round, ms, response: r });
    const u = usageOf(r);
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.reasoning_tokens += u.reasoning_tokens;
    total.cached_tokens += u.cached_tokens;

    const calls = r.output.filter((i): i is OpenAI.Responses.ResponseFunctionToolCall => i.type === "function_call");
    if (state === "replay") history.push(...toResponseInputItems(r.output));
    if (calls.length === 0) {
      return { finalText: r.output_text, rounds: round, toolCalls, responses, roundMs, usage: total, history };
    }
    const outputs: ResponseInputItem[] = [];
    for (const c of calls) {
      const res = await runTool(o.tools, c.name, c.arguments, c.call_id);
      toolCalls.push({ round, call_id: c.call_id, name: c.name, arguments: c.arguments, args: res.args, output: res.output, ...(res.error ? { error: res.error } : {}) });
      o.onTrace?.({ type: "tool.executed", round, call_id: c.call_id, name: c.name, arguments: c.arguments, output: res.output });
      outputs.push({ type: "function_call_output", call_id: c.call_id, output: res.output });
    }
    if (state === "replay") history.push(...outputs);
    else {
      pending = outputs;
      prevId = r.id;
    }
  }
  throw new Error(`tool loop did not finish within ${maxRounds} rounds`);
}

// ---------------------------------------------------------------------------------------------
// Streaming text (Responses API)
// ---------------------------------------------------------------------------------------------

export interface StreamTextResult {
  text: string;
  status: "completed" | "incomplete" | "failed" | "error";
  /** ms from request start to the first event of any kind (roughly TTFB). */
  firstEventMs: number | null;
  /** ms from request start to the first response.output_text.delta (time to first token). */
  ttftMs: number | null;
  totalMs: number;
  response?: Responses;
  usage: Usage;
  eventCounts: Record<string, number>;
  error?: string;
}

export interface StreamHooks {
  onDelta?: (delta: string, atMs: number) => void;
  onEvent?: (e: ResponseStreamEvent, atMs: number) => void;
  signal?: AbortSignal;
}

export async function streamText(client: OpenAI, params: Omit<ResponseCreateParamsStreaming, "stream">, hooks: StreamHooks = {}): Promise<StreamTextResult> {
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  const stream = await client.responses.create({ ...params, stream: true }, hooks.signal ? { signal: hooks.signal } : undefined);
  let text = "";
  let firstEventMs: number | null = null;
  let ttftMs: number | null = null;
  let status: StreamTextResult["status"] = "error";
  let response: Responses | undefined;
  let error: string | undefined;
  const eventCounts: Record<string, number> = {};
  for await (const e of stream) {
    const now = at();
    firstEventMs ??= now;
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    hooks.onEvent?.(e, now);
    switch (e.type) {
      case "response.output_text.delta":
        ttftMs ??= now;
        text += e.delta;
        hooks.onDelta?.(e.delta, now);
        break;
      case "response.completed":
        status = "completed";
        response = e.response;
        break;
      case "response.incomplete":
        status = "incomplete";
        response = e.response;
        break;
      case "response.failed":
        status = "failed";
        response = e.response;
        error = e.response.error?.message;
        break;
      case "error":
        status = "error";
        error = e.message;
        break;
    }
  }
  return { text, status, firstEventMs, ttftMs, totalMs: at(), ...(response ? { response } : {}), usage: response ? usageOf(response) : usageOf({}), eventCounts, ...(error ? { error } : {}) };
}

/**
 * Accumulates streamed text deltas and releases whole sentences, for feeding a TTS engine sentence-by-sentence while
 * the LLM is still generating.
 */
export class SentenceBuffer {
  private buf = "";
  private readonly minChars: number;
  /** Sentences shorter than minChars are merged with the next one ("Sure." + next) for smoother TTS prosody. */
  constructor(minChars = 16) {
    this.minChars = minChars;
  }
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // sentence end = . ! ? (optionally followed by quotes/brackets) + whitespace; avoid splitting "10 a.m. on"
    const re = /[.!?]["')\]]?\s+/g;
    let cut = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf)) !== null) {
      const end = m.index + m[0].length;
      const candidate = this.buf.slice(cut, end).trim();
      const abbrev = /\b(?:[ap]\.m|[A-Z]|Mr|Ms|Mrs|Dr|St|No|vs|e\.g|i\.e)\.$/.test(this.buf.slice(cut, m.index + 1));
      if (candidate.length >= this.minChars && !abbrev) {
        out.push(candidate);
        cut = end;
      }
    }
    this.buf = this.buf.slice(cut);
    return out;
  }
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}

// ---------------------------------------------------------------------------------------------
// Streaming TTS -> PCM16 chunks (/v1/audio/speech, response_format "pcm")
// ---------------------------------------------------------------------------------------------

export const TTS_PCM_RATE = 24_000;

export interface SpeechPcmOptions {
  input: string;
  voice: string;
  model?: string;
  /** gpt-4o-mini-tts only: tone/accent/pace prompt. */
  instructions?: string;
  speed?: number;
  signal?: AbortSignal;
  /** Re-frame output into fixed-size PCM frames (bytes, must be even). Default: pass network chunks through (even-aligned). */
  frameBytes?: number;
}

export interface PcmChunk {
  /** PCM16 LE mono @ 24 kHz, always an even number of bytes. */
  pcm: Uint8Array;
  index: number;
  /** ms since the request was started. */
  atMs: number;
}

export interface SpeechStats {
  status: number;
  requestId: string | undefined;
  contentType: string | null;
  headers: Record<string, string>;
  /** ms from request start to response headers. */
  headersMs: number;
  /** ms from request start to the first audio byte. */
  ttfbMs: number | null;
  totalMs: number | null;
  bytes: number;
  networkChunks: number;
  oddChunks: number;
  audioMs: number;
}

/**
 * Start a TTS request and return its stats plus an async generator of even-aligned PCM chunks. HTTP chunk boundaries
 * do not respect sample boundaries, so an odd trailing byte is carried into the next chunk (seen in practice; 10d t06).
 */
export async function openSpeechPcmStream(client: OpenAI, o: SpeechPcmOptions): Promise<{ stats: SpeechStats; chunks: AsyncGenerator<PcmChunk> }> {
  const body: OpenAI.Audio.SpeechCreateParams = {
    model: o.model ?? MODELS.tts,
    voice: o.voice,
    input: o.input,
    response_format: "pcm",
    ...(o.instructions ? { instructions: o.instructions } : {}),
    ...(o.speed ? { speed: o.speed } : {}),
  };
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  const res = await client.audio.speech.create(body, o.signal ? { signal: o.signal } : undefined);
  const stats: SpeechStats = {
    status: res.status,
    requestId: res.headers.get("x-request-id") ?? undefined,
    contentType: res.headers.get("content-type"),
    headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => k.toLowerCase() !== "set-cookie")),
    headersMs: at(),
    ttfbMs: null,
    totalMs: null,
    bytes: 0,
    networkChunks: 0,
    oddChunks: 0,
    audioMs: 0,
  };
  if (!res.body) throw new Error("speech response has no body");
  const body$ = res.body;
  const frameBytes = o.frameBytes && o.frameBytes % 2 === 0 ? o.frameBytes : undefined;

  async function* chunks(): AsyncGenerator<PcmChunk> {
    const aligner = new EvenByteAligner(frameBytes ?? 2);
    let index = 0;
    for await (const raw of body$ as unknown as AsyncIterable<Uint8Array>) {
      const now = at();
      stats.ttfbMs ??= now;
      stats.networkChunks++;
      stats.bytes += raw.byteLength;
      if (raw.byteLength % 2 !== 0) stats.oddChunks++;
      const buf = aligner.push(raw);
      if (!buf.length) continue;
      if (frameBytes) {
        for (let off = 0; off < buf.length; off += frameBytes) yield { pcm: buf.slice(off, off + frameBytes), index: index++, atMs: now };
      } else {
        yield { pcm: buf, index: index++, atMs: now };
      }
    }
    const tail = aligner.flush();
    if (tail.length > 0) yield { pcm: tail, index: index++, atMs: at() };
    stats.totalMs = at();
    stats.audioMs = Math.round(((stats.bytes / 2) * 1000) / TTS_PCM_RATE);
  }
  return { stats, chunks: chunks() };
}

// ---------------------------------------------------------------------------------------------
// Streamed Chat Completions (OpenAI-compatible BYO LLM endpoint shape; unused by Baton, kept for the BYO note)
// ---------------------------------------------------------------------------------------------

export interface ChatToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface ChatStreamResult {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  firstChunkMs: number | null;
  /** first content delta OR first tool-call delta */
  ttftMs: number | null;
  totalMs: number;
  chunkCount: number;
  model: string | undefined;
  usage: ChatChunk["usage"] | undefined;
}

/**
 * Make a generic OpenAI-compatible chat body acceptable to GPT-5.6/6 reasoning models on /v1/chat/completions
 * (verified in t07/t07b):
 *  - function tools + any reasoning_effort other than "none" -> 400; the default effort is "medium", so an omitted
 *    effort fails too
 *  - max_tokens -> 400 "Use 'max_completion_tokens' instead" on reasoning models
 *  - temperature/top_p != default are only accepted when reasoning_effort is "none"
 */
export type NormalizedChatBody = Record<string, unknown> & { reasoning_effort: string; max_completion_tokens?: number; temperature?: number; top_p?: number };

export function normalizeChatBodyForReasoningModel(body: Record<string, unknown>, opts: { effort?: "none" | "low" | "medium" | "high" | "xhigh" } = {}): NormalizedChatBody {
  const out: Record<string, unknown> = { ...body };
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0;
  if (out.reasoning_effort === undefined) out.reasoning_effort = opts.effort ?? "none";
  if (hasTools && out.reasoning_effort !== "none") out.reasoning_effort = "none";
  if (out.max_tokens !== undefined) {
    if (out.max_completion_tokens === undefined) out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  if (out.reasoning_effort !== "none") {
    delete out.temperature;
    delete out.top_p;
  }
  return out as NormalizedChatBody;
}

export async function streamChat(
  client: OpenAI,
  params: Omit<ChatStreamParams, "stream">,
  hooks: { onChunk?: (c: ChatChunk, atMs: number) => void; signal?: AbortSignal } = {},
): Promise<ChatStreamResult> {
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  const stream = await client.chat.completions.create({ ...params, stream: true }, hooks.signal ? { signal: hooks.signal } : undefined);
  let text = "";
  const calls = new Map<number, ChatToolCall>();
  let finishReason: string | null = null;
  let firstChunkMs: number | null = null;
  let ttftMs: number | null = null;
  let chunkCount = 0;
  let model: string | undefined;
  let usage: ChatChunk["usage"] | undefined;
  for await (const c of stream) {
    const now = at();
    firstChunkMs ??= now;
    chunkCount++;
    model ??= c.model;
    hooks.onChunk?.(c, now);
    if (c.usage) usage = c.usage;
    for (const choice of c.choices) {
      const d = choice.delta;
      if (d?.content) {
        ttftMs ??= now;
        text += d.content;
      }
      for (const tc of d?.tool_calls ?? []) {
        ttftMs ??= now;
        const cur = calls.get(tc.index) ?? { index: tc.index, id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { text, toolCalls: [...calls.values()].sort((a, b) => a.index - b.index), finishReason, firstChunkMs, ttftMs, totalMs: at(), chunkCount, model, usage };
}
