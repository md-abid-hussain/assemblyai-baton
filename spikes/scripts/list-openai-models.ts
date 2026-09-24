/** GET https://api.openai.com/v1/models -> out/openai-models.jsonl (+ prints TTS/audio-related ids). */
import { OPENAI_API_KEY } from "../lib/env.ts";
import { createLogger, loggedFetch } from "../lib/log.ts";

const log = createLogger("openai-models");
const res = await loggedFetch<{ data: { id: string; created: number; owned_by: string }[] }>(log, "https://api.openai.com/v1/models", {
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  label: "list-models",
});
const ids = (res.json?.data ?? []).map((m) => ({ id: m.id, created: new Date(m.created * 1000).toISOString().slice(0, 10) }));
const audio = ids.filter((m) => /tts|speech|audio|realtime|transcribe|whisper|voice/i.test(m.id)).sort((a, b) => a.created.localeCompare(b.created));
log.result(res.ok ? "PASS" : "FAIL", { status: res.status, ms: res.ms, total: ids.length, audio });
log.close();
console.log(`status=${res.status} ms=${res.ms} total_models=${ids.length}`);
for (const m of audio) console.log(`  ${m.created}  ${m.id}`);
