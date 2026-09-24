/**
 * e2e-client.ts - live check of the product path using ONLY client.ts + the worklet code string:
 *   mintStreamingToken (30 s window, 120 s cap) -> StreamingSession.connect({ token }) over the Node 22
 *   built-in WebSocket (browser-like, default factory) -> 24 kHz Float32 "mic" in 128-sample render
 *   quanta -> PCM16_DOWNSAMPLER_JS (the exact AudioWorklet code) -> 50 ms PCM16 16 kHz frames ->
 *   sendAudio (chunk validation ON) -> TurnTracker -> 1.5 s of silence quanta -> terminate().
 *
 *   npx tsx streaming/e2e-client.ts
 */
import vm from "node:vm";
import { setTimeout as sleep } from "node:timers/promises";
import { ASSEMBLYAI_API_KEY, FIXTURES_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { pcm16ToFloat32 } from "../lib/audio.ts";
import { readWav } from "../lib/wav.ts";
import { GOLDEN_PARAMS, PRESETS, StreamingSession, TurnTracker, mintStreamingToken } from "./client.ts";
import { PCM16_DOWNSAMPLER_JS, type Pcm16DownsamplerCtor } from "./browser-capture.ts";
import { rateGuard, saveSummary } from "./harness.ts";

const log = createLogger("streaming-e2e-client", { maxString: 2000 });
await rateGuard(log);

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const { token, expires_in_seconds } = await mintStreamingToken(ASSEMBLYAI_API_KEY, { expiresInSeconds: 30, maxSessionDurationSeconds: 120 });
log.note("minted", { expires_in_seconds, tokenChars: token.length, ms: ms() });

const params = { ...GOLDEN_PARAMS, ...PRESETS.voiceAgent };
const session = await StreamingSession.connect({
  auth: { token },
  params,
  onFrame: (dir, frame, meta) => (meta.binaryBytes !== undefined ? log.tally("audio_out", meta.binaryBytes) : log.event(dir, frame, { ms: ms() })),
});
const connectedAt = ms();
const tracker = new TurnTracker();
const finals: { ms: number; text: string }[] = [];
let speechStartedAt: number | undefined;
session.on("speechStarted", () => (speechStartedAt ??= ms()));
session.on("turn", (t) => {
  if (tracker.apply(t) === "final") finals.push({ ms: ms(), text: t.transcript });
});

// "device" audio: 24 kHz float32, fed as 128-sample render quanta at real time
const Down = vm.runInNewContext(`${PCM16_DOWNSAMPLER_JS}; Pcm16Downsampler`, { Math, Int16Array, Float32Array }) as Pcm16DownsamplerCtor;
const w = readWav(`${FIXTURES_DIR}/question_24k.wav`);
const mic = pcm16ToFloat32(w.samples);
let framesSent = 0;
let rejected = 0;
const ds = new Down(24000, 16000, 50, (frame) => {
  try {
    if (session.sendAudio(new Uint8Array(frame.buffer))) framesSent++;
  } catch {
    rejected++;
  }
});
const audioStart = ms();
const silence = new Float32Array(128);
const totalQuanta = Math.ceil(mic.length / 128) + Math.ceil((24000 * 1.5) / 128);
const tAudio = performance.now();
for (let q = 0; q < totalQuanta && session.isOpen; q++) {
  const off = q * 128;
  ds.process(off < mic.length ? mic.subarray(off, off + 128) : silence);
  const dueMs = ((q + 1) * 128) / 24;
  const wait = dueMs - (performance.now() - tAudio);
  if (wait > 2) await sleep(wait);
}
const audioEnd = ms();
const termination = await session.terminate();
const text = finals.map((f) => f.text).join(" ");
const ok = text.replace(/\D/g, "").includes("481529") && !!termination && rejected === 0;
const summary = {
  test: "e2e-client",
  status: ok ? "PASS" : "FAIL",
  request: { params, auth: "token (30 s window, 120 s cap) via Node 22 built-in WebSocket", audio: "question_24k.wav as 24 kHz Float32 128-sample quanta -> PCM16_DOWNSAMPLER_JS -> 50 ms 16 kHz frames, + 1.5 s silence" },
  begin: session.begin,
  expiresInFromNowS: session.begin.expires_at - Math.round(Date.now() / 1000),
  connectedAtMs: connectedAt,
  audioStartMs: audioStart,
  audioEndMs: audioEnd,
  speechStartedAfterAudioStartMs: speechStartedAt !== undefined ? speechStartedAt - audioStart : undefined,
  framesSent,
  framesRejectedClientSide: rejected,
  finals: finals.map((f) => ({ afterAudioStartMs: f.ms - audioStart, text: f.text })),
  lastFinalBeforeTerminate: finals.length ? finals.at(-1)!.ms <= audioEnd : false,
  termination,
  close: session.closeInfo,
};
log.result(ok ? "PASS" : "FAIL", summary);
log.close();
console.log(JSON.stringify(summary, null, 2));
saveSummary("e2e-client", summary);
