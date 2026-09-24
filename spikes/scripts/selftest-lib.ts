/** selftest-lib.ts - offline sanity tests for lib/ (no network). `npx tsx scripts/selftest-lib.ts` */
import { readFileSync } from "node:fs";
import { OPENAI_API_KEY, keys, mask } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { decodeWav, encodeWav } from "../lib/wav.ts";
import {
  chunkBytes,
  chunkPcm16,
  deinterleave,
  interleave,
  mulawDecode,
  mulawDecodeSample,
  mulawEncode,
  mulawEncodeSample,
  pace,
  paceAudio,
  pcm16ToBase64,
  pcm16ToBytes,
  resampleLinear,
  rmsDbfs,
  silenceChunks,
  silencePcm16,
  trimSilence,
  concatPcm16,
} from "../lib/audio.ts";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
}
const sine = (hz: number, ms: number, rate: number, amp = 0.5) => {
  const n = Math.round((ms * rate) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767);
  return out;
};
const zeroCrossings = (x: Int16Array) => {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) c++;
  return c;
};

// WAV round trip (mono + stereo)
{
  const m = sine(440, 500, 16000);
  const d = decodeWav(encodeWav(m, 16000, 1));
  check("wav mono roundtrip", d.sampleRate === 16000 && d.channels === 1 && d.frames === m.length && d.samples.every((v, i) => v === m[i]), `frames=${d.frames} dur=${d.durationMs}`);
  const st = interleave(sine(440, 500, 16000), new Int16Array(8000));
  const d2 = decodeWav(encodeWav(st, 16000, 2));
  const [l, r] = deinterleave(d2.samples, 2);
  check("wav stereo roundtrip", d2.channels === 2 && d2.frames === 8000 && rmsDbfs(r!) === -Infinity && rmsDbfs(l!) > -10, `L=${rmsDbfs(l!).toFixed(1)}dB R=${rmsDbfs(r!)}`);
}

// mu-law
{
  const known = [mulawEncodeSample(0), mulawEncodeSample(32767), mulawEncodeSample(-32768), mulawDecodeSample(0xff), mulawDecodeSample(0x80), mulawDecodeSample(0x00)];
  check("mulaw known values", known.join() === [0xff, 0x80, 0x00, 0, 32124, -32124].join(), known.join());
  const s = sine(1000, 200, 8000, 0.7);
  const back = mulawDecode(mulawEncode(s));
  let err = 0;
  for (let i = 0; i < s.length; i++) err += (s[i]! - back[i]!) ** 2;
  const snr = 10 * Math.log10(s.reduce((a, v) => a + v * v, 0) / err);
  check("mulaw roundtrip SNR > 30 dB", snr > 30, `snr=${snr.toFixed(1)}dB`);
}

// resampling
{
  const s24 = sine(1000, 1000, 24000);
  const s16 = resampleLinear(s24, 24000, 16000);
  const s8 = resampleLinear(s24, 24000, 8000);
  check("resample lengths", s16.length === 16000 && s8.length === 8000, `${s16.length}/${s8.length}`);
  check("resample preserves 1 kHz", Math.abs(zeroCrossings(s16) - 2000) <= 4 && Math.abs(zeroCrossings(s8) - 2000) <= 4, `zc16=${zeroCrossings(s16)} zc8=${zeroCrossings(s8)}`);
  const hi = sine(10000, 1000, 24000);
  const aa = rmsDbfs(resampleLinear(hi, 24000, 8000));
  const noaa = rmsDbfs(resampleLinear(hi, 24000, 8000, { antiAlias: false }));
  check("anti-alias filter attenuates 10 kHz on 24k->8k", aa < -40 && noaa > -12, `with=${aa.toFixed(1)}dB without=${noaa.toFixed(1)}dB`);
  const up = resampleLinear(sine(440, 1000, 16000), 16000, 24000);
  check("upsample 16k->24k", up.length === 24000 && Math.abs(zeroCrossings(up) - 880) <= 4, `len=${up.length}`);
}

