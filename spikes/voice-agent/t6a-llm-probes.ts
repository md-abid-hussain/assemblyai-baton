/**
 * T6a / T7 / C9 / C10 - direct probes before wiring an LLM into the Voice Agent:
 *   - GET  https://llm-gateway.assemblyai.com/v1/models  (catalog; pick OpenAI + Claude ids)
 *   - POST https://llm-gateway.assemblyai.com/v1/chat/completions stream:true for an OpenAI and a Claude model
 *     (is streaming OpenAI-only? does the account have Gateway access/billing?)
 *   - POST https://api.openai.com/v1/chat/completions stream:true (direct OpenAI TTFT baseline)
 * Tiny max_tokens; costs fractions of a cent.
 *
 *   npx tsx voice-agent/t6a-llm-probes.ts
 * Log: spikes/out/va-t6a-llm-probes.jsonl
 */
import { ASSEMBLYAI_API_KEY, OPENAI_API_KEY } from "../lib/env.ts";
import { loggedFetch } from "../lib/log.ts";
import { LLM_GATEWAY_BASE } from "./client.ts";
import { brief, vaLogger } from "./harness.ts";

const log = vaLogger("t6a-llm-probes");
const out: Record<string, unknown> = {};

async function streamProbe(label: string, url: string, auth: string, model: string, extra: Record<string, unknown> = {}) {
  const body = { model, stream: true, max_tokens: 12, messages: [{ role: "user", content: "Reply with the single word: ready" }], ...extra };
  log.event("http", { phase: "request", label, url, body });
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    const r = { label, model, error: String(e) };
    log.event("http", { phase: "response", ...r });
    return r;
  }
  const ct = res.headers.get("content-type") ?? "";
  let firstChunkMs: number | null = null;
  let firstContentMs: number | null = null;
  let text = "";
  let raw = "";
  let chunks = 0;
  if (res.body && res.ok) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      raw += s;
      if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - t0);
      for (const line of s.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d) as { choices?: { delta?: { content?: string } }[] };
          chunks++;
          const c = j.choices?.[0]?.delta?.content;
          if (c) {
            if (firstContentMs === null) firstContentMs = Math.round(performance.now() - t0);
            text += c;
          }
        } catch {
          /* partial line */
        }
      }
    }
  } else {
    raw = await res.text();
  }
  const r = { label, model, status: res.status, contentType: ct, firstChunkMs, firstContentMs, totalMs: Math.round(performance.now() - t0), sseChunks: chunks, text, rawStart: raw.slice(0, 600) };
  log.event("http", { phase: "response", ...r });
  console.log(label, brief(r, 700));
  return r;
}

async function main() {
  const models = await loggedFetch<{ data?: { id: string; owned_by?: string; supported_parameters?: string[]; available_regions?: string[] }[] }>(log, `${LLM_GATEWAY_BASE}/models`, {
    headers: { Authorization: ASSEMBLYAI_API_KEY },
    label: "gateway models",
  });
  const ids = (models.json?.data ?? []).map((m) => m.id);
  out.gatewayModelsStatus = models.status;
  out.gatewayModelIds = ids;
  const streamable = (models.json?.data ?? []).filter((m) => m.supported_parameters?.includes("stream")).map((m) => m.id);
  out.gatewayStreamableIds = streamable;
  console.log("gateway models:", models.status, ids.length, ids.join(", "));

  const pick = (cands: string[]) => cands.find((c) => ids.includes(c));
  const gwOpenAI = pick(["gpt-4.1-mini", "gpt-5-mini", "gpt-4.1", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5"]) ?? "gpt-4.1-mini";
  const gwClaude = pick(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"]) ?? "claude-haiku-4-5-20251001";
  out.picked = { gwOpenAI, gwClaude };

  out.gatewayOpenAI = await streamProbe("gateway stream openai", `${LLM_GATEWAY_BASE}/chat/completions`, ASSEMBLYAI_API_KEY, gwOpenAI);
  out.gatewayClaude = await streamProbe("gateway stream claude", `${LLM_GATEWAY_BASE}/chat/completions`, ASSEMBLYAI_API_KEY, gwClaude);
  out.gatewayClaudeBearer = await streamProbe("gateway stream claude (Bearer auth)", `${LLM_GATEWAY_BASE}/chat/completions`, `Bearer ${ASSEMBLYAI_API_KEY}`, gwClaude);
  out.openaiDirect41mini = await streamProbe("openai direct gpt-4.1-mini", "https://api.openai.com/v1/chat/completions", `Bearer ${OPENAI_API_KEY}`, "gpt-4.1-mini");
  out.openaiDirectLuna = await streamProbe("openai direct gpt-5.6-luna", "https://api.openai.com/v1/chat/completions", `Bearer ${OPENAI_API_KEY}`, "gpt-5.6-luna", { max_tokens: undefined, max_completion_tokens: 200 });

  log.result("PASS", out);
  log.close();
  console.log("picked:", out.picked);
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
