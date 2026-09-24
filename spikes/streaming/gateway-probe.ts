/** One-off: can this account call the LLM Gateway at all? (explains the silent in-stream llm_gateway result). Run from spikes/: npx tsx streaming/gateway-probe.ts */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { createLogger, loggedFetch } from "../lib/log.ts";
const log = createLogger("streaming-llm-http-probe2");
for (const model of ["gpt-5-nano", "gpt-4.1", "gemini-2.5-flash"]) {
  const r = await loggedFetch(log, "https://llm-gateway.assemblyai.com/v1/chat/completions", {
    label: model,
    method: "POST",
    headers: { Authorization: ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 5 }),
  });
  console.log(model, r.status, r.ms, r.text.slice(0, 600));
}
log.close();