// chunking
{
  const pcm = sine(440, 1000, 16000);
  const c1 = chunkPcm16(pcm, 16000, 50);
  const c2 = chunkBytes(pcm16ToBytes(pcm), 16000, 50);
  const c3 = chunkBytes(pcm16ToBytes(sine(440, 1010, 16000)), 16000, 50, 2, 1, { padLast: true });
  check("chunk 1 s @ 50 ms", c1.length === 20 && c1.every((c) => c.length === 800) && c2.length === 20 && c2.every((c) => c.length === 1600), `${c1.length}x${c1[0]?.length} / ${c2.length}x${c2[0]?.length}`);
  check("chunk padLast", c3.length === 21 && c3[20]!.length === 1600, `${c3.length}, last=${c3[20]?.length}`);
  const sil = [...silenceChunks(20, 8000, { encoding: "mulaw", totalMs: 100 })];
  check("silenceChunks mulaw", sil.length === 5 && sil.every((c) => c.length === 160 && c.every((b) => b === 0xff)), `${sil.length}x${sil[0]?.length}`);
}

// trimSilence
{
  const x = concatPcm16([silencePcm16(300, 16000), sine(300, 500, 16000), silencePcm16(400, 16000)]);
  const t = trimSilence(x, 16000, { padMs: 0 });
  const startMs = (t.start / 16000) * 1000;
  const endMs = (t.end / 16000) * 1000;
  check("trimSilence", Math.abs(startMs - 300) <= 12 && Math.abs(endMs - 800) <= 12, `start=${startMs}ms end=${endMs}ms`);
}

// pacing (release: end -> 10 x 50 ms = ~500 ms wall)
{
  const t0 = performance.now();
  let maxLate = 0;
  let n = 0;
  for await (const c of paceAudio(pcm16ToBytes(sine(440, 500, 16000)), { sampleRate: 16000, chunkMs: 50 })) {
    maxLate = Math.max(maxLate, c.lateMs);
    n++;
  }
  const wall = performance.now() - t0;
  check("paceAudio real-time (500 ms audio)", n === 10 && wall >= 495 && wall < 600, `chunks=${n} wall=${wall.toFixed(0)}ms maxLate=${maxLate.toFixed(1)}ms`);
  const t1 = performance.now();
  for await (const _ of pace([1, 2, 3, 4, 5], 40, { release: "start" })) void _;
  const wall2 = performance.now() - t1;
  check("pace release=start (5 x 40 ms -> ~160 ms)", wall2 >= 155 && wall2 < 240, `wall=${wall2.toFixed(0)}ms`);
}

// logger redaction + secret masking
{
  const log = createLogger("selftest-log");
  const audio = pcm16ToBase64(sine(440, 100, 16000)); // 3200 bytes
  log.out({ type: "input.audio", audio });
  log.in({ type: "reply.audio", data: audio });
  log.in({ event: "media", media: { payload: Buffer.from(new Uint8Array(160)).toString("base64") } });
  log.out({ headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, token: "tmp_abcdefghijklmnopqrstuvwxyz", note: `leak ${OPENAI_API_KEY} here`, url: "wss://x/v3/ws?sample_rate=16000&token=abcdef1234567890" });
  log.ws("out", pcm16ToBytes(sine(440, 50, 16000)), true);
  log.ws("in", Buffer.from(JSON.stringify({ type: "Begin", id: "abc" })), false);
  log.close();
  const text = readFileSync(log.path, "utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { data: Record<string, unknown> });
  check("log: audio -> {bytes:3200}", JSON.stringify(lines[0]!.data.audio) === '{"bytes":3200}' && JSON.stringify(lines[1]!.data.data) === '{"bytes":3200}', JSON.stringify(lines[0]!.data.audio));
  check("log: twilio media.payload -> {bytes:160}", text.includes('"payload":{"bytes":160}'), "");
  check("log: no secret value in file", !text.includes(OPENAI_API_KEY) && !text.includes("abcdef1234567890") && !text.includes("tmp_abcdefghijklmnopqrstuvwxyz"), "");
  check("log: binary ws frame -> bytes", text.includes('"binary":true,"bytes":1600'), "");
  check("env: keys object prints masked", JSON.stringify(keys).includes("...") && !JSON.stringify(keys).includes(OPENAI_API_KEY) && mask(OPENAI_API_KEY).length < 20, JSON.stringify(Object.keys(keys)));
}

let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exitCode = fail ? 1 : 0;
