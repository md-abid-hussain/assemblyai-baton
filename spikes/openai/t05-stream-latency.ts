/**
 * t05 - Responses API streaming: event vocabulary + TTFT/total latency for fast vs smart models.
 *   - 5 configs x 3 reps, same short voice-style prompt, store:false
 *   - one streamed function-call run to capture the tool-argument event types
 *   - SentenceBuffer check on a real stream (what a BYO-TTS pipeline would speak, sentence by sentence)
 * Out: out/openai-t05-stream.jsonl
 */
import type OpenAI from "openai";
import { createLogger } from "../lib/log.ts";
import { MODELS, SentenceBuffer, streamText, toResponsesTool, type ReasoningEffort } from "./client.ts";
import { errInfo, header, oa, stats, trunc } from "./common.ts";
import { getClaimStatus, lookupPolicy } from "./t03-tools-defs.ts";

const log = createLogger("openai-t05-stream");
header(log, "t05-stream-latency");

const INSTRUCTIONS = "You are a friendly insurance phone agent. Reply in two short spoken sentences, no lists, no markdown.";
const PROMPT = "Hi, my claim number is CL44812. Can you tell me what happens next with my claim and how long repairs usually take?";

const CONFIGS: { model: string; effort?: ReasoningEffort }[] = [
  { model: MODELS.fast, effort: "none" },
  { model: MODELS.fast, effort: "low" },
  { model: MODELS.fast }, // default effort (= medium per t04)
  { model: MODELS.balanced, effort: "low" },
  { model: MODELS.reasoning, effort: "low" },
];
const REPS = 3;

const table: Record<string, unknown>[] = [];
let loggedFullSequence = false;
for (const cfg of CONFIGS) {
  const label = `${cfg.model}/${cfg.effort ?? "default"}`;
  const ttft: number[] = [];
  const total: number[] = [];
  const firstEvent: number[] = [];
  let lastUsage: unknown;
  let sampleText = "";
  let eventCounts: Record<string, number> = {};
  for (let rep = 0; rep < REPS; rep++) {
    const sequence: { t: number; type: string; delta?: string }[] = [];
    const params: Omit<OpenAI.Responses.ResponseCreateParamsStreaming, "stream"> = {
      model: cfg.model,
      instructions: INSTRUCTIONS,
      input: PROMPT,
      store: false,
      max_output_tokens: 400,
      ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
    };
    if (rep === 0) log.out({ type: "responses.create(stream)", label, body: { ...params, stream: true } });
    try {
      const r = await streamText(oa, params, {
        onEvent: (e, at) => {
          if (!loggedFullSequence) log.in(e, { at_ms: at, label });
          sequence.push({ t: at, type: e.type, ...(e.type === "response.output_text.delta" ? { delta: e.delta } : {}) });
        },
      });
      loggedFullSequence = true;
      if (r.ttftMs !== null) ttft.push(r.ttftMs);
      if (r.firstEventMs !== null) firstEvent.push(r.firstEventMs);
      total.push(r.totalMs);
      lastUsage = r.usage;
      sampleText = r.text;
      eventCounts = r.eventCounts;
      log.note("run", { label, rep, status: r.status, ttft_ms: r.ttftMs, first_event_ms: r.firstEventMs, total_ms: r.totalMs, usage: r.usage, event_counts: r.eventCounts, first_events: sequence.slice(0, 8).map((s) => `${s.t}ms ${s.type}${s.delta !== undefined ? ` "${s.delta}"` : ""}`), text: r.text });
      console.log(`${label.padEnd(22)} rep${rep} status=${r.status} firstEvent=${r.firstEventMs}ms ttft=${r.ttftMs}ms total=${r.totalMs}ms out=${r.usage.output_tokens} reason=${r.usage.reasoning_tokens}`);
    } catch (e) {
      log.error(e, { label, rep });
      console.log(`${label} rep${rep} ERROR ${JSON.stringify(errInfo(e))}`);
    }
  }
  const row = { label, ttft_ms: stats(ttft), first_event_ms: stats(firstEvent), total_ms: stats(total), usage_last: lastUsage, event_counts_last: eventCounts, sample_text: trunc(sampleText, 300) };
  table.push(row);
  log.note("config summary", row);
}

// ---- streamed function call: which events carry tool arguments? ----
let toolStream: Record<string, unknown> = {};
{
  const seq: string[] = [];
  const argDeltas: string[] = [];
  try {
    const r = await streamText(
      oa,
      { model: MODELS.fast, input: "Check policy H P 7 7 4 0 3 9 1 please.", tools: [toResponsesTool(lookupPolicy), toResponsesTool(getClaimStatus)], store: false, reasoning: { effort: "none" } },
      {
        onEvent: (e, at) => {
          seq.push(`${at}ms ${e.type}`);
          if (e.type === "response.function_call_arguments.delta") argDeltas.push(e.delta);
          if (e.type !== "response.function_call_arguments.delta") log.in(e, { at_ms: at, label: "tool-stream" });
        },
      },
    );
    const fc = r.response?.output.find((o) => o.type === "function_call");
    toolStream = { status: r.status, total_ms: r.totalMs, sequence: seq, arg_deltas: argDeltas, function_call: fc };
    console.log(`tool stream: ${seq.map((s) => s.split(" ")[1]).join(" > ")}`);
    console.log(`  arg deltas: ${JSON.stringify(argDeltas)}`);
  } catch (e) {
    toolStream = { error: errInfo(e) };
    console.log(`tool stream ERROR ${JSON.stringify(errInfo(e))}`);
  }
  log.note("tool stream", toolStream);
}

// ---- SentenceBuffer on a live stream ----
let sentenceCheck: Record<string, unknown> = {};
{
  const sb = new SentenceBuffer();
  const emitted: { at: number; s: string }[] = [];
  const r = await streamText(
    oa,
    { model: MODELS.fast, instructions: INSTRUCTIONS, input: "Tell me in three sentences what I should do after a minor rear-end collision at 5 p.m. on Main St.", store: false, reasoning: { effort: "none" } },
    { onDelta: (d, at) => sb.push(d).forEach((s) => emitted.push({ at, s })) },
  );
  const tail = sb.flush();
  if (tail) emitted.push({ at: r.totalMs, s: tail });
  sentenceCheck = { ttft_ms: r.ttftMs, total_ms: r.totalMs, first_sentence_ready_ms: emitted[0]?.at, sentences: emitted, rejoined_equals_text: emitted.map((e) => e.s).join(" ").replace(/\s+/g, " ") === r.text.trim().replace(/\s+/g, " ") };
  log.note("sentence buffer", sentenceCheck);
  console.log(`sentences: ${JSON.stringify(emitted)}`);
}

for (const row of table) {
  const t = row.ttft_ms as ReturnType<typeof stats>;
  const tt = row.total_ms as ReturnType<typeof stats>;
  console.log(`${String(row.label).padEnd(22)} TTFT median ${t?.median}ms (min ${t?.min} max ${t?.max})  total median ${tt?.median}ms`);
}
log.result(table.every((r) => (r.ttft_ms as { n: number } | null)?.n === REPS) ? "PASS" : "PARTIAL", {
  request_shape: "POST /v1/responses {model, instructions, input, stream:true, store:false, max_output_tokens, reasoning:{effort}}",
  prompt: PROMPT,
  table,
  tool_stream: { sequence: toolStream.sequence, arg_deltas: toolStream.arg_deltas },
  sentence_buffer: sentenceCheck,
});
log.close();
