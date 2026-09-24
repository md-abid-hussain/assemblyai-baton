/** T6a2 / C10 - which LLM Gateway models (if any) this account may call. Non-streaming, max_tokens 4. */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { loggedFetch } from "../lib/log.ts";
import { LLM_GATEWAY_BASE } from "./client.ts";
import { vaLogger } from "./harness.ts";

const log = vaLogger("t6a2-gateway-access");
const models = ["qwen3.5-4b-32k-fast", "gpt-oss-20b", "gemini-2.5-flash-lite", "gpt-5-nano", "claude-sonnet-4-6", "gpt-4.1"];
const res: Record<string, unknown> = {};
for (const model of models) {
  const r = await loggedFetch(log, `${LLM_GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "Say ok" }] }),
    label: model,
  });
  res[model] = { status: r.status, body: r.text.slice(0, 200) };
  console.log(model, r.status, r.text.slice(0, 160));
}
log.result("PASS", res);
log.close();
