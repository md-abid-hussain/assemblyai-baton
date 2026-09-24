/**
 * t04 - which parameter names/values are accepted, per model and per API (Responses vs Chat Completions).
 * Tiny prompts, max_output_tokens capped, so the whole matrix costs well under $0.05.
 * Out: out/openai-t04-params.jsonl
 */
import type OpenAI from "openai";
import { createLogger } from "../lib/log.ts";
import { MODELS } from "./client.ts";
import { errInfo, header, oa, trunc, type ErrInfo } from "./common.ts";

const log = createLogger("openai-t04-params");
header(log, "t04-param-probe");

const PROMPT = "Reply with the single word OK.";

interface ProbeRow {
  api: "responses" | "chat";
  case: string;
  model: string;
  ok: boolean;
  ms: number;
  status?: string | null | undefined;
  text?: string;
  usage?: unknown;
  error?: ErrInfo;
  headers?: Record<string, string | null>;
}
const rows: ProbeRow[] = [];

async function probeResponses(caseName: string, model: string, extra: Record<string, unknown>): Promise<ProbeRow> {
  const body = { model, input: PROMPT, max_output_tokens: 64, store: false, ...extra } as OpenAI.Responses.ResponseCreateParamsNonStreaming;
  log.out({ type: "responses.create", case: caseName, body });
  const t0 = performance.now();
  let row: ProbeRow;
  try {
    const { data, response } = await oa.responses.create(body).withResponse();
    row = {
      api: "responses",
      case: caseName,
      model,
      ok: true,
      ms: Math.round(performance.now() - t0),
      status: data.status,
      text: trunc(data.output_text, 60),
      usage: data.usage,
      headers: { "openai-processing-ms": response.headers.get("openai-processing-ms"), "x-request-id": response.headers.get("x-request-id") },
    };
    log.in({ type: "responses.response", case: caseName, row, response: { id: data.id, model: data.model, status: data.status, incomplete_details: data.incomplete_details, reasoning: data.reasoning, text: data.text, service_tier: data.service_tier, temperature: data.temperature, top_p: data.top_p, output_types: data.output.map((o) => o.type) } });
  } catch (e) {
    row = { api: "responses", case: caseName, model, ok: false, ms: Math.round(performance.now() - t0), error: errInfo(e) };
    log.in({ type: "responses.error", case: caseName, error: row.error });
  }
  rows.push(row);
  console.log(`${row.ok ? "OK  " : "ERR "} responses ${model.padEnd(12)} ${caseName.padEnd(38)} ${row.ms}ms ${row.ok ? `${row.status} "${row.text}"` : `${row.error?.status} ${row.error?.code ?? ""} ${trunc(row.error?.message, 140)}`}`);
  return row;
}

