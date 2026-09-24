/**
 * t03 - Responses API function calling with 2 tools and a tool-result round trip.
 *   A: gpt-6-luna, replay history, store:false + include reasoning.encrypted_content (stateless)
 *   B: gpt-6-luna, previous_response_id (store:true)
 *   C: gpt-6-sol,  replay history, store:false
 *   D: negative - store:false replay WITHOUT include encrypted_content (does replaying reasoning items break?)
 *   E: forced tool_choice {type:"function", name} on luna
 * Out: out/openai-t03-tools.jsonl
 */
import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { createLogger } from "../lib/log.ts";
import { MODELS, runToolLoop, toResponsesTool, type ReasoningEffort, type ToolLoopResult } from "./client.ts";
import { errInfo, header, oa, trunc } from "./common.ts";
import { getClaimStatus, lookupPolicy } from "./t03-tools-defs.ts";

const log = createLogger("openai-t03-tools");
header(log, "t03-tools");

// ---- two tools with deterministic fake backends (t03-tools-defs.ts) ----
const TOOLS = [lookupPolicy, getClaimStatus];
const INSTRUCTIONS = "You are a claims assistant for Harbor Point. Always use tools for policy and claim facts; never answer from memory. Answer in at most two short sentences suitable for reading aloud.";
const USER = "This is Priya Shah. My policy is H P 7 7 4 0 3 9 1 and my claim number is C L 4 4 8 1 2. Is my policy active, what's my deductible, and when will the appraiser call me?";

function check(r: ToolLoopResult) {
  const names = new Set(r.toolCalls.map((c) => c.name));
  const args = r.toolCalls.map((c) => c.arguments).join(" ");
  return {
    both_tools_called: names.has("lookup_policy") && names.has("get_claim_status"),
    args_normalized: /HP7740391/.test(args) && /CL44812/.test(args),
    parallel_in_round1: r.toolCalls.filter((c) => c.round === 1).length >= 2,
    answer_has_500: /\$?500/.test(r.finalText),
    answer_has_friday_10: /friday/i.test(r.finalText) && /10/.test(r.finalText),
  };
}

const cases: { name: string; model: string; state: "replay" | "previous_response_id"; store: boolean; effort: ReasoningEffort }[] = [
  { name: "A luna replay store:false", model: MODELS.fast, state: "replay", store: false, effort: "low" },
  { name: "B luna previous_response_id", model: MODELS.fast, state: "previous_response_id", store: true, effort: "low" },
  { name: "C sol replay store:false", model: MODELS.balanced, state: "replay", store: false, effort: "low" },
];

const summary: Record<string, unknown>[] = [];
for (const c of cases) {
  try {
    const r = await runToolLoop(oa, { model: c.model, instructions: INSTRUCTIONS, input: USER, tools: TOOLS, state: c.state, store: c.store, reasoningEffort: c.effort, log });
    const chk = check(r);
    const row = {
      case: c.name,
      ok: Object.values(chk).slice(0, 2).every(Boolean) && chk.answer_has_500 && chk.answer_has_friday_10,
      checks: chk,
      rounds: r.rounds,
      round_ms: r.roundMs,
      tool_calls: r.toolCalls.map((t) => ({ round: t.round, name: t.name, arguments: t.arguments, call_id: t.call_id })),
      round1_output_types: r.responses[0]?.output.map((o) => o.type),
      round1_function_call_item: r.responses[0]?.output.find((o) => o.type === "function_call"),
      final_text: r.finalText,
      usage: r.usage,
    };
    summary.push(row);
    log.note("case result", row);
    console.log(`${c.name.padEnd(30)} rounds=${r.rounds} ms=${r.roundMs.join("+")} calls=${r.toolCalls.map((t) => `${t.name}(${t.arguments})`).join(", ")}\n    -> ${trunc(r.finalText, 200)}\n    checks=${JSON.stringify(chk)}`);
  } catch (e) {
    summary.push({ case: c.name, ok: false, error: errInfo(e) });
    log.error(e, { case: c.name });
    console.log(`${c.name} ERROR ${JSON.stringify(errInfo(e))}`);
  }
}

