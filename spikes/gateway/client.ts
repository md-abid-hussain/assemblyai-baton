/**
 * gateway/client.ts - AssemblyAI LLM Gateway client built on the official OpenAI SDK (baseURL swap).
 *
 * Live-verified 2026-09-24 (research/10c-async-gateway-smoke.md), on the only model the hackathon
 * account can reach (qwen3.5-4b-32k-fast, 2 req/min; 44 others -> 400 "Your account does not have
 * access to this LLM Gateway model" until the plan is upgraded):
 *  - Base URL  https://llm-gateway.assemblyai.com/v1  (EU: https://llm-gateway.eu.assemblyai.com/v1)
 *  - Auth      the AssemblyAI API key; `Authorization: Bearer <key>` (SDK) and raw `<key>` both work.
 *  - GET /v1/models needs no auth; it changes within minutes. Unsupported params are REJECTED (400),
 *    so pre-check with `unsupportedParams()`.
 *  - Pass-through extras verified live: transcript_id (+ exact "{{ transcript }}"), model_region
 *    ("global" only), post_processing_steps json-repair, stream (SSE also on non-OpenAI qwen).
 *  - NOT live-verified (no access): response_format / tools / finish_reason families on Claude/GPT.
 *    `runToolLoop` and `normalizeFinishReason` are covered by gateway/selftest.ts with a mock fetch.
 *  - `fallbacks` do not rescue validation/access errors (all model ids must be valid AND accessible).
 *
 * Server-side only: never ship the AssemblyAI key to a browser.
 */
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export const GATEWAY_BASE_US = "https://llm-gateway.assemblyai.com/v1";
export const GATEWAY_BASE_EU = "https://llm-gateway.eu.assemblyai.com/v1";
/** Exact literal the Gateway substitutes with the transcript text when `transcript_id` is set (first occurrence only). */
export const TRANSCRIPT_TAG = "{{ transcript }}";

export type GatewayRegion = "us" | "eu";

// ---------------------------------------------------------------------------------------------
// Models catalog (GET /v1/models, no auth)
// ---------------------------------------------------------------------------------------------

export interface GatewayModelPricingTier {
  prompt?: number;
  completions?: number;
  input_cache_read?: number;
  input_cache_write?: number;
  input_cache_write_1h?: number;
  [k: string]: number | undefined;
}

export interface GatewayModel {
  id: string;
  name?: string;
  description?: string;
  creator?: string;
  context_length?: number;
  supported_parameters?: string[];
  default_parameters?: Record<string, unknown>;
  top_provider?: { is_moderated?: boolean; context_length?: number; max_completion_tokens?: number };
  /** $ per 1M tokens. Keys observed: "global" (+ optional "regional_increase_percent"). */
  pricing?: { global?: GatewayModelPricingTier; regional_increase_percent?: number; [k: string]: unknown };
  /** 0 = no retirement scheduled, otherwise a unix timestamp. */
  retirement_date?: number;
  available_regions?: string[];
  [k: string]: unknown;
}

