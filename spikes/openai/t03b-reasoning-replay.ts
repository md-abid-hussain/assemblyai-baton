/**
 * t03b - stateless (store:false) tool round trip when round 1 DOES emit a reasoning item.
 *   D1: replay the reasoning item WITHOUT include:["reasoning.encrypted_content"]  (expected to fail?)
 *   D2: replay WITH include:["reasoning.encrypted_content"]                        (expected to work)
 *   D3: drop the reasoning item and replay only function_call + output             (does that work?)
 * Out: out/openai-t03b-reasoning-replay.jsonl
 */
import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { createLogger } from "../lib/log.ts";
import { MODELS, toResponsesTool } from "./client.ts";
import { errInfo, header, oa, trunc } from "./common.ts";
import { getClaimStatus, lookupPolicy } from "./t03-tools-defs.ts";

const log = createLogger("openai-t03b-reasoning-replay");
header(log, "t03b-reasoning-replay");

const TOOLS = [lookupPolicy, getClaimStatus];
const INSTRUCTIONS = "You are a claims assistant. Always use tools for policy and claim facts. Answer in two short sentences.";
const USER =
  "I have two reference numbers written down, H P 7 7 4 0 3 9 1 and C L 4 4 8 1 2, but I don't remember which one is my policy and which is my claim. Work it out, then tell me if my policy is active and when the appraiser will call.";

type Variant = "D1 without include" | "D2 with include" | "D3 drop reasoning item";
const out: Record<string, unknown>[] = [];

async function attempt(variant: Variant, model: string) {
  const include = variant === "D2 with include" ? (["reasoning.encrypted_content"] as OpenAI.Responses.ResponseIncludable[]) : undefined;
  const base = { model, instructions: INSTRUCTIONS, tools: TOOLS.map(toResponsesTool), store: false, reasoning: { effort: "xhigh" as const }, ...(include ? { include } : {}) };
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: USER }];
  const r1 = await oa.responses.create({ ...base, input });
  log.in({ type: "responses.response", variant, round: 1, response: r1 });
  const reasoningItems = r1.output.filter((o) => o.type === "reasoning");
  const items = toResponseInputItems(r1.output);
  input.push(...(variant === "D3 drop reasoning item" ? items.filter((i) => (i as { type?: string }).type !== "reasoning") : items));
  for (const item of r1.output) {
    if (item.type !== "function_call") continue;
    const tool = TOOLS.find((t) => t.name === item.name)!;
    input.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(await tool.execute(JSON.parse(item.arguments), { callId: item.call_id })) });
  }
  const r1Info = {
    output_types: r1.output.map((o) => o.type),
    reasoning_tokens: r1.usage?.output_tokens_details?.reasoning_tokens,
    reasoning_item: reasoningItems[0] ? { ...reasoningItems[0], encrypted_content: reasoningItems[0].encrypted_content ? `<${reasoningItems[0].encrypted_content.length} chars>` : reasoningItems[0].encrypted_content } : null,
  };
  if (!reasoningItems.length) return { variant, model, skipped: true, reason: "no reasoning item in round 1", r1: r1Info };
  if (!r1.output.some((o) => o.type === "function_call")) return { variant, model, skipped: true, reason: "no function call in round 1", r1: r1Info };
  log.out({ type: "responses.create", variant, round: 2, body: { ...base, input } });
  try {
    const r2 = await oa.responses.create({ ...base, input });
    log.in({ type: "responses.response", variant, round: 2, response: r2 });
    return { variant, model, round2: "accepted", r1: r1Info, final_text: r2.output_text };
  } catch (e) {
    log.in({ type: "responses.error", variant, round: 2, error: errInfo(e) });
    return { variant, model, round2: "rejected", r1: r1Info, error: errInfo(e) };
  }
}

for (const variant of ["D1 without include", "D2 with include", "D3 drop reasoning item"] as Variant[]) {
  let res: Record<string, unknown> = {};
  for (const model of [MODELS.fast, MODELS.balanced]) {
    try {
      res = await attempt(variant, model);
    } catch (e) {
      res = { variant, model, error: errInfo(e) };
    }
    if (!res.skipped) break;
  }
  out.push(res);
  log.note("variant result", res);
  console.log(`${variant}: ${res.skipped ? `SKIPPED (${res.reason})` : res.round2 ?? "error"} model=${res.model} r1=${JSON.stringify(res.r1)} ${res.error ? JSON.stringify(res.error) : trunc(res.final_text as string, 140)}`);
}

const d1 = out[0] ?? {};
const d2 = out[1] ?? {};
const tested = !d1.skipped && !d2.skipped;
log.result(tested ? "PASS" : "PARTIAL", { finding: { d1: d1.round2 ?? d1.error, d2: d2.round2 ?? d2.error, d3: out[2]?.round2 ?? out[2]?.error }, out });
log.close();
