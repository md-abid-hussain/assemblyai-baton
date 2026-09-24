/**
 * Read-only telephony/webhook checks (no numbers imported, nothing created) + a G.711 mu-law codec session.
 *   - GET agents.us.assemblyai.com/v1/phone-numbers, GET agents.assemblyai.com/v1/phone-numbers
 *   - GET /v1/webhook-subscriptions (both hosts)
 *   - session with input+output audio/pcmu (8 kHz): stream fixtures/question_8k.mulaw in 20 ms frames
 *     (Twilio's frame size), check the reply audio is 8 kHz mu-law, save it as a WAV.
 *
 *   npx tsx voice-agent/t8-readonly-and-pcmu.ts
 * Log: spikes/out/va-t8-readonly-and-pcmu.jsonl   Audio: spikes/out/va-pcmu-reply.wav
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { mulawDecode, rmsDbfs } from "../lib/audio.ts";
import { writeWav } from "../lib/wav.ts";
import { RealtimeAudioFeeder, VA_US_REST_BASE } from "./client.ts";
import { FIXTURES_DIR, OUT_DIR, brief, concatBytes, newRecorder, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t8-readonly-and-pcmu");
const rest = restFor(log);
const restUs = restFor(log, "raw", VA_US_REST_BASE);
const out: Record<string, unknown> = {};

async function main() {
  for (const [label, r] of [
    ["us phone-numbers", await restUs.request("GET", "/phone-numbers", undefined, "GET us /phone-numbers")],
    ["global phone-numbers", await rest.request("GET", "/phone-numbers", undefined, "GET global /phone-numbers")],
    ["global webhook-subscriptions", await rest.request("GET", "/webhook-subscriptions", undefined, "GET global /webhook-subscriptions")],
    ["us webhook-subscriptions", await restUs.request("GET", "/webhook-subscriptions", undefined, "GET us /webhook-subscriptions")],
    ["global agents (leftover check)", await rest.request("GET", "/agents", undefined, "GET global /agents")],
  ] as const) {
    out[label] = { status: r.status, body: brief(r.body, 400) };
    console.log(label, r.status, brief(r.body, 300));
  }

  // --- mu-law session ---------------------------------------------------------------------
  const mulaw = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, "question_8k.mulaw")));
  const rec = newRecorder();
  const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
  const hardStop = setTimeout(() => void s.end(), 60_000);
  const ready = await s.start({
    system_prompt: "You are Max, Acme Shop's AI phone assistant. You cannot look up orders on this line; say a human will call back within one business day. One short sentence.",
    input: { format: { encoding: "audio/pcmu" } },
    output: { voice: "alba", format: { encoding: "audio/pcmu" } },
  });
  out.readyFormats = { input: (ready.config as { input?: { format?: unknown } }).input?.format, output: (ready.config as { output?: { format?: unknown } }).output?.format };
  const feeder = new RealtimeAudioFeeder(s, { sampleRate: 8000, bytesPerSample: 1, chunkMs: 20, silenceByte: 0xff });
  feeder.start();
  await sleep(500);
  const idx = rec.events.length;
  await feeder.play(mulaw);
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const evs = rec.events.slice(idx);
    if (evs.some((e) => e.ev.type === "reply.done") && evs.some((e) => e.ev.type === "transcript.agent")) break;
    await sleep(200);
  }
  await sleep(500);
  await feeder.stop();
  clearTimeout(hardStop);
  out.ended = (await s.end()) ?? null;
  const evs = rec.events.slice(idx);
  const bytes = concatBytes(rec.replyOrder.flatMap((id) => rec.audioByReply.get(id) ?? []));
  const chunkSizes = [...new Set(rec.audioChunks.map((c) => c.bytes))];
  const pcm = mulawDecode(bytes);
  writeWav(resolve(OUT_DIR, "va-pcmu-reply.wav"), pcm, 8000, 1);
  out.pcmu = {
    user: evs.filter((e) => e.ev.type === "transcript.user").map((e) => (e.ev as { text?: string }).text),
    agent: evs.filter((e) => e.ev.type === "transcript.agent").map((e) => (e.ev as { text?: string }).text),
    replyAudioBytes: bytes.length,
    replyChunkByteSizes: chunkSizes,
    impliedSecondsAt8kMulaw: +(bytes.length / 8000).toFixed(2),
    wallSecondsFirstToLastChunk: rec.audioChunks.length ? +((rec.audioChunks[rec.audioChunks.length - 1]!.ms - rec.audioChunks[0]!.ms) / 1000).toFixed(2) : null,
    decodedRmsDb: Math.round(rmsDbfs(pcm)),
  };
  console.log("pcmu:", brief(out.pcmu, 800));
  const ok = (out.pcmu as { agent: string[] }).agent.length > 0;
  log.result(ok ? "PASS" : "FAIL", out);
  log.close();
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
