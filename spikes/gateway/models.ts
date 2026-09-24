/**
 * gateway/models.ts - T7/C26/C27: GET https://llm-gateway.assemblyai.com/v1/models (no auth, then with auth),
 * save the full catalog to out/gateway_models.json and print a compact capability table.
 *
 *   npx tsx gateway/models.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY, OUT_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { GATEWAY_BASE_EU, GATEWAY_BASE_US, type GatewayModel } from "./client.ts";
import { loggingFetch } from "../async/http-log.ts";

const log = createLogger("gateway-models");
const lf = loggingFetch(log);

async function get(url: string, auth: boolean): Promise<{ status: number; ms: number; body: unknown; headers: Record<string, string> }> {
  const t0 = performance.now();
  const res = await lf(url, { headers: auth ? { authorization: ASSEMBLYAI_API_KEY } : {}, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, ms: Math.round(performance.now() - t0), body, headers: Object.fromEntries(res.headers.entries()) };
}

const noAuth = await get(`${GATEWAY_BASE_US}/models`, false);
const withAuth = await get(`${GATEWAY_BASE_US}/models`, true);
const eu = await get(`${GATEWAY_BASE_EU}/models`, false);

const models = ((noAuth.body as { data?: GatewayModel[] })?.data ?? []) as GatewayModel[];
const modelsAuth = ((withAuth.body as { data?: GatewayModel[] })?.data ?? []) as GatewayModel[];
const modelsEu = ((eu.body as { data?: GatewayModel[] })?.data ?? []) as GatewayModel[];

writeFileSync(
  resolve(OUT_DIR, "gateway_models.json"),
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      url: `${GATEWAY_BASE_US}/models`,
      auth: "none (public endpoint)",
      status: noAuth.status,
      ms: noAuth.ms,
      count: models.length,
      eu_endpoint: { url: `${GATEWAY_BASE_EU}/models`, status: eu.status, count: modelsEu.length, ids: modelsEu.map((m) => m.id) },
      same_list_with_auth: JSON.stringify(models.map((m) => m.id).sort()) === JSON.stringify(modelsAuth.map((m) => m.id).sort()),
      raw: noAuth.body,
    },
    null,
    2,
  ),
);

const keysSeen = new Set<string>();
for (const m of models) for (const k of Object.keys(m)) keysSeen.add(k);
const regionCounts: Record<string, number> = {};
for (const m of models) {
  const key = (m.available_regions ?? []).slice().sort().join("+") || "<none>";
  regionCounts[key] = (regionCounts[key] ?? 0) + 1;
}
const table = models.map((m) => ({
  id: m.id,
  creator: m.creator,
  ctx: m.context_length,
  regions: (m.available_regions ?? []).join(","),
  params: (m.supported_parameters ?? []).join(","),
  price: m.pricing?.global ? `${m.pricing.global.prompt}/${m.pricing.global.completions}` : JSON.stringify(m.pricing),
  regional_increase: m.pricing?.regional_increase_percent,
  retire: m.retirement_date,
}));
log.note("summary", { count: models.length, count_auth: modelsAuth.length, count_eu: modelsEu.length, keysSeen: [...keysSeen], regionCounts });
log.note("table", { table });
log.result(noAuth.status === 200 && models.length > 0 ? "PASS" : "FAIL", {
  claims: ["T7 (catalog part)", "C26", "C27"],
  count: models.length,
  regionCounts,
  noAuthStatus: noAuth.status,
  withAuthStatus: withAuth.status,
  euStatus: eu.status,
  euCount: modelsEu.length,
});
log.close();

console.log(JSON.stringify({ count: models.length, countAuth: modelsAuth.length, countEu: modelsEu.length, status: [noAuth.status, withAuth.status, eu.status], ms: noAuth.ms, keysSeen: [...keysSeen], regionCounts }, null, 1));
for (const r of table) console.log([r.id, r.creator, r.ctx, r.regions, r.price, r.regional_increase ?? "", r.retire, r.params].join(" | "));
