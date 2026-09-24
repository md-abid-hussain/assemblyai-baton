/**
 * t08 - OpenAI Agents SDK (@openai/agents 0.18.0, zod 4) smoke test, installed ONLY in this subfolder.
 *   A: minimal agent, one zod tool + structured outputType, non-streamed run (gpt-6-luna, effort low)
 *   B: same agent, streamed run - event types + text/tool events
 *   C: agent with NO model set -> which default model/API does the SDK use?
 * Out: out/openai-t08-agents.jsonl
 */
import { Agent, run, setDefaultOpenAIKey, setTracingDisabled, tool } from "@openai/agents";
import { z } from "zod";
import { OPENAI_API_KEY } from "../../lib/env.ts";
import { createLogger } from "../../lib/log.ts";

const log = createLogger("openai-t08-agents");
log.note("start", { test: "t08-agents-sdk", node: process.version });

setDefaultOpenAIKey(OPENAI_API_KEY);
setTracingDisabled(true); // default would export traces to OpenAI's tracing endpoint

const toolCalls: { name: string; args: unknown; at: number }[] = [];
const t0 = performance.now();
const lookupPolicy = tool({
  name: "lookup_policy",
  description: "Look up an insurance policy by policy number. Returns status and deductible.",
  parameters: z.object({ policy_number: z.string().describe("Uppercase, no spaces, e.g. HP1234567") }),
  execute: async ({ policy_number }) => {
    toolCalls.push({ name: "lookup_policy", args: { policy_number }, at: Math.round(performance.now() - t0) });
    return policy_number.replace(/\s+/g, "").toUpperCase() === "HP7740391"
      ? { policy_number: "HP7740391", holder: "Priya Shah", status: "active", deductible_usd: 500 }
      : { error: "policy not found" };
  },
});

const PolicySummary = z.object({
  policy_number: z.string(),
  policy_active: z.boolean(),
  deductible_usd: z.number(),
  spoken_reply: z.string().describe("One short sentence to read to the caller"),
});

const agent = new Agent({
  name: "Claims policy checker",
  instructions: "You check insurance policies. Always call lookup_policy; never answer from memory.",
  model: "gpt-6-luna",
  modelSettings: { reasoning: { effort: "low" }, store: false },
  tools: [lookupPolicy],
  outputType: PolicySummary,
});

const INPUT = "This is Priya Shah, policy H P 7 7 4 0 3 9 1. Is it active and what's my deductible?";
const results: Record<string, Record<string, unknown>> = {};

// A: non-streamed
try {
  const ta = performance.now();
  const r = await run(agent, INPUT);
  const ms = Math.round(performance.now() - ta);
  const parsed = PolicySummary.safeParse(r.finalOutput);
  results.A = {
    ok: parsed.success && r.finalOutput?.policy_number === "HP7740391" && r.finalOutput.deductible_usd === 500 && toolCalls.length >= 1,
    ms,
    final_output: r.finalOutput,
    new_item_types: r.newItems.map((i) => i.type),
    raw_responses: r.rawResponses.length,
    usage: r.rawResponses.map((x) => x.usage),
    tool_calls: [...toolCalls],
    last_agent: r.lastAgent?.name,
  };
  log.in({ type: "run.result", ...results.A });
  console.log(`A non-stream: ${ms}ms ok=${(results.A as { ok: boolean }).ok} final=${JSON.stringify(r.finalOutput)} items=${r.newItems.map((i) => i.type).join(",")}`);
} catch (e) {
  results.A = { ok: false, error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 500) } : String(e) };
  log.error(e, { case: "A" });
  console.log("A ERROR", results.A);
}

// B: streamed
try {
  toolCalls.length = 0;
  const tb = performance.now();
  const s = await run(agent, INPUT, { stream: true });
  const counts: Record<string, number> = {};
  const firsts: string[] = [];
  let firstTextMs: number | null = null;
  for await (const ev of s) {
    const key = ev.type === "raw_model_stream_event" ? `raw:${(ev.data as { type?: string }).type}` : ev.type === "run_item_stream_event" ? `item:${ev.name}` : ev.type;
    counts[key] = (counts[key] ?? 0) + 1;
    if (firsts.length < 14 && !firsts.includes(key)) firsts.push(key);
    if (firstTextMs === null && ev.type === "raw_model_stream_event" && (ev.data as { type?: string }).type === "output_text_delta") firstTextMs = Math.round(performance.now() - tb);
  }
  await s.completed;
  const ms = Math.round(performance.now() - tb);
  results.B = { ok: !!s.finalOutput && s.finalOutput.deductible_usd === 500, ms, first_text_delta_ms: firstTextMs, event_counts: counts, first_event_kinds: firsts, final_output: s.finalOutput, tool_calls: [...toolCalls] };
  log.in({ type: "run.stream.result", ...results.B });
  console.log(`B stream: ${ms}ms firstText=${firstTextMs}ms counts=${JSON.stringify(counts)}`);
} catch (e) {
  results.B = { ok: false, error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 500) } : String(e) };
  log.error(e, { case: "B" });
  console.log("B ERROR", results.B);
}

// C: no model set -> SDK default
try {
  const plain = new Agent({ name: "Default-model agent", instructions: "Reply with the single word OK." });
  const r = await run(plain, "Go.");
  const raw = r.rawResponses[0] as unknown as { providerData?: Record<string, unknown>; responseId?: string };
  results.C = { final_output: r.finalOutput, agent_model_field: plain.model, provider_model: raw?.providerData?.model, response_id: raw?.responseId, raw_keys: Object.keys(raw ?? {}), provider_keys: Object.keys(raw?.providerData ?? {}).slice(0, 20) };
  log.in({ type: "default-model.result", ...results.C });
  console.log(`C default model: agent.model=${JSON.stringify(plain.model)} provider model=${String(raw?.providerData?.model)} response_id=${raw?.responseId}`);
} catch (e) {
  results.C = { error: e instanceof Error ? { name: e.name, message: e.message.slice(0, 500) } : String(e) };
  console.log("C ERROR", results.C);
}

const ok = (results.A as { ok?: boolean })?.ok && (results.B as { ok?: boolean })?.ok;
log.result(ok ? "PASS" : "PARTIAL", {
  install: { dir: "spikes/openai/agents-sdk", packages: { "@openai/agents": "0.18.0", zod: "4.6.5", openai: "7.23.0 (nested, same as root)" }, added_packages: 25, seconds: 22.8 },
  results,
});
log.close();