async function probeChat(caseName: string, model: string, extra: Record<string, unknown>): Promise<ProbeRow> {
  const body = { model, messages: [{ role: "user", content: PROMPT }], ...extra } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  log.out({ type: "chat.completions.create", case: caseName, body });
  const t0 = performance.now();
  let row: ProbeRow;
  try {
    const { data, response } = await oa.chat.completions.create(body).withResponse();
    row = {
      api: "chat",
      case: caseName,
      model,
      ok: true,
      ms: Math.round(performance.now() - t0),
      status: data.choices[0]?.finish_reason,
      text: trunc(data.choices[0]?.message.content, 60),
      usage: data.usage,
      headers: { "openai-processing-ms": response.headers.get("openai-processing-ms"), "x-request-id": response.headers.get("x-request-id") },
    };
    log.in({ type: "chat.completion", case: caseName, row, response: { id: data.id, model: data.model, service_tier: data.service_tier, choices: data.choices } });
  } catch (e) {
    row = { api: "chat", case: caseName, model, ok: false, ms: Math.round(performance.now() - t0), error: errInfo(e) };
    log.in({ type: "chat.error", case: caseName, error: row.error });
  }
  rows.push(row);
  console.log(`${row.ok ? "OK  " : "ERR "} chat      ${model.padEnd(12)} ${caseName.padEnd(38)} ${row.ms}ms ${row.ok ? `${row.status} "${row.text}"` : `${row.error?.status} ${row.error?.code ?? ""} ${trunc(row.error?.message, 140)}`}`);
  return row;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const { fast, balanced, reasoning } = MODELS;

// ---------------- Responses API ----------------
await probeResponses("baseline (no reasoning param)", fast, {});
for (const e of EFFORTS) await probeResponses(`reasoning.effort=${e}`, fast, { reasoning: { effort: e } });
for (const e of ["none", "minimal", "low", "max"] as const) await probeResponses(`reasoning.effort=${e}`, balanced, { reasoning: { effort: e } });
for (const e of ["none", "minimal", "low", "max"] as const) await probeResponses(`reasoning.effort=${e}`, reasoning, { reasoning: { effort: e } });
await probeResponses("baseline (no reasoning param)", balanced, {});
await probeResponses("baseline (no reasoning param)", reasoning, {});
await probeResponses("temperature=0.2 (default effort)", fast, { temperature: 0.2 });
await probeResponses("temperature=0.2 + effort=none", fast, { temperature: 0.2, reasoning: { effort: "none" } });
await probeResponses("top_p=0.9 + effort=none", fast, { top_p: 0.9, reasoning: { effort: "none" } });
await probeResponses("temperature=0.2 + effort=none", reasoning, { temperature: 0.2, reasoning: { effort: "none" } });
await probeResponses("text.verbosity=low", fast, { text: { verbosity: "low" } });
await probeResponses("reasoning.summary=auto (effort=low)", fast, { reasoning: { effort: "low", summary: "auto" } });
await probeResponses("service_tier=fast", fast, { service_tier: "fast", reasoning: { effort: "none" } });
await probeResponses("service_tier=priority", fast, { service_tier: "priority", reasoning: { effort: "none" } });
await probeResponses("service_tier=flex", fast, { service_tier: "flex", reasoning: { effort: "none" } });
await probeResponses("max_output_tokens=8", fast, { max_output_tokens: 8, reasoning: { effort: "none" } });
await probeResponses("max_output_tokens=16", fast, { max_output_tokens: 16, reasoning: { effort: "none" } });
await probeResponses("prompt_cache_key", fast, { prompt_cache_key: "spike-t04", reasoning: { effort: "none" } });
await probeResponses("WRONG NAME max_tokens", fast, { max_tokens: 64 });
await probeResponses("WRONG NAME response_format (chat-style)", fast, { response_format: { type: "json_object" } });
await probeResponses("WRONG NAME reasoning_effort (chat-style)", fast, { reasoning_effort: "low" });
await probeResponses("text.format json_schema + pattern/format", fast, {
  reasoning: { effort: "none" },
  text: {
    format: {
      type: "json_schema",
      name: "ok_probe",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["word", "policy", "date"],
        properties: {
          word: { type: "string", enum: ["OK"] },
          policy: { type: "string", pattern: "^[A-Z]{2}[0-9]{7}$", description: "Use HP7740391" },
          date: { type: "string", format: "date", description: "Use 2026-09-15" },
        },
      },
    },
  },
});
await probeResponses("text.format strict WITHOUT additionalProperties:false", fast, {
  reasoning: { effort: "none" },
  text: { format: { type: "json_schema", name: "bad_probe", strict: true, schema: { type: "object", required: ["word"], properties: { word: { type: "string" } } } } },
});
await probeResponses("text.format strict with optional key (not in required)", fast, {
  reasoning: { effort: "none" },
  text: { format: { type: "json_schema", name: "bad_probe2", strict: true, schema: { type: "object", additionalProperties: false, required: ["word"], properties: { word: { type: "string" }, extra: { type: "string" } } } } },
});

// ---------------- Chat Completions ----------------
await probeChat("baseline (no reasoning param)", fast, { max_completion_tokens: 64 });
for (const e of ["none", "minimal", "low", "max"] as const) await probeChat(`reasoning_effort=${e}`, fast, { reasoning_effort: e, max_completion_tokens: 64 });
await probeChat("verbosity=low", fast, { verbosity: "low", max_completion_tokens: 64 });
await probeChat("legacy max_tokens=64", fast, { max_tokens: 64 });
await probeChat("legacy max_tokens=64 + effort=none", fast, { max_tokens: 64, reasoning_effort: "none" });
await probeChat("temperature=0.7 (default effort)", fast, { temperature: 0.7, max_completion_tokens: 64 });
await probeChat("temperature=0.7 + effort=none", fast, { temperature: 0.7, reasoning_effort: "none", max_completion_tokens: 64 });
await probeChat("WRONG NAME reasoning:{effort} (responses-style)", fast, { reasoning: { effort: "low" }, max_completion_tokens: 64 });
await probeChat("response_format json_schema strict", fast, {
  reasoning_effort: "none",
  max_completion_tokens: 64,
  response_format: { type: "json_schema", json_schema: { name: "ok_probe", strict: true, schema: { type: "object", additionalProperties: false, required: ["word"], properties: { word: { type: "string", enum: ["OK"] } } } } },
});
await probeChat("baseline", "gpt-5.6-luna", { max_completion_tokens: 64 });
await probeChat("temperature=0.7 (default effort)", "gpt-5.6-luna", { temperature: 0.7, max_completion_tokens: 64 });
await probeChat("baseline", "gpt-4.1-mini", { max_tokens: 64, temperature: 0.7 });

const summary = rows.map((r) => ({ api: r.api, model: r.model, case: r.case, ok: r.ok, ms: r.ms, status: r.status ?? null, err: r.error ? `${r.error.status} ${r.error.code ?? ""} ${r.error.param ?? ""}: ${trunc(r.error.message, 200)}` : null, usage: r.usage }));
log.result("PASS", { cases: rows.length, accepted: rows.filter((r) => r.ok).length, rejected: rows.filter((r) => !r.ok).length, summary });
log.close();
