/** t-rate-violation.ts - send question_24k.wav at 4x real time: does audio_rate_violation fire, and what is transcribed? */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { brief, loadFixturePcm, newRecorder, open, sleep, vaLogger } from "./harness.ts";
const log = vaLogger("t-rate-violation");
const rec = newRecorder();
const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY, maxDurationMs: 40_000 }, rec);
await s.start({ system_prompt: "Test agent. Reply in five words.", output: { voice: "alba" } });
const q = loadFixturePcm("question_24k.wav");
const chunk = 2400; // 50 ms of PCM16 @ 24 kHz
const t0 = performance.now();
for (let off = 0; off < q.bytes.length; off += chunk) {
  s.sendAudio(q.bytes.subarray(off, off + chunk));
  await sleep(12.5); // 4x real time
}
const sendMs = Math.round(performance.now() - t0);
for (let i = 0; i < 60; i++) { s.sendAudio(new Uint8Array(chunk)); await sleep(50); } // 3 s of real-time silence
await sleep(4000);
const errors = rec.events.filter((e) => e.ev.type === "session.error").map((e) => e.ev);
const out = { sentAudioMs: 7300, wallMs: sendMs, errors: errors.slice(0, 3), errorCount: errors.length, userTranscripts: rec.events.filter((e) => e.ev.type === "transcript.user").map((e) => (e.ev as { text?: string }).text), agent: rec.events.filter((e) => e.ev.type === "transcript.agent").map((e) => (e.ev as { text?: string }).text), open: s.isOpen };
const ended = await s.end();
log.result(errors.length ? "PASS" : "PARTIAL", { ...out, ended });
log.close();
console.log(brief(out, 1500));
