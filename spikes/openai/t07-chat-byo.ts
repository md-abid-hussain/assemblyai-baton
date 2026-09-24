/**
 * t07 - Chat Completions compatibility for AssemblyAI Voice Agent BYO `llm` (research/01 §10, synthesis C9/T6):
 * the endpoint must accept POST {base_url}/chat/completions with stream:true (OpenAI schema).
 *   A: raw SSE wire format (fetch) - data: {...} lines + data: [DONE], tool_calls deltas, usage chunk
 *   B: SDK streamChat() round trip: tool_calls -> tool messages -> streamed final text
 *   C: TTFT with tools present, default effort vs reasoning_effort none, candidate BYO models
 *   D: params a generic OpenAI-compatible caller may send (temperature, max_tokens, top_p) while streaming
 * Out: out/openai-t07-chat.jsonl
 */
import type OpenAI from "openai";
import { OPENAI_API_KEY } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { MODELS, streamChat, toChatTool } from "./client.ts";
import { errInfo, header, oa, stats, trunc } from "./common.ts";
import { getClaimStatus, lookupPolicy } from "./t03-tools-defs.ts";

const log = createLogger("openai-t07-chat");
header(log, "t07-chat-byo");

const TOOLS = [lookupPolicy, getClaimStatus];
const chatTools = TOOLS.map(toChatTool);
const SYSTEM = "You are a claims voice agent for Harbor Point. Use tools for policy and claim facts. Reply in one or two short spoken sentences.";
const USER_TOOL = "My claim number is C L 4 4 8 1 2 and policy H P 7 7 4 0 3 9 1. When will the appraiser call, and what's my deductible?";
const USER_CHAT = "Hi there, I was in a small accident yesterday and I'm not sure what to do first.";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ---------------- A: raw SSE wire format ----------------
let wire: Record<string, unknown> = {};
{
  const body = {
    model: MODELS.fast,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_TOOL },
    ],
    tools: chatTools,
    reasoning_effort: "none",
  };
  log.out({ type: "POST /v1/chat/completions (raw)", body });
  const t0 = performance.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const headersMs = Math.round(performance.now() - t0);
  const text = await res.text();
  const totalMs = Math.round(performance.now() - t0);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const dataLines = lines.filter((l) => l.startsWith("data:"));
  const parsed = dataLines.map((l) => l.slice(5).trim()).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d) as Record<string, unknown>);
  wire = {
    status: res.status,
    content_type: res.headers.get("content-type"),
    headers_ms: headersMs,
    total_ms: totalMs,
    line_endings: text.includes("\r\n") ? "CRLF" : "LF",
    non_data_lines: lines.filter((l) => !l.startsWith("data:")).slice(0, 5),
    data_lines: dataLines.length,
    last_line: dataLines.at(-1),
    first_chunk: parsed[0],
    tool_chunks_sample: parsed.filter((p) => JSON.stringify(p).includes("tool_calls")).slice(0, 4),
    finish_chunk: parsed.find((p) => (p.choices as { finish_reason?: string }[] | undefined)?.some((c) => c.finish_reason)),
    usage_chunk: parsed.find((p) => p.usage),
  };
  log.in({ type: "raw sse summary", ...wire });
  console.log(`A raw: status=${res.status} ct=${wire.content_type} lines=${dataLines.length} last=${wire.last_line} eol=${wire.line_endings}`);
  console.log(`  first chunk: ${trunc(JSON.stringify(wire.first_chunk), 400)}`);
  console.log(`  tool chunk:  ${trunc(JSON.stringify((wire.tool_chunks_sample as unknown[])[0]), 400)}`);
  console.log(`  finish:      ${trunc(JSON.stringify(wire.finish_chunk), 300)}`);
  console.log(`  usage:       ${trunc(JSON.stringify(wire.usage_chunk), 400)}`);
}

// ---------------- B: SDK round trip ----------------
let roundTrip: Record<string, unknown> = {};
try {
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER_TOOL },
  ];
  const p1 = { model: MODELS.fast, messages, tools: chatTools, reasoning_effort: "none" as const, stream_options: { include_usage: true } };
  log.out({ type: "chat.completions.create(stream) r1", body: p1 });
  const r1 = await streamChat(oa, p1, { onChunk: (c, at) => log.in(c, { at_ms: at, round: 1 }) });
  messages.push({ role: "assistant", content: r1.text || null, tool_calls: r1.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) });
  for (const tc of r1.toolCalls) {
    const tool = TOOLS.find((t) => t.name === tc.name)!;
    const out = await tool.execute(JSON.parse(tc.arguments), { callId: tc.id });
    messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
  }
  const p2 = { ...p1, messages };
  log.out({ type: "chat.completions.create(stream) r2", body: p2 });
  const r2 = await streamChat(oa, p2, { onChunk: (c, at) => log.in(c, { at_ms: at, round: 2 }) });
  roundTrip = {
    r1: { finish_reason: r1.finishReason, tool_calls: r1.toolCalls, ttft_ms: r1.ttftMs, total_ms: r1.totalMs, chunks: r1.chunkCount, model: r1.model, usage: r1.usage },
    r2: { finish_reason: r2.finishReason, text: r2.text, ttft_ms: r2.ttftMs, total_ms: r2.totalMs, chunks: r2.chunkCount, usage: r2.usage },
    ok: r1.finishReason === "tool_calls" && r1.toolCalls.length === 2 && r2.finishReason === "stop" && /500/.test(r2.text) && /friday/i.test(r2.text),
  };
  console.log(`B round trip: r1 finish=${r1.finishReason} calls=${r1.toolCalls.map((t) => `${t.name}(${t.arguments})`).join(", ")} ttft=${r1.ttftMs}ms | r2 finish=${r2.finishReason} ttft=${r2.ttftMs}ms -> ${trunc(r2.text, 160)}`);
} catch (e) {
  roundTrip = { ok: false, error: errInfo(e) };
  console.log(`B ERROR ${JSON.stringify(errInfo(e))}`);
}
log.note("round trip", roundTrip);

