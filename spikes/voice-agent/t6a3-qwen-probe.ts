/** T6a3 - why does qwen3.5-4b-32k-fast fail inside the Voice Agent? Direct Gateway calls: stream, tools, stream+tools. */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { LLM_GATEWAY_BASE } from "./client.ts";
import { LOOKUP_ORDER_TOOL } from "./core-loop-config.ts";
import { vaLogger } from "./harness.ts";

const log = vaLogger("t6a3-qwen-probe");
const tools = [{ type: "function", function: { name: LOOKUP_ORDER_TOOL.name, description: LOOKUP_ORDER_TOOL.description, parameters: LOOKUP_ORDER_TOOL.parameters } }];
const variants: [string, Record<string, unknown>][] = [
  ["stream", { stream: true }],
  ["tools (no stream)", { tools }],
  ["stream + tools", { stream: true, tools }],
  ["stream + temperature", { stream: true, temperature: 0.7 }],
];
const res: Record<string, unknown> = {};
for (const [name, extra] of variants) {
  const body = { model: "qwen3.5-4b-32k-fast", max_tokens: 40, messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "Where is order 481529?" }], ...extra };
  const t0 = performance.now();
  const r = await fetch(`${LLM_GATEWAY_BASE}/chat/completions`, { method: "POST", headers: { Authorization: ASSEMBLYAI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  const ms = Math.round(performance.now() - t0);
  res[name] = { status: r.status, ms, contentType: r.headers.get("content-type"), body: text.slice(0, 700) };
  log.event("http", { label: name, request: body, status: r.status, ms, response: text.slice(0, 2000) });
  console.log(name, r.status, ms, r.headers.get("content-type"), text.slice(0, 300).replace(/\n/g, "\n"));
}
log.result("PASS", res);
log.close();
