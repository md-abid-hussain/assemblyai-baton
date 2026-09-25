/**
 * p1p3-analyze.ts - the pure half of the WP18·0 publish probes (PLATFORM §8.3 P-1/P-2/P-3). No I/O, no network,
 * so it is unit-tested at $0 (tests/unit/server/publish/p1p3-analyze.test.ts).
 *
 *  - P-1 (greeting): verbatim similarity of the spoken greeting and the time from `session.ready` to the first
 *    audible chunk. Pass = similarity ≥ 0.95 and ≤ 2.5 s, in every run.
 *  - P-2 (HTTP tool body + headers): parse the postman-echo body that AssemblyAI stored in the session timeline's
 *    `tool_calls[].result`, check that the args arrived as a JSON body and that `X-Changeover-Key` arrived, and
 *    list EVERY request header AssemblyAI sent (secret-looking values redacted; the probe key only as "matched").
 *  - P-3 (in-band next step): the first audible reply after the tool call follows `next_step` (asks for a colour).
 */
import { verbatimSimilarity } from "../../src/core/qa/verbatim";

export const P1_MIN_SIMILARITY = 0.95;
export const P1_MAX_FIRST_AUDIBLE_MS = 2500;

/** The in-band step the probe's tool URL carries (`?next_step=…`, echoed back by postman-echo in `args`). */
export const PROBE_NEXT_STEP = "Now ask the customer for their favourite colour.";
/** Does a reply follow PROBE_NEXT_STEP? (It must ask about a colour; "color" and "colour" both count.) */
export const followsNextStep = (text: string | null | undefined): boolean => !!text && /\bcolou?rs?\b/i.test(text);

export interface P1Run {
  similarity: number | null;
  firstAudibleMs: number | null;
}
export function p1RunPass(r: P1Run): boolean {
  return r.similarity !== null && r.similarity >= P1_MIN_SIMILARITY && r.firstAudibleMs !== null && r.firstAudibleMs <= P1_MAX_FIRST_AUDIBLE_MS;
}
export const greetingSimilarity = (greeting: string, spoken: string | null | undefined): number | null =>
  spoken ? Math.round(verbatimSimilarity(greeting, spoken) * 1000) / 1000 : null;

// ------------------------------------------------------------------------------------------------ P-2

/** Header names whose values are never written to the probe output (the probe key is reported as "matched"). */
const SECRET_HEADER = /auth|key|token|secret|signature|cookie|session-token|credential/i;

export interface RedactedHeaders {
  /** Every header, name lower-cased, value kept unless it looks secret. */
  headers: Record<string, string>;
  names: string[];
  /** The `x-changeover-key` value equals the probe key (compared, never written). */
  keyMatched: boolean;
  keyPresent: boolean;
}

export function redactHeaders(raw: Record<string, unknown> | null | undefined, probeKey: string): RedactedHeaders {
  const headers: Record<string, string> = {};
  let keyMatched = false;
  let keyPresent = false;
  for (const [k, v] of Object.entries(raw ?? {})) {
    const name = k.toLowerCase();
    const value = typeof v === "string" ? v : JSON.stringify(v);
    if (name === "x-changeover-key") {
      keyPresent = true;
      keyMatched = value === probeKey;
      headers[name] = keyMatched ? "[probe key: matched]" : `[redacted: ${value.length} chars, NOT the probe key]`;
      continue;
    }
    headers[name] = SECRET_HEADER.test(name) || (probeKey && value.includes(probeKey)) ? `[redacted: ${value.length} chars]` : value;
  }
  return { headers, names: Object.keys(headers).sort(), keyMatched, keyPresent };
}

