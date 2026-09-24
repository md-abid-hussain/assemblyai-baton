/**
 * gateway/access.ts - C10: which Gateway models can this account actually call?
 * One tiny request per model from out/gateway_models.json (max_tokens 16). Denied calls are free.
 * Records status, error body and the per-model x-ratelimit-* headers.
 *
 *   npx tsx gateway/access.ts          -> out/gateway-access.jsonl, out/gateway-access.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY, OUT_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { loggingFetch } from "../async/http-log.ts";
import { GATEWAY_BASE_US, type GatewayModel } from "./client.ts";

const log = createLogger("gateway-access");
const lf = loggingFetch(log);
const catalog = JSON.parse(readFileSync(resolve(OUT_DIR, "gateway_models.json"), "utf8")) as { raw: { data: GatewayModel[] } };
const rows: Array<Record<string, unknown>> = [];

for (const m of catalog.raw.data) {
  const t0 = performance.now();
  const res = await lf(`${GATEWAY_BASE_US}/chat/completions`, {
    method: "POST",
    headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "Say hi." }], max_tokens: 16 }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  const b = body as { metadata?: { errors?: string[] }; message?: string; error?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  rows.push({
    model: m.id,
    creator: m.creator,
    provider: (m.default_provider as { id?: string } | undefined)?.id,
    status: res.status,
    ms: Math.round(performance.now() - t0),
    error: res.ok ? null : (b?.metadata?.errors?.join("; ") ?? b?.message ?? b?.error ?? text.slice(0, 200)),
    finish_reason: b?.choices?.[0]?.finish_reason ?? null,
    content: b?.choices?.[0]?.message?.content?.slice(0, 40) ?? null,
    rate_limit: res.headers.get("x-ratelimit-limit"),
    rate_remaining: res.headers.get("x-ratelimit-remaining"),
    rate_reset: res.headers.get("x-ratelimit-reset"),
  });
}

const accessible = rows.filter((r) => r.status === 200).map((r) => r.model);
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
const errors = [...new Set(rows.filter((r) => r.status !== 200).map((r) => `${r.status}: ${r.error}`))];
writeFileSync(resolve(OUT_DIR, "gateway-access.json"), JSON.stringify({ at: new Date().toISOString(), accessible, byStatus, errors, rows }, null, 2));
log.result(accessible.length > 0 ? "PARTIAL" : "FAIL", { claims: ["C10", "T7"], accessible, byStatus, errors });
log.close();
console.log(JSON.stringify({ accessible, byStatus, errors }, null, 1));
for (const r of rows) console.log([r.model, r.status, r.ms, r.rate_limit ?? "", r.error ?? r.content].join(" | "));