// ---------------- C: TTFT with tools present, candidate BYO models ----------------
const CANDIDATES: { model: string; effort?: "none" | "low" }[] = [
  { model: MODELS.fast }, // what the Voice Agent gets if it sends no reasoning_effort (default = medium)
  { model: MODELS.fast, effort: "none" },
  { model: "gpt-5.6-luna" },
  { model: "gpt-5.6-luna", effort: "none" },
  { model: "gpt-5.6-terra", effort: "none" },
  { model: "gpt-4.1-mini" },
];
const latency: Record<string, unknown>[] = [];
for (const c of CANDIDATES) {
  const label = `${c.model}/${c.effort ?? "default"}`;
  const ttft: number[] = [];
  const total: number[] = [];
  let reasoningTokens: number[] = [];
  let sample = "";
  let err: unknown;
  for (let rep = 0; rep < 3; rep++) {
    try {
      const r = await streamChat(oa, {
        model: c.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: USER_CHAT },
        ],
        tools: chatTools,
        stream_options: { include_usage: true },
        ...(c.effort ? { reasoning_effort: c.effort } : {}),
      });
      if (r.ttftMs !== null) ttft.push(r.ttftMs);
      total.push(r.totalMs);
      reasoningTokens.push(r.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
      sample = r.text;
    } catch (e) {
      err = errInfo(e);
    }
  }
  const row = { label, ttft_ms: stats(ttft), total_ms: stats(total), reasoning_tokens: reasoningTokens, sample: trunc(sample, 160), ...(err ? { error: err } : {}) };
  latency.push(row);
  log.note("latency", row);
  console.log(`C ${label.padEnd(22)} TTFT median ${row.ttft_ms?.median}ms (min ${row.ttft_ms?.min}, max ${row.ttft_ms?.max}) total ${row.total_ms?.median}ms reasoning=${reasoningTokens.join("/")}${err ? ` ERR ${JSON.stringify(err)}` : ""}`);
  reasoningTokens = [];
}

// ---------------- D: generic-client params while streaming ----------------
const generic: Record<string, unknown>[] = [];
const GENERIC_CASES: { name: string; extra: Record<string, unknown> }[] = [
  { name: "temperature=0.7", extra: { temperature: 0.7 } },
  { name: "temperature=1", extra: { temperature: 1 } },
  { name: "max_tokens=256", extra: { max_tokens: 256 } },
  { name: "max_completion_tokens=256", extra: { max_completion_tokens: 256 } },
  { name: "top_p=0.9", extra: { top_p: 0.9 } },
  { name: "parallel_tool_calls=false", extra: { parallel_tool_calls: false } },
  { name: "tool_choice=auto + user", extra: { tool_choice: "auto", user: "va-session-123" } },
];
for (const model of [MODELS.fast, "gpt-4.1-mini"]) {
  for (const gc of GENERIC_CASES) {
    try {
      const r = await streamChat(oa, { model, messages: [{ role: "user", content: "Say OK." }], tools: chatTools, ...gc.extra } as Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "stream">);
      generic.push({ model, case: gc.name, ok: true, finish: r.finishReason });
    } catch (e) {
      const ei = errInfo(e);
      generic.push({ model, case: gc.name, ok: false, status: ei.status, code: ei.code, param: ei.param, message: trunc(ei.message, 200) });
    }
    const g = generic.at(-1)!;
    console.log(`D ${model.padEnd(14)} ${gc.name.padEnd(26)} ${g.ok ? "accepted" : `REJECTED ${g.status} ${g.code ?? ""} ${g.message}`}`);
  }
}
log.note("generic params", { generic });

const byoOk = wire.status === 200 && roundTrip.ok === true;
log.result(byoOk ? "PASS" : "PARTIAL", {
  cites: ["C9 (OpenAI side only: streamed chat.completions + tools works on api.openai.com for gpt-6-luna; AssemblyAI side still needs T6)"],
  request_shape: "POST https://api.openai.com/v1/chat/completions {model, messages, tools:[{type:'function',function:{name,description,parameters,strict}}], stream:true, stream_options:{include_usage:true}, reasoning_effort}",
  wire: { status: wire.status, content_type: wire.content_type, line_endings: wire.line_endings, last_line: wire.last_line, first_chunk: wire.first_chunk, finish_chunk: wire.finish_chunk, usage_chunk: wire.usage_chunk },
  round_trip: roundTrip,
  latency,
  generic,
});
log.close();
