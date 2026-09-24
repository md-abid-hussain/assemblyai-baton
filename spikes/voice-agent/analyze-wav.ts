/** analyze-wav.ts <wav> - speech segments (> -50 dBFS, gaps > 300 ms) of a saved agent-audio WAV. */
import { readWav } from "../lib/wav.ts";
import { rmsDbfs } from "../lib/audio.ts";
const w = readWav(process.argv[2]!);
const win = w.sampleRate / 100;
const segs: [number, number][] = [];
let cur: number | null = null, last = 0, minDb = 0, silentZero = 0, frames = 0;
for (let i = 0; i + win <= w.samples.length; i += win) {
  const db = rmsDbfs(w.samples.subarray(i, i + win)); frames++;
  if (db === -Infinity) silentZero++; else if (db < minDb) minDb = db;
  const t = (i / w.sampleRate) * 1000;
  if (db > -50) { if (cur === null) cur = t; last = t + 10; } else if (cur !== null && t - last > 300) { segs.push([cur, last]); cur = null; }
}
if (cur !== null) segs.push([cur, last]);
console.log(JSON.stringify({ file: process.argv[2], durMs: Math.round(w.durationMs), digitalZero10msFrames: silentZero, of: frames, quietestNonZeroDb: Math.round(minDb), segmentsMs: segs.map(([a, b]) => [Math.round(a), Math.round(b)]) }));