// ---- D: negative - replay reasoning items with store:false but WITHOUT encrypted content ----
{
  const name = "D luna replay store:false WITHOUT include";
  try {
    const tools = TOOLS.map(toResponsesTool);
    const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: USER }];
    const body1 = { model: MODELS.fast, instructions: INSTRUCTIONS, tools, input, store: false, reasoning: { effort: "high" as const } };
    log.out({ type: "responses.create", case: name, round: 1, body: body1 });
    const r1 = await oa.responses.create(body1);
    log.in({ type: "responses.response", case: name, round: 1, response: r1 });
    const types = r1.output.map((o) => o.type);
    input.push(...toResponseInputItems(r1.output));
    for (const item of r1.output) {
      if (item.type !== "function_call") continue;
      const tool = TOOLS.find((t) => t.name === item.name)!;
      input.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(await tool.execute(JSON.parse(item.arguments), { callId: item.call_id })) });
    }
    const body2 = { ...body1, input };
    log.out({ type: "responses.create", case: name, round: 2, body: body2 });
    try {
      const r2 = await oa.responses.create(body2);
      log.in({ type: "responses.response", case: name, round: 2, response: r2 });
      summary.push({ case: name, ok: true, round1_output_types: types, note: "server accepted replayed reasoning items without encrypted_content", final_text: r2.output_text });
      console.log(`${name}: round1 types=${types.join(",")} -> round2 ACCEPTED: ${trunc(r2.output_text, 120)}`);
    } catch (e) {
      summary.push({ case: name, ok: false, expected_failure: true, round1_output_types: types, error: errInfo(e) });
      log.in({ type: "responses.error", case: name, round: 2, error: errInfo(e) });
      console.log(`${name}: round1 types=${types.join(",")} -> round2 REJECTED ${JSON.stringify(errInfo(e))}`);
    }
  } catch (e) {
    summary.push({ case: name, ok: false, error: errInfo(e) });
    console.log(`${name} ERROR ${JSON.stringify(errInfo(e))}`);
  }
}

// ---- E: forced tool choice ----
{
  const name = "E luna tool_choice forced lookup_policy";
  try {
    const body = {
      model: MODELS.fast,
      instructions: INSTRUCTIONS,
      tools: TOOLS.map(toResponsesTool),
      input: USER,
      store: false,
      reasoning: { effort: "none" as const },
      tool_choice: { type: "function" as const, name: "lookup_policy" },
    };
    log.out({ type: "responses.create", case: name, body });
    const r = await oa.responses.create(body);
    log.in({ type: "responses.response", case: name, response: r });
    const calls = r.output.filter((o) => o.type === "function_call").map((o) => (o.type === "function_call" ? `${o.name}(${o.arguments})` : ""));
    summary.push({ case: name, ok: calls.length > 0 && calls.every((c) => c.startsWith("lookup_policy")), calls });
    console.log(`${name}: ${calls.join(", ")}`);
  } catch (e) {
    summary.push({ case: name, ok: false, error: errInfo(e) });
    console.log(`${name} ERROR ${JSON.stringify(errInfo(e))}`);
  }
}

const main = summary.filter((s) => String(s.case).match(/^[ABC] /));
log.result(main.every((s) => s.ok) ? "PASS" : main.some((s) => s.ok) ? "PARTIAL" : "FAIL", {
  request_shape: {
    tool: "{type:'function', name, description, parameters:{type:'object',additionalProperties:false,required:[...],properties}, strict:true}",
    round_trip_item: "{type:'function_call_output', call_id, output:'<JSON string>'}",
    stateless: "store:false + include:['reasoning.encrypted_content'] + replay toResponseInputItems(response.output)",
    stateful: "store:true + previous_response_id + only the function_call_output items (resend instructions)",
  },
  summary,
});
log.close();