export interface EchoAnalysis {
  parsed: boolean;
  /** postman-echo `json`: the parsed JSON request body (null when the body was not JSON). */
  jsonBody: Record<string, unknown> | null;
  /** The request's content-type header. */
  contentType: string | null;
  /** postman-echo `args`: the URL query string as received. */
  query: Record<string, unknown> | null;
  /** The body carried every tool-call argument with the same value. */
  argsInBody: boolean;
  /** The args were merged into the query string instead (the T4 GET behaviour). */
  argsInQuery: boolean;
  nextStepEchoed: boolean;
  url: string | null;
  headers: RedactedHeaders;
  /** Headers that look like a per-session / per-call id (a better binding key than the single-active-run lock). */
  idLikeHeaders: string[];
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const sameValue = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Analyse one `tool_calls[].result` string (the postman-echo POST response body). */
export function analyzeEchoResult(result: unknown, toolArgs: Record<string, unknown>, probeKey: string): EchoAnalysis {
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(typeof result === "string" ? JSON.parse(result) : result);
  } catch {
    body = null;
  }
  const headersRaw = asRecord(body?.headers);
  const headers = redactHeaders(headersRaw, probeKey);
  const jsonBody = asRecord(body?.json);
  const query = asRecord(body?.args);
  const argKeys = Object.keys(toolArgs);
  const argsInBody = !!jsonBody && argKeys.length > 0 && argKeys.every((k) => sameValue(jsonBody[k], toolArgs[k]));
  const argsInQuery = !!query && argKeys.length > 0 && argKeys.every((k) => k in query);
  const idLikeHeaders = headers.names.filter(
    (n) => /(session|call|request|conversation|agent|tool|idempot|trace|correlation)[-_]?id|^x-(aai|assemblyai)|x-request-id|x-amzn-trace-id/i.test(n),
  );
  return {
    parsed: !!body,
    jsonBody,
    contentType: typeof headersRaw?.["content-type"] === "string" ? (headersRaw["content-type"] as string) : null,
    query,
    argsInBody,
    argsInQuery,
    nextStepEchoed: query?.next_step === PROBE_NEXT_STEP,
    url: typeof body?.url === "string" ? body.url : null,
    headers,
    idLikeHeaders,
  };
}

export function p2RunPass(a: EchoAnalysis | null, agentUsedResult: boolean): boolean {
  return !!a && a.parsed && a.argsInBody && a.headers.keyMatched && agentUsedResult;
}

// ------------------------------------------------------------------------------------------------ timeline

export interface TimelineToolCall {
  call_id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  dispatched_at_ms?: number | null;
  result_received_at_ms?: number | null;
  duration_ms?: number | null;
  is_error?: boolean;
  timed_out?: boolean;
}
export interface TimelineTurn {
  turn_id?: string;
  trigger?: string;
  status?: string;
  requested_instructions?: string | null;
  user_transcript?: string | null;
  agent_text?: string | null;
  agent_reply_started_at_ms?: number | null;
  time_to_first_audio_ms?: number | null;
  tool_calls?: TimelineToolCall[];
}

/** Every tool call named `name` in a timeline, with the index of its turn. */
export function toolCallsNamed(turns: readonly TimelineTurn[], name: string): { turnIndex: number; call: TimelineToolCall }[] {
  const out: { turnIndex: number; call: TimelineToolCall }[] = [];
  turns.forEach((t, i) => (t.tool_calls ?? []).forEach((c) => c.name === name && out.push({ turnIndex: i, call: c })));
  return out;
}

export const parseArgs = (a: unknown): Record<string, unknown> => {
  if (typeof a === "string") {
    try {
      return asRecord(JSON.parse(a)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(a) ?? {};
};

/** Short, secret-free view of the timeline turns for the notes. */
export function summarizeTurns(turns: readonly TimelineTurn[], probeKey: string): Record<string, unknown>[] {
  const scrub = (s: unknown, n: number): string | null => (typeof s === "string" ? (probeKey ? s.split(probeKey).join("[probe key]") : s).slice(0, n) : null);
  return turns.map((t) => ({
    trigger: t.trigger ?? null,
    status: t.status ?? null,
    instructions: scrub(t.requested_instructions, 60),
    user: scrub(t.user_transcript, 80),
    agent: scrub(t.agent_text, 160),
    ttfaMs: t.time_to_first_audio_ms ?? null,
    tools: (t.tool_calls ?? []).map((c) => ({ name: c.name, ms: c.duration_ms ?? null, isError: !!c.is_error, timedOut: !!c.timed_out })),
  }));
}