export async function listGatewayModels(opts: { region?: GatewayRegion; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<GatewayModel[]> {
  const f = opts.fetch ?? fetch;
  const base = opts.region === "eu" ? GATEWAY_BASE_EU : GATEWAY_BASE_US;
  const res = await f(`${base}/models`, { signal: opts.signal ?? AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { data?: GatewayModel[] };
  return body.data ?? [];
}

export function modelSupports(model: GatewayModel | undefined, param: string): boolean {
  return !!model?.supported_parameters?.includes(param);
}

/** Request fields the Gateway validates against `supported_parameters` (it 400s instead of ignoring them). */
const GATED_PARAMS = ["temperature", "tools", "tool_choice", "response_format", "stream", "reasoning_effort", "max_tokens"] as const;

/**
 * Pre-flight check: which gated params in `params` does `model` not support? Observed live:
 * `400 {"metadata":{"errors":["model qwen3.5-4b-32k-fast does not support response_format"]}}`.
 */
export function unsupportedParams(model: GatewayModel | undefined, params: Record<string, unknown>): string[] {
  if (!model) return ["<model not in catalog>"];
  return GATED_PARAMS.filter((p) => params[p] !== undefined && params[p] !== false && !modelSupports(model, p));
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface GatewayClientOptions {
  /** AssemblyAI API key (NOT the OpenAI key). */
  apiKey: string;
  region?: GatewayRegion;
  /** Custom fetch (e.g. a logging wrapper). */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * OpenAI SDK instance pointed at the Gateway. `organization`/`project`/`adminAPIKey` are forced to
 * null so OPENAI_ORG_ID / OPENAI_PROJECT_ID env vars can never leak OpenAI headers to AssemblyAI,
 * and `apiKey` is required so the SDK can never fall back to process.env.OPENAI_API_KEY.
 */
export function createGatewayClient(opts: GatewayClientOptions): OpenAI {
  if (!opts.apiKey) throw new Error("createGatewayClient: apiKey (AssemblyAI key) is required");
  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.region === "eu" ? GATEWAY_BASE_EU : GATEWAY_BASE_US,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: opts.maxRetries ?? 2,
    timeout: opts.timeoutMs ?? 60_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/** Gateway-only request fields (pass-through in the SDK body). */
export interface GatewayExtras {
  /** Inject an AssemblyAI transcript's `text` in place of the first literal `{{ transcript }}`. */
  transcript_id?: string;
  /** Opt into global (non-regional) routing; only "global" is accepted. */
  model_region?: "global";
  fallbacks?: Array<{ model: string } & Record<string, unknown>>;
  fallback_config?: { retry?: boolean; depth?: number };
  post_processing_steps?: Array<{ type: "json-repair" }>;
}

export type GatewayChatParams = Omit<ChatCompletionCreateParamsNonStreaming, "stream"> & GatewayExtras;
export type GatewayStreamParams = Omit<ChatCompletionCreateParamsStreaming, "stream"> & GatewayExtras;

/** Gateway usage: Anthropic-style names (input/output) on every model, sometimes plus OpenAI-style ones. */
export interface GatewayUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  [k: string]: unknown;
}

export type GatewayChatCompletion = Omit<ChatCompletion, "usage"> & {
  request_id?: string;
  usage?: GatewayUsage;
  /** nanoseconds */
  response_time?: number;
  http_status_code?: number;
  llm_status_code?: number;
  request?: Record<string, unknown>;
};

export interface GatewayCallResult {
  completion: GatewayChatCompletion;
  /** Wall-clock ms for the HTTP round trip. */
  ms: number;
  /** Selected response headers (rate-limit etc.). */
  headers: Record<string, string>;
}

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) if (/^x-ratelimit|^x-request-id|^request-id|^x-aai/i.test(k)) out[k] = v;
  return out;
}

/** Non-streaming chat completion with Gateway extras. */
export async function gatewayChat(client: OpenAI, params: GatewayChatParams, opts: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
  const t0 = performance.now();
  const { data, response } = await client.chat.completions
    .create({ ...(params as ChatCompletionCreateParamsNonStreaming), stream: false }, { signal: opts.signal ?? null })
    .withResponse();
  return { completion: data as unknown as GatewayChatCompletion, ms: Math.round(performance.now() - t0), headers: pickHeaders(response.headers) };
}

export interface StreamStats {
  text: string;
  chunks: number;
  ttftMs: number | null;
  totalMs: number;
  finishReason: string | null;
  usage: unknown;
  toolCallDeltas: number;
}

/**
 * Streaming chat completion. `onDelta` fires per text delta. Returns the assembled text + timing.
 * Only models whose `supported_parameters` include "stream" should be called this way.
 */
export async function gatewayStream(
  client: OpenAI,
  params: GatewayStreamParams,
  onDelta?: (delta: string, chunk: ChatCompletionChunk) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<StreamStats> {
  const t0 = performance.now();
  const stream = await client.chat.completions.create({ ...(params as ChatCompletionCreateParamsStreaming), stream: true }, { signal: opts.signal ?? null });
  let text = "";
  let chunks = 0;
  let ttftMs: number | null = null;
  let finishReason: string | null = null;
  let usage: unknown = null;
  let toolCallDeltas = 0;
  for await (const chunk of stream) {
    chunks++;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content ?? "";
    if (delta) {
      if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
      text += delta;
      onDelta?.(delta, chunk);
    }
    if (choice?.delta?.tool_calls?.length) toolCallDeltas++;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if ((chunk as { usage?: unknown }).usage) usage = (chunk as { usage?: unknown }).usage;
  }
  return { text, chunks, ttftMs, totalMs: Math.round(performance.now() - t0), finishReason, usage, toolCallDeltas };
}

// ---------------------------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------------------------

export type NormalizedFinish = "stop" | "tool_calls" | "length" | "content_filter" | "other";

/** OpenAI: stop/tool_calls/length. Claude (passed through): end_turn/tool_use/max_tokens/stop_sequence. */
export function normalizeFinishReason(fr: string | null | undefined): NormalizedFinish {
  switch (fr) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

export function completionText(c: GatewayChatCompletion): string {
  const content = c.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** Parse a structured-output reply. Strips ```json fences defensively. */
export function parseJsonContent<T = unknown>(c: GatewayChatCompletion): T {
  const raw = completionText(c).trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  return JSON.parse(unfenced) as T;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export function extractToolCalls(c: GatewayChatCompletion): ToolCall[] {
  const calls = c.choices?.[0]?.message?.tool_calls ?? [];
  const out: ToolCall[] = [];
  for (const tc of calls) {
    if (tc.type === "function") out.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
  }
  return out;
}

export function usageTokens(u: GatewayUsage | undefined): { input: number; output: number } {
  return { input: u?.input_tokens ?? u?.prompt_tokens ?? 0, output: u?.output_tokens ?? u?.completion_tokens ?? 0 };
}

/** Build a json_schema response_format (strict, additionalProperties:false expected in `schema`). */
export function jsonSchemaFormat(name: string, schema: Record<string, unknown>): { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict: true } } {
  return { type: "json_schema", json_schema: { name, schema, strict: true } };
}

export type ToolHandler = (args: unknown) => Promise<unknown> | unknown;

/**
 * Agentic tool loop: call -> run tool handlers -> feed results -> repeat until a normal stop.
 * Works for both OpenAI-family and Claude-family finish reasons.
 */
export async function runToolLoop(
  client: OpenAI,
  params: GatewayChatParams & { tools: ChatCompletionTool[] },
  handlers: Record<string, ToolHandler>,
  opts: { maxIterations?: number; onStep?: (step: { iteration: number; result: GatewayCallResult; toolCalls: ToolCall[] }) => void } = {},
): Promise<{ final: GatewayCallResult; messages: ChatCompletionMessageParam[]; iterations: number }> {
  const messages: ChatCompletionMessageParam[] = [...params.messages];
  const max = opts.maxIterations ?? 6;
  for (let i = 1; i <= max; i++) {
    const result = await gatewayChat(client, { ...params, messages });
    const toolCalls = extractToolCalls(result.completion);
    opts.onStep?.({ iteration: i, result, toolCalls });
    if (toolCalls.length === 0) return { final: result, messages, iterations: i };
    messages.push({
      role: "assistant",
      content: completionText(result.completion) || null,
      tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })),
    });
    for (const tc of toolCalls) {
      const handler = handlers[tc.name];
      let output: unknown;
      try {
        output = handler ? await handler(tc.arguments ? JSON.parse(tc.arguments) : {}) : { error: `unknown tool ${tc.name}` };
      } catch (err) {
        output = { error: String(err) };
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
    }
  }
  throw new Error(`runToolLoop: exceeded ${max} iterations`);
}
