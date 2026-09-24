/**
 * t01 - GET /v1/models: save the full list, tier the models, and GET /v1/models/{id} for the picks.
 * Out: out/openai_models.json (full list), out/openai-t01-models.jsonl
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPENAI_API_KEY, OUT_DIR } from "../lib/env.ts";
import { createLogger, loggedFetch } from "../lib/log.ts";
import { MODELS, pickModels } from "./client.ts";
import { header } from "./common.ts";

interface ModelObj {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

const log = createLogger("openai-t01-models");
header(log, "t01-models");
const auth = { Authorization: `Bearer ${OPENAI_API_KEY}` };

const list = await loggedFetch<{ object: string; data: ModelObj[] }>(log, "https://api.openai.com/v1/models", { headers: auth, label: "GET /v1/models" });
if (!list.ok || !list.json) {
  log.result("FAIL", { status: list.status, body: list.text.slice(0, 500) });
  log.close();
  process.exit(1);
}
const data = [...list.json.data].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
const ids = data.map((m) => m.id);
const tiers = pickModels(ids);

writeFileSync(
  resolve(OUT_DIR, "openai_models.json"),
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      endpoint: "GET https://api.openai.com/v1/models",
      count: data.length,
      tiers,
      data: data.map((m) => ({ ...m, created_iso: new Date(m.created * 1000).toISOString().slice(0, 10) })),
    },
    null,
    2,
  ),
);

// Retrieve the picks + a few research-mentioned ids to see which are visible to this key.
const probe = [
  MODELS.reasoning,
  MODELS.balanced,
  MODELS.fast,
  MODELS.tts,
  MODELS.realtime,
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-cyber",
  "gpt-daybreak-blue-latest",
  "gpt-rosalind-research",
  "chat-latest",
  "gpt-live-1",
  "gpt-transcribe",
  "gpt-4o-mini-tts",
];
const retrieved: Record<string, { status: number; ms: number; in_list: boolean; body: unknown }> = {};
for (const id of probe) {
  const r = await loggedFetch(log, `https://api.openai.com/v1/models/${encodeURIComponent(id)}`, { headers: auth, label: `GET /v1/models/${id}` });
  retrieved[id] = { status: r.status, ms: r.ms, in_list: ids.includes(id), body: r.json ?? r.text.slice(0, 200) };
}

const families = {
  gpt6: ids.filter((i) => /^gpt-6/.test(i)),
  gpt56: ids.filter((i) => /^gpt-5\.6/.test(i)),
  tts: tiers.tts,
  realtime: tiers.realtime,
  transcribe: tiers.transcribe,
  audio_chat: ids.filter((i) => /^gpt-audio/.test(i)),
  image: ids.filter((i) => /image/.test(i)),
};
const picksMatchConstants =
  tiers.reasoning === MODELS.reasoning && tiers.balanced === MODELS.balanced && tiers.fast === MODELS.fast && tiers.tts.includes(MODELS.tts) && tiers.realtime.includes(MODELS.realtime);

log.result(picksMatchConstants ? "PASS" : "PARTIAL", {
  status: list.status,
  ms: list.ms,
  total: ids.length,
  tiers,
  families,
  retrieved: Object.fromEntries(Object.entries(retrieved).map(([k, v]) => [k, { status: v.status, in_list: v.in_list }])),
  picks_match_client_constants: picksMatchConstants,
});
log.close();
console.log(JSON.stringify({ total: ids.length, tiers, families, retrieved: Object.fromEntries(Object.entries(retrieved).map(([k, v]) => [k, `${v.status}${v.in_list ? " (listed)" : ""}`])) }, null, 2));
