/**
 * t07b - follow-up to t07: on /v1/chat/completions, which models accept function tools at their DEFAULT
 * reasoning effort (what a BYO caller that sends no reasoning_effort gets), which efforts work with tools,
 * the generic-param matrix re-run with reasoning_effort:"none", and the normalizeChatBodyForReasoningModel shim.
 * Out: out/openai-t07b-chat-tools-effort.jsonl
 */
import type OpenAI from "openai";
import { createLogger } from "../lib/log.ts";
import { MODELS, normalizeChatBodyForReasoningModel, streamChat, toChatTool } from "./client.ts";
import { errInfo, header, oa, trunc } from "./common.ts";
import { getClaimStatus, lookupPolicy } from "./t03-tools-defs.ts";

const log = createLogger("openai-t07b-chat-tools-effort");
header(log, "t07b-chat-tools-effort");
const chatTools = [lookupPolicy, getClaimStatus].map(toChatTool);
type Body = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "stream">;
const rows: Record<string, unknown>[] = [];

async function probe(group: string, name: string, body: Record<string, unknown>) {
  log.out({ type: "chat.completions.create(stream)", group, name, body });
  try {
    const r = await streamChat(oa, body as Body);
    rows.push({ group, name, model: body.model, ok: true, finish: r.finishReason, ttft_ms: r.ttftMs, tool_calls: r.toolCalls.map((t) => t.name), text: trunc(r.text, 80) });
  } catch (e) {
    const ei = errInfo(e);
    rows.push({ group, name, model: body.model, ok: false, status: ei.status, code: ei.code, param: ei.param, message: trunc(ei.message, 220) });
  }
  const r = rows.at(-1)!;
  log.in({ type: "probe", ...r });
  console.log(`${group.padEnd(8)} ${String(body.model).padEnd(14)} ${name.padEnd(40)} ${r.ok ? `ok finish=${r.finish} ttft=${r.ttft_ms}ms` : `REJECTED ${r.status} ${r.param ?? ""}: ${r.message}`}`);
}

const msgs = (content: string) => [{ role: "user", content }];

// 1) tools at default effort, per model
for (const model of [MODELS.fast, MODELS.balanced, MODELS.reasoning, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"])
  await probe("default", "tools, no reasoning_effort", { model, messages: msgs("Say OK."), tools: chatTools });

// 2) which efforts work with tools (luna, sol)
for (const model of [MODELS.fast, MODELS.balanced])
  for (const eff of ["none", "low", "high"]) await probe("effort", `tools, reasoning_effort=${eff}`, { model, messages: msgs("Say OK."), tools: chatTools, reasoning_effort: eff });
await probe("effort", "tools, reasoning_effort=low", { model: MODELS.reasoning, messages: msgs("Say OK."), tools: chatTools, reasoning_effort: "low" });
// no tools at default effort (control)
await probe("control", "NO tools, no reasoning_effort", { model: MODELS.fast, messages: msgs("Say OK.") });

// 3) generic params with effort none (gpt-6-luna)
for (const [name, extra] of [
  ["temperature=0.7", { temperature: 0.7 }],
  ["max_tokens=256", { max_tokens: 256 }],
  ["max_completion_tokens=256", { max_completion_tokens: 256 }],
  ["top_p=0.9", { top_p: 0.9 }],
  ["parallel_tool_calls=false", { parallel_tool_calls: false }],
  ["tool_choice=auto + user", { tool_choice: "auto", user: "va-session-123" }],
] as const)
  await probe("generic", `effort=none + ${name}`, { model: MODELS.fast, messages: msgs("Say OK."), tools: chatTools, reasoning_effort: "none", ...extra });

// 4) shim: a "generic OpenAI client" body -> normalize -> accepted?
const genericBody = { model: MODELS.fast, messages: msgs("My claim is C L 4 4 8 1 2. When will the appraiser call?"), tools: chatTools, temperature: 0.7, max_tokens: 256, stream_options: { include_usage: true } };
await probe("shim", "generic body AS-IS", genericBody);
const normalized = normalizeChatBodyForReasoningModel(genericBody);
log.note("shim normalized body", { before: genericBody, after: normalized });
await probe("shim", "generic body NORMALIZED", normalized);

const defaultRows = rows.filter((r) => r.group === "default");
log.result("PASS", {
  finding: {
    tools_at_default_effort_rejected: defaultRows.filter((r) => !r.ok).map((r) => r.model),
    tools_at_default_effort_ok: defaultRows.filter((r) => r.ok).map((r) => r.model),
    shim_ok: rows.find((r) => r.name === "generic body NORMALIZED")?.ok,
  },
  rows,
});
log.close();
